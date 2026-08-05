import { squircleAll } from "/static/squircle.js";
import { Player, formatTime } from "/static/player.js";
import { confirmDialog, toast, isBotWall, signinToast } from "/static/ui.js";
import * as store from "/static/store.js";

const $ = (sel) => document.querySelector(sel);

const state = {
  view: "browse",
  mode: "hero", // hero | results | library
  results: [],
  lastQuery: "",
  jobs: new Map(),
  quality: "1080",
  hasMpv: false,
  watching: null,
  playlist: [], // queued-to-play videos
  autoNextTimer: 0,
  channels: [], // subscriptions
  channelResults: [], // channel search results
  channelViewing: null, // channel whose page is open
  feedChannel: "", // "" = everyone
};

let player = null;

// ---------------------------------------------------------------- formatting

function bytes(n) {
  if (!n) return "0B";
  const units = ["B", "K", "M", "G", "T"];
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

function ymd(s) {
  if (!s || s.length !== 8) return "";
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function button(label, cls, onClick, { radius = 12, title } = {}) {
  const b = document.createElement("button");
  b.className = `btn ${cls}`;
  b.dataset.squircle = "";
  b.dataset.radius = String(radius);
  b.textContent = label;
  if (title) b.title = title;
  if (onClick) b.onclick = onClick;
  return b;
}

const jobToVideo = (j) => ({
  id: j.id,
  url: j.url,
  title: j.title,
  uploader: j.uploader,
  duration: j.duration,
  thumbnail: j.poster,
  view_count: 0,
  upload_date: "",
  description: "",
});

// ------------------------------------------------------- smoothed progress bars

const bars = new Map();
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

// -------------------------------------------------------------------- routing

function show(view) {
  state.view = view;
  $("#view-browse").classList.toggle("hidden", view !== "browse");
  $("#view-watch").classList.toggle("hidden", view !== "watch");
  if (view !== "watch" && player) {
    cancelAutoNext();
    player.unload();
  }
  window.scrollTo({ top: 0 });
  squircleAll();
}

/** Hero is the resting state: the search is the page until you search. */
function setMode(mode) {
  state.mode = mode;
  $("#hero").classList.toggle("hidden", mode !== "hero");
  $("#browse-body").classList.toggle("hidden", mode === "hero");
  $("#bar").classList.toggle("bar-quiet", mode === "hero");
  $("#lib-bar").classList.toggle("hidden", mode !== "library");
  $("#subs-bar").classList.toggle("hidden", mode !== "feed");
  $("#chan-bar").classList.toggle("hidden", mode !== "channel");
  squircleAll();
}

// -------------------------------------------------------------- subscriptions

async function loadChannels() {
  try {
    const data = await (await fetch("/api/subscriptions")).json();
    state.channels = data.channels || [];
  } catch {
    state.channels = [];
  }
  paintWatchActions();
}

const isSubscribed = (channelId) => state.channels.some((c) => c.id === channelId);

async function subscribe(target) {
  try {
    const res = await fetch("/api/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "could not subscribe");
    state.channels = data.channels;
    // YouTube fuzzy-matches unknown handles, so say which channel actually
    // got added rather than assuming it was the one that was typed.
    toast(`subscribed to ${data.channel.name}`, { kind: "ok" });
    renderSubChips();
    paintWatchActions();
    return true;
  } catch (err) {
    toast(String(err.message || err), { kind: "err", timeout: 6000 });
    return false;
  }
}

async function unsubscribe(channel) {
  const ok = await confirmDialog({
    title: `Unsubscribe from ${channel.name}?`,
    body: "Their uploads stop appearing in your feed. Nothing downloaded is removed.",
    confirmLabel: "unsubscribe",
    danger: true,
  });
  if (!ok) return;
  const res = await fetch(`/api/subscriptions/${channel.id}`, { method: "DELETE" });
  if (res.ok) {
    state.channels = (await res.json()).channels;
    renderSubChips();
    paintWatchActions();
    if (state.mode === "feed") showFeed();
  }
}

function followers(n) {
  if (!n) return "";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M subs`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K subs`;
  return `${n} subs`;
}

function avatarFor(channel, size = 52) {
  const img = document.createElement("img");
  img.className = "avatar";
  img.loading = "lazy";
  img.alt = "";
  img.width = size;
  img.height = size;
  img.style.width = `${size}px`;
  img.style.height = `${size}px`;
  img.dataset.squircle = "";
  // A big radius on a square gives a superellipse, which is the house look for
  // an app-icon-shaped thing. A plain circle would be the only round corner in
  // the app not going through the primitive.
  img.dataset.radius = String(Math.round(size * 0.34));
  // Prefer the locally cached copy: instant, and survives the url expiring.
  img.src = channel.avatar_file ? `/thumbs/${channel.avatar_file}` : channel.avatar || "";
  if (channel.avatar_file && channel.avatar) {
    img.onerror = () => {
      img.onerror = null;
      img.src = channel.avatar;
    };
  }
  return img;
}

function renderSubChips() {
  const strip = $("#channel-strip");
  const tiles = [];

  const all = document.createElement("button");
  all.className = `chan-tile all${state.feedChannel ? "" : " on"}`;
  all.dataset.squircle = "";
  all.dataset.radius = "12";
  all.dataset.edge = "";
  all.innerHTML = `<span class="chan-all-mark">流</span><span class="chan-name">everyone</span>`;
  all.onclick = () => {
    state.feedChannel = "";
    showFeed();
  };
  tiles.push(all);

  for (const c of state.channels) {
    const tile = document.createElement("div");
    tile.className = `chan-tile${state.feedChannel === c.id ? " on" : ""}`;
    tile.dataset.squircle = "";
    tile.dataset.radius = "12";
    tile.dataset.edge = "";

    const pick = document.createElement("button");
    pick.className = "chan-pick";
    pick.title = `only ${c.name}`;
    const name = document.createElement("span");
    name.className = "chan-name";
    name.textContent = c.name;
    const meta = document.createElement("span");
    meta.className = "chan-meta dim";
    meta.textContent = followers(c.followers);
    const text = document.createElement("span");
    text.className = "chan-text";
    text.append(name);
    if (c.followers) text.append(meta);
    pick.append(avatarFor(c, 44), text);
    pick.onclick = () => {
      state.feedChannel = state.feedChannel === c.id ? "" : c.id;
      showFeed();
    };

    const x = document.createElement("button");
    x.className = "chan-x";
    x.textContent = "×";
    x.title = `unsubscribe from ${c.name}`;
    x.onclick = (e) => {
      e.stopPropagation();
      unsubscribe(c);
    };

    tile.append(pick, x);
    tiles.push(tile);
  }

  strip.replaceChildren(...tiles);
  $("#subs-count").textContent = state.channels.length
    ? `${state.channels.length} channel${state.channels.length === 1 ? "" : "s"}`
    : "none yet";
  squircleAll();
}

/** Search results: a row per channel with a subscribe button. */
function channelRow(channel) {
  const row = document.createElement("div");
  row.className = "chan-row";
  row.dataset.squircle = "";
  row.dataset.radius = "12";
  row.dataset.edge = "";

  const body = document.createElement("div");
  body.className = "chan-row-body";
  const name = document.createElement("div");
  name.className = "chan-row-name";
  name.textContent = channel.name;
  const meta = document.createElement("div");
  meta.className = "card-sub dim";
  meta.textContent = [followers(channel.followers), channel.description]
    .filter(Boolean)
    .join(" · ");
  body.append(name, meta);

  const already = isSubscribed(channel.id);
  const action = button(
    already ? "subscribed" : "subscribe",
    already ? "ghost" : "primary",
    already
      ? () => unsubscribe(state.channels.find((c) => c.id === channel.id) || channel)
      : async () => {
          action.disabled = true;
          await subscribeChannel(channel);
          action.disabled = false;
        },
  );

  row.append(avatarFor(channel, 52), body, action);
  return row;
}

async function subscribeChannel(channel, { stay = false } = {}) {
  try {
    const res = await fetch("/api/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "could not subscribe");
    state.channels = data.channels;
    toast(`subscribed to ${data.channel.name}`, { kind: "ok" });
    renderSubChips();
    renderChannelResults();
    paintWatchActions();
    if (!stay) showFeed();
  } catch (err) {
    toast(String(err.message || err), { kind: "err", timeout: 6000 });
  }
}

function renderChannelResults() {
  const host = $("#channel-results");
  host.replaceChildren(...state.channelResults.map(channelRow));
  squircleAll();
}

async function findChannels(query) {
  const host = $("#channel-results");
  host.replaceChildren();
  const note = document.createElement("div");
  note.className = "dim pad";
  note.textContent = "searching channels…";
  host.append(note);
  try {
    const data = await (
      await fetch(`/api/search/channels?q=${encodeURIComponent(query)}&limit=10`)
    ).json();
    state.channelResults = data.channels || [];
    if (!state.channelResults.length) {
      note.textContent = "no channels matched.";
      return;
    }
    renderChannelResults();
  } catch (err) {
    note.textContent = `channel search failed: ${err.message || err}`;
  }
}

/** A channel's own page: header plus its recent uploads. */
async function openChannel(channelId) {
  show("browse");
  setMode("channel");
  $("#browse-title").textContent = "channel";
  $("#grab-all").classList.add("hidden");
  $("#status").textContent = "loading channel…";
  state.results = [];
  render();

  try {
    const data = await (await fetch(`/api/channel/${channelId}?limit=40`)).json();
    if (!data.channel) throw new Error("channel not found");
    const c = data.channel;
    state.channelViewing = c;
    state.results = data.videos || [];

    $("#chan-bar-name").textContent = c.name;
    $("#chan-bar-meta").textContent = [followers(c.followers), `${state.results.length} recent`]
      .filter(Boolean)
      .join("  ·  ");
    $("#chan-bar-desc").textContent = c.description || "";
    const av = $("#chan-bar-avatar");
    const local = state.channels.find((s) => s.id === c.id);
    av.src = local?.avatar_file ? `/thumbs/${local.avatar_file}` : c.avatar || "";
    av.dataset.squircle = "";
    av.dataset.radius = "26";
    av.classList.toggle("hidden", !av.src);

    paintChannelSubButton(c);
    $("#browse-title").textContent = c.name;
    $("#status").textContent = "";
    $("#empty").textContent = "no uploads found.";
    render();
  } catch (err) {
    $("#status").textContent = `channel failed: ${err.message || err}`;
  }
}

function paintChannelSubButton(channel) {
  const btn = $("#chan-bar-sub");
  const already = isSubscribed(channel.id);
  btn.textContent = already ? "subscribed" : "subscribe";
  btn.className = `btn ${already ? "ghost" : "primary"}`;
  btn.onclick = async () => {
    if (already) await unsubscribe(state.channels.find((c) => c.id === channel.id) || channel);
    else await subscribeChannel(channel, { stay: true });
    paintChannelSubButton(channel);
  };
}

async function showFeed() {
  show("browse");
  setMode("feed");
  $("#browse-title").textContent = "subscriptions";
  $("#grab-all").classList.add("hidden");
  await loadChannels();
  renderSubChips();

  if (!state.channels.length) {
    state.results = [];
    $("#empty").textContent = "no subscriptions yet. add a channel above.";
    $("#status").textContent = "";
    render();
    return;
  }

  $("#status").textContent = "loading feed…";
  try {
    const params = new URLSearchParams({ limit: "60" });
    if (state.feedChannel) params.set("channel", state.feedChannel);
    const data = await (await fetch(`/api/feed?${params}`)).json();
    state.results = data.videos || [];
    state.channels = data.channels || state.channels;
    $("#empty").textContent = "nothing new from these channels.";
    render();
  } catch (err) {
    $("#status").textContent = `feed failed: ${err.message || err}`;
  }
}

// ---------------------------------------------------------------------- cards

function cardFor(video, { library = false } = {}) {
  const job = state.jobs.get(video.id);
  const done = job && job.state === "done";
  const active = job && !["done", "failed", "cancelled"].includes(job.state);
  const ws = store.watchState(video.id, video.duration);

  const el = document.createElement("article");
  el.className = `card${done ? " in-library" : ""} is-${ws.state}`;
  el.dataset.squircle = "";
  el.dataset.edge = "";

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  const poster = (job && job.poster) || video.thumbnail;
  if (poster) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = poster;
    img.alt = "";
    thumb.append(img);
  }
  if (video.duration) {
    const b = document.createElement("span");
    b.className = "badge";
    b.textContent = formatTime(video.duration);
    thumb.append(b);
  }
  if (ws.state === "watched") {
    const b = document.createElement("span");
    b.className = "badge left watched";
    b.textContent = "watched";
    thumb.append(b);
  } else if (done && !library) {
    const b = document.createElement("span");
    b.className = "badge left";
    b.textContent = "in library";
    thumb.append(b);
  } else if (active && job.watchable) {
    const b = document.createElement("span");
    b.className = "badge left";
    b.textContent = "streaming";
    thumb.append(b);
  }
  // How far in you are, drawn along the bottom of the poster.
  if (ws.fraction > 0.005) {
    const wrap = document.createElement("div");
    wrap.className = "thumb-progress";
    const fill = document.createElement("div");
    fill.className = `thumb-progress-fill${ws.state === "watched" ? " full" : ""}`;
    fill.style.width = `${ws.fraction * 100}%`;
    wrap.append(fill);
    thumb.append(wrap);
  }
  thumb.onclick = () => openWatch(video);

  const body = document.createElement("div");
  body.className = "card-body";

  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = video.title;
  title.title = video.title;
  title.onclick = () => openWatch(video);

  const sub = document.createElement("div");
  sub.className = "card-sub";
  const bits = [video.uploader];
  if (library && job) bits.push(bytes(job.fetched_bytes));
  else bits.push(views(video.view_count));
  if (ws.state === "partial") bits.push(`${formatTime(ws.resumeAt)} in`);
  sub.textContent = bits.filter(Boolean).join(" · ");

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const watchLabel = ws.state === "partial" ? "resume" : ws.state === "watched" ? "rewatch" : "watch";
  actions.append(button(watchLabel, "primary", () => openWatch(video)));

  if (done) {
    actions.append(
      button("delete", "ghost danger", async (e) => {
        e.stopPropagation();
        await deleteDownload(job);
      }),
    );
  } else if (active) {
    const label = job.watchable ? "downloading" : job.stage || job.state;
    const b = button(label, "ghost", null, { title: label });
    b.disabled = true;
    actions.append(b);
  } else {
    actions.append(
      button("get", "ghost", (e) => {
        e.stopPropagation();
        enqueue([video]);
      }),
    );
  }

  body.append(title, sub, actions);
  el.append(thumb, body);
  return el;
}

function miniFor(video, { removable = false } = {}) {
  const el = document.createElement("div");
  el.className = "mini";
  el.dataset.squircle = "";
  el.dataset.radius = "12";
  el.dataset.edge = "";
  const img = document.createElement("img");
  img.className = "mini-thumb";
  img.loading = "lazy";
  img.src = video.thumbnail || "";
  img.alt = "";
  const body = document.createElement("div");
  body.className = "mini-body";
  const t = document.createElement("div");
  t.className = "mini-title";
  t.textContent = video.title;
  const s = document.createElement("div");
  s.className = "card-sub dim";
  s.textContent = [video.uploader, formatTime(video.duration)].filter(Boolean).join(" · ");
  body.append(t, s);
  el.append(img, body);
  el.onclick = () => openWatch(video);
  if (removable) {
    const x = button("×", "ghost tiny", (e) => {
      e.stopPropagation();
      state.playlist = state.playlist.filter((v) => v.id !== video.id);
      renderPlaylist();
    }, { radius: 9 });
    el.append(x);
  }
  return el;
}

// ------------------------------------------------------------------ deleting

async function deleteDownload(job) {
  const ok = await confirmDialog({
    title: "Delete this download?",
    body: `"${job.title}"\n\nThe ${bytes(job.fetched_bytes)} file will be removed from your library. You can always download it again.`,
    confirmLabel: "delete",
    danger: true,
  });
  if (!ok) return false;
  if (state.watching && state.watching.id === job.id) player.unload();
  await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
  toast("deleted", { kind: "ok" });
  return true;
}

async function sweepWatched() {
  const done = [...state.jobs.values()].filter((j) => j.state === "done");
  const watched = done.filter((j) => store.watchState(j.id, j.duration).state === "watched");
  if (!watched.length) {
    toast("nothing watched to clear", { kind: "info" });
    return;
  }
  const total = watched.reduce((n, j) => n + (j.fetched_bytes || 0), 0);
  const ok = await confirmDialog({
    title: `Delete ${watched.length} watched ${watched.length === 1 ? "video" : "videos"}?`,
    body: `Frees ${bytes(total)}.\n\n${watched.slice(0, 6).map((j) => `· ${j.title}`).join("\n")}${
      watched.length > 6 ? `\n· and ${watched.length - 6} more` : ""
    }`,
    confirmLabel: `delete ${watched.length}`,
    danger: true,
  });
  if (!ok) return;
  for (const j of watched) await fetch(`/api/jobs/${j.id}`, { method: "DELETE" });
  toast(`freed ${bytes(total)}`, { kind: "ok" });
}

/** End-of-video prompt. Has its own opt-out, because a dialog after every
    single video would be its own kind of annoying. */
async function offerDeleteOnFinish(job) {
  const ok = await confirmDialog({
    title: "Finished. Delete it?",
    body: `"${job.title}"\n\nFrees ${bytes(job.fetched_bytes)}. You can download it again any time.\n\nTurn this prompt off in filters.`,
    confirmLabel: `delete ${bytes(job.fetched_bytes)}`,
    cancelLabel: "keep",
    danger: true,
  });
  if (!ok) return false;
  await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
  toast(`freed ${bytes(job.fetched_bytes)}`, { kind: "ok" });
  player.unload();
  show("browse");
  return true;
}

// ---------------------------------------------------------------------- watch

async function openWatch(video) {
  cancelAutoNext();
  state.watching = video;
  show("watch");

  paintWatchMeta(video);
  paintWatchActions();
  renderUpNext();

  await playBest(video);
  loadComments(video.id);
  loadVotes(video.id);
  // Search results and RSS feed entries are flat: no description, often no
  // channel id or view count. Fetch the real thing and repaint once it lands.
  enrichWatch(video.id);
  squircleAll();
}

function paintWatchMeta(video) {
  $("#w-title").textContent = video.title;
  $("#w-stats").textContent = [views(video.view_count), ymd(video.upload_date)]
    .filter(Boolean)
    .join("  ·  ");

  $("#w-chan-name").textContent = video.uploader || "";
  const channel = state.channels.find((c) => c.id === video.channel_id);
  $("#w-chan-subs").textContent = channel ? followers(channel.followers) : "";
  const avatar = $("#w-avatar");
  const src = channel
    ? channel.avatar_file
      ? `/thumbs/${channel.avatar_file}`
      : channel.avatar
    : "";
  avatar.src = src || "";
  avatar.classList.toggle("hidden", !src);
  avatar.dataset.squircle = "";
  avatar.dataset.radius = "18";

  const desc = $("#w-desc");
  desc.textContent = video.description || "";
  desc.classList.remove("open");
  const more = $("#w-desc-more");
  // Only offer to expand when there is something hidden.
  requestAnimationFrame(() => {
    const clipped = desc.scrollHeight > desc.clientHeight + 4;
    more.classList.toggle("hidden", !clipped);
    more.textContent = "show more";
  });
  more.onclick = () => {
    const open = desc.classList.toggle("open");
    more.textContent = open ? "show less" : "show more";
  };
  desc.onclick = () => more.click();
}

async function enrichWatch(videoId) {
  try {
    const full = await (await fetch(`/api/video/${videoId}`)).json();
    if (state.watching?.id !== videoId || !full.id) return;
    // Keep whatever we already had (a feed entry knows its publish date), and
    // fill the gaps from the full extraction.
    const merged = { ...state.watching };
    for (const [k, v] of Object.entries(full)) {
      if (v !== "" && v !== 0 && v != null) merged[k] = v;
    }
    state.watching = merged;
    paintWatchMeta(merged);
    paintWatchActions();
    squircleAll();
  } catch {
    /* offline: the flat metadata we already showed stands */
  }
}

function renderUpNext() {
  const id = state.watching?.id;
  const queued = state.playlist.filter((v) => v.id !== id);
  const rest = state.results.filter(
    (v) => v.id !== id && !queued.some((q) => q.id === v.id) && !store.isBlocked(v),
  );
  const list = [...queued, ...rest].slice(0, 14);
  $("#w-next").replaceChildren(
    ...list.map((v) => miniFor(v, { removable: queued.some((q) => q.id === v.id) })),
  );
}

async function playBest(video) {
  const job = state.jobs.get(video.id);
  const ws = store.watchState(video.id, video.duration);
  const resumeAt = ws.state === "partial" ? ws.resumeAt : 0;

  if (job && job.state === "done" && job.media) {
    await player.load({
      src: job.media,
      live: false,
      videoId: video.id,
      duration: video.duration,
      poster: job.poster || video.thumbnail,
      resumeAt,
    });
    return;
  }
  if (job && job.watchable && job.hls) {
    await player.load({
      src: job.hls,
      live: true,
      videoId: video.id,
      duration: video.duration || job.duration,
      poster: job.poster || video.thumbnail,
      resumeAt,
    });
    return;
  }
  if (!job) await enqueue([video]);
  player.unload();
  player.video.poster = video.thumbnail || "";
  player.knownDuration = video.duration || 0;
  player.videoId = video.id;
}

function paintWatchActions() {
  const v = state.watching;
  if (!v) return;
  const job = state.jobs.get(v.id);
  const get = $("#w-get");
  const mpv = $("#w-mpv");
  mpv.classList.toggle("hidden", !state.hasMpv || !job || (!job.watchable && job.state !== "done"));
  mpv.onclick = () => fetch(`/api/jobs/${v.id}/mpv`, { method: "POST" });

  // Subscribe straight from what you are watching. The feed entries carry a
  // channel_id; search results sometimes do not, so fall back to the video URL
  // and let the server work the channel out.
  const subBtn = $("#w-subscribe");
  const channelId = v.channel_id || "";
  if (channelId && isSubscribed(channelId)) {
    subBtn.textContent = "subscribed";
    subBtn.onclick = () => unsubscribe(state.channels.find((c) => c.id === channelId));
  } else {
    subBtn.textContent = "subscribe";
    subBtn.onclick = async () => {
      subBtn.disabled = true;
      subBtn.textContent = "…";
      await subscribe(channelId || v.url);
      subBtn.disabled = false;
      paintWatchActions();
    };
  }

  const visit = () => (channelId ? openChannel(channelId) : toast("no channel for this one"));
  $("#w-visit").onclick = visit;
  $("#w-channel").onclick = visit;
  $("#w-visit").disabled = !channelId;

  $("#w-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(v.url);
      toast("link copied", { kind: "ok", timeout: 2000 });
    } catch {
      toast("could not copy", { kind: "err" });
    }
  };
  $("#w-yt").onclick = () => window.open(v.url, "_blank", "noopener");

  const del = $("#w-delete");
  const owned = job && job.state === "done";
  del.classList.toggle("hidden", !owned);
  if (owned) {
    del.textContent = `delete ${bytes(job.fetched_bytes)}`;
    del.onclick = async () => {
      if (await deleteDownload(job)) {
        player.unload();
        show("browse");
      }
    };
  }

  $("#w-queue").onclick = () => {
    if (state.playlist.some((x) => x.id === v.id)) {
      toast("already queued");
      return;
    }
    state.playlist.push(v);
    renderPlaylist();
    renderUpNext();
    toast("added to queue", { kind: "ok" });
  };

  if (job && job.state === "done") {
    get.textContent = "in library";
    get.disabled = true;
    get.onclick = null;
  } else if (job && !["failed", "cancelled"].includes(job.state)) {
    const pct = Math.round((job.progress || 0) * 100);
    get.textContent = job.watchable ? `downloading ${pct}%` : job.stage || job.state;
    get.disabled = true;
  } else {
    get.textContent = "download";
    get.disabled = false;
    get.onclick = () => enqueue([v]);
  }
}

async function loadVotes(videoId) {
  try {
    const data = await (await fetch(`/api/votes/${videoId}`)).json();
    if (state.watching?.id !== videoId || !data.likes) return;
    $("#w-votes").textContent = `${views(data.likes).replace(" views", "")} up · ${views(
      data.dislikes,
    ).replace(" views", "")} down`;
  } catch {
    /* RYD offline: no votes shown */
  }
}

// ------------------------------------------------------------- autoplay next

function nextInLine() {
  const id = state.watching?.id;
  if (state.playlist.length) {
    const next = state.playlist.find((v) => v.id !== id);
    if (next) return next;
  }
  const pool = state.results.filter((v) => !store.isBlocked(v));
  const i = pool.findIndex((v) => v.id === id);
  return i >= 0 && i + 1 < pool.length ? pool[i + 1] : null;
}

function startAutoNext() {
  if (!store.getSettings().autoplay) return;
  const next = nextInLine();
  if (!next) return;
  let left = 10;
  const card = $("#next-card");
  $("#next-title").textContent = next.title;
  $("#next-count").textContent = String(left);
  card.classList.remove("hidden");
  squircleAll();
  $("#next-go").onclick = () => {
    cancelAutoNext();
    playNext(next);
  };
  $("#next-stop").onclick = cancelAutoNext;
  state.autoNextTimer = setInterval(() => {
    left -= 1;
    $("#next-count").textContent = String(left);
    if (left <= 0) {
      cancelAutoNext();
      playNext(next);
    }
  }, 1000);
}

function playNext(video) {
  state.playlist = state.playlist.filter((v) => v.id !== video.id);
  renderPlaylist();
  openWatch(video);
}

function cancelAutoNext() {
  clearInterval(state.autoNextTimer);
  state.autoNextTimer = 0;
  $("#next-card")?.classList.add("hidden");
}

// ------------------------------------------------------------------ comments

async function loadComments(videoId) {
  const list = $("#c-list");
  const stateEl = $("#c-state");
  list.replaceChildren();
  $("#c-count").textContent = "";
  stateEl.textContent = "loading comments…";
  try {
    const res = await fetch(`/api/comments/${videoId}?limit=120`);
    const data = await res.json();
    if (state.watching?.id !== videoId) return;
    if (data.error) {
      stateEl.textContent = `comments unavailable: ${data.error}`;
      if (isBotWall(data.error)) signinToast(data.error);
      return;
    }
    if (!data.comments.length) {
      stateEl.textContent = "no comments.";
      return;
    }
    stateEl.textContent = "";
    $("#c-count").textContent = `${data.fetched} of ${data.count}`;
    list.replaceChildren(...data.comments.map(commentEl));
  } catch (err) {
    stateEl.textContent = `comments failed: ${err.message || err}`;
  }
}

function commentEl(c) {
  const el = document.createElement("div");
  el.className = "comment";

  const img = document.createElement("img");
  img.className = "comment-avatar";
  img.loading = "lazy";
  if (c.author_thumbnail) img.src = c.author_thumbnail;
  img.alt = "";
  el.append(img);

  const body = document.createElement("div");
  body.className = "comment-body";

  const head = document.createElement("div");
  head.className = "comment-head";
  const author = document.createElement("span");
  author.className = `comment-author${c.author_is_uploader ? " op" : ""}`;
  author.textContent = c.author;
  head.append(author);
  if (c.is_pinned) {
    const p = document.createElement("span");
    p.className = "dim";
    p.textContent = "pinned";
    head.append(p);
  }
  if (c.time_text) {
    const t = document.createElement("span");
    t.className = "dim";
    t.textContent = c.time_text;
    head.append(t);
  }

  const text = document.createElement("div");
  text.className = "comment-text";
  text.textContent = c.text;

  const meta = document.createElement("div");
  meta.className = "comment-meta";
  if (c.like_count) {
    const l = document.createElement("span");
    l.textContent = `${c.like_count} likes`;
    meta.append(l);
  }

  body.append(head, text, meta);

  if (c.replies && c.replies.length) {
    const wrap = document.createElement("div");
    wrap.className = "comment-replies hidden";
    wrap.replaceChildren(...c.replies.map(commentEl));
    const label = (n) => `${n} repl${n === 1 ? "y" : "ies"}`;
    const toggle = document.createElement("button");
    toggle.className = "reply-toggle";
    toggle.textContent = label(c.replies.length);
    toggle.onclick = () => {
      wrap.classList.toggle("hidden");
      toggle.textContent = wrap.classList.contains("hidden")
        ? label(c.replies.length)
        : "hide replies";
    };
    body.append(toggle, wrap);
  }

  el.append(body);
  return el;
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
    right.textContent = [
      job.duration ? `${formatTime(job.progress * job.duration)} / ${formatTime(job.duration)}` : "",
      bytes(job.fetched_bytes),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  line.append(stage, right);

  const actions = document.createElement("div");
  actions.className = "job-actions";
  if (job.state === "done" || job.watchable) {
    actions.append(
      button("watch", job.watchable ? "primary" : "ghost", () => {
        closeDrawers();
        openWatch(jobToVideo(job));
      }),
    );
  }
  if (state.hasMpv && (job.watchable || job.state === "done")) {
    actions.append(button("mpv", "ghost", () => fetch(`/api/jobs/${job.id}/mpv`, { method: "POST" })));
  }
  if (!["done", "failed", "cancelled"].includes(job.state)) {
    actions.append(
      button("stop", "ghost danger", async () => {
        const ok = await confirmDialog({
          title: "Stop this download?",
          body: `"${job.title}"\n\nProgress so far is discarded.`,
          confirmLabel: "stop",
          danger: true,
        });
        if (ok) fetch(`/api/jobs/${job.id}/cancel`, { method: "POST" });
      }),
    );
  } else if (job.state !== "done") {
    actions.append(
      button("clear", "ghost", () => fetch(`/api/jobs/${job.id}?keep_file=true`, { method: "DELETE" })),
    );
  }

  el.append(title, track, line);
  if (actions.children.length) el.append(actions);
  setBar(fill, job.state === "done" ? 1 : job.progress || 0);
  return el;
}

function renderPlaylist() {
  $("#playlist").replaceChildren(...state.playlist.map((v) => miniFor(v, { removable: true })));
  $("#playlist-empty").classList.toggle("hidden", state.playlist.length > 0);
  squircleAll();
}

function openDrawer(id) {
  $(id).classList.remove("hidden");
  squircleAll();
}
function closeDrawers() {
  $("#drawer").classList.add("hidden");
  $("#filters").classList.add("hidden");
}

// --------------------------------------------------------------------- render

function render() {
  if (state.view === "browse" && state.mode !== "hero") {
    const library = state.mode === "library";
    const visible = library ? state.results : state.results.filter((v) => !store.isBlocked(v));
    $("#grid").replaceChildren(...visible.map((v) => cardFor(v, { library })));
    $("#empty").classList.toggle("hidden", visible.length > 0);
    const hidden = state.results.length - visible.length;
    if (!library) {
      $("#status").textContent = `${visible.length} results${hidden ? ` · ${hidden} filtered out` : ""}`;
    }
    if (library) paintLibraryBar();
    if (state.mode === "channel" && state.channelViewing) {
      paintChannelSubButton(state.channelViewing);
    }
  }
  if (state.view === "watch") paintWatchActions();

  const active = [...state.jobs.values()].filter((j) => j.state !== "done");
  active.sort((a, b) => b.created - a.created);
  $("#queue-list").replaceChildren(...active.map(jobRow));
  $("#queue-empty").classList.toggle("hidden", active.length > 0);
  const running = active.filter((j) => !["failed", "cancelled"].includes(j.state)).length;
  $("#queue-count").textContent = running ? `${running} active` : "";
  $("#queue-pip").classList.toggle("hidden", running === 0);

  squircleAll();
}

function paintLibraryBar() {
  const done = [...state.jobs.values()].filter((j) => j.state === "done");
  const total = done.reduce((n, j) => n + (j.fetched_bytes || 0), 0);
  const watched = done.filter((j) => store.watchState(j.id, j.duration).state === "watched");
  const watchedBytes = watched.reduce((n, j) => n + (j.fetched_bytes || 0), 0);
  const partial = done.filter((j) => store.watchState(j.id, j.duration).state === "partial").length;

  $("#lib-summary").textContent =
    `${done.length} videos · ${bytes(total)}` +
    (partial ? ` · ${partial} in progress` : "") +
    (watched.length ? ` · ${watched.length} watched taking ${bytes(watchedBytes)}` : "");
  const sweep = $("#lib-sweep");
  sweep.classList.toggle("hidden", watched.length === 0);
  sweep.textContent = `free ${bytes(watchedBytes)}`;
  $("#status").textContent = "";
}

// ----------------------------------------------------------------- networking

async function enqueue(videos) {
  const res = await fetch("/api/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos, quality: state.quality }),
  });
  if (!res.ok) {
    const detail = (await res.json()).detail || res.status;
    if (isBotWall(detail)) signinToast(detail);
    else toast(`could not queue: ${detail}`, { kind: "err" });
    return;
  }
  const data = await res.json();
  for (const job of data.jobs) state.jobs.set(job.id, job);
  render();
}

async function runSearch(query, { into = "results" } = {}) {
  const s = store.getSettings();
  const params = new URLSearchParams({
    q: query,
    sort: s.sort,
    date: s.uploadDate,
    duration: s.videoDuration,
  });
  const res = await fetch(`/api/search?${params}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "search failed");
  return data;
}

const looksLikeUrl = (s) => /^(https?:\/\/|www\.)/i.test(s.trim());

/** A pasted link names one thing. Go straight to it rather than showing a
    one-item "search result" grid; only a playlist is worth listing. */
async function openLink(url) {
  $("#status").textContent = "opening…";
  try {
    const data = await runSearch(url);
    const entries = data.results || [];
    if (!entries.length) throw new Error("nothing found at that link");
    if (data.kind === "playlist" && entries.length > 1) {
      show("browse");
      setMode("results");
      state.results = entries;
      state.lastQuery = url;
      $("#browse-title").textContent = data.title || "playlist";
      const all = $("#grab-all");
      all.classList.remove("hidden");
      all.textContent = `get all ${entries.length}`;
      all.onclick = () => enqueue(entries.filter((v) => !store.isBlocked(v)));
      render();
      return;
    }
    state.results = entries;
    openWatch(entries[0]);
  } catch (err) {
    show("browse");
    setMode("results");
    $("#status").textContent = String(err.message || err);
    state.results = [];
    $("#empty").textContent = "could not open that link.";
    render();
  }
}

async function doSearch(query) {
  if (looksLikeUrl(query)) return openLink(query);
  $("#status").textContent = "searching…";
  show("browse");
  setMode("results");
  try {
    const data = await runSearch(query);
    state.results = data.results;
    state.lastQuery = query;
    $("#q").value = query;
    $("#browse-title").textContent = data.kind === "playlist" ? data.title : "results";
    const all = $("#grab-all");
    all.classList.toggle("hidden", data.results.length < 2);
    all.textContent = `get all ${data.results.length}`;
    all.onclick = () => enqueue(data.results.filter((v) => !store.isBlocked(v)));
    $("#empty").textContent = "nothing matched, or everything was filtered out.";
    render();
  } catch (err) {
    $("#status").textContent = String(err.message || err);
  }
}

function showLibrary() {
  show("browse");
  setMode("library");
  state.results = [...state.jobs.values()]
    .filter((j) => j.state === "done")
    .sort((a, b) => {
      // Half-watched first: those are the ones you came back for.
      const wa = store.watchState(a.id, a.duration).state === "partial" ? 0 : 1;
      const wb = store.watchState(b.id, b.duration).state === "partial" ? 0 : 1;
      return wa - wb || b.finished - a.finished;
    })
    .map(jobToVideo);
  $("#browse-title").textContent = "library";
  $("#grab-all").classList.add("hidden");
  $("#empty").textContent = "nothing downloaded yet.";
  render();
}

function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = (evt) => {
    const payload = JSON.parse(evt.data);
    if (payload.hello) {
      state.jobs = new Map(payload.jobs.map((j) => [j.id, j]));
    } else if (payload.state === "removed") {
      state.jobs.delete(payload.id);
      if (state.mode === "library") {
        state.results = state.results.filter((v) => v.id !== payload.id);
      }
    } else {
      const previous = state.jobs.get(payload.id);
      state.jobs.set(payload.id, payload);
      handleWatchingUpdate(previous, payload);
    }
    render();
  };
  es.onerror = () => {
    $("#status").textContent = "reconnecting…";
  };
}

function handleWatchingUpdate(previous, job) {
  if (!state.watching || state.watching.id !== job.id || !player) return;
  const playing = !!player.video.currentSrc || !!player.hls;

  if (job.watchable && job.hls && !playing) {
    const ws = store.watchState(job.id, job.duration);
    player.load({
      src: job.hls,
      live: true,
      videoId: job.id,
      duration: state.watching.duration || job.duration,
      poster: job.poster,
      resumeAt: ws.state === "partial" ? ws.resumeAt : 0,
    });
    return;
  }
  if (job.state === "done" && job.media && previous && previous.state !== "done" && playing) {
    player.swapSource(job.media, { live: false });
  }
}

// ------------------------------------------------------------------- filters

function renderChips() {
  const s = store.getSettings();
  const build = (host, key, list) => {
    host.replaceChildren(
      ...list.map((value) => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.dataset.squircle = "";
        chip.dataset.radius = "9";
        chip.dataset.edge = "";
        chip.textContent = value;
        const x = document.createElement("button");
        x.textContent = "×";
        x.onclick = () => {
          store.setSetting(key, store.getSettings()[key].filter((v) => v !== value));
          renderChips();
          render();
        };
        chip.append(x);
        return chip;
      }),
    );
  };
  build($("#chip-words"), "blockedWords", s.blockedWords);
  build($("#chip-channels"), "blockedChannels", s.blockedChannels);
  squircleAll();
}

function wireFilters() {
  const s = store.getSettings();
  const bind = (sel, key, event = "change", prop = "value") => {
    const el = $(sel);
    el[prop] = s[key];
    el.addEventListener(event, () => {
      store.setSetting(key, el[prop]);
      render();
      if (state.mode === "results" && state.lastQuery && prop === "value") doSearch(state.lastQuery);
    });
  };
  bind("#f-sort", "sort");
  bind("#f-date", "uploadDate");
  bind("#f-dur", "videoDuration");
  bind("#f-shorts", "hideShorts", "change", "checked");
  bind("#f-watched", "hideWatched", "change", "checked");
  bind("#f-askdelete", "askDeleteOnFinish", "change", "checked");

  const addTo = (formSel, inputSel, key) => {
    $(formSel).onsubmit = (e) => {
      e.preventDefault();
      const input = $(inputSel);
      const value = input.value.trim();
      if (!value) return;
      const list = store.getSettings()[key];
      if (!list.includes(value)) store.setSetting(key, [...list, value]);
      input.value = "";
      renderChips();
      render();
    };
  };
  addTo("#add-word", "#word-input", "blockedWords");
  addTo("#add-channel", "#channel-input", "blockedChannels");
  renderChips();
}

// ------------------------------------------------------------------- startup

function wireHero() {
  const input = $("#hero-q");
  let timer = 0;
  let seq = 0;

  input.addEventListener("input", () => {
    const value = input.value.trim();
    clearTimeout(timer);
    if (value.length < 2) {
      $("#hero-results").replaceChildren();
      $("#hero-hint").textContent = "type to search · enter for the full grid";
      return;
    }
    // A link is not a query. Do not fire searches at it while it is being
    // pasted; enter opens it directly.
    if (looksLikeUrl(value)) {
      $("#hero-results").replaceChildren();
      $("#hero-hint").textContent = "link detected · enter to open it";
      return;
    }
    $("#hero-hint").textContent = "searching…";
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const data = await runSearch(value);
        if (mine !== seq) return; // a newer keystroke already won
        const list = data.results.filter((v) => !store.isBlocked(v)).slice(0, 6);
        state.results = data.results;
        state.lastQuery = value;
        $("#hero-hint").textContent = `${data.results.length} results · enter for the full grid`;
        $("#hero-results").replaceChildren(...list.map((v) => miniFor(v)));
        squircleAll();
      } catch {
        $("#hero-hint").textContent = "search failed";
      }
    }, 420);
  });

  $("#hero-q").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const value = input.value.trim();
    if (value) doSearch(value);
  });
}

async function init() {
  player = new Player();
  player.onProgress = (id, t, d) => store.saveProgress(id, t, d);
  player.onEnded = async () => {
    const finished = state.watching;
    if (finished) store.markWatched(finished.id, true);
    render();
    // Offer to reclaim the space while it is obvious the video is done with.
    const job = finished && state.jobs.get(finished.id);
    if (job && job.state === "done" && store.getSettings().askDeleteOnFinish) {
      const gone = await offerDeleteOnFinish(job);
      if (gone) return; // nothing to autoplay from a page we just left
    }
    startAutoNext();
  };
  player.onSleep = () => toast("sleep timer: paused", { kind: "info", timeout: 8000 });

  const cfg = await (await fetch("/api/config")).json();
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
  $("#home").onclick = () => {
    show("browse");
    setMode("hero");
    $("#hero-q").value = "";
    $("#hero-results").replaceChildren();
    $("#hero-q").focus();
  };
  $("#tab-subs").onclick = () => {
    state.feedChannel = "";
    showFeed();
  };
  $("#tab-library").onclick = showLibrary;
  $("#add-sub").onsubmit = async (e) => {
    e.preventDefault();
    const input = $("#sub-input");
    const value = input.value.trim();
    if (!value) return;
    // A url or a raw channel id names exactly one channel, so subscribe to it.
    // Anything else is a search: YouTube fuzzy-matches handles and would happily
    // subscribe you to the wrong creator, so show the options and let you pick.
    if (/^https?:\/\//i.test(value) || /^UC[\w-]{22}$/.test(value)) {
      input.value = "";
      if (await subscribe(value)) showFeed();
    } else {
      findChannels(value);
    }
  };
  $("#tab-queue").onclick = () => openDrawer("#drawer");
  $("#tab-filters").onclick = () => openDrawer("#filters");
  $("#drawer-close").onclick = closeDrawers;
  $("#filters-close").onclick = closeDrawers;
  for (const id of ["#drawer", "#filters"]) {
    $(id).onclick = (e) => {
      if (e.target === $(id)) closeDrawers();
    };
  }
  $("#lib-sweep").onclick = sweepWatched;

  const autoplay = $("#autoplay");
  autoplay.checked = store.getSettings().autoplay;
  autoplay.onchange = () => store.setSetting("autoplay", autoplay.checked);

  $("#btn-sleep").onclick = async () => {
    const current = player.sleepRemaining();
    const ok = await confirmDialog({
      title: current ? `Sleep timer: ${current} min left` : "Sleep in 30 minutes?",
      body: current
        ? "Turn the sleep timer off?"
        : "Playback pauses when the timer runs out.",
      confirmLabel: current ? "turn off" : "start",
    });
    if (ok) player.setSleepTimer(current ? 0 : 30);
  };

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#drawer").classList.contains("hidden") || !$("#filters").classList.contains("hidden")) {
        closeDrawers();
      } else if (state.view === "watch") {
        show("browse");
      }
    }
    // "/" focuses search from anywhere, like every other browser-ish thing.
    if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      (state.mode === "hero" ? $("#hero-q") : $("#q")).focus();
    }
  });

  wireHero();
  wireFilters();
  loadChannels();
  connectEvents();
  setMode("hero");
  renderPlaylist();
  squircleAll();
  render();
  $("#hero-q").focus();
}

init();
