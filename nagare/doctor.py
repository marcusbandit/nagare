"""Startup preflight.

Without ffmpeg nothing here works, but the failure would otherwise surface as a
job that dies at 0% with a traceback from deep inside the pipeline. Check once,
up front, and say the actual command to run.
"""

from __future__ import annotations

import shutil
import sys

# Distro/OS -> the one command that installs ffmpeg there. Keyed by the id in
# /etc/os-release so a derivative (mint -> ubuntu, endeavouros -> arch) resolves
# through ID_LIKE rather than falling through to the generic message.
_FFMPEG_INSTALL = {
    "arch": "sudo pacman -S ffmpeg",
    "debian": "sudo apt install ffmpeg",
    "ubuntu": "sudo apt install ffmpeg",
    "fedora": "sudo dnf install ffmpeg",
    "rhel": "sudo dnf install ffmpeg",
    "opensuse": "sudo zypper install ffmpeg",
    "alpine": "sudo apk add ffmpeg",
    "void": "sudo xbps-install -S ffmpeg",
    "gentoo": "sudo emerge media-video/ffmpeg",
    "darwin": "brew install ffmpeg",
    "win32": "winget install Gyan.FFmpeg",
}


def _os_ids() -> list[str]:
    """This machine's os-release ID plus its ID_LIKE ancestors, most specific first."""
    if sys.platform in ("darwin", "win32"):
        return [sys.platform]
    ids: list[str] = []
    try:
        with open("/etc/os-release", encoding="utf-8") as fh:
            fields = dict(
                line.rstrip("\n").split("=", 1) for line in fh if "=" in line and not line.startswith("#")
            )
    except OSError:
        return ids
    for key in ("ID", "ID_LIKE"):
        for value in fields.get(key, "").strip('"').split():
            if value not in ids:
                ids.append(value)
    return ids


def install_hint(tool: str = "ffmpeg") -> str:
    for os_id in _os_ids():
        if os_id in _FFMPEG_INSTALL:
            return _FFMPEG_INSTALL[os_id].replace("ffmpeg", tool)
    return f"install {tool} with your package manager"


def missing_tools() -> list[str]:
    """Required external binaries that are not on PATH."""
    return [tool for tool in ("ffmpeg", "ffprobe") if shutil.which(tool) is None]


def check(exit_on_failure: bool = True) -> list[str]:
    """Report missing requirements. Returns the list; exits non-zero if any."""
    missing = missing_tools()
    if not missing:
        return missing
    names = " and ".join(missing)
    print(
        f"nagare: {names} not found on PATH.\n"
        f"\n"
        f"  ffmpeg does the muxing that makes a video watchable while it downloads,\n"
        f"  so nagare cannot run without it. Both binaries ship in the same package:\n"
        f"\n"
        f"      {install_hint()}\n",
        file=sys.stderr,
    )
    if exit_on_failure:
        raise SystemExit(1)
    return missing
