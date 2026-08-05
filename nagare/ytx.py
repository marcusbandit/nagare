"""Thin wrapper over the yt-dlp python API for search and metadata.

Downloads do not go through here: they run as a subprocess pipeline in jobs.py so
they can be killed cleanly and so ffmpeg can split the stream into live HLS.
"""

from __future__ import annotations

import asyncio
import itertools
import urllib.request
from typing import Any

from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

from . import config

_BASE_OPTS: dict[str, Any] = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "ignoreerrors": True,
    "noprogress": True,
}

_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)


def _best_thumb(entry: dict) -> str:
    """Pick a reasonably sized thumbnail, preferring ~medium width."""
    if entry.get("thumbnail"):
        return entry["thumbnail"]
    thumbs = entry.get("thumbnails") or []
    scored = [t for t in thumbs if t.get("url")]
    if not scored:
        return ""
    # Prefer the widest thumbnail that is still <= 640px, else the narrowest one.
    under = [t for t in scored if (t.get("width") or 0) <= 640]
    if under:
        return max(under, key=lambda t: t.get("width") or 0)["url"]
    return min(scored, key=lambda t: t.get("width") or 10**9)["url"]


def normalise(entry: dict) -> dict:
    """Flatten a yt-dlp info dict into the shape the frontend consumes."""
    vid = entry.get("id") or ""
    url = entry.get("webpage_url") or entry.get("url") or ""
    if url and not url.startswith("http") and vid:
        url = f"https://www.youtube.com/watch?v={vid}"
    return {
        "id": vid,
        "url": url,
        "title": entry.get("title") or "(untitled)",
        "uploader": entry.get("uploader") or entry.get("channel") or "",
        "duration": entry.get("duration") or 0,
        "thumbnail": _best_thumb(entry),
        "view_count": entry.get("view_count") or 0,
        "upload_date": entry.get("upload_date") or "",
        "is_live": bool(entry.get("is_live")),
        "description": (entry.get("description") or "")[:400],
    }


def _search_sync(query: str, limit: int) -> list[dict]:
    opts = {**_BASE_OPTS, "extract_flat": "in_playlist"}
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
    entries = (info or {}).get("entries") or []
    return [normalise(e) for e in entries if e]


def _resolve_sync(url: str) -> dict:
    """Resolve a URL to either a single video or a playlist of videos."""
    opts = {**_BASE_OPTS, "extract_flat": "in_playlist"}
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if not info:
        raise ValueError("nothing found at that URL")
    if info.get("_type") == "playlist" or info.get("entries"):
        entries = [normalise(e) for e in (info.get("entries") or []) if e]
        return {
            "type": "playlist",
            "title": info.get("title") or "playlist",
            "entries": entries,
        }
    return {"type": "video", "title": info.get("title") or "", "entries": [normalise(info)]}


def _search_filtered_sync(url: str, limit: int) -> list[dict]:
    opts = {**_BASE_OPTS, "extract_flat": "in_playlist", "playlistend": limit}
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    # extract_flat can hand back a lazy generator, which does not slice.
    entries = itertools.islice((info or {}).get("entries") or [], limit)
    out = []
    for e in entries:
        if not e:
            continue
        normalised = normalise(e)
        # A results page also yields channels and playlists; keep real videos.
        if normalised["id"] and len(normalised["id"]) == 11:
            out.append(normalised)
    return out


async def search(query: str, limit: int = 24) -> list[dict]:
    return await asyncio.to_thread(_search_sync, query, limit)


async def search_filtered(url: str, limit: int = 24) -> list[dict]:
    return await asyncio.to_thread(_search_filtered_sync, url, limit)


async def resolve(url: str) -> dict:
    try:
        return await asyncio.to_thread(_resolve_sync, url)
    except DownloadError as exc:
        raise ValueError(str(exc).replace("ERROR: ", "")) from exc


def _cache_thumb_sync(video_id: str, url: str) -> str:
    if not url or not video_id:
        return ""
    dest = config.THUMBS / f"{video_id}.jpg"
    if dest.exists() and dest.stat().st_size > 0:
        return dest.name
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _UA})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read()
        if data:
            dest.write_bytes(data)
            return dest.name
    except Exception:
        return ""
    return ""


async def cache_thumb(video_id: str, url: str) -> str:
    """Copy the poster locally so the library still has art if YouTube 404s later."""
    return await asyncio.to_thread(_cache_thumb_sync, video_id, url)
