"""Thin wrapper over the yt-dlp python API for search and metadata.

Downloads do not go through here: they run as a subprocess pipeline in jobs.py so
they can be killed cleanly and so ffmpeg can split the stream into live HLS.
"""

from __future__ import annotations

import asyncio
import re
import urllib.request
from typing import Any

from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

from . import auth, config

_BASE_OPTS: dict[str, Any] = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "ignoreerrors": True,
    "noprogress": True,
    # Sign the player requests in so YouTube does not answer them with its
    # "confirm you're not a bot" wall. Empty when no browser/file is configured.
    **auth.ydl_opts(),
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
        "channel_id": entry.get("channel_id") or "",
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
    recorder = auth.Recorder()
    with YoutubeDL({**opts, "logger": recorder}) as ydl:
        info = ydl.extract_info(url, download=False)
    if not info:
        # ignoreerrors turns the bot wall into a silent None; the log is the only
        # place it shows, so check there before calling it a generic miss.
        if recorder.saw_bot_check():
            raise ValueError(auth.recover("sign in to confirm you're not a bot"))
        raise ValueError("nothing found at that URL")
    if info.get("_type") == "playlist" or info.get("entries"):
        entries = [normalise(e) for e in (info.get("entries") or []) if e]
        return {
            "type": "playlist",
            "title": info.get("title") or "playlist",
            "entries": entries,
        }
    return {"type": "video", "title": info.get("title") or "", "entries": [normalise(info)]}


def _entries(info, limit: int) -> list:
    """Entries can be a list, a generator or yt-dlp's PagedList. Only a list is
    safe to slice, and playlistend already bounds how much is fetched."""
    raw = (info or {}).get("entries") or []
    if not isinstance(raw, list):
        raw = list(raw)
    return raw[:limit]


def _search_filtered_sync(url: str, limit: int) -> list[dict]:
    opts = {**_BASE_OPTS, "extract_flat": "in_playlist", "playlistend": limit}
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    out = []
    for e in _entries(info, limit):
        if not e:
            continue
        normalised = normalise(e)
        # A results page also yields channels and playlists; keep real videos.
        if normalised["id"] and len(normalised["id"]) == 11:
            out.append(normalised)
    return out


def _abs_url(url: str) -> str:
    """YouTube hands back protocol-relative avatar urls (//yt3.ggpht.com/...)."""
    if url.startswith("//"):
        return f"https:{url}"
    return url


def pick_avatar(entry: dict) -> str:
    """The biggest square thumbnail is the channel avatar; the wide ones are banners."""
    thumbs = [t for t in (entry.get("thumbnails") or []) if t.get("url")]
    if not thumbs:
        return ""
    square = [t for t in thumbs if t.get("width") and t.get("width") == t.get("height")]
    pool = square or thumbs
    return _abs_url(max(pool, key=lambda t: t.get("width") or 0)["url"])


def normalise_channel(entry: dict) -> dict:
    channel_id = entry.get("channel_id") or entry.get("id") or ""
    return {
        "id": channel_id,
        "name": entry.get("channel") or entry.get("title") or entry.get("uploader") or "",
        "url": entry.get("url") or f"https://www.youtube.com/channel/{channel_id}",
        "avatar": pick_avatar(entry),
        "followers": entry.get("channel_follower_count") or 0,
        "description": (entry.get("description") or "")[:200],
    }


def _search_channels_sync(url: str, limit: int) -> list[dict]:
    opts = {**_BASE_OPTS, "extract_flat": "in_playlist", "playlistend": limit}
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    out = []
    for e in _entries(info, limit):
        if not e:
            continue
        channel = normalise_channel(e)
        if re.fullmatch(r"UC[\w-]{22}", channel["id"] or ""):
            out.append(channel)
    return out


async def search_channels(url: str, limit: int = 12) -> list[dict]:
    return await asyncio.to_thread(_search_channels_sync, url, limit)


def _channel_sync(channel_id: str, limit: int) -> dict:
    url = f"https://www.youtube.com/channel/{channel_id}/videos"
    opts = {**_BASE_OPTS, "extract_flat": "in_playlist", "playlistend": limit}
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if not info:
        raise ValueError("channel not found")
    videos = [normalise(e) for e in _entries(info, limit) if e]
    return {
        "channel": {
            "id": info.get("channel_id") or channel_id,
            "name": info.get("channel") or info.get("uploader") or info.get("title") or "",
            "url": f"https://www.youtube.com/channel/{channel_id}",
            "avatar": pick_avatar(info),
            "followers": info.get("channel_follower_count") or 0,
            "description": (info.get("description") or "")[:600],
        },
        "videos": [v for v in videos if v["id"]],
    }


def _video_full_sync(video_id: str) -> dict:
    """Single video, with the description uncropped (cards crop it, the watch
    page should not)."""
    opts = {**_BASE_OPTS, "extract_flat": False}
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(
            f"https://www.youtube.com/watch?v={video_id}", download=False
        )
    info = info or {}
    out = normalise(info)
    out["description"] = info.get("description") or ""
    out["like_count"] = info.get("like_count") or 0
    out["channel_url"] = info.get("channel_url") or ""
    out["channel_followers"] = info.get("channel_follower_count") or 0
    return out


async def video_full(video_id: str) -> dict:
    return await asyncio.to_thread(_video_full_sync, video_id)


async def channel(channel_id: str, limit: int = 30) -> dict:
    return await asyncio.to_thread(_channel_sync, channel_id, limit)


async def search(query: str, limit: int = 24) -> list[dict]:
    return await asyncio.to_thread(_search_sync, query, limit)


async def search_filtered(url: str, limit: int = 24) -> list[dict]:
    return await asyncio.to_thread(_search_filtered_sync, url, limit)


async def resolve(url: str) -> dict:
    try:
        return await asyncio.to_thread(_resolve_sync, url)
    except DownloadError as exc:
        raise ValueError(auth.recover(str(exc).replace("ERROR: ", ""))) from exc


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
