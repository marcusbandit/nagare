"""SponsorBlock segments and YouTube comments.

Both are slow enough and optional enough that they are fetched on demand from the
watch page rather than as part of resolving a video, and both are cached in memory
for the life of the process so re-opening a video is instant.
"""

from __future__ import annotations

import asyncio
import base64
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from yt_dlp import YoutubeDL

SPONSORBLOCK_API = "https://sponsor.ajay.app/api/skipSegments"

# The categories worth acting on, in the order they should win when they overlap.
SPONSOR_CATEGORIES = [
    "sponsor",
    "selfpromo",
    "interaction",
    "intro",
    "outro",
    "preview",
    "music_offtopic",
    "filler",
]

CATEGORY_LABELS = {
    "sponsor": "sponsor",
    "selfpromo": "self promo",
    "interaction": "interaction reminder",
    "intro": "intro",
    "outro": "outro",
    "preview": "recap",
    "music_offtopic": "non-music",
    "filler": "filler",
}

_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)

_sponsor_cache: dict[str, tuple[float, list[dict]]] = {}
_comment_cache: dict[str, tuple[float, dict]] = {}
_CACHE_TTL = 60 * 60


def _sponsor_sync(video_id: str) -> list[dict]:
    query = urllib.parse.urlencode(
        {"videoID": video_id, "categories": json.dumps(SPONSOR_CATEGORIES)}
    )
    req = urllib.request.Request(f"{SPONSORBLOCK_API}?{query}", headers={"User-Agent": _UA})
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            raw = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        if exc.code == 404:  # no submissions for this video, which is normal
            return []
        raise
    segments = []
    for entry in raw:
        start, end = (entry.get("segment") or [0, 0])[:2]
        if end <= start:
            continue
        category = entry.get("category") or "sponsor"
        segments.append(
            {
                "uuid": entry.get("UUID", ""),
                "category": category,
                "label": CATEGORY_LABELS.get(category, category),
                "start": float(start),
                "end": float(end),
                "action": entry.get("actionType") or "skip",
                "locked": bool(entry.get("locked")),
                "votes": entry.get("votes", 0),
            }
        )
    segments.sort(key=lambda s: s["start"])
    return segments


async def sponsor_segments(video_id: str) -> list[dict]:
    hit = _sponsor_cache.get(video_id)
    if hit and time.time() - hit[0] < _CACHE_TTL:
        return hit[1]
    try:
        segments = await asyncio.to_thread(_sponsor_sync, video_id)
    except Exception:
        return []
    _sponsor_cache[video_id] = (time.time(), segments)
    return segments


RYD_API = "https://returnyoutubedislikeapi.com/votes"

_votes_cache: dict[str, tuple[float, dict]] = {}


def _votes_sync(video_id: str) -> dict:
    req = urllib.request.Request(
        f"{RYD_API}?videoId={urllib.parse.quote(video_id)}", headers={"User-Agent": _UA}
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode())
    return {
        "likes": data.get("likes", 0),
        "dislikes": data.get("dislikes", 0),
        "rating": round(data.get("rating", 0), 2),
        "views": data.get("viewCount", 0),
    }


async def votes(video_id: str) -> dict:
    """Dislike counts, via ReturnYouTubeDislike. Empty dict when unavailable."""
    hit = _votes_cache.get(video_id)
    if hit and time.time() - hit[0] < _CACHE_TTL:
        return hit[1]
    try:
        data = await asyncio.to_thread(_votes_sync, video_id)
    except Exception:
        return {}
    _votes_cache[video_id] = (time.time(), data)
    return data


# YouTube encodes its search filters into the `sp` query parameter as a small
# base64url protobuf. Building it properly means the filters compose, instead of
# pasting the handful of magic constants that only work one at a time.
_SORT = {"relevance": 0, "rating": 1, "date": 2, "views": 3}
_DATE = {"hour": 1, "today": 2, "week": 3, "month": 4, "year": 5}
_DURATION = {"short": 1, "long": 2, "medium": 3}


def _varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def search_params(sort: str = "relevance", date: str = "any", duration: str = "any") -> str:
    """Return the `sp` value for these filters, or "" when nothing is set."""
    sub = bytearray()
    if date in _DATE:
        sub += b"\x08" + _varint(_DATE[date])
    sub += b"\x10\x01"  # type = video, so channels and playlists stay out
    if duration in _DURATION:
        sub += b"\x18" + _varint(_DURATION[duration])

    body = bytearray()
    if sort in _SORT and _SORT[sort]:
        body += b"\x08" + _varint(_SORT[sort])
    body += b"\x12" + _varint(len(sub)) + bytes(sub)

    return base64.urlsafe_b64encode(bytes(body)).decode().rstrip("=")


def search_url(query: str, sort: str, date: str, duration: str) -> str:
    sp = search_params(sort, date, duration)
    q = urllib.parse.urlencode({"search_query": query})
    return f"https://www.youtube.com/results?{q}&sp={sp}"


def _comments_sync(video_id: str, limit: int) -> dict:
    opts: Any = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "getcomments": True,
        "noprogress": True,
        # max_comments = [total, top-level, replies, replies-per-thread]
        "extractor_args": {
            "youtube": {"max_comments": [str(limit), "all", str(limit), "8"]}
        },
    }
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    info = info or {}
    raw = info.get("comments") or []

    comments = []
    for c in raw:
        comments.append(
            {
                "id": c.get("id", ""),
                "parent": c.get("parent", "root"),
                "author": c.get("author") or "",
                "author_thumbnail": c.get("author_thumbnail") or "",
                "author_is_uploader": bool(c.get("author_is_uploader")),
                "is_pinned": bool(c.get("is_pinned")),
                "is_favorited": bool(c.get("is_favorited")),
                "text": c.get("text") or "",
                "like_count": c.get("like_count") or 0,
                "time_text": c.get("_time_text") or c.get("time_text") or "",
                "timestamp": c.get("timestamp") or 0,
            }
        )

    # Thread them: yt-dlp returns a flat list where a reply's parent is the
    # top-level comment's id.
    by_id = {c["id"]: c for c in comments}
    roots: list[dict] = []
    for c in comments:
        c["replies"] = []
    for c in comments:
        parent = c.get("parent")
        if parent and parent != "root" and parent in by_id:
            by_id[parent]["replies"].append(c)
        else:
            roots.append(c)
    roots.sort(key=lambda c: (not c["is_pinned"], -(c["like_count"] or 0)))

    return {
        "count": info.get("comment_count") or len(comments),
        "fetched": len(comments),
        "comments": roots,
    }


async def comments(video_id: str, limit: int = 120) -> dict:
    key = f"{video_id}:{limit}"
    hit = _comment_cache.get(key)
    if hit and time.time() - hit[0] < _CACHE_TTL:
        return hit[1]
    try:
        data = await asyncio.to_thread(_comments_sync, video_id, limit)
    except Exception as exc:  # noqa: BLE001
        return {"count": 0, "fetched": 0, "comments": [], "error": str(exc)[:200]}
    _comment_cache[key] = (time.time(), data)
    return data
