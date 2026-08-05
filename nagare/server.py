"""FastAPI app: search, queue, live progress over SSE, and byte-range media serving."""

from __future__ import annotations

import asyncio
import contextlib
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import webbrowser
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import auth, config, doctor, extras, subs, ytx
from .jobs import manager

config.ensure_dirs()

@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI):
    manager.load_library()
    yield


app = FastAPI(title="nagare", docs_url=None, redoc_url=None, lifespan=lifespan)


# --------------------------------------------------------------------- api


@app.get("/api/config")
async def api_config() -> dict:
    return {
        "qualities": [
            {"id": k, "label": v["label"]} for k, v in config.QUALITIES.items()
        ],
        "default_quality": config.DEFAULT_QUALITY,
        "has_mpv": bool(config.MPV),
        "root": str(config.ROOT),
    }


@app.get("/api/search")
async def api_search(
    q: str,
    limit: int = 24,
    sort: str = "relevance",
    date: str = "any",
    duration: str = "any",
) -> JSONResponse:
    q = q.strip()
    if not q:
        return JSONResponse({"results": []})
    if q.startswith(("http://", "https://", "www.")):
        url = q if q.startswith("http") else f"https://{q}"
        try:
            resolved = await ytx.resolve(url)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, str(exc)) from exc
        return JSONResponse({"results": resolved["entries"], "kind": resolved["type"],
                             "title": resolved["title"]})
    try:
        filtered = sort != "relevance" or date != "any" or duration != "any"
        if filtered:
            # ytsearch: has no filter syntax, so go through a real results page
            # with the `sp` protobuf instead.
            results = await ytx.search_filtered(
                extras.search_url(q, sort, date, duration), min(max(limit, 1), 50)
            )
        else:
            results = await ytx.search(q, min(max(limit, 1), 50))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc
    return JSONResponse({"results": results, "kind": "search", "title": q})


@app.get("/api/auth/status")
async def api_auth_status() -> JSONResponse:
    """Where YouTube cookies come from and whether a session is visible."""
    return JSONResponse(await asyncio.to_thread(auth.status))


@app.post("/api/auth/signin")
async def api_auth_signin() -> JSONResponse:
    """Open the default browser at YouTube's sign-in so cookies get refreshed."""
    opened = await asyncio.to_thread(auth.open_signin, True)
    return JSONResponse({"ok": opened, "browser": auth.pretty_source()})


@app.get("/api/votes/{video_id}")
async def api_votes(video_id: str) -> JSONResponse:
    return JSONResponse(await extras.votes(video_id))


# ------------------------------------------------------------- subscriptions


@app.get("/api/subscriptions")
async def api_subs() -> JSONResponse:
    return JSONResponse({"channels": subs.load()})


@app.get("/api/search/channels")
async def api_search_channels(q: str, limit: int = 12) -> JSONResponse:
    q = q.strip()
    if not q:
        return JSONResponse({"channels": []})
    try:
        found = await ytx.search_channels(
            extras.search_url(q, result_type="channel"), min(max(limit, 1), 30)
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc
    return JSONResponse({"channels": found})


@app.post("/api/subscriptions")
async def api_subscribe(payload: dict) -> JSONResponse:
    # A search result is already resolved; subscribing to it should not cost
    # another round trip just to look the channel up again.
    channel = payload.get("channel")
    try:
        if isinstance(channel, dict) and channel.get("id"):
            record = await subs.add_channel(channel)
        else:
            target = (payload.get("target") or "").strip()
            if not target:
                raise HTTPException(400, "give a channel url, @handle or a video url")
            record = await subs.add(target)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, str(exc)) from exc
    return JSONResponse({"channel": record, "channels": subs.load()})


@app.delete("/api/subscriptions/{channel_id}")
async def api_unsubscribe(channel_id: str) -> JSONResponse:
    if not subs.remove(channel_id):
        raise HTTPException(404, "not subscribed")
    return JSONResponse({"channels": subs.load()})


