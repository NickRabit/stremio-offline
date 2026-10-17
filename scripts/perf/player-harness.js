// Loaded into a signed-in page of the measurement instance (perf-instance.sh serves this folder
// as /perf/ and hls.js as /perf-hls.js; run-matrix.mjs drives it). It repeats what the web player does -- inspect when
// a source is selected, start, hls.js with the player's settings, seek through the server when
// the target is outside the converted stretch -- and times each step to the first painted frame.
//
//   await import("/perf/player-harness.js"); const result = await window.perf.run({ ... });
(() => {
  const HLS_PLAYER_CONFIG = {
    maxBufferLength: 25, maxMaxBufferLength: 45, backBufferLength: 60, maxBufferHole: 1,
    maxBufferSize: 40 * 1000 * 1000, liveDurationInfinity: true, liveSyncDurationCount: 3,
    startOnSegmentBoundary: true, maxLiveSyncPlaybackRate: 1, testBandwidth: false,
  };
  const supports = (type) => { try { return MediaSource.isTypeSupported(type); } catch { return false; } };
  const browserCaps = () => ({
    h264: supports('video/mp4; codecs="avc1.640029"'), hevc: supports('video/mp4; codecs="hvc1.1.6.L93.B0"'),
    hevc10: supports('video/mp4; codecs="hvc1.2.4.L153.B0"'), vp8: supports('video/webm; codecs="vp8"'),
    vp9: supports('video/mp4; codecs="vp09.00.10.08"'), av1: supports('video/mp4; codecs="av01.0.05M.08"'),
    aac: supports('audio/mp4; codecs="mp4a.40.2"'), mp3: supports('audio/mp4; codecs="mp4a.40.34"'),
    opus: supports('audio/mp4; codecs="opus"'), vorbis: supports('audio/webm; codecs="vorbis"'),
    ac3: supports('audio/mp4; codecs="ac-3"'), eac3: supports('audio/mp4; codecs="ec-3"'), flac: supports('audio/mp4; codecs="flac"'),
  });
  // direct: what this browser declares. native: a native client (Android TV) that plays H.264 and
  // AAC but no file container, so the server copies an MP4's picture into HLS. A transcode is
  // asked for with `quality`, as the player's quality menu does.
  const CAPS = {
    direct: () => browserCaps(),
    native: () => ({ containers: ["hls"], h264: true, aac: true, audioDecode: ["aac", "mp3"] }),
  };

  const json = async (url, options = {}) => {
    const response = await fetch(url, { ...options, headers: { "content-type": "application/json", ...(options.headers ?? {}) } });
    const text = await response.text();
    if (!response.ok) throw new Error(`${options.method ?? "GET"} ${url.split("?")[0]} ${response.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : undefined;
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function mintSource(source) {
    if (source.kind === "library") return json("/api/library/source", { method: "POST", body: JSON.stringify({ path: source.path }) });
    if (source.kind === "addon") {
      const streams = await json(`/api/streams/movie/${source.id}?addon=${encodeURIComponent(source.addon)}`);
      return streams[source.index];
    }
    const answer = await json(`/api/remote-libraries/${source.library}/items/${source.item}/sources`);
    return answer.streams[0];
  }

  /** Resolves with the wall-clock time of the first frame painted after `since`. */
  function nextFrame(video, timeoutMs, since = performance.now()) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no frame")), timeoutMs);
      const check = () => video.requestVideoFrameCallback((now) => {
        if (now < since) return check();
        clearTimeout(timer); resolve(performance.now());
      });
      check();
    });
  }

  class Run {
    constructor(options) {
      this.options = options; this.marks = { wallStart: Date.now() }; this.events = [];
      this.t0 = performance.now();
      this.video = document.createElement("video");
      this.video.muted = true; this.video.playsInline = true;
      Object.assign(this.video.style, { position: "fixed", right: "8px", bottom: "8px", width: "320px", zIndex: 99999, background: "#000" });
      document.body.append(this.video);
      this.stalls = 0; this.stallMs = 0;
      this.video.addEventListener("waiting", () => { this.waitingAt = performance.now(); });
      this.video.addEventListener("playing", () => {
        if (this.waitingAt !== undefined && this.counting) { this.stalls += 1; this.stallMs += performance.now() - this.waitingAt; }
        this.waitingAt = undefined;
      });
    }
    mark(name) { this.marks[name] = Math.round(performance.now() - this.t0); this.marks[`${name}Wall`] = Date.now(); }

    attach(session, startAt = 0) {
      this.hls?.destroy(); this.hls = undefined;
      this.session = session;
      const video = this.video;
      if (session.playlist !== false && session.mode !== "direct") {
        const hls = new window.Hls({ ...HLS_PLAYER_CONFIG });
        this.hls = hls;
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => { this.mark(`${this.phase}Manifest`); void video.play().catch(() => undefined); });
        hls.on(window.Hls.Events.FRAG_LOADED, (_e, data) => { if (!this.marks[`${this.phase}Frag`]) this.mark(`${this.phase}Frag`); this.fragBytes = (this.fragBytes ?? 0) + (data.frag?.stats?.total ?? 0); });
        hls.on(window.Hls.Events.ERROR, (_e, data) => this.events.push({ at: Math.round(performance.now() - this.t0), details: data.details, fatal: data.fatal }));
        hls.loadSource(session.url); hls.attachMedia(video);
      } else {
        video.src = session.url;
        if (startAt) video.addEventListener("loadedmetadata", () => { video.currentTime = startAt; }, { once: true });
        void video.play().catch(() => undefined);
      }
    }

    position() { return (this.session?.mode === "direct" ? 0 : this.session?.offset ?? 0) + this.video.currentTime; }

    async seek(target, name) {
      this.phase = name;
      const video = this.video;
      const begun = performance.now();
      this.mark(`${name}Begin`);
      if (this.session.mode === "direct") {
        video.currentTime = target;
        await nextFrame(video, 60_000, begun);
        await this.untilPlaying(60_000);
        this.mark(`${name}Frame`);
        return;
      }
      const relative = target - this.session.offset;
      const end = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0;
      if (relative >= 0 && relative <= Math.max(0, end - 0.5)) {
        this.marks[`${name}Plan`] = "native";
        video.currentTime = relative;
        await nextFrame(video, 60_000, begun);
        this.mark(`${name}Frame`);
        return;
      }
      this.marks[`${name}Plan`] = "restart";
      video.pause();
      const next = await json(`/api/playback/${this.session.id}/seek`, { method: "POST", body: JSON.stringify({ time: target }) });
      this.mark(`${name}Answer`);
      this.marks[`${name}Offset`] = Math.round(next.offset);
      this.attach(next);
      await nextFrame(video, 60_000, begun);
      await this.untilPlaying(60_000);
      this.mark(`${name}Frame`);
    }

    async untilPlaying(timeoutMs) {
      const deadline = performance.now() + timeoutMs;
      const startTime = this.video.currentTime;
      while (performance.now() < deadline) {
        if (!this.video.paused && this.video.readyState >= 3 && this.video.currentTime > startTime) return;
        await sleep(20);
      }
      throw new Error("playback did not advance");
    }

    async play(seconds) {
      this.counting = true;
      const until = performance.now() + seconds * 1000;
      while (performance.now() < until) await sleep(250);
      this.counting = false;
    }

    async execute() {
      const { source, path: route, quality, waitForInspect = false, inspectLeadMs = 0, playSeconds = 20, seekFraction = 0.5, backTo = 30 } = this.options;
      try {
        const stream = await mintSource(source);
        this.mark("minted");
        // The detail page inspects the selected source; the viewer presses Play some time later.
        const inspection = json("/api/inspect", { method: "POST", body: JSON.stringify({ sourceId: stream.sourceId }) })
          .then((value) => { this.mark("inspected"); this.duration = value?.duration; return value; });
        if (waitForInspect) await inspection; else await sleep(inspectLeadMs);
        this.phase = "start";
        this.mark("play");
        const capabilities = CAPS[route]();
        const session = await json("/api/playback", { method: "POST", body: JSON.stringify({ sourceId: stream.sourceId, capabilities, time: 0, subtitleIds: [], subtitleLanguage: null, ...(quality ? { quality } : {}) }) });
        this.mark("startAnswer");
        await inspection.catch(() => undefined);
        this.marks.mode = session.mode; this.marks.copy = session.copy; this.marks.hardware = session.hardware;
        this.duration ??= session.duration;
        const playClick = performance.now();
        this.attach(session);
        await nextFrame(this.video, 90_000, playClick);
        this.mark("firstFrame");
        await this.untilPlaying(60_000);
        this.mark("advancing");
        await this.play(playSeconds);
        this.mark("steadyEnd");
        this.marks.positionBeforeSeek = Math.round(this.position());
        await this.seek(Math.round((this.duration ?? 0) * seekFraction), "seekMid");
        await this.play(5);
        await this.seek(backTo, "seekBack");
        await this.play(5);
        this.mark("done");
        this.marks.positionEnd = Math.round(this.position());
      } catch (error) {
        this.marks.error = error.message;
      } finally {
        this.hls?.destroy();
        this.video.remove();
        if (this.session) await fetch(`/api/playback/${this.session.id}`, { method: "DELETE" }).catch(() => undefined);
        this.marks.stalls = this.stalls; this.marks.stallMs = Math.round(this.stallMs);
        this.marks.hlsFragBytes = this.fragBytes;
        this.marks.events = this.events.slice(0, 10);
        this.marks.wallEnd = Date.now();
      }
      return { label: this.options.label, ...this.marks };
    }
  }

  window.perf = {
    async ready() {
      if (window.Hls) return;
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "/perf-hls.js"; script.onload = resolve; script.onerror = reject;
        document.head.append(script);
      });
    },
    async run(options) { await this.ready(); return new Run(options).execute(); },
  };
})();
