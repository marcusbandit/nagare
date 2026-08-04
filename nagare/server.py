"""FastAPI app: search, queue, live progress over SSE, and byte-range media serving."""

from __future__ import annotations

import asyncio
import contextlib
import json
import mimetypes
import os
import subprocess
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import config, ytx
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
async def api_search(q: str, limit: int = 24) -> JSONResponse:
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
        results = await ytx.search(q, min(max(limit, 1), 50))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc
    return JSONResponse({"results": results, "kind": "search", "title": q})


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


def main() -> None:
    import uvicorn

    config.ensure_dirs()
    url = f"http://{config.HOST}:{config.PORT}"
    print(f"nagare -> {url}   (library: {config.ROOT})")
    if os.environ.get("NAGARE_OPEN", "1") == "1":
        with contextlib.suppress(Exception):
            subprocess.Popen(  # noqa: S603
                ["xdg-open", url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="warning")


if __name__ == "__main__":
    main()