@app.get("/api/channel/{channel_id}")
async def api_channel(channel_id: str, limit: int = 30) -> JSONResponse:
    try:
        data = await ytx.channel(channel_id, min(max(limit, 1), 90))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(404, str(exc)) from exc
    return JSONResponse(data)


@app.get("/api/feed")
async def api_feed(limit: int = 60, channel: str = "") -> JSONResponse:
    return JSONResponse(await subs.feed(min(max(limit, 1), 200), channel))


@app.post("/api/download")
async def api_download(payload: dict) -> JSONResponse:
    videos = payload.get("videos") or ([payload["video"]] if payload.get("video") else [])
    quality = payload.get("quality") or config.DEFAULT_QUALITY
    if not videos:
        raise HTTPException(400, "no videos given")
    created = []
    for video in videos:
        try:
            job = await manager.enqueue(video, quality)
            created.append(job.public())
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    return JSONResponse({"jobs": created})


@app.get("/api/sponsorblock/{video_id}")
async def api_sponsorblock(video_id: str) -> JSONResponse:
    return JSONResponse({"segments": await extras.sponsor_segments(video_id)})


@app.get("/api/subtitles/{video_id}")
async def api_subtitle_tracks(video_id: str) -> JSONResponse:
    return JSONResponse({"tracks": await extras.subtitle_tracks(video_id)})


@app.get("/api/subtitles/{video_id}/{lang}")
async def api_subtitle_vtt(video_id: str, lang: str) -> Response:
    try:
        text = await extras.subtitle_vtt(video_id, lang)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(404, str(exc)) from exc
    return Response(text, media_type="text/vtt; charset=utf-8")


@app.get("/api/comments/{video_id}")
async def api_comments(video_id: str, limit: int = 120) -> JSONResponse:
    return JSONResponse(await extras.comments(video_id, min(max(limit, 1), 500)))


@app.get("/api/video/{video_id}")
async def api_video(video_id: str) -> JSONResponse:
    """Full metadata for the watch page (description, counts, related fields)."""
    try:
        resolved = await ytx.resolve(f"https://www.youtube.com/watch?v={video_id}")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(404, str(exc)) from exc
    entries = resolved.get("entries") or []
    if not entries:
        raise HTTPException(404, "video not found")
    return JSONResponse(entries[0])


@app.get("/api/video/{video_id}/full")
async def api_video_full(video_id: str) -> JSONResponse:
    return JSONResponse(await ytx.video_full(video_id))


@app.get("/api/jobs")
async def api_jobs() -> JSONResponse:
    return JSONResponse({"jobs": manager.all()})


@app.post("/api/jobs/{job_id}/cancel")
async def api_cancel(job_id: str) -> JSONResponse:
    ok = await manager.cancel(job_id)
    if not ok:
        raise HTTPException(404, "no such active job")
    return JSONResponse({"ok": True})


@app.delete("/api/jobs/{job_id}")
async def api_delete(job_id: str, keep_file: bool = False) -> JSONResponse:
    ok = await manager.remove(job_id, delete_file=not keep_file)
    if not ok:
        raise HTTPException(404, "no such job")
    return JSONResponse({"ok": True})


