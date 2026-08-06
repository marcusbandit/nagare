"""Channel subscriptions and the combined feed.

Subscriptions live server-side (one json file next to the library) rather than in
the browser, so they survive a cleared profile and mean the same thing however
the app is opened.

The feed comes from each channel's RSS document, not from yt-dlp. RSS is one
small request per channel, carries real publish timestamps (which a flat channel
scrape often does not), and needs no extraction, so a feed over twenty channels
lands in about a second instead of a minute. The tradeoff is that RSS carries no
duration; cards simply omit the badge for feed items.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from typing import Any

from yt_dlp import YoutubeDL

from . import auth, config, ytx

RSS = "https://www.youtube.com/feeds/videos.xml?channel_id="

_NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "yt": "http://www.youtube.com/xml/schemas/2015",
    "media": "http://search.yahoo.com/mrss/",
}

_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)

_feed_cache: dict[str, tuple[float, list[dict]]] = {}
_FEED_TTL = 10 * 60


def _path():
    return config.ROOT / "subscriptions.json"


def load() -> list[dict]:
    try:
        data = json.loads(_path().read_text())
    except (OSError, json.JSONDecodeError):
        return []
    return data if isinstance(data, list) else []


def save(subs: list[dict]) -> None:
    _path().write_text(json.dumps(subs, indent=2))


def _resolve_channel_sync(target: str) -> dict:
    """Turn a channel URL, @handle, UC id or video URL into a channel record."""
    target = target.strip()
    if re.fullmatch(r"UC[\w-]{22}", target):
        url = f"https://www.youtube.com/channel/{target}"
    elif target.startswith("@"):
        url = f"https://www.youtube.com/{target}"
    elif target.startswith(("http://", "https://")):
        url = target
    else:
        url = f"https://www.youtube.com/@{target}"

    opts: Any = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "playlistend": 1,
        "noprogress": True,
        **auth.ydl_opts(),
    }
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False) or {}

    channel_id = info.get("channel_id") or info.get("uploader_id") or ""
    name = info.get("channel") or info.get("uploader") or info.get("title") or ""
    # A video URL resolves to the video; its channel fields still identify the
    # channel, so subscribing straight from something you are watching works.
    if not channel_id:
        entries = info.get("entries") or []
        first = next(iter(entries), None) or {}
        channel_id = first.get("channel_id") or ""
        name = name or first.get("channel") or ""

    if not re.fullmatch(r"UC[\w-]{22}", channel_id or ""):
        raise ValueError("could not find a channel there")

    return {
        "id": channel_id,
        "name": (name or channel_id).strip(),
        "url": f"https://www.youtube.com/channel/{channel_id}",
        "avatar": ytx.pick_avatar(info),
        "followers": info.get("channel_follower_count") or 0,
        "added": time.time(),
    }


def cache_avatar_sync(channel_id: str, url: str) -> str:
    """Keep a local copy so the subscriptions page paints instantly and offline."""
    if not url or not channel_id:
        return ""
    dest = config.THUMBS / f"ch_{channel_id}.jpg"
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


async def add(target: str) -> dict:
    subs = load()
    record = await asyncio.to_thread(_resolve_channel_sync, target)
    record["avatar_file"] = await asyncio.to_thread(
        cache_avatar_sync, record["id"], record.get("avatar", "")
    )
    if any(s["id"] == record["id"] for s in subs):
        return record
    subs.append(record)
    subs.sort(key=lambda s: s["name"].lower())
    save(subs)
    _feed_cache.pop(record["id"], None)
    return record


async def add_channel(channel: dict) -> dict:
    """Subscribe from an already-resolved channel (a search result), so picking
    one out of a list costs no extra round trip to YouTube."""
    subs = load()
    record = {
        "id": channel["id"],
        "name": channel.get("name") or channel["id"],
        "url": channel.get("url") or f"https://www.youtube.com/channel/{channel['id']}",
        "avatar": channel.get("avatar", ""),
        "followers": channel.get("followers", 0),
        "added": time.time(),
    }
    record["avatar_file"] = await asyncio.to_thread(
        cache_avatar_sync, record["id"], record["avatar"]
    )
    if any(s["id"] == record["id"] for s in subs):
        return record
    subs.append(record)
    subs.sort(key=lambda s: s["name"].lower())
    save(subs)
    _feed_cache.pop(record["id"], None)
    return record


def remove(channel_id: str) -> bool:
    subs = load()
    kept = [s for s in subs if s["id"] != channel_id]
    if len(kept) == len(subs):
        return False
    save(kept)
    _feed_cache.pop(channel_id, None)
    return True


def _parse_feed(xml: bytes, channel_name: str) -> list[dict]:
    root = ET.fromstring(xml)
    out = []
    for entry in root.findall("atom:entry", _NS):
        vid = entry.findtext("yt:videoId", "", _NS)
        if not vid:
            continue
        group = entry.find("media:group", _NS)
        thumb = ""
        description = ""
        views = 0
        if group is not None:
            thumb_el = group.find("media:thumbnail", _NS)
            if thumb_el is not None:
                thumb = thumb_el.get("url") or ""
            description = (group.findtext("media:description", "", _NS) or "")[:400]
            stats = group.find("media:community/media:statistics", _NS)
            if stats is not None:
                views = int(stats.get("views") or 0)

        published = entry.findtext("atom:published", "", _NS)
        # 2026-08-04T17:03:11+00:00 -> epoch seconds
        ts = 0.0
        if published:
            try:
                ts = time.mktime(time.strptime(published[:19], "%Y-%m-%dT%H:%M:%S"))
            except ValueError:
                ts = 0.0

        out.append(
            {
                "id": vid,
                "url": f"https://www.youtube.com/watch?v={vid}",
                "title": entry.findtext("atom:title", "", _NS) or "(untitled)",
                "uploader": entry.findtext("atom:author/atom:name", "", _NS) or channel_name,
                "channel_id": entry.findtext("yt:channelId", "", _NS),
                "duration": 0,  # RSS carries none
                "thumbnail": thumb,
                "view_count": views,
                "upload_date": published[:10].replace("-", "") if published else "",
                "published": ts,
                "description": description,
                "is_live": False,
            }
        )
    return out


def _fetch_channel_sync(sub: dict) -> list[dict]:
    hit = _feed_cache.get(sub["id"])
    if hit and time.time() - hit[0] < _FEED_TTL:
        return hit[1]
    req = urllib.request.Request(RSS + sub["id"], headers={"User-Agent": _UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            xml = resp.read()
    except (urllib.error.URLError, TimeoutError):
        return hit[1] if hit else []
    try:
        items = _parse_feed(xml, sub.get("name", ""))
    except ET.ParseError:
        return hit[1] if hit else []
    _feed_cache[sub["id"]] = (time.time(), items)
    return items


async def feed(limit: int = 60, channel_id: str = "") -> dict:
    """Newest uploads across every subscription, merged and sorted."""
    subs = load()
    if channel_id:
        subs = [s for s in subs if s["id"] == channel_id]
    if not subs:
        return {"videos": [], "channels": load()}

    batches = await asyncio.gather(
        *[asyncio.to_thread(_fetch_channel_sync, s) for s in subs],
        return_exceptions=True,
    )
    videos: list[dict] = []
    for batch in batches:
        if isinstance(batch, list):
            videos.extend(batch)

    videos.sort(key=lambda v: v.get("published", 0), reverse=True)
    return {"videos": videos[:limit], "channels": load()}
