// The player. Structure follows AniBeam's: a floating control island over the
// video, a scrub bar that layers buffered / segment bands / played on one track,
// a hover bubble with a decoded frame preview, and chrome that hides when idle.
// Restyled for Greensteel and taught about live HLS and SponsorBlock.

import { squircleAll } from "/static/squircle.js";

const ICON = {
  play: '<path d="M6 4l14 8-14 8z"/>',
  pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z"/>',
  back: '<path d="M11 12l8-5v10zM3 12l8-5v10z"/>',
  fwd: '<path d="M13 12L5 7v10zM21 12l-8-5v10z"/>',
  vol: '<path d="M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9l6 6M22 9l-6 6" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  full: '<path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  exitFull: '<path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  pip: '<rect x="3" y="5" width="18" height="14" rx="1" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="12" y="11" width="7" height="6" fill="currentColor"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" fill="none" stroke="currentColor" stroke-width="1.8"/>',
};

const svg = (body) => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${body}</svg>`;
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const IDLE_MS = 2200;

export function formatTime(total) {
  if (!isFinite(total) || total < 0) return "0:00";
  const s = Math.floor(total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export class Player {
  constructor() {
    this.video = document.querySelector("#video");
    this.wrap = document.querySelector("#player-wrap");
    this.controls = document.querySelector("#player-controls");
    this.scrub = document.querySelector("#scrub");
    this.scrubWrap = document.querySelector("#scrub-wrap");
    this.played = document.querySelector("#scrub-played");
    this.buffered = document.querySelector("#scrub-buffered");
    this.bandsEl = document.querySelector("#scrub-bands");
    this.knob = document.querySelector("#scrub-knob");
    this.bubble = document.querySelector("#scrub-bubble");
    this.bubbleTime = document.querySelector("#scrub-bubble-time");
    this.preview = document.querySelector("#scrub-preview");
    this.timeEl = document.querySelector("#ptime");
    this.centre = document.querySelector("#player-center");
    this.livePill = document.querySelector("#live-pill");
    this.toast = document.querySelector("#sb-toast");
    this.toastText = document.querySelector("#sb-toast-text");
    this.manual = document.querySelector("#sb-manual");
    this.manualText = document.querySelector("#sb-manual-text");

    this.hls = null;
    this.segments = [];
    this.sbEnabled = localStorage.getItem("nagare.sb") !== "0";
    this.skipped = new Set();
    this.lastSkip = null;
    this.dragging = false;
    this.live = false;
    this.knownDuration = 0;
    this.previewVideo = null;
    this.previewSrc = "";
    this.idleTimer = 0;
    this.toastTimer = 0;

    // Callbacks the app fills in.
    this.onProgress = null; // (videoId, currentTime, duration)
    this.onEnded = null; // () => play the next thing
    this.onSleep = null; // () => the sleep timer fired

    this.sleepAt = 0; // epoch ms, 0 = off
    this.sleepTimer = 0;
    this.holdTimer = 0;
    this.holdRate = 0; // the rate we were on before a press-and-hold
    this._lastSave = 0;

    this._wire();
  }

  // ------------------------------------------------------------ sleep timer

  /** @param {number} minutes 0 clears the timer. */
  setSleepTimer(minutes) {
    clearTimeout(this.sleepTimer);
    if (!minutes) {
      this.sleepAt = 0;
      this._showToast("sleep timer off");
      return;
    }
    this.sleepAt = Date.now() + minutes * 60000;
    this.sleepTimer = setTimeout(() => {
      this.video.pause();
      this.sleepAt = 0;
      this.onSleep?.();
    }, minutes * 60000);
    this._showToast(`sleeping in ${minutes} min`);
  }

  sleepRemaining() {
    if (!this.sleepAt) return 0;
    return Math.max(0, Math.round((this.sleepAt - Date.now()) / 60000));
  }

  // ------------------------------------------------------------------ wiring

  _wire() {
    const v = this.video;
    const btn = (id) => document.querySelector(id);

    this.btnPlay = btn("#btn-play");
    this.btnMute = btn("#btn-mute");
    this.btnFull = btn("#btn-full");
    this.btnPip = btn("#btn-pip");
    this.btnSpeed = btn("#btn-speed");
    this.btnSb = btn("#btn-sb");
    this.vol = btn("#vol");

    this.btnPlay.innerHTML = svg(ICON.play);
    btn("#btn-back").innerHTML = svg(ICON.back);
    btn("#btn-fwd").innerHTML = svg(ICON.fwd);
    this.btnMute.innerHTML = svg(ICON.vol);
    this.btnFull.innerHTML = svg(ICON.full);
    this.btnPip.innerHTML = svg(ICON.pip);
    this.btnSb.innerHTML = svg(ICON.shield);
    this.btnSb.classList.toggle("on", this.sbEnabled);
    this.btnSb.classList.toggle("off", !this.sbEnabled);

    this.btnPlay.onclick = () => this.toggle();
    btn("#btn-back").onclick = () => this.nudge(-10);
    btn("#btn-fwd").onclick = () => this.nudge(10);
    this.btnMute.onclick = () => this.toggleMute();
    this.btnFull.onclick = () => this.toggleFullscreen();
    this.btnPip.onclick = () => this.togglePip();
    this.btnSpeed.onclick = () => this.cycleSpeed();
    this.btnSb.onclick = () => this.toggleSponsorBlock();
    btn("#sb-undo").onclick = (e) => {
      e.stopPropagation();
      this.undoSkip();
    };
    this.manual.onclick = () => this.takeManualSkip();

    const savedVol = parseFloat(localStorage.getItem("nagare.vol") ?? "1");
    v.volume = isFinite(savedVol) ? savedVol : 1;
    this.vol.value = String(v.volume);
    this.vol.oninput = () => {
      v.volume = parseFloat(this.vol.value);
      v.muted = v.volume === 0;
      localStorage.setItem("nagare.vol", String(v.volume));
      this._paintVolume();
    };

    v.addEventListener("timeupdate", () => this._paintProgress());
    v.addEventListener("progress", () => this._paintBuffered());
    v.addEventListener("durationchange", () => this._paintProgress());
    v.addEventListener("play", () => this._paintPlay());
    v.addEventListener("pause", () => this._paintPlay());
    v.addEventListener("volumechange", () => this._paintVolume());
    v.addEventListener("ratechange", () => {
      this.btnSpeed.textContent = `${v.playbackRate}x`;
    });
    v.addEventListener("ended", () => {
      if (this.videoId) this.onProgress?.(this.videoId, this._duration(), this._duration());
      this.onEnded?.();
    });

    // Press and hold anywhere on the picture to run at 2x, release to drop back.
    // Lifted straight from PipePipe, and it is the one gesture that genuinely
    // earns its place on a desktop too.
    v.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      clearTimeout(this.holdTimer);
      this.holdTimer = setTimeout(() => {
        this.holdRate = v.playbackRate;
        v.playbackRate = 2;
        this._showToast("2x while held");
      }, 450);
    });
    const endHold = () => {
      clearTimeout(this.holdTimer);
      if (this.holdRate) {
        v.playbackRate = this.holdRate;
        this.holdRate = 0;
        this.toast.classList.add("hidden");
      }
    };
    v.addEventListener("pointerup", endHold);
    v.addEventListener("pointerleave", endHold);
    v.addEventListener("pointercancel", endHold);

    // A click that was not a hold toggles playback.
    v.addEventListener("click", () => {
      if (this.holdRate) return;
      this.toggle();
    });

    // Scrub: drive from the invisible range input so keyboard works too.
    this.scrub.addEventListener("input", () => {
      this.dragging = true;
      const t = (parseFloat(this.scrub.value) / 1000) * this._duration();
      this._paintProgress(t);
    });
    const release = () => {
      if (!this.dragging) return;
      this.dragging = false;
      const t = (parseFloat(this.scrub.value) / 1000) * this._duration();
      this.seek(t);
    };
    this.scrub.addEventListener("change", release);
    this.scrub.addEventListener("pointerup", release);

    this.scrubWrap.addEventListener("pointermove", (e) => this._hover(e));
    this.scrubWrap.addEventListener("pointerleave", () => this._hoverEnd());

    // Idle chrome.
    for (const evt of ["pointermove", "pointerdown", "keydown"]) {
      this.wrap.addEventListener(evt, () => this._wake());
    }
    this.wrap.addEventListener("pointerleave", () => {
      if (!this.video.paused) this._sleep();
    });
    document.addEventListener("fullscreenchange", () => {
      this.btnFull.innerHTML = svg(document.fullscreenElement ? ICON.exitFull : ICON.full);
      squircleAll();
    });

    document.addEventListener("keydown", (e) => this._key(e));
    this._paintVolume();
  }

  // ------------------------------------------------------------------ source

  /** @param {{src:string, live:boolean, videoId:string, duration:number, poster:string}} opts */
  async load(opts) {
    this.unload();
    const v = this.video;
    this.live = !!opts.live;
    this.knownDuration = opts.duration || 0;
    this.videoId = opts.videoId;
    this.previewSrc = this.live ? "" : opts.src;
    if (opts.poster) v.poster = opts.poster;

    this.livePill.classList.toggle("hidden", !this.live);

    if (this.live && window.Hls && window.Hls.isSupported()) {
      this.hls = new window.Hls({
        // The playlist grows while we watch. Start at the beginning, not at the
        // live edge, and keep everything already downloaded seekable.
        startPosition: 0,
        lowLatencyMode: false,
        backBufferLength: Infinity,
      });
      this.hls.loadSource(opts.src);
      this.hls.attachMedia(v);
      this.hls.on(window.Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}));
      this.hls.on(window.Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) this.hls.startLoad();
        else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) this.hls.recoverMediaError();
      });
    } else {
      v.src = opts.src;
      v.play().catch(() => {});
    }

    // Pick up where we left off, once the source knows how long it is.
    if (opts.resumeAt && opts.resumeAt > 1) {
      const resume = () => {
        this.video.currentTime = opts.resumeAt;
        this._showToast(`resumed at ${formatTime(opts.resumeAt)}`);
      };
      if (v.readyState >= 1) resume();
      else v.addEventListener("loadedmetadata", resume, { once: true });
    }

    this.setSegments([]);
    if (opts.videoId) this._loadSegments(opts.videoId);
    this._paintProgress();
    this._wake();
  }

  unload() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.skipped.clear();
    this.lastSkip = null;
    this.segments = [];
    this.bandsEl.replaceChildren();
    this.manual.classList.add("hidden");
    this.toast.classList.add("hidden");
    if (this.previewVideo) {
      this.previewVideo.remove();
      this.previewVideo = null;
    }
  }

  /** Switch source without losing the playhead (live HLS -> finished file). */
  async swapSource(src, { live }) {
    const at = this.video.currentTime;
    const wasPlaying = !this.video.paused;
    const segments = this.segments;
    await this.load({
      src,
      live,
      videoId: this.videoId,
      duration: this.knownDuration,
    });
    this.setSegments(segments);
    const resume = () => {
      this.video.currentTime = at;
      if (wasPlaying) this.video.play().catch(() => {});
    };
    if (this.video.readyState >= 1) resume();
    else this.video.addEventListener("loadedmetadata", resume, { once: true });
  }

  // ------------------------------------------------------------ sponsorblock

  async _loadSegments(videoId) {
    try {
      const res = await fetch(`/api/sponsorblock/${videoId}`);
      const data = await res.json();
      if (this.videoId === videoId) this.setSegments(data.segments || []);
    } catch {
      /* offline or blocked: the player just has no bands */
    }
  }

  setSegments(segments) {
    this.segments = segments || [];
    this._paintBands();
  }

  _paintBands() {
    const d = this._duration();
    if (!d) {
      this.bandsEl.replaceChildren();
      return;
    }
    const nodes = this.segments.map((s) => {
      const el = document.createElement("div");
      el.className = `band ${s.category}`;
      el.style.left = `${(s.start / d) * 100}%`;
      el.style.width = `${Math.max(((s.end - s.start) / d) * 100, 0.4)}%`;
      el.title = s.label;
      return el;
    });
    this.bandsEl.replaceChildren(...nodes);
  }

  _checkSegments(t) {
    if (!this.segments.length) return;
    const seg = this.segments.find(
      (s) => t >= s.start && t < s.end - 0.2 && s.action !== "poi",
    );
    if (!seg) {
      this.manual.classList.add("hidden");
      return;
    }
    if (!this.sbEnabled) {
      this.manualText.textContent = `skip ${seg.label}`;
      this.manual.classList.remove("hidden");
      this.pendingSkip = seg;
      return;
    }
    if (this.skipped.has(seg.uuid)) return;
    this.skipped.add(seg.uuid);
    this.lastSkip = { from: t, seg };
    this.video.currentTime = seg.end;
    this._showToast(`skipped ${seg.label}`);
  }

  takeManualSkip() {
    if (!this.pendingSkip) return;
    this.video.currentTime = this.pendingSkip.end;
    this.manual.classList.add("hidden");
  }

  undoSkip() {
    if (!this.lastSkip) return;
    this.video.currentTime = this.lastSkip.from;
    this.skipped.delete(this.lastSkip.seg.uuid);
    this.lastSkip = null;
    this.toast.classList.add("hidden");
  }

  _showToast(text) {
    this.toastText.textContent = text;
    this.toast.classList.remove("hidden");
    squircleAll();
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.classList.add("hidden"), 5000);
  }

  toggleSponsorBlock() {
    this.sbEnabled = !this.sbEnabled;
    localStorage.setItem("nagare.sb", this.sbEnabled ? "1" : "0");
    this.btnSb.classList.toggle("on", this.sbEnabled);
    this.btnSb.classList.toggle("off", !this.sbEnabled);
    this._showToast(this.sbEnabled ? "sponsorblock on" : "sponsorblock off");
  }

  // -------------------------------------------------------------- transport

  _duration() {
    const d = this.video.duration;
    if (isFinite(d) && d > 0) return d;
    return this.knownDuration || 0;
  }

  toggle() {
    if (this.video.paused) this.video.play().catch(() => {});
    else this.video.pause();
  }

  nudge(by) {
    this.seek(this.video.currentTime + by);
  }

  seek(t) {
    const d = this._duration();
    this.video.currentTime = Math.max(0, Math.min(t, d ? d - 0.05 : t));
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
  }

  cycleSpeed() {
    const i = SPEEDS.indexOf(this.video.playbackRate);
    this.video.playbackRate = SPEEDS[(i + 1) % SPEEDS.length] ?? 1;
  }

  async toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await this.wrap.requestFullscreen().catch(() => {});
  }

  async togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await this.video.requestPictureInPicture();
    } catch {
      /* not supported for this source */
    }
  }

  _key(e) {
    if (document.querySelector("#view-watch").classList.contains("hidden")) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const k = e.key;
    const map = {
      " ": () => this.toggle(),
      k: () => this.toggle(),
      j: () => this.nudge(-10),
      l: () => this.nudge(10),
      ArrowLeft: () => this.nudge(-5),
      ArrowRight: () => this.nudge(5),
      ArrowUp: () => this._bumpVolume(0.05),
      ArrowDown: () => this._bumpVolume(-0.05),
      f: () => this.toggleFullscreen(),
      m: () => this.toggleMute(),
      p: () => this.togglePip(),
      ",": () => this.nudge(-1 / 30),
      ".": () => this.nudge(1 / 30),
      "<": () => this._stepSpeed(-1),
      ">": () => this._stepSpeed(1),
    };
    if (map[k]) {
      e.preventDefault();
      map[k]();
      this._wake();
      return;
    }
    if (/^[0-9]$/.test(k)) {
      e.preventDefault();
      const d = this._duration();
      if (d) this.seek((parseInt(k, 10) / 10) * d);
      this._wake();
    }
  }

  _bumpVolume(by) {
    const v = this.video;
    v.volume = Math.max(0, Math.min(1, v.volume + by));
    v.muted = v.volume === 0;
    localStorage.setItem("nagare.vol", String(v.volume));
  }

  _stepSpeed(dir) {
    const i = SPEEDS.indexOf(this.video.playbackRate);
    const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 3 : i) + dir))];
    this.video.playbackRate = next;
  }

  // ---------------------------------------------------------------- painting

  _paintPlay() {
    const playing = !this.video.paused;
    this.btnPlay.innerHTML = svg(playing ? ICON.pause : ICON.play);
    this.centre.innerHTML = svg(playing ? ICON.play : ICON.pause);
    this.centre.classList.add("show");
    setTimeout(() => this.centre.classList.remove("show"), 320);
    if (playing) this._sleepSoon();
    else this._wake();
  }

  _paintVolume() {
    const v = this.video;
    const off = v.muted || v.volume === 0;
    this.btnMute.innerHTML = svg(off ? ICON.mute : ICON.vol);
    this.vol.value = String(off ? 0 : v.volume);
  }

  _paintProgress(overrideTime) {
    const d = this._duration();
    const t = overrideTime ?? this.video.currentTime;
    const pct = d ? Math.max(0, Math.min(1, t / d)) : 0;
    this.played.style.width = `${pct * 100}%`;
    this.knob.style.left = `${pct * 100}%`;
    if (!this.dragging) this.scrub.value = String(Math.round(pct * 1000));
    this.timeEl.textContent = `${formatTime(t)} / ${formatTime(d)}`;
    if (this.bandsEl.childElementCount !== this.segments.length) this._paintBands();
    if (!this.dragging && overrideTime === undefined) this._checkSegments(t);
    this._paintBuffered();

    // Persist the playhead a few times a minute, not on every timeupdate.
    if (overrideTime === undefined && this.videoId && d > 0) {
      const now = Date.now();
      if (now - this._lastSave > 4000) {
        this._lastSave = now;
        this.onProgress?.(this.videoId, t, d);
      }
    }
  }

  _paintBuffered() {
    const d = this._duration();
    const b = this.video.buffered;
    if (!d || !b.length) return;
    this.buffered.style.width = `${Math.min(1, b.end(b.length - 1) / d) * 100}%`;
  }

  // ------------------------------------------------------------ hover bubble

  _hover(e) {
    const d = this._duration();
    if (!d) return;
    const rect = this.scrubWrap.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const t = (x / rect.width) * d;

    this.bubble.classList.remove("hidden");
    this.bubbleTime.textContent = formatTime(t);
    this._previewFrame(t);
    squircleAll();

    // The bubble is a child of the player root, so place it in the root's
    // coordinates: follow the cursor along the scrubber, and sit just above the
    // control island whatever height that island happens to be.
    const wrapRect = this.wrap.getBoundingClientRect();
    const islandRect = this.controls.getBoundingClientRect();
    const width = this.bubble.offsetWidth || 172;
    const half = width / 2;
    const wanted = rect.left - wrapRect.left + x;
    const left = Math.max(half + 6, Math.min(wanted, wrapRect.width - half - 6));

    this.bubble.style.left = `${left}px`;
    this.bubble.style.bottom = `${Math.max(wrapRect.bottom - islandRect.top + 10, 12)}px`;
  }

  _hoverEnd() {
    this.bubble.classList.add("hidden");
  }

  /** Decode a frame at `t` into the bubble. Only for finished local files:
      a growing HLS playlist cannot be seeked in a second element cheaply. */
  _previewFrame(t) {
    if (!this.previewSrc) {
      this.preview.classList.add("hidden");
      return;
    }
    this.preview.classList.remove("hidden");
    if (!this.previewVideo) {
      const pv = document.createElement("video");
      pv.src = this.previewSrc;
      pv.muted = true;
      pv.preload = "metadata";
      pv.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none";
      pv.addEventListener("seeked", () => {
        const ctx = this.preview.getContext("2d");
        if (!ctx || !pv.videoWidth) return;
        ctx.drawImage(pv, 0, 0, this.preview.width, this.preview.height);
      });
      this.wrap.append(pv);
      this.previewVideo = pv;
    }
    clearTimeout(this._previewTimer);
    this._previewTimer = setTimeout(() => {
      if (this.previewVideo && this.previewVideo.readyState >= 1) {
        this.previewVideo.currentTime = t;
      }
    }, 60);
  }

  // ------------------------------------------------------------- idle chrome

  _wake() {
    this.controls.classList.remove("is-hidden");
    this.wrap.classList.remove("cursor-hidden");
    this._sleepSoon();
  }

  _sleepSoon() {
    clearTimeout(this.idleTimer);
    if (this.video.paused) return;
    this.idleTimer = setTimeout(() => this._sleep(), IDLE_MS);
  }

  _sleep() {
    if (this.video.paused) return;
    this.controls.classList.add("is-hidden");
    this.wrap.classList.add("cursor-hidden");
    this._hoverEnd();
  }
}
