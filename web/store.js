// Local state that belongs to the viewer rather than the library: how far into
// each video you got, what you have finished, and the filters you have set.
// All of it is localStorage, so it survives restarts but never leaves the box.

const KEY_PROGRESS = "nagare.progress";
const KEY_SETTINGS = "nagare.settings";

// Below this we assume you were just sampling and had not really started.
const STARTED_SECONDS = 15;
// Above this the credits are rolling; call it watched. Same threshold AniBeam
// uses to decide an episode counts.
const WATCHED_FRACTION = 0.85;

function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "") ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or private mode: progress just stops persisting */
  }
}

// ------------------------------------------------------------------ progress

/** @type {Record<string, {t:number, d:number, watched:boolean, at:number}>} */
let progress = read(KEY_PROGRESS, {});

export function getProgress(videoId) {
  return progress[videoId] || null;
}

export function saveProgress(videoId, t, d) {
  if (!videoId || !isFinite(t) || t < 0) return;
  const previous = progress[videoId];
  const watched = d > 0 ? t / d >= WATCHED_FRACTION : previous?.watched || false;
  progress[videoId] = {
    t,
    d: d || previous?.d || 0,
    watched: watched || previous?.watched || false,
    at: Date.now(),
  };
  write(KEY_PROGRESS, progress);
}

export function markWatched(videoId, watched = true) {
  const p = progress[videoId] || { t: 0, d: 0, at: Date.now() };
  progress[videoId] = { ...p, watched, at: Date.now() };
  write(KEY_PROGRESS, progress);
}

export function clearProgress(videoId) {
  delete progress[videoId];
  write(KEY_PROGRESS, progress);
}

/** How the library should describe this item. */
export function watchState(videoId, duration) {
  const p = getProgress(videoId);
  if (!p) return { state: "unwatched", fraction: 0, resumeAt: 0 };
  const d = duration || p.d || 0;
  const fraction = d ? Math.min(p.t / d, 1) : 0;
  if (p.watched) return { state: "watched", fraction: 1, resumeAt: 0 };
  if (p.t >= STARTED_SECONDS && fraction < WATCHED_FRACTION) {
    return { state: "partial", fraction, resumeAt: p.t };
  }
  return { state: "unwatched", fraction, resumeAt: 0 };
}

// ------------------------------------------------------------------ settings

const DEFAULTS = {
  // Off. Having the next video start on its own is the single most intrusive
  // thing a player can do; opt in from the watch page if you want it.
  autoplay: false,
  sponsorblock: true,
  blockedWords: [],
  blockedChannels: [],
  hideShorts: true,
  hideWatched: false,
  askDeleteOnFinish: true,
  sort: "relevance",
  uploadDate: "any",
  videoDuration: "any",
  // What a search should come back with: everything, or only one kind of thing.
  searchOnly: "all",
};

// Bump when a default changes in a way that should override what is already
// stored. Without this, anyone who ran the old build keeps autoplay on forever,
// because their settings object already has autoplay: true written into it.
const SETTINGS_VERSION = 2;

let settings = { ...DEFAULTS, ...read(KEY_SETTINGS, {}) };
if (settings.version !== SETTINGS_VERSION) {
  settings = { ...settings, autoplay: false, version: SETTINGS_VERSION };
  write(KEY_SETTINGS, settings);
}

export function getSettings() {
  return settings;
}

export function setSetting(key, value) {
  settings = { ...settings, [key]: value };
  write(KEY_SETTINGS, settings);
  return settings;
}

/** True when a search result should be hidden by the user's block rules. */
export function isBlocked(video) {
  const s = settings;
  const title = (video.title || "").toLowerCase();
  const channel = (video.uploader || "").toLowerCase();
  if (s.hideShorts && video.duration && video.duration > 0 && video.duration <= 60) return true;
  if (s.blockedChannels.some((c) => c && channel.includes(c.toLowerCase()))) return true;
  if (s.blockedWords.some((w) => w && title.includes(w.toLowerCase()))) return true;
  if (s.hideWatched && watchState(video.id, video.duration).state === "watched") return true;
  return false;
}
