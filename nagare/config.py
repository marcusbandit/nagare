"""Paths, ports and tunables. Everything configurable via NAGARE_* env vars."""

import os
import shutil
from pathlib import Path

ROOT = Path(os.environ.get("NAGARE_HOME", Path.home() / "Videos" / "nagare")).expanduser()

MEDIA = ROOT / "media"    # finished, browser-playable mp4/m4a
WORK = ROOT / "work"      # per-job live HLS while downloading
META = ROOT / "meta"      # one json per job, the library index
THUMBS = ROOT / "thumbs"  # cached poster images

WEB = Path(__file__).resolve().parent.parent / "web"

HOST = os.environ.get("NAGARE_HOST", "127.0.0.1")
PORT = int(os.environ.get("NAGARE_PORT", "8737"))
MAX_CONCURRENT = int(os.environ.get("NAGARE_CONCURRENCY", "2"))

# Seconds of media per HLS segment. Smaller means you can start watching sooner
# but costs more files and more playlist churn.
SEGMENT_SECONDS = int(os.environ.get("NAGARE_SEGMENT_SECONDS", "4"))

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"
MPV = shutil.which("mpv")

# Format selectors. The h264 ladder is the default because a browser can always
# decode it; "best" lets YouTube hand back AV1/VP9 + Opus, which Chrome plays but
# other players may not.
QUALITIES = {
    "2160": {
        "label": "2160p",
        "fmt": "bv*[height<=2160]+ba/b[height<=2160]/b",
        "audio_only": False,
    },
    "1440": {
        "label": "1440p",
        "fmt": "bv*[height<=1440]+ba/b[height<=1440]/b",
        "audio_only": False,
    },
    "1080": {
        "label": "1080p",
        "fmt": (
            "bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/"
            "bv*[height<=1080]+ba/b[height<=1080]/b"
        ),
        "audio_only": False,
    },
    "720": {
        "label": "720p",
        "fmt": (
            "bv*[height<=720][vcodec^=avc1]+ba[acodec^=mp4a]/"
            "bv*[height<=720]+ba/b[height<=720]/b"
        ),
        "audio_only": False,
    },
    "best": {
        "label": "best",
        "fmt": "bv*+ba/b",
        "audio_only": False,
    },
    "audio": {
        "label": "audio",
        "fmt": "ba[acodec^=mp4a]/ba/b",
        "audio_only": True,
    },
}
DEFAULT_QUALITY = os.environ.get("NAGARE_QUALITY", "1080")


def ensure_dirs() -> None:
    for d in (MEDIA, WORK, META, THUMBS):
        d.mkdir(parents=True, exist_ok=True)
