# nagare

A local YouTube frontend built on yt-dlp. Search, queue, and **watch a video while
it is still downloading**.

```
nagare            # starts the server and opens a browser
nagare --help
```

Library lives in `~/Videos/nagare` (`media/` holds the finished files).

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
| `nagare/ytx.py`     | yt-dlp python API: search, URL/playlist resolve, posters. |
| `nagare/jobs.py`    | The download pipeline and job state machine.              |
| `nagare/server.py`  | FastAPI: API, SSE progress, byte-range media serving.     |
| `web/squircle.js`   | The G2 corner primitive. Every rounded shape routes here. |
| `web/app.js`        | UI, SSE client, hls.js player.                            |

## Design

Greensteel, per `~/.config/hypr/DESIGN.md`: Monocraft, backgrounds only from
void/abyss/dark, two font sizes (18/27), G2 corners via `clip-path` rather than
`border-radius`, and exponentially smoothed progress bars.

## Notes

- Quality defaults to 1080p on the H.264/AAC ladder because a browser can always
  decode it. `best` lets YouTube hand back AV1/VP9 + Opus, which Chrome plays but
  other players may not.
- `mpv` buttons play the growing HLS playlist directly, so the same
  watch-while-downloading works outside the browser.
- Interrupted jobs are not resumable; a restart discards them and their segments.