@app.post("/api/jobs/{job_id}/mpv")
async def api_mpv(job_id: str) -> JSONResponse:
    if not config.MPV:
        raise HTTPException(501, "mpv is not installed")
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "no such job")
    if job.state == "done" and job.file:
        target = str(config.MEDIA / job.file)
    elif job.watchable:
        target = str(config.WORK / job.id / "index.m3u8")
    else:
        raise HTTPException(409, "nothing playable yet")
    subprocess.Popen(  # noqa: S603 - local, user initiated
        [config.MPV, "--force-window=yes", target],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return JSONResponse({"ok": True})


@app.get("/api/events")
async def api_events(request: Request) -> StreamingResponse:
    queue = manager.subscribe()

    async def stream():
        try:
            yield f"data: {json.dumps({'hello': True, 'jobs': manager.all()})}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=20)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {json.dumps(payload)}\n\n"
        finally:
            manager.unsubscribe(queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ------------------------------------------------------------------- media


def _range_response(path: Path, request: Request) -> Response:
    """Serve a file honouring Range, so the browser can seek and so a growing
    file still streams."""
    if not path.is_file():
        raise HTTPException(404, "not found")
    size = path.stat().st_size
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    range_header = request.headers.get("range")

    if not range_header:
        return FileResponse(path, media_type=media_type, headers={"Accept-Ranges": "bytes"})

    units, _, spec = range_header.partition("=")
    if units.strip().lower() != "bytes":
        raise HTTPException(416, "bad range unit")
    start_s, _, end_s = spec.split(",")[0].partition("-")
    try:
        if start_s:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
        else:  # suffix range: last N bytes
            start = max(size - int(end_s), 0)
            end = size - 1
    except ValueError as exc:
        raise HTTPException(416, "bad range") from exc

    if start >= size:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
    end = min(end, size - 1)
    length = end - start + 1

    def chunks():
        with path.open("rb") as fh:
            fh.seek(start)
            remaining = length
            while remaining > 0:
                block = fh.read(min(262144, remaining))
                if not block:
                    break
                remaining -= len(block)
                yield block

    return StreamingResponse(
        chunks(),
        status_code=206,
        media_type=media_type,
        headers={
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(length),
            "Accept-Ranges": "bytes",
        },
    )


def _safe_join(base: Path, relative: str) -> Path:
    target = (base / relative).resolve()
    if not str(target).startswith(str(base.resolve())):
        raise HTTPException(403, "outside the media root")
    return target


@app.get("/media/{filename:path}")
async def media(filename: str, request: Request) -> Response:
    return _range_response(_safe_join(config.MEDIA, filename), request)


@app.get("/hls/{job_id}/{filename:path}")
async def hls(job_id: str, filename: str, request: Request) -> Response:
    path = _safe_join(config.WORK, f"{job_id}/{filename}")
    if not path.is_file():
        raise HTTPException(404, "not found")
    media_type = (
        "application/vnd.apple.mpegurl" if path.suffix == ".m3u8" else "video/iso.segment"
    )
    # The playlist grows while the download runs, so it must never be cached.
    if path.suffix == ".m3u8":
        return Response(
            path.read_bytes(),
            media_type=media_type,
            headers={"Cache-Control": "no-store"},
        )
    return _range_response(path, request)


@app.get("/thumbs/{filename:path}")
async def thumbs(filename: str, request: Request) -> Response:
    return _range_response(_safe_join(config.THUMBS, filename), request)


# --------------------------------------------------------------------- web


@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    return HTMLResponse((config.WEB / "index.html").read_text())


app.mount("/static", StaticFiles(directory=str(config.WEB)), name="static")


def _open_browser(url: str) -> None:
    """Open the UI in the desktop browser. Best effort; never fatal."""
    with contextlib.suppress(Exception):
        # xdg-open (and `open` on macOS) respects the desktop's default-browser
        # setting, which the stdlib's webbrowser module does not always pick up.
        # Both take a detached child; everywhere else webbrowser is the answer.
        opener = {"darwin": "open"}.get(sys.platform, "xdg-open")
        if sys.platform != "win32" and shutil.which(opener):
            subprocess.Popen(  # noqa: S603
                [opener, url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            return
        webbrowser.open(url)


def main() -> None:
    import uvicorn

    doctor.check()
    config.ensure_dirs()
    url = f"http://{config.HOST}:{config.PORT}"
    # flush: stdout is block-buffered when piped (a launcher, a log file), and
    # this line is the only thing telling you where the server is.
    print(f"nagare -> {url}   (library: {config.ROOT})", flush=True)
    print(f"nagare: authenticating YouTube with {auth.pretty_source()}", flush=True)
    if os.environ.get("NAGARE_OPEN", "1") == "1":
        _open_browser(url)
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="warning")


if __name__ == "__main__":
    main()
