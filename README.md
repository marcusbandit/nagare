# nagare

A local YouTube frontend built on yt-dlp. Search, queue, and **watch a video while
it is still downloading**.

Nothing is uploaded anywhere. The server binds to `127.0.0.1`, the library is a
folder of plain mp4 files, and there is no account, no telemetry, and no database.

## Install

You need two things: **ffmpeg** (does the muxing) and **[uv](https://docs.astral.sh/uv/)**
(runs the Python side and fetches its own interpreter, so no system Python setup).

```sh
# 1. ffmpeg
sudo pacman -S ffmpeg        # Arch
sudo apt install ffmpeg      # Debian / Ubuntu
sudo dnf install ffmpeg      # Fedora
brew install ffmpeg          # macOS

# 2. uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# 3. nagare
git clone https://github.com/marcusbandit/nagare
cd nagare
uv run nagare
```

That last command creates the environment, installs the dependencies, starts the
server and opens your browser. It takes a few seconds the first time and is
instant afterwards. There is no build step and no separate install command.

If something is missing, nagare says which binary and the exact command for your
distro instead of failing later mid-download.

### Optional: the desktop app

Same UI in its own window, with hardware video decode, instead of a browser tab.
Needs [bun](https://bun.sh) or npm for the Electron shell:

```sh
./nagare-app
```

The first run installs Electron (~100 MB) and every run after that starts
straight up. Symlink it onto your PATH if you want it as a command:

```sh
ln -s "$PWD/nagare-app" ~/.local/bin/nagare-app
```

### Optional: install as a command

```sh
uv tool install .        # provides `nagare` on your PATH, no checkout needed
```

## Using it

Search in the box, click a result to queue it. It becomes watchable within a few
seconds while the rest downloads in the background. Finished videos live in
`~/Videos/nagare/media` as ordinary mp4 files you can move, copy, or play in
anything.

| Env var              | Default             | What                                  |
| -------------------- | ------------------- | ------------------------------------- |
| `NAGARE_HOME`        | `~/Videos/nagare`   | Where the library lives                |
| `NAGARE_PORT`        | `8737`              | Server port                            |
| `NAGARE_HOST`        | `127.0.0.1`         | Bind address                           |
| `NAGARE_QUALITY`     | `1080`              | `2160`/`1440`/`1080`/`720`/`best`/`audio` |
| `NAGARE_CONCURRENCY` | `2`                 | Simultaneous downloads                 |
| `NAGARE_OPEN`        | `1`                 | Open a browser on start; `0` to skip   |
| `NAGARE_COOKIES_FROM_BROWSER` | (auto) | Browser to read YouTube cookies from, e.g. `firefox`, `chrome:Default`. Overrides the auto-detected default browser |
| `NAGARE_COOKIES_FILE` | (unset)            | Path to an exported `cookies.txt`; use on a headless/remote box where no browser profile is reachable |

```sh
NAGARE_QUALITY=720 NAGARE_HOME=/mnt/media/yt uv run nagare
```

Requires Python 3.11+, though uv handles that for you.

## Troubleshooting

**`ffmpeg not found`** - install it (see above); `ffmpeg` and `ffprobe` both come
from the same package and both are needed.

**`address already in use`** - something else holds 8737. Use
`NAGARE_PORT=9000 uv run nagare`.

**A download fails or stalls at 0%** - usually a stale yt-dlp against a YouTube
change. `uv lock --upgrade-package yt-dlp && uv run nagare`.

**"Sign in to confirm you're not a bot"** - YouTube distrusts anonymous requests
to its player, which is what downloads, comments and metadata use (search does
not, which is why search keeps working). nagare answers this by signing the
requests in with your browser's YouTube cookies: it auto-detects your default
browser (Firefox, Chrome, Brave, Edge, Safari, Vivaldi, Opera, or a Firefox fork
like Zen/LibreWolf) and reads the login from it, so **just stay signed in to
YouTube in that browser**. If a login lapses, nagare reopens YouTube for you and
says so; sign back in and retry. Point it elsewhere with `NAGARE_COOKIES_FROM_BROWSER`
or `NAGARE_COOKIES_FILE` (see the table above) — the latter is the way on a
headless server.

**Video plays but has no sound, or vice versa** - the `best` ladder can hand back
codecs your browser will not decode. Use the default `1080`, which pins H.264/AAC.

**Interrupted jobs do not resume.** A restart discards them and their segments;
queue the video again.

## How watching-while-downloading works

The interesting part is the pipeline:

```
yt-dlp (video stream) ─┐
                       ├─> ffmpeg -c copy ─> live HLS (fMP4, EVENT playlist) ─> browser
yt-dlp (audio stream) ─┘
```

- **One yt-dlp per stream.** This is a speed decision, not a style one. When a
  single yt-dlp has to merge video and audio it hands the download to ffmpeg,
  which pulls each URL over one plain connection, and YouTube throttles that
  hard: measured **~175 KB/s**. Asking for one format at a time keeps yt-dlp's
  own chunked downloader, which is not throttled: **~1.3 MB/s** on the same
  video, and both streams run in parallel into one muxer.
- **ffmpeg only copies, never re-encodes.** It muxes the two streams into HLS
  segments plus an `EVENT` playlist, which a browser can start playing straight
  away and can seek freely within whatever has landed so far.
- **On completion the segments are concatenated back into one faststart mp4.**
  An HLS fMP4 init segment followed by its media segments already *is* a valid
  fragmented mp4, so this is a byte concatenation plus one stream copy to move
  the index to the front. A two hour video finishes in seconds, not a re-encode.

In practice a video becomes watchable within a few seconds of queueing, and
downloads run at roughly 15x realtime.

Two details that are easy to get wrong and are handled here:

- **AAC needs `aac_adtstoasc`.** Audio arriving as ADTS cannot enter MP4 as-is;
  the muxer rejects the packets outright. A preflight `--simulate` call reports
  the chosen audio codec so the filter is applied only when it applies.
- **The pipe fds must be closed in the parent.** Otherwise ffmpeg never sees EOF
  and every job hangs at 100%.

## Layout

| Path                | What                                                     |
| ------------------- | -------------------------------------------------------- |
| `nagare/config.py`  | Paths, port, quality ladders. All `NAGARE_*` env vars.    |
| `nagare/doctor.py`  | Startup preflight: required binaries and install hints.   |
| `nagare/ytx.py`     | yt-dlp python API: search, URL/playlist resolve, posters. |
| `nagare/auth.py`    | YouTube sign-in: reads cookies from your browser so the player stops bot-checking. |
| `nagare/jobs.py`    | The download pipeline and job state machine.              |
| `nagare/server.py`  | FastAPI: API, SSE progress, byte-range media serving.     |
| `electron/main.js`  | Desktop shell: spawns the server, owns its lifetime.      |
| `web/squircle.js`   | The G2 corner primitive. Every rounded shape routes here. |
| `web/app.js`        | UI, SSE client, hls.js player.                            |

## Design

Greensteel: Monocraft, backgrounds only from void/abyss/dark, two font sizes
(18/27), G2 corners via `clip-path` rather than `border-radius`, and
exponentially smoothed progress bars.

## Notes

- Quality defaults to 1080p on the H.264/AAC ladder because a browser can always
  decode it. `best` lets YouTube hand back AV1/VP9 + Opus, which Chrome plays but
  other players may not.
- `mpv` buttons play the growing HLS playlist directly, so the same
  watch-while-downloading works outside the browser.

## License

MIT, see [LICENSE](LICENSE). nagare drives [yt-dlp](https://github.com/yt-dlp/yt-dlp)
(Unlicense) and [ffmpeg](https://ffmpeg.org) (LGPL/GPL depending on build), neither
of which is bundled here; you install them yourself.
