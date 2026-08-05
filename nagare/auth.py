"""YouTube authentication for yt-dlp, via your browser's cookies.

YouTube guards its *player* endpoint with a "Sign in to confirm you're not a bot"
check. The requests that need the player -- downloads, full metadata, comments,
subtitles -- get blocked when they are anonymous, and a single download makes a
burst of them, which is why starting a download can knock out everything else
while search (which only touches the light listing endpoints) keeps working.

The fix is to sign the requests in. We do not store a copy of your login: yt-dlp
reads the cookies straight out of your browser at call time, so the only thing
you have to do is be signed in to YouTube in that browser. When you are not,
`recover()` opens it for you.

Source resolution, most specific first:

  NAGARE_COOKIES_FILE          -> an exported Netscape cookies.txt (headless/servers)
  NAGARE_COOKIES_FROM_BROWSER  -> "firefox", "chrome:Default", "firefox:/path", ...
  (otherwise)                  -> your OS default browser, auto-detected

Firefox forks (Zen, LibreWolf, Waterfox) keep a Firefox-format cookies.sqlite, so
they are read through yt-dlp's `firefox` extractor pointed at their profile path.
"""

from __future__ import annotations

import configparser
import contextlib
import os
import plistlib
import shutil
import subprocess
import sys
import time
import webbrowser
from functools import lru_cache
from pathlib import Path

# Signing in here sets exactly the cookies we then read back.
SIGNIN_URL = "https://www.youtube.com/"

# macOS bundle ids are stored lowercased in LaunchServices; keep these lowercase.
# Firefox forks -> the folder under ~/Library/Application Support that holds their
# profiles.ini. They are all read through the `firefox` extractor.
_FIREFOX_FORKS = {
    "org.mozilla.firefox": ("firefox", "Firefox"),
    "org.mozilla.firefoxdeveloperedition": ("firefox", "Firefox"),
    "org.mozilla.nightly": ("firefox", "Firefox"),
    "app.zen-browser.zen": ("zen", "zen"),
    "io.gitlab.librewolf-community": ("librewolf", "librewolf"),
    "net.waterfox.waterfox": ("waterfox", "Waterfox"),
}
# Chromium family: yt-dlp already knows their default cookie path, so no profile
# path is needed.
_CHROMIUM = {
    "com.google.chrome": "chrome",
    "com.google.chrome.canary": "chrome",
    "com.brave.browser": "brave",
    "com.microsoft.edgemac": "edge",
    "com.operasoftware.opera": "opera",
    "com.vivaldi.vivaldi": "vivaldi",
    "com.apple.safari": "safari",
}
_PRETTY = {
    "firefox": "Firefox", "zen": "Zen", "librewolf": "LibreWolf", "waterfox": "Waterfox",
    "chrome": "Chrome", "brave": "Brave", "edge": "Edge", "opera": "Opera",
    "vivaldi": "Vivaldi", "safari": "Safari",
}


# --------------------------------------------------------------- browser detect


def default_browser_bundle_id() -> str | None:
    """The bundle id registered to open https, i.e. the default browser (macOS)."""
    if sys.platform != "darwin":
        return None
    plist = (
        Path.home()
        / "Library/Preferences/com.apple.LaunchServices"
        / "com.apple.launchservices.secure.plist"
    )
    try:
        with plist.open("rb") as fh:
            data = plistlib.load(fh)
    except (OSError, plistlib.InvalidFileException, ValueError):
        return None
    for handler in data.get("LSHandlers", []):
        if handler.get("LSHandlerURLScheme") == "https":
            return (handler.get("LSHandlerRoleAll") or handler.get("LSHandlerRoleViewer") or "")
    return "com.apple.safari"  # nothing registered means the system default, Safari


