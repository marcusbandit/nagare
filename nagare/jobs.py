"""Download jobs.

The pipeline is what makes watch-while-downloading work:

    yt-dlp -o -   ->   ffmpeg   ->   live HLS (fMP4, EVENT playlist)

yt-dlp muxes the chosen video and audio streams to stdout as they arrive, so ffmpeg
sees a continuous stream from the first second rather than a file that only exists
once the download finishes. ffmpeg copies (never re-encodes) that into HLS segments
plus an EVENT playlist, which a browser can start playing immediately and can seek
freely within whatever has landed so far.

When the stream ends the segments are concatenated back into a single faststart mp4
and the working directory is thrown away. Every step is a stream copy, so finishing
a two hour video costs a couple of seconds, not a re-encode.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import shutil
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import auth, config, ytx

_PCT_RE = re.compile(r"\[download\]\s+(\d+(?:\.\d+)?)%")

TERMINAL = {"done", "failed", "cancelled"}


@dataclass
class Job:
    id: str
    url: str
    title: str = ""
    uploader: str = ""
    duration: float = 0.0
    thumbnail: str = ""
    thumb_file: str = ""
    quality: str = config.DEFAULT_QUALITY
    audio_only: bool = False

    state: str = "queued"  # queued | running | finalizing | done | failed | cancelled
    stage: str = ""        # human readable detail under the progress bar
    progress: float = 0.0  # 0..1, fraction of the video that is watchable
    fetched_bytes: int = 0
    speed: float = 0.0     # ffmpeg's speed multiplier (x realtime)
    watchable: bool = False
    error: str = ""
    file: str = ""         # final media filename, relative to MEDIA
    created: float = field(default_factory=time.time)
    finished: float = 0.0

    def public(self) -> dict:
        d = asdict(self)
        d["hls"] = f"/hls/{self.id}/index.m3u8" if self.watchable and self.state not in ("done",) else ""
        d["media"] = f"/media/{self.file}" if self.file else ""
        d["poster"] = f"/thumbs/{self.thumb_file}" if self.thumb_file else self.thumbnail
        return d


class JobManager:
    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}
        self.procs: dict[str, list[asyncio.subprocess.Process]] = {}
        self._subscribers: set[asyncio.Queue] = set()
        self._sem = asyncio.Semaphore(config.MAX_CONCURRENT)
        self._tasks: dict[str, asyncio.Task] = {}

    # ---------------------------------------------------------------- events

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=256)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def _emit(self, job: Job) -> None:
        payload = job.public()
        for q in list(self._subscribers):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                pass

    def _update(self, job: Job, **fields) -> None:
        for k, v in fields.items():
            setattr(job, k, v)
        self._emit(job)

    # ------------------------------------------------------------ persistence

    def _meta_path(self, job_id: str) -> Path:
        return config.META / f"{job_id}.json"

    def _save(self, job: Job) -> None:
        self._meta_path(job.id).write_text(json.dumps(asdict(job), indent=2))

    def load_library(self) -> None:
        """Rehydrate finished jobs from disk; drop anything whose media vanished."""
        for path in sorted(config.META.glob("*.json")):
            try:
                data = json.loads(path.read_text())
            except (json.JSONDecodeError, OSError):
                continue
            known = {f.name for f in Job.__dataclass_fields__.values()}
            job = Job(**{k: v for k, v in data.items() if k in known})
            if job.state != "done":
                # Anything interrupted by a restart is not resumable; forget it.
                path.unlink(missing_ok=True)
                shutil.rmtree(config.WORK / job.id, ignore_errors=True)
                continue
            if not job.file or not (config.MEDIA / job.file).exists():
                path.unlink(missing_ok=True)
                continue
            self.jobs[job.id] = job

    # ------------------------------------------------------------------- api

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def all(self) -> list[dict]:
        return [j.public() for j in sorted(self.jobs.values(), key=lambda j: -j.created)]

    async def enqueue(self, video: dict, quality: str) -> Job:
        quality = quality if quality in config.QUALITIES else config.DEFAULT_QUALITY
        job_id = video.get("id") or ""
        if not job_id:
            raise ValueError("video has no id")
        # A channel id or a playlist id here would hand yt-dlp a whole channel to
        # download. Only a video id is a video.
        if not ytx.VIDEO_ID.fullmatch(job_id):
            raise ValueError(f"{job_id} is not a video")

        existing = self.jobs.get(job_id)
        if existing and existing.state not in TERMINAL:
            return existing
        if existing and existing.state == "done":
            return existing

        job = Job(
            id=job_id,
            url=video.get("url") or f"https://www.youtube.com/watch?v={job_id}",
            title=video.get("title") or job_id,
            uploader=video.get("uploader") or "",
            duration=float(video.get("duration") or 0),
            thumbnail=video.get("thumbnail") or "",
            quality=quality,
            audio_only=config.QUALITIES[quality]["audio_only"],
        )
        self.jobs[job_id] = job
        self._emit(job)
        self._tasks[job_id] = asyncio.create_task(self._supervise(job))
        return job

    async def cancel(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job or job.state in TERMINAL:
            return False
        self._update(job, state="cancelled", stage="cancelled")
        for proc in self.procs.get(job_id, []):
            with contextlib.suppress(ProcessLookupError):
                proc.terminate()
        task = self._tasks.get(job_id)
        if task:
            task.cancel()
        shutil.rmtree(config.WORK / job_id, ignore_errors=True)
        return True

    async def remove(self, job_id: str, delete_file: bool = True) -> bool:
        job = self.jobs.pop(job_id, None)
        if not job:
            return False
        if job.state not in TERMINAL:
            for proc in self.procs.get(job_id, []):
                with contextlib.suppress(ProcessLookupError):
                    proc.terminate()
            task = self._tasks.get(job_id)
            if task:
                task.cancel()
        shutil.rmtree(config.WORK / job_id, ignore_errors=True)
        self._meta_path(job_id).unlink(missing_ok=True)
        if delete_file and job.file:
            (config.MEDIA / job.file).unlink(missing_ok=True)
        self._emit(Job(id=job_id, url="", state="removed"))
        return True

    # -------------------------------------------------------------- pipeline

    async def _supervise(self, job: Job) -> None:
        try:
            self._update(job, stage="waiting for a slot")
            async with self._sem:
                await self._run(job)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - surface anything to the UI
            self._update(job, state="failed", error=str(exc), stage="failed")
            self._save(job)
        finally:
            self._tasks.pop(job.id, None)

    async def _run(self, job: Job) -> None:
        workdir = config.WORK / job.id
        shutil.rmtree(workdir, ignore_errors=True)
        workdir.mkdir(parents=True, exist_ok=True)

        self._update(job, state="running", stage="asking YouTube for the streams")

        thumb = await ytx.cache_thumb(job.id, job.thumbnail)
        if thumb:
            self._update(job, thumb_file=thumb)

        fmt = config.QUALITIES[job.quality]["fmt"]

        format_id, acodec, duration = await self._probe(job, fmt)
        if duration and not job.duration:
            self._update(job, duration=duration)

        # Each selected stream gets its own yt-dlp. That matters for speed: when a
        # single yt-dlp has to merge, it hands the download to ffmpeg, which pulls
        # each URL over one plain connection and YouTube throttles that to a crawl
        # (measured ~175 KB/s). Asking for one format at a time keeps yt-dlp's own
        # chunked downloader, which is not throttled (~1.3 MB/s on the same video),
        # and running them in parallel into one muxer keeps playback progressive.
        streams = [s for s in format_id.split("+") if s] or [fmt]

        self._update(job, stage="starting the streams")

        read_fds: list[int] = []
        downloaders: list[asyncio.subprocess.Process] = []
        for spec in streams:
            read_fd, write_fd = os.pipe()
            try:
                proc = await asyncio.create_subprocess_exec(
                    sys.executable, "-m", "yt_dlp", "-q", "--no-warnings",
                    "--no-playlist", "--no-part", "--no-cache-dir",
                    *auth.cli_args(),
                    "-f", spec, "-o", "-", job.url,
                    stdout=write_fd,
                    stderr=asyncio.subprocess.PIPE,
                )
            finally:
                os.close(write_fd)
            read_fds.append(read_fd)
            downloaders.append(proc)

        inputs: list[str] = []
        for fd in read_fds:
            inputs += ["-i", f"pipe:{fd}"]

        if job.audio_only:
            maps = ["-map", "0:a:0"]
        elif len(read_fds) > 1:
            maps = ["-map", "0:v:0", "-map", "1:a:0"]
        else:
            maps = ["-map", "0:v:0?", "-map", "0:a:0?"]

        # AAC arriving as ADTS cannot enter MP4 as-is; the muxer rejects the
        # packets outright. The filter converts it, and is a no-op when the
        # stream is already in the ASC form MP4 wants.
        abitstream = ["-bsf:a", "aac_adtstoasc"] if _is_aac(acodec) else []
        ffmpeg_cmd = [
            config.FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error",
            *inputs, *maps, "-c", "copy", *abitstream,
            "-f", "hls",
            "-hls_time", str(config.SEGMENT_SECONDS),
            "-hls_playlist_type", "event",
            "-hls_segment_type", "fmp4",
            "-hls_fmp4_init_filename", "init.mp4",
            "-hls_segment_filename", "seg%05d.m4s",
            "-progress", "pipe:1", "-stats_period", "0.4",
            "index.m3u8",
        ]

        try:
            ffmpeg = await asyncio.create_subprocess_exec(
                *ffmpeg_cmd,
                cwd=workdir,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                pass_fds=tuple(read_fds),
            )
        finally:
            # The read ends belong to ffmpeg now. Holding them open here would
            # stop ffmpeg ever seeing EOF, and the job would hang at 100%.
            for fd in read_fds:
                os.close(fd)

        self.procs[job.id] = [*downloaders, ffmpeg]

        yt_err: list[str] = []
        ff_err: list[str] = []
        try:
            await asyncio.gather(
                self._pump_ffmpeg_progress(job, ffmpeg),
                self._drain(ffmpeg.stderr, ff_err),
                *[self._pump_ytdlp_stderr(job, p, yt_err) for p in downloaders],
            )
            yt_rcs = [await p.wait() for p in downloaders]
            yt_rc = next((rc for rc in yt_rcs if rc != 0), 0)
            ff_rc = await ffmpeg.wait()
        finally:
            self.procs.pop(job.id, None)

        if job.state == "cancelled":
            return

        if ff_rc != 0 or (yt_rc != 0 and not job.watchable):
            # yt-dlp's ERROR line is usually the root cause ("Video unavailable");
            # ffmpeg's is the proximate one. Prefer the root cause when there is one.
            detail = (
                _first_error(yt_err)
                or _first_error(ff_err)
                or f"yt-dlp exited {yt_rc}, ffmpeg exited {ff_rc}"
            )
            detail = auth.recover(detail)  # opens sign-in + rewrites when it's the bot wall
            self._update(job, state="failed", error=detail, stage="failed")
            self._save(job)
            shutil.rmtree(workdir, ignore_errors=True)
            return

        await self._finalise(job, workdir)

    async def _probe(self, job: Job, fmt: str) -> tuple[str, str, float]:
        """Ask yt-dlp what it is about to hand us, without downloading anything.

        Cheap, and it buys four things: the concrete format ids (so each stream can
        be fetched separately at full speed), the audio codec (so ffmpeg gets the
        right bitstream filter), the real duration (so progress means something when
        the client only pasted a URL), and an early, readable error for videos that
        are private, geo-blocked or gone.
        """
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "yt_dlp", "--no-warnings", "--simulate", "--no-playlist",
            "--no-cache-dir", *auth.cli_args(), "-f", fmt,
            "--print", "%(format_id)s|%(acodec)s|%(duration)s",
            job.url,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate()
        if proc.returncode != 0:
            message = _first_error(err.decode(errors="replace").splitlines())
            raise RuntimeError(auth.recover(message) or "yt-dlp could not read that video")
        text = out.decode(errors="replace").strip()
        line = text.splitlines()[-1] if text else ""
        parts = line.split("|")
        format_id = parts[0].strip() if parts else ""
        acodec = parts[1].strip() if len(parts) > 1 else ""
        try:
            duration = float(parts[2])
        except (IndexError, ValueError):
            duration = 0.0
        return format_id, acodec, duration

    async def _pump_ffmpeg_progress(self, job: Job, proc: asyncio.subprocess.Process) -> None:
        """ffmpeg -progress emits key=value lines; out_time_us is what we care about.

        out_time is how much *media* has been written, so out_time / duration is
        literally "how much of this video can I watch right now" - a better number
        for this app than bytes fetched.
        """
        assert proc.stdout is not None
        last_emit = 0.0
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                break
            line = raw.decode(errors="replace").strip()
            key, _, value = line.partition("=")
            if key == "out_time_us" and value.isdigit():
                seconds = int(value) / 1_000_000
                if job.duration > 0:
                    job.progress = min(seconds / job.duration, 1.0)
                if not job.watchable and (config.WORK / job.id / "index.m3u8").exists():
                    job.watchable = True
                    job.stage = "ready to watch"
            elif key == "speed":
                with contextlib.suppress(ValueError):
                    job.speed = float(value.rstrip("x").strip() or 0)

            now = time.monotonic()
            if key == "progress" and now - last_emit > 0.4:
                last_emit = now
                # ffmpeg reports no total_size for segmented output, so the honest
                # number is what has actually been written to the working directory.
                job.fetched_bytes = _dir_size(config.WORK / job.id)
                if job.watchable and job.stage in ("", "ready to watch", "downloading"):
                    job.stage = "downloading"
                self._emit(job)

    async def _pump_ytdlp_stderr(
        self, job: Job, proc: asyncio.subprocess.Process, sink: list[str]
    ) -> None:
        """yt-dlp narrates format selection on stderr (media is on stdout)."""
        assert proc.stderr is not None
        while True:
            raw = await proc.stderr.readline()
            if not raw:
                break
            line = raw.decode(errors="replace").strip()
            if not line or _is_progress_noise(line):
                continue
            sink.append(line)
            if len(sink) > 60:
                del sink[0]
            if job.watchable:
                continue
            if "Downloading" in line and "format" not in line:
                continue
            pct = _PCT_RE.search(line)
            if pct:
                self._update(job, stage=f"fetching {pct.group(1)}%")
            elif line.startswith("[info]") or "Extracting" in line:
                self._update(job, stage="resolving streams")

    @staticmethod
    async def _drain(stream, sink: list[str]) -> None:
        if stream is None:
            return
        while True:
            raw = await stream.readline()
            if not raw:
                break
            text = raw.decode(errors="replace").strip()
            if text:
                sink.append(text)
                if len(sink) > 60:
                    del sink[0]

    async def _finalise(self, job: Job, workdir: Path) -> None:
        """Glue the fMP4 segments back into one seekable file.

        An HLS fMP4 init segment followed by its media segments *is* a valid
        fragmented mp4, so concatenating the bytes gives a playable file directly.
        The second pass only rewrites the index to the front (faststart) so the
        browser can seek without fetching the tail first.
        """
        self._update(job, state="finalizing", stage="assembling the file", progress=1.0)

        init = workdir / "init.mp4"
        segments = sorted(workdir.glob("seg*.m4s"))
        if not init.exists() or not segments:
            self._update(job, state="failed", error="no media was written", stage="failed")
            self._save(job)
            shutil.rmtree(workdir, ignore_errors=True)
            return

        joined = workdir / "joined.mp4"
        with joined.open("wb") as out:
            for part in [init, *segments]:
                with part.open("rb") as src:
                    shutil.copyfileobj(src, out, length=1024 * 1024)

        ext = "m4a" if job.audio_only else "mp4"
        final = config.MEDIA / f"{_safe_name(job.title)} [{job.id}].{ext}"
        proc = await asyncio.create_subprocess_exec(
            config.FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-i", str(joined), "-c", "copy", "-movflags", "+faststart",
            "-f", "mp4" if not job.audio_only else "ipod", str(final),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()

        if proc.returncode != 0 or not final.exists():
            # Fall back to the concatenated file: less seekable, but complete.
            final = config.MEDIA / f"{_safe_name(job.title)} [{job.id}].{ext}"
            shutil.move(str(joined), str(final))

        shutil.rmtree(workdir, ignore_errors=True)
        self._update(
            job,
            state="done",
            stage="",
            watchable=False,
            file=final.name,
            finished=time.time(),
            fetched_bytes=final.stat().st_size if final.exists() else job.fetched_bytes,
        )
        self._save(job)


def _safe_name(title: str) -> str:
    cleaned = re.sub(r'[/\\:*?"<>|\x00-\x1f]', "_", title).strip(" .")
    return (cleaned or "video")[:120]


def _dir_size(path: Path) -> int:
    try:
        return sum(entry.stat().st_size for entry in os.scandir(path) if entry.is_file())
    except OSError:
        return 0


def _is_aac(acodec: str) -> bool:
    a = (acodec or "").lower()
    return a.startswith("mp4a") or "aac" in a


def _is_progress_noise(line: str) -> bool:
    """ffmpeg's per-frame stats, which yt-dlp's internal muxer emits on stderr.

    Without this the last line of the buffer is always a stats line, which would
    then be reported to the user as though it were the error.
    """
    return line.startswith(("frame=", "size=", "Press [q]")) or "Last message repeated" in line


def _first_error(lines: list[str]) -> str:
    for line in lines:
        if "ERROR" in line or "Error" in line:
            return line.replace("ERROR:", "").strip()[:300]
    return lines[-1][:300] if lines else ""


manager = JobManager()
