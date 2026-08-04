import { squircleAll } from "/static/squircle.js";

const $ = (sel) => document.querySelector(sel);

const state = {
  view: "browse",
  results: [],
  jobs: new Map(),
  qualities: [],
  quality: "1080",
  hasMpv: false,
  playing: null, // { id, kind: "live" | "file" }
};

let hls = null;

// ---------------------------------------------------------------- formatting

function hhmmss(total) {
  if (!total || total < 0) return "";
  const s = Math.round(total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function bytes(n) {
  if (!n) return "";
  const units = ["B", "K", "M", "G"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
}

function views(n) {
  if (!n) return "";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M views`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K views`;
  return `${n} views`;
}

// ------------------------------------------------------- smoothed progress bars
// Exponential smoothing, per the house rule: fast when far, slow when close, and
// safe at any framerate. Targets arrive from SSE a few times a second; this makes
// the bar move continuously between them instead of stepping.

const bars = new Map(); // element -> { target, current }
const SPEED = 9;

function setBar(el, target) {
  const entry = bars.get(el);
  if (entry) entry.target = target;
  else bars.set(el, { target, current: target });
}

let lastFrame = performance.now();
function tick(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  const factor = 1 - Math.exp(-SPEED * dt);
  for (const [el, entry] of bars) {
    if (!el.isConnected) {
      bars.delete(el);
      continue;
    }
    entry.current += (entry.target - entry.current) * factor;
    if (Math.abs(entry.target - entry.current) < 0.0005) entry.current = entry.target;
    el.style.width = `${(entry.current * 100).toFixed(2)}%`;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// --------------------------------------------------------------------- player

function stopPlayback() {
  const video = $("#player");
  if (hls) {
    hls.destroy();
    hls = null;
  }
  video.removeAttribute("src");
  video.load();
  state.playing = null;
  $("#player-panel").classList.add("hidden");
}

function play(job, { live }) {
  const video = $("#player");
  const panel = $("#player-panel");

  if (hls) {
    hls.destroy();
    hls = null;
  }

  const src = live ? job.hls : job.media;
  if (!src) return;

  if (live && window.Hls && window.Hls.isSupported()) {
    hls = new window.Hls({
      // EVENT playlists grow while we watch; start at the beginning rather than
      // at the live edge, and keep re-reading the playlist for new segments.
      startPosition: 0,
      lowLatencyMode: false,
      backBufferLength: Infinity,
    });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    hls.on(window.Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
    });
  } else {
    video.src = src;
    video.play().catch(() => {});
  }

  state.playing = { id: job.id, kind: live ? "live" : "file" };
  $("#player-title").textContent = job.title;
  $("#player-sub").textContent = live
    ? `${job.uploader} · streaming while it downloads`
    : job.uploader;
  $("#player-mpv").classList.toggle("hidden", !state.hasMpv);
  panel.classList.remove("hidden");
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  squircleAll();
}

// ---------------------------------------------------------------------- cards

function cardFor(video) {
  const job = state.jobs.get(video.id);
  const done = job && job.state === "done";
  const active = job && !["done", "failed", "cancelled"].includes(job.state);

  const el = document.createElement("article");
  el.className = `card${done ? " in-library" : ""}`;
  el.dataset.squircle = "";

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  if (video.thumbnail || (job && job.poster)) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = (job && job.poster) || video.thumbnail;
    img.alt = "";
    thumb.append(img);
  }
  if (video.duration) {
    const b = document.createElement("span");
    b.className = "badge";
    b.textContent = hhmmss(video.duration);
    thumb.append(b);
  }
  if (done) {
    const b = document.createElement("span");
    b.className = "badge left";
    b.textContent = "in library";
    thumb.append(b);
  }

  const body = document.createElement("div");
  body.className = "card-body";

  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = video.title;

  const sub = document.createElement("div");
  sub.className = "dim";
  sub.textContent = [video.uploader, views(video.view_count)].filter(Boolean).join(" · ");

  const actions = document.createElement("div");
  actions.className = "card-actions";

  if (done) {
    const watch = button("watch", "primary", () => play(job, { live: false }));
    const remove = button("delete", "ghost danger", async () => {
      if (!confirm(`Delete "${job.title}" and its file?`)) return;
      if (state.playing && state.playing.id === job.id) stopPlayback();
      await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
    });
    actions.append(watch, remove);
    thumb.onclick = () => play(job, { live: false });
  } else if (active) {
    const label = job.watchable ? "watch now" : job.stage || job.state;
    const watch = button(label, job.watchable ? "primary" : "ghost", () =>
      job.watchable ? play(job, { live: true }) : null,
    );
    watch.disabled = !job.watchable;
    actions.append(watch, button("stop", "ghost danger", () =>
      fetch(`/api/jobs/${job.id}/cancel`, { method: "POST" }),
    ));
  } else {
    const get = button("download", "primary", () => enqueue([video]));
    actions.append(get);
    thumb.onclick = () => enqueue([video]);
  }

  body.append(title, sub, actions);
  el.append(thumb, body);
  return el;
}

function button(label, cls, onClick) {
  const b = document.createElement("button");
  b.className = `btn ${cls}`;
  b.dataset.squircle = "";
  b.dataset.radius = "12";
  b.textContent = label;
  if (onClick) b.onclick = onClick;
  return b;
}

// ---------------------------------------------------------------------- queue

function jobRow(job) {
  const el = document.createElement("div");
  el.className = `job is-${job.state}${job.watchable ? " is-live" : ""}`;

  const title = document.createElement("div");
  title.className = "job-title";
  title.textContent = job.title;
  title.title = job.title;

  const track = document.createElement("div");
  track.className = "track";
  track.dataset.squircle = "";
  track.dataset.radius = "5";
  const fill = document.createElement("div");
  fill.className = "fill";
  track.append(fill);

  const line = document.createElement("div");
  line.className = "job-line";
  const stage = document.createElement("span");
  stage.className = `stage${job.watchable ? " live" : ""}${job.state === "failed" ? " err" : ""}`;
  const right = document.createElement("span");
  right.className = "dim";

  if (job.state === "failed") {
    stage.textContent = job.error || "failed";
  } else if (job.state === "done") {
    stage.textContent = "done";
    right.textContent = bytes(job.fetched_bytes);
  } else if (job.state === "queued") {
    stage.textContent = job.stage || "queued";
  } else {
    stage.textContent = job.stage || job.state;
    const watchable = hhmmss(job.progress * job.duration);
    right.textContent = [
      watchable && job.duration ? `${watchable} / ${hhmmss(job.duration)}` : "",
      bytes(job.fetched_bytes),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  line.append(stage, right);

  const actions = document.createElement("div");
  actions.className = "job-actions";
  if (job.state === "done") {
    actions.append(button("watch", "ghost", () => play(job, { live: false })));
  } else if (job.watchable) {
    actions.append(button("watch now", "primary", () => play(job, { live: true })));
  }
  if (state.hasMpv && (job.watchable || job.state === "done")) {
    actions.append(button("mpv", "ghost", () =>
      fetch(`/api/jobs/${job.id}/mpv`, { method: "POST" }),
    ));
  }
  if (!["done", "failed", "cancelled"].includes(job.state)) {
    actions.append(button("stop", "ghost danger", () =>
      fetch(`/api/jobs/${job.id}/cancel`, { method: "POST" }),
    ));
  } else if (job.state !== "done") {
    actions.append(button("clear", "ghost", () =>
      fetch(`/api/jobs/${job.id}?keep_file=true`, { method: "DELETE" }),
    ));
  }

  el.append(title, track, line);
  if (actions.children.length) el.append(actions);

  setBar(fill, job.state === "done" ? 1 : job.progress || 0);
  return el;
}

// --------------------------------------------------------------------- render

function render() {
  const grid = $("#grid");
  const list =
    state.view === "library"
      ? [...state.jobs.values()].filter((j) => j.state === "done")
      : state.results;

  grid.replaceChildren(...list.map((v) => cardFor(v)));
  $("#empty").classList.toggle("hidden", list.length > 0);
  if (state.view === "library" && !list.length) {
    $("#empty").innerHTML = "nothing downloaded yet.";
  }

  const active = [...state.jobs.values()].filter((j) => j.state !== "done");
  active.sort((a, b) => b.created - a.created);
  $("#queue-list").replaceChildren(...active.map(jobRow));
  $("#queue-empty").classList.toggle("hidden", active.length > 0);
  const running = active.filter((j) => !["failed", "cancelled"].includes(j.state)).length;
  $("#queue-count").textContent = running ? `${running} active` : "";

  squircleAll();
}

// ----------------------------------------------------------------- networking

async function enqueue(videos) {
  const res = await fetch("/api/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos, quality: state.quality }),
  });
  if (!res.ok) {
    setStatus(`could not queue: ${(await res.json()).detail || res.status}`);
    return;
  }
  const data = await res.json();
  for (const job of data.jobs) state.jobs.set(job.id, job);
  render();
}

function setStatus(text) {
  $("#status").textContent = text;
}

async function doSearch(query) {
  setStatus("searching…");
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "search failed");
    state.results = data.results;
    state.view = "browse";
    syncTabs();
    setStatus(
      data.kind === "playlist"
        ? `${data.results.length} in "${data.title}"`
        : `${data.results.length} results`,
    );
    if (data.kind === "playlist" && data.results.length > 1) offerBulk(data);
    render();
  } catch (err) {
    setStatus(String(err.message || err));
  }
}

function offerBulk(data) {
  const bar = document.createElement("div");
  bar.className = "tabs";
  const b = button(`download all ${data.results.length}`, "primary", () => {
    enqueue(data.results);
    bar.remove();
  });
  bar.append(b);
  $("#grid").before(bar);
}

function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = (evt) => {
    const payload = JSON.parse(evt.data);
    if (payload.hello) {
      state.jobs = new Map(payload.jobs.map((j) => [j.id, j]));
    } else if (payload.state === "removed") {
      state.jobs.delete(payload.id);
    } else {
      state.jobs.set(payload.id, payload);
      // A live stream that just finished should switch over to the finished file.
      if (
        state.playing &&
        state.playing.id === payload.id &&
        state.playing.kind === "live" &&
        payload.state === "done"
      ) {
        const at = $("#player").currentTime;
        play(payload, { live: false });
        $("#player").addEventListener(
          "loadedmetadata",
          () => {
            $("#player").currentTime = at;
          },
          { once: true },
        );
      }
    }
    render();
  };
  es.onerror = () => setStatus("reconnecting…");
}

function syncTabs() {
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("on", t.dataset.view === state.view);
  });
  $("#empty").innerHTML =
    state.view === "library"
      ? "nothing downloaded yet."
      : "search for something, or paste a youtube url.<br />downloads start streaming to the player before they finish.";
}

// ------------------------------------------------------------------- startup

async function init() {
  const cfg = await (await fetch("/api/config")).json();
  state.qualities = cfg.qualities;
  state.quality = cfg.default_quality;
  state.hasMpv = cfg.has_mpv;

  const sel = $("#quality");
  sel.replaceChildren(
    ...cfg.qualities.map((q) => {
      const o = document.createElement("option");
      o.value = q.id;
      o.textContent = q.label;
      if (q.id === cfg.default_quality) o.selected = true;
      return o;
    }),
  );
  sel.onchange = () => {
    state.quality = sel.value;
  };

  $("#search-form").onsubmit = (e) => {
    e.preventDefault();
    const q = $("#q").value.trim();
    if (q) doSearch(q);
  };

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.onclick = () => {
      state.view = tab.dataset.view;
      syncTabs();
      render();
    };
  });

  $("#player-close").onclick = stopPlayback;
  $("#player-mpv").onclick = () => {
    if (state.playing) fetch(`/api/jobs/${state.playing.id}/mpv`, { method: "POST" });
  };

  connectEvents();
  squircleAll();
  render();
  $("#q").focus();
}

init();