def _firefox_profile(base: Path) -> str | None:
    """Path of the profile a Firefox-family browser is actually using.

    Modern Firefox pins one profile per install in an ``[Install*]`` section; that
    wins over the legacy ``Default=1`` flag (Zen, for one, ships both and only the
    install one has cookies). Fall back to the flagged profile, then to whichever
    profile actually has a cookie db.
    """
    ini = base / "profiles.ini"
    if not ini.exists():
        return None
    parser = configparser.ConfigParser()
    with contextlib.suppress(configparser.Error):
        parser.read([str(ini), str(base / "installs.ini")])

    install_defaults: list[Path] = []
    flagged: list[Path] = []
    everything: list[Path] = []
    for section in parser.sections():
        if section.startswith("Install") and parser.has_option(section, "Default"):
            install_defaults.append(base / parser.get(section, "Default"))
        elif section.startswith("Profile") and parser.has_option(section, "Path"):
            rel = parser.get(section, "IsRelative", fallback="1") == "1"
            path = parser.get(section, "Path")
            full = (base / path) if rel else Path(path)
            everything.append(full)
            if parser.get(section, "Default", fallback="0") == "1":
                flagged.append(full)

    ordered = install_defaults + flagged + everything
    for profile in ordered:  # a profile with cookies beats one merely marked default
        if (profile / "cookies.sqlite").exists():
            return str(profile)
    for profile in ordered:
        if profile.exists():
            return str(profile)
    return None


@lru_cache(maxsize=1)
def browser_spec() -> tuple[str, str | None, None, None] | None:
    """(browser, profile, keyring, container) for yt-dlp, or None if we have none.

    Shaped for both ``cookiesfrombrowser`` (the tuple) and ``--cookies-from-browser``
    (name[:profile]).
    """
    env = os.environ.get("NAGARE_COOKIES_FROM_BROWSER", "").strip()
    if env:
        name, _, profile = env.partition(":")
        return (name.strip().lower(), profile.strip() or None, None, None)

    bundle = (default_browser_bundle_id() or "").lower()
    if bundle in _FIREFOX_FORKS:
        _, subdir = _FIREFOX_FORKS[bundle]
        profile = _firefox_profile(Path.home() / "Library/Application Support" / subdir)
        return ("firefox", profile, None, None) if profile else None
    if bundle in _CHROMIUM:
        return (_CHROMIUM[bundle], None, None, None)
    return None


def _fork_name() -> str:
    """Best label for the detected default browser (so 'Zen', not 'Firefox')."""
    bundle = (default_browser_bundle_id() or "").lower()
    if bundle in _FIREFOX_FORKS:
        return _PRETTY.get(_FIREFOX_FORKS[bundle][0], "your browser")
    if bundle in _CHROMIUM:
        return _PRETTY.get(_CHROMIUM[bundle], "your browser")
    return "your browser"


def pretty_source() -> str:
    """One-liner naming where cookies come from, for logs and status."""
    cookie_file = os.environ.get("NAGARE_COOKIES_FILE", "").strip()
    if cookie_file:
        return f"the cookies file at {cookie_file}"
    if browser_spec():
        return f"{_fork_name()}"
    bundle = default_browser_bundle_id()
    return f"no supported browser (default is {bundle or 'unknown'})"


# ------------------------------------------------------------------- yt-dlp glue


def ydl_opts() -> dict:
    """Cookie options to merge into a `YoutubeDL(...)` call. Empty when unconfigured."""
    cookie_file = os.environ.get("NAGARE_COOKIES_FILE", "").strip()
    if cookie_file:
        return {"cookiefile": cookie_file}
    spec = browser_spec()
    return {"cookiesfrombrowser": spec} if spec else {}


def cli_args() -> list[str]:
    """The same, as flags for a `python -m yt_dlp` subprocess."""
    cookie_file = os.environ.get("NAGARE_COOKIES_FILE", "").strip()
    if cookie_file:
        return ["--cookies", cookie_file]
    spec = browser_spec()
    if not spec:
        return []
    name, profile = spec[0], spec[1]
    return ["--cookies-from-browser", f"{name}:{profile}" if profile else name]


class Recorder:
    """A yt-dlp logger that just remembers messages.

    With ``ignoreerrors`` on, yt-dlp swallows the bot-check error and returns None
    instead of raising, so the only way to know it happened is to watch the log.
    """

    def __init__(self) -> None:
        self.messages: list[str] = []

    def debug(self, msg: str) -> None:  # noqa: D102 - yt-dlp logger protocol
        pass

    def info(self, msg: str) -> None:  # noqa: D102
        pass

    def warning(self, msg: str) -> None:  # noqa: D102
        self.messages.append(msg)

    def error(self, msg: str) -> None:  # noqa: D102
        self.messages.append(msg)

    def saw_bot_check(self) -> bool:
        return any(is_bot_check(m) for m in self.messages)


def is_bot_check(message: str) -> bool:
    """True if `message` is YouTube's 'confirm you're not a bot' wall."""
    m = (message or "").lower()
    return "not a bot" in m or "sign in to confirm" in m


# -------------------------------------------------------------------- sign in


_last_open = 0.0
_OPEN_COOLDOWN = 45.0  # a download can fail many streams at once; open one tab, not ten


def open_signin(force: bool = False) -> bool:
    """Open the default browser at YouTube's sign-in. Throttled unless forced."""
    global _last_open
    now = time.monotonic()
    if not force and now - _last_open < _OPEN_COOLDOWN:
        return False
    _last_open = now
    try:
        if sys.platform == "darwin":
            subprocess.Popen(  # noqa: S603, S607 - local, user initiated
                ["open", SIGNIN_URL],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
            )
        elif sys.platform != "win32" and shutil.which("xdg-open"):
            subprocess.Popen(  # noqa: S603, S607
                ["xdg-open", SIGNIN_URL],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
            )
        else:
            webbrowser.open(SIGNIN_URL)
        return True
    except Exception:  # noqa: BLE001 - opening a browser must never be fatal
        with contextlib.suppress(Exception):
            webbrowser.open(SIGNIN_URL)
        return False


def recover(message: str) -> str:
    """If `message` is the bot wall, open sign-in and return a message that says so.

    Anything else is returned untouched, so callers can wrap every yt-dlp error
    with this and only the relevant one changes.
    """
    if not is_bot_check(message):
        return message
    if not browser_spec() and not os.environ.get("NAGARE_COOKIES_FILE", "").strip():
        bundle = default_browser_bundle_id() or "your default browser"
        return (
            "YouTube wants you to sign in to confirm you're not a bot, but nagare "
            f"can't read cookies from {bundle}. Make Firefox/Chrome your default "
            "browser, or set NAGARE_COOKIES_FILE to an exported cookies.txt."
        )
    opened = open_signin()
    where = pretty_source()
    tail = (
        f"I opened {where} — sign in to YouTube there, then try again."
        if opened
        else f"Sign in to YouTube in {where}, then try again."
    )
    return f"YouTube asked you to confirm you're not a bot. {tail}"


# ---------------------------------------------------------------------- status


def signed_in() -> bool | None:
    """Best-effort: are YouTube auth cookies visible in the source? None if unknown."""
    if os.environ.get("NAGARE_COOKIES_FILE", "").strip():
        return None  # we do not parse the file just to answer this
    spec = browser_spec()
    if not spec:
        return None
    try:
        from yt_dlp.cookies import extract_cookies_from_browser

        jar = extract_cookies_from_browser(spec[0], profile=spec[1])
    except Exception:  # noqa: BLE001
        return None
    auth_cookies = {"SID", "__Secure-3PSID", "SAPISID", "LOGIN_INFO", "__Secure-1PSID"}
    present = {c.name for c in jar if c.domain and ("google.com" in c.domain or "youtube.com" in c.domain)}
    return bool(auth_cookies & present)


def status() -> dict:
    """What the app will use to authenticate, for the settings UI and the log line."""
    cookie_file = os.environ.get("NAGARE_COOKIES_FILE", "").strip()
    spec = browser_spec()
    return {
        "source": "file" if cookie_file else ("browser" if spec else "none"),
        "browser": _fork_name() if spec else "",
        "cookie_file": cookie_file,
        "default_browser": default_browser_bundle_id() or "",
        "supported": bool(cookie_file or spec),
        "signed_in": signed_in(),
        "description": pretty_source(),
    }
