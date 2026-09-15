import { enterPlayerFullscreen, exitPlayerFullscreen, playerIsFullscreen, supportsPlayerFullscreen } from "./player-fullscreen";
import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import { AudioLines, Captions, CaptionsOff, Check, Download, HardDrive, Star, Gauge, Maximize, Minimize, Pause, Play, RotateCcw, RotateCw, Settings, SlidersHorizontal, SkipBack, SkipForward, Volume2, X } from "lucide-react";
import { ApiError, api, describeError, subtitleUrl } from "./api";
import { watchSidecar } from "./player-sidecar";
import { label, pickAddonSubtitle } from "./languages";
import { hostOf, report } from "./diagnostics";
import { releaseMediaElement, AHEAD_CATCHUP_MS, HLS_PLAYER_CONFIG, ignoreHlsErrorDuringRestart, planDecodeRecovery, planSeek, recordDecodeRecover, waitForSeekable } from "./player-hls";
import { detectCapabilities } from "./capabilities";
import { t, useI18n, type Key } from "./i18n";
import type { Capabilities, PlaybackMode, PlaybackSession, Stream, Subtitle, Track } from "./types";

interface Props { previousTitle?: string; onPrevious?: () => Promise<void>; nextTitle?: string; nextBusy?: boolean; onNext?: () => Promise<void>; open: boolean; title: string; stream: Stream | null; subtitles: Subtitle[]; subtitleLanguage: string; audioLanguage: string; progressKey?: string; progressPoster?: string; favorite?: boolean; onToggleFavorite?: () => void; onDownload: () => Promise<boolean>; onDeviceDownload: () => Promise<boolean>; onClose: () => void }

const fmt = (seconds: number) => !Number.isFinite(seconds) ? "0:00" : `${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}:` : ""}${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** Native range thumbs are the only draggable part on iOS. A press anywhere on
 *  the track grabs the current position; the finger then nudges it by how far
 *  it moves, instead of jumping to the press point. A tap still seeks there. */
const TAP_PX = 10;

const timeAtClientX = (clientX: number, track: HTMLElement, max: number) => {
  const rect = track.getBoundingClientRect();
  if (rect.width <= 0 || max <= 0) return 0;
  return Math.min(max, Math.max(0, ((clientX - rect.left) / rect.width) * max));
};

const timeFromDelta = (clientX: number, track: HTMLElement, startX: number, startValue: number, max: number) => {
  const width = track.getBoundingClientRect().width;
  if (width <= 0 || max <= 0) return startValue;
  return Math.min(max, Math.max(0, startValue + ((clientX - startX) / width) * max));
};

function PreviewFrame({ sessionId, time }: { sessionId: string; time: number }) {
  const [image, setImage] = useState<string>();
  const bucket = useRef(0);
  bucket.current = Math.floor(time / 5) * 5;
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    let previous: number | undefined;
    let timer: ReturnType<typeof setTimeout>;
    setImage(undefined);
    const refresh = async () => {
      let delay = 250;
      try {
        const at = bucket.current;
        if (at !== previous) {
          const response = await fetch(`/api/playback/${encodeURIComponent(sessionId)}/preview?time=${at}`, { signal: controller.signal });
          if (response.status === 200) {
            const blob = await response.blob();
            if (controller.signal.aborted) return;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            objectUrl = URL.createObjectURL(blob);
            setImage(objectUrl);
            previous = at;
          } else delay = 1000;
        }
      } catch { delay = 1000; }
      if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), delay);
    };
    timer = setTimeout(() => void refresh(), 250);
    return () => { clearTimeout(timer); controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [sessionId]);
  return image ? <img src={image} alt="" /> : null;
}

function TimelineBar({ value, max, sessionId, onScrub, onSeek, onReveal }: {
  value: number; max: number; sessionId?: string; onScrub: (value: number | null) => void; onSeek: (value: number) => void; onReveal: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startValue: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const maxRef = useRef(max);
  const valueRef = useRef(value);
  const onScrubRef = useRef(onScrub);
  const onSeekRef = useRef(onSeek);
  const onRevealRef = useRef(onReveal);
  maxRef.current = max;
  valueRef.current = value;
  onScrubRef.current = onScrub;
  onSeekRef.current = onSeek;
  onRevealRef.current = onReveal;

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const track = trackRef.current;
      if (!track) return;
      event.preventDefault();
      onRevealRef.current();
      if (!drag.moved && Math.abs(event.clientX - drag.startX) < TAP_PX) return;
      drag.moved = true;
      onScrubRef.current(timeFromDelta(event.clientX, track, drag.startX, drag.startValue, maxRef.current));
    };
    const onUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const track = trackRef.current;
      dragRef.current = null;
      setDragging(false);
      if (!track) { onScrubRef.current(null); return; }
      if (event.type === "pointercancel") { onScrubRef.current(null); return; }
      if (drag.moved) onSeekRef.current(timeFromDelta(event.clientX, track, drag.startX, drag.startValue, maxRef.current));
      else onSeekRef.current(timeAtClientX(event.clientX, track, maxRef.current));
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return <div
    ref={trackRef}
    className={`timeline-bar${dragging ? " scrubbing" : ""}`}
    role="slider"
    tabIndex={0}
    aria-label={t("player.position")}
    aria-valuemin={0}
    aria-valuemax={Math.round(max)}
    aria-valuenow={Math.round(Math.min(value, max))}
    aria-valuetext={fmt(value)}
    onPointerMove={(event) => { if (!dragRef.current && event.pointerType === "mouse") setHover(timeAtClientX(event.clientX, event.currentTarget, max)); }}
    onPointerLeave={() => setHover(null)}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      setHover(null);
      event.preventDefault();
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
      dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startValue: valueRef.current, moved: false };
      setDragging(true);
      onReveal();
      onScrub(valueRef.current);
    }}>
    <div className="timeline-rail" aria-hidden="true">
      <i className="timeline-fill" style={{ width: `${percent}%` }} />
      <b className="timeline-thumb" style={{ left: `${percent}%` }} />
    </div>
    {(dragging || hover !== null) && <span className="timeline-preview" style={{ left: `clamp(80px, ${max > 0 ? (dragging ? value : hover ?? 0) / max * 100 : 0}%, calc(100% - 80px))` }}>
      {sessionId && <PreviewFrame sessionId={sessionId} time={dragging ? value : hover ?? 0} />}
      <span>{fmt(dragging ? value : hover ?? 0)}</span>
    </span>}
  </div>;
}

const supports = (type: string) => {
  try { if (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported) return MediaSource.isTypeSupported(type); } catch { /* MSE may be unavailable */ }
  try { return document.createElement("video").canPlayType(type) !== ""; } catch { return false; }
};
const capabilities = (): Capabilities => detectCapabilities(supports, navigator.userAgent, navigator.maxTouchPoints);

const MODE_KEY: Record<PlaybackMode, Key> = {
  direct: "player.mode.direct",
  remux: "player.mode.direct",
  transcode: "player.mode.transcode",
};

/** Overlay fullscreen keeps the HTML cue layer. Native cues are only for the
 *  video element's own fullscreen (iOS), where those siblings are not shown. */
const nativeVideoFullscreen = (video: HTMLVideoElement, overlay: HTMLElement | null) => {
  if (document.fullscreenElement === overlay) return false;
  const webkitVideo = video as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean };
  return document.fullscreenElement === video || Boolean(webkitVideo.webkitDisplayingFullscreen);
};

/** Keys the player claims for itself. Anything else (Escape) leaves focus alone. */
const SHORTCUT_KEYS = new Set([" ", "k", "ArrowLeft", "ArrowRight", "c", "t", "f"]);

/** Target transcode qualities; the values must match QUALITY_BITRATE on the server. */
const QUALITIES = [1080, 720, 480];
const lowerQuality = (current: number | null) => current === null || current === 1080 ? 720 : current === 720 ? 480 : null;

const CHANNELS: Record<number, string> = { 1: "mono", 2: "stereo", 6: "5.1", 8: "7.1" };
/** Files routinely tag several tracks with the same language, so a track has to be
 *  recognisable by something else as well. */
const trackLabel = (track: Track) => {
  const parts = [label(track.language)];
  if (track.title) parts.push(track.title);
  if (track.channels) parts.push(CHANNELS[track.channels] ?? `${track.channels}ch`);
  if (track.forced) parts.push("forced");
  return `${parts.join(" · ")} (${track.codec})`;
};

const SUBTITLE_DELAY_STEP_S = 0.25;
const SUBTITLE_DELAY_LIMIT_S = 30;

export function Player({ previousTitle, onPrevious, nextTitle, nextBusy, onNext, open, title, stream, subtitles, subtitleLanguage, audioLanguage, progressKey, progressPoster, favorite, onToggleFavorite, onDownload, onDeviceDownload, onClose }: Props) {
  // Subscribes the whole overlay to the language, so a switch behind it redraws every label.
  useI18n();
  const [subtitleIds, setSubtitleIds] = useState<Record<string, string>>({});
  const overlayRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sessionRef = useRef<string | null>(null);
  const modeRef = useRef<PlaybackMode>("transcode");
  const offsetRef = useRef(0);
  const probeDurationRef = useRef(0);
  const timeRef = useRef(0);
  const seekingRef = useRef(false);
  const seekInFlightRef = useRef(false);
  const pendingSeekRef = useRef<number | null>(null);
  const seekEpochRef = useRef(0);
  const catchupRef = useRef(0);
  const decodeRecoversRef = useRef<number[]>([]);
  const recoverFromDecodeRef = useRef<(reason: string) => void>(() => undefined);
  /** Once playback is given up, the element and hls.js must stop, or they keep failing
   * every few seconds and flood the log with the same error until the window is closed. */
  const abandonedRef = useRef(false);
  const escalateRef = useRef(false);
  const [sidecarReady, setSidecarReady] = useState(false);
  // The reader is still working through the film, so the track is attached again
  // whenever the picture is about to catch up with the cues it already has.
  const [sidecarPass, setSidecarPass] = useState(0);
  /** What the viewer dialled in: a positive delay holds the cues back against the picture. */
  const [subtitleDelay, setSubtitleDelay] = useState(0);
  const [session, setSession] = useState<PlaybackSession | null>(null);
  const [addonSubtitle, setAddonSubtitle] = useState<Subtitle | null>(null);
  const [offset, setOffset] = useState(0);
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState("");
  const stallsRef = useRef<number[]>([]);
  const bufferTimerRef = useRef<number | undefined>(undefined);
  const [qualityHint, setQualityHint] = useState<number | null>(null);
  const [downloadState, setDownloadState] = useState<"idle" | "busy" | "done">("idle");
  const [deviceDownloadBusy, setDeviceDownloadBusy] = useState(false);
  const [resumedFrom, setResumedFrom] = useState(0);
  const [subtitleText, setSubtitleText] = useState("");
  const [nativeSubtitles, setNativeSubtitles] = useState(false);
  // Hiding subtitles must not touch the session: switching the track on the server
  // restarts FFmpeg and waits for new segments. Only the rendering changes here, so the
  // track keeps running and comes back instantly.
  const [subtitlesHidden, setSubtitlesHidden] = useState(false);
  const subtitlesHiddenRef = useRef(false);
  const applySubtitleVisibilityRef = useRef<(() => void) | null>(null);
  const [mobileLandscape, setMobileLandscape] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [fullscreenUnavailable, setFullscreenUnavailable] = useState(false);
  const [cursorHidden, setCursorHidden] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsTimerRef = useRef<number | undefined>(undefined);
  const automaticFullscreenRef = useRef(false);
  useEffect(() => {
    if (!open) { setSettingsOpen(false); setBrowserFullscreen(false); setFullscreenUnavailable(false); return; }
    const bottom = bottomRef.current;
    if (!bottom) return;
    const measure = () => overlayRef.current?.style.setProperty("--player-bottom-height", `${bottom.getBoundingClientRect().height}px`);
    const observer = new ResizeObserver(measure);
    observer.observe(bottom);
    measure();
    setFullscreenSupported(supportsPlayerFullscreen(overlayRef.current));
    const sync = () => setBrowserFullscreen(playerIsFullscreen(overlayRef.current));
    const events = ["fullscreenchange", "webkitfullscreenchange"];
    for (const event of events) document.addEventListener(event, sync);
    sync();
    return () => {
      observer.disconnect();
      for (const event of events) document.removeEventListener(event, sync);
    };
  }, [open]);
  useEffect(() => {
    if (!fullscreenUnavailable) return;
    const timer = window.setTimeout(() => setFullscreenUnavailable(false), 5000);
    return () => window.clearTimeout(timer);
  }, [fullscreenUnavailable]);
  // The resumed-at notice should inform, not get in the way; it leaves after five seconds.
  useEffect(() => {
    if (!resumedFrom) return;
    const timer = setTimeout(() => setResumedFrom(0), 5000);
    return () => clearTimeout(timer);
  }, [resumedFrom]);
  const reportRef = useRef<{ position: number; duration: number }>({ position: 0, duration: 0 });
  // A library file is already on disk, so offering to download it makes no sense.
  const isLocal = stream?.kind === "library";
  const addonSubtitles = [...(stream?.subtitles ?? []), ...subtitles];

  // Some browsers paint native WebVTT below the visible video box. Active cues
  // are mirrored into an HTML layer, and tracks stay in hidden mode so the
  // browser does not draw its own cue box. Overlay fullscreen must keep that
  // layer: Chromium on Windows otherwise promotes the video to a
  // DirectComposition plane and both the HTML overlay and native cues vanish.
  useEffect(() => {
    if (!open) return;
    const video = videoRef.current;
    if (!video) return;
    const bound = new Map<TextTrack, () => void>();
    const mirrored = new Set<TextTrack>();
    let useNativeRenderer = false;
    let syncingModes = false;
    let fullscreenSync = 0;

    const showActiveCues = () => {
      if (subtitlesHiddenRef.current) { setSubtitleText(""); return; }
      const lines = Array.from(video.textTracks)
        .filter((track) => mirrored.has(track) && track.activeCues)
        .flatMap((track) => Array.from(track.activeCues ?? []))
        .map((cue) => {
          const vttCue = cue as VTTCue;
          return typeof vttCue.getCueAsHTML === "function" ? vttCue.getCueAsHTML().textContent ?? "" : vttCue.text ?? "";
        })
        .map((text) => text.trim())
        .filter(Boolean);
      setSubtitleText(lines.join("\n"));
    };
    const syncTrackModes = () => {
      if (syncingModes) return;
      syncingModes = true;
      for (const track of Array.from(video.textTracks)) {
        if (track.mode === "showing") mirrored.add(track);
        // The picker never uses disabled: it unmounts the track or starts a new
        // session. Chromium may still flip an active track to disabled while
        // entering fullscreen, so a mirrored track is restored, not dropped.
        if (mirrored.has(track)) track.mode = useNativeRenderer && !subtitlesHiddenRef.current ? "showing" : "hidden";
      }
      syncingModes = false;
    };
    const bindTracks = () => {
      for (const track of Array.from(video.textTracks)) {
        if (bound.has(track)) continue;
        const onCueChange = showActiveCues;
        track.addEventListener("cuechange", onCueChange);
        bound.set(track, onCueChange);
      }
      syncTrackModes();
      showActiveCues();
    };
    const updateFullscreenMode = () => {
      useNativeRenderer = nativeVideoFullscreen(video, overlayRef.current);
      setNativeSubtitles(useNativeRenderer);
      bindTracks();
      cancelAnimationFrame(fullscreenSync);
      fullscreenSync = requestAnimationFrame(() => bindTracks());
    };

    bindTracks();
    applySubtitleVisibilityRef.current = () => { syncTrackModes(); showActiveCues(); };
    video.textTracks.addEventListener("addtrack", bindTracks);
    video.textTracks.addEventListener("change", bindTracks);
    video.addEventListener("loadedmetadata", bindTracks);
    document.addEventListener("fullscreenchange", updateFullscreenMode);
    video.addEventListener("webkitbeginfullscreen", updateFullscreenMode);
    video.addEventListener("webkitendfullscreen", updateFullscreenMode);
    return () => {
      cancelAnimationFrame(fullscreenSync);
      applySubtitleVisibilityRef.current = null;
      video.textTracks.removeEventListener("addtrack", bindTracks);
      video.textTracks.removeEventListener("change", bindTracks);
      video.removeEventListener("loadedmetadata", bindTracks);
      document.removeEventListener("fullscreenchange", updateFullscreenMode);
      video.removeEventListener("webkitbeginfullscreen", updateFullscreenMode);
      video.removeEventListener("webkitendfullscreen", updateFullscreenMode);
      for (const [track, listener] of bound) track.removeEventListener("cuechange", listener);
      for (const track of mirrored) if (track.mode === "hidden") track.mode = "showing";
      setSubtitleText("");
      setNativeSubtitles(false);
    };
  }, [open, session?.id, addonSubtitle?.subtitleId]);

  useEffect(() => {
    subtitlesHiddenRef.current = subtitlesHidden;
    applySubtitleVisibilityRef.current?.();
  }, [subtitlesHidden]);

  const detach = () => {
    hlsRef.current?.destroy(); hlsRef.current = null;
    releaseMediaElement(videoRef.current);
  };

  /** Stop for good: with hls.js attached the element keeps refusing new segments and
   * every failure is reported again, so the session has to be torn down, not just labelled.
   * FFmpeg would otherwise keep converting and downloading for another five idle minutes. */
  const abandon = (message: string) => {
    if (abandonedRef.current) return;
    abandonedRef.current = true;
    detach();
    const video = videoRef.current;
    if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
    clearBuffering();
    setError(message);
    const id = sessionRef.current;
    if (id) void api.stopPlayback(id).catch(() => undefined);
  };

  const attach = (url: string, mode: PlaybackMode, autoplay = true, playlist = false) => {
    const video = videoRef.current; if (!video) return;
    detach();
    // Direct play normally means handing the element the address and letting the
    // browser get on with it. A playlist is the exception: only Safari reads one
    // natively, so it falls through to hls.js the same way a converted stream
    // does — and costs the server nothing, unlike converting it would.
    if (mode === "direct" && !playlist) { video.src = url; if (autoplay) void video.play().catch(() => undefined); return; }
    if (Hls.isSupported()) {
      // A longer buffer on both sides means the browser handles an ordinary few-second
      // skip itself, immediately, instead of restarting FFmpeg on the server.
      // maxBufferHole bridges the small gaps at segment boundaries (a video copy only cuts
      // on key frames) instead of letting playback freeze on them.
      const hls = new Hls({ ...HLS_PLAYER_CONFIG });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => { if (autoplay) void video.play().catch(() => undefined); });
      let recoveries = 0;
      hls.on(Hls.Events.FRAG_BUFFERED, () => { recoveries = 0; });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (hlsRef.current !== hls || abandonedRef.current) return;
        if (ignoreHlsErrorDuringRestart(seekInFlightRef.current)) return;
        report(data.fatal ? "ERROR" : "WARN", `hls.js: ${data.details}`, {
          ...context(), type: data.type, fatal: data.fatal,
          httpStatus: data.response?.code, responseText: typeof data.response?.text === "string" ? data.response.text.slice(0, 120) : undefined,
          fragment: hostOf(data.frag?.url), url: hostOf(data.url),
          // What MSE was actually asked for, and what it said. Without these a
          // bufferAddCodecError names the symptom and nothing that caused it.
          mimeType: (data as { mimeType?: string }).mimeType,
          reason: (data as { reason?: string }).reason,
          cause: ((data as { error?: Error }).error?.message ?? (data as { err?: Error }).err?.message)?.slice(0, 160),
        });
        if (!data.fatal) return;
        if (recoveries < 2) {
          recoveries += 1;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { hls.startLoad(); return; }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          recoverFromDecodeRef.current(data.details);
          return;
        }
        abandon(t("player.playbackFailed", { details: data.details, type: data.type }));
      });
      hls.loadSource(url); hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) { video.src = url; if (autoplay) void video.play().catch(() => undefined); }
    else {
      report("ERROR", "The browser supports neither MSE nor native HLS", { ...context(), userAgent: navigator.userAgent });
      setError(t("player.noHls"));
    }
  };

  const showTime = (value: number) => { timeRef.current = value; setTime(value); };
  const nudgeSubtitlesRef = useRef((_by: number) => {});
  // Read in the teardown below, which runs before the new render's props are visible.
  const openRef = useRef(open);
  openRef.current = open;

  /** Shared description of the session: without it an error report is a bare "it did not play". */
  const context = () => ({
    session: sessionRef.current ?? undefined, mode: modeRef.current, position: Math.round(timeRef.current),
    offset: Math.round(offsetRef.current), title,
    stream: stream?.kind,
  });

  const applySession = (next: PlaybackSession, autoplay = true) => {
    // A fresh conversion deserves a fresh verdict, even after an earlier one was given up on.
    abandonedRef.current = false;
    if (next.sidecarUrl !== session?.sidecarUrl) { setSidecarReady(false); setSidecarPass(0); }
    sessionRef.current = next.id; modeRef.current = next.mode; offsetRef.current = next.offset;
    setSession(next); setOffset(next.offset); showTime(next.offset);
    if (next.duration) { probeDurationRef.current = next.duration; setDuration(next.duration); }
    if (next.subtitleIds) setSubtitleIds(next.subtitleIds);
    attach(next.url, next.mode, autoplay, Boolean(next.playlist));
  };

  useEffect(() => {
    if (!open || !stream?.playable || !videoRef.current) return;
    let disposed = false; const video = videoRef.current; const epoch = ++seekEpochRef.current;
    setError(""); setBuffering(true); setTime(0); setDuration(0); setOffset(0); setScrub(null); setSession(null); setAddonSubtitle(null);
    timeRef.current = 0; offsetRef.current = 0; probeDurationRef.current = 0; seekingRef.current = false; pendingSeekRef.current = null;
    reportRef.current = { position: 0, duration: 0 }; setResumedFrom(0);
    stallsRef.current = []; setQualityHint(null); setDownloadState("idle");
    decodeRecoversRef.current = []; abandonedRef.current = false; escalateRef.current = false; setSidecarReady(false); setSidecarPass(0); setSubtitleDelay(0);
    setSubtitlesHidden(false); subtitlesHiddenRef.current = false;
    // Resuming: the server knows the position and starts playback right there.
    (async () => {
      const saved = progressKey ? await api.progressOf(progressKey).catch(() => null) : null;
      const from = saved && saved.position > 30 ? saved.position : 0;
      if (from) setResumedFrom(from);
      return { created: await api.startPlayback(stream, capabilities(), from, addonSubtitles.map((item) => item.subtitleId)), from };
    })().then(({ created, from }) => {
      if (disposed) { void api.stopPlayback(created.id).catch(() => undefined); return; }
      applySession(created);
      report("DEBUG", `Playback session started in ${created.mode} mode`, {
        ...context(), mode: created.mode, hardware: created.hardware, acceleration: created.acceleration,
        video: created.video, audio: created.audio, resumedFrom: Math.round(from), capabilities: capabilities(),
      });
      // For direct play the server need not start FFmpeg, so the video element sets the
      // starting time itself. With remux/transcode the offset is already in the session URL.
      if (from > 0 && created.mode === "direct") {
        const move = () => { if (!disposed) { video.currentTime = from; showTime(from); } };
        if (video.readyState >= 1) move(); else video.addEventListener("loadedmetadata", move, { once: true });
      }
      // The server has chosen among the tracks the film carries; an addon fills the gap only
      // where the film left one, and by the same rule -- silence over understood dialogue.
      if (created.subtitleTrack === null && !created.sidecarUrl) {
        setAddonSubtitle(pickAddonSubtitle(addonSubtitles, subtitleLanguage, created.audioTracks[created.audioTrack]?.language, audioLanguage));
      }
    }).catch((value) => {
      const message = value instanceof Error ? value.message : String(value);
      report("ERROR", `Playback did not start: ${message}`, { ...context(), phase: "start", capabilities: capabilities() });
      setError(describeError(value));
    }).finally(() => { if (!disposed) setBuffering(false); });
    return () => {
      disposed = true; detach();
      if (bufferTimerRef.current !== undefined) { clearTimeout(bufferTimerRef.current); bufferTimerRef.current = undefined; }
      if (seekEpochRef.current === epoch) { seekEpochRef.current += 1; pendingSeekRef.current = null; seekingRef.current = false; seekInFlightRef.current = false; }
      video.pause(); video.removeAttribute("src"); video.load();
      const id = sessionRef.current; sessionRef.current = null;
      if (id) {
        // The session is the server's only view of what is playing, so say who ended it and why.
        // A teardown while the player is still open means something below it changed the film.
        report("INFO", "Playback released by the player", { session: id, reason: openRef.current ? "the source or the title changed" : "the player was closed", title, stream: stream?.kind });
        void api.stopPlayback(id).catch(() => undefined);
      }
    };
  }, [open, stream, progressKey]);

  useEffect(() => {
    const url = session?.sidecarUrl;
    if (!url) { setSidecarReady(false); setSidecarPass(0); return; }
    const controller = new AbortController();
    setSidecarReady(false); setSidecarPass(0);
    void watchSidecar(url, controller.signal, () => timeRef.current, ({ pass }) => {
      if (controller.signal.aborted) return;
      setSidecarReady(true); setSidecarPass(pass);
    });
    return () => controller.abort();
  }, [session?.sidecarUrl]);

  /** Inside the produced part we seek at once; otherwise the conversion restarts at the new position. */
  const seekTo = async (target: number, forceRestart = false) => {
    const video = videoRef.current; if (!video) return;
    const bounded = Math.max(0, duration ? Math.min(target, duration - 1) : target);
    setScrub(null); showTime(bounded);
    // A forced restart may be an escalation away from direct play, so it must reach the server.
    if (modeRef.current === "direct" && !forceRestart) { video.currentTime = bounded; return; }
    const token = ++catchupRef.current;
    const relative = bounded - offsetRef.current;
    const end = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0;
    const plan = forceRestart || seekInFlightRef.current ? "restart" : planSeek(relative, end);
    if (plan === "native") { video.currentTime = relative; return; }
    if (plan === "wait") {
      const epoch = seekEpochRef.current;
      showBufferSoon();
      const covered = await waitForSeekable(
        () => video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0,
        relative, AHEAD_CATCHUP_MS,
        () => token !== catchupRef.current || epoch !== seekEpochRef.current,
      );
      clearBuffering();
      if (token !== catchupRef.current || epoch !== seekEpochRef.current) return;
      if (covered) { video.currentTime = relative; return; }
    }

    pendingSeekRef.current = bounded;
    if (seekInFlightRef.current) return;
    let id = sessionRef.current; if (!id) return;
    const epoch = seekEpochRef.current;
    const autoplay = !video.paused;
    // Keep the last frame. The previous HLS generation stays served for a few
    // seconds, so destroying it here only produced a black screen and bufferStalledError.
    seekInFlightRef.current = true; seekingRef.current = true; setBuffering(true); setError("");
    video.pause();
    // A session started to recover from one the server had forgotten. If the viewer closes the
    // film or moves on before it is taken up, nothing else knows about it, and it would convert
    // and pull at the source on its own.
    let started: string | undefined;
    try {
      while (pendingSeekRef.current !== null && epoch === seekEpochRef.current) {
        const requested = pendingSeekRef.current; pendingSeekRef.current = null;
        let recoveredDirectAt: number | null = null;
        let next: PlaybackSession;
        const escalating = escalateRef.current; escalateRef.current = false;
        try { next = escalating ? await api.escalatePlayback(id, requested) : await api.seekPlayback(id, requested); }
        catch (value) {
          if (epoch !== seekEpochRef.current) return;
          if (!(value instanceof ApiError) || !(value.code === "RESOURCE_NOT_FOUND" || value.messageKey === "err.playbackSessionGone")) throw value;
          // The server may have restarted in the meantime, or cleaned up an idle session.
          // A new HLS session starts at the target; a direct stream is moved by the browser.
          next = await api.startPlayback(stream!, capabilities(), requested, addonSubtitles.map((item) => item.subtitleId));
          id = next.id; started = next.id;
          if (next.mode === "direct") recoveredDirectAt = requested;
        }
        if (epoch !== seekEpochRef.current) return;
        // If the viewer picked another spot meanwhile, the old generation is never attached.
        if (pendingSeekRef.current !== null) continue;
        applySession(next, autoplay);
        if (recoveredDirectAt !== null) {
          const moveDirect = () => { const current = videoRef.current; if (current) current.currentTime = recoveredDirectAt!; showTime(recoveredDirectAt!); };
          if (videoRef.current && videoRef.current.readyState >= 1) moveDirect();
          else videoRef.current?.addEventListener("loadedmetadata", moveDirect, { once: true });
        }
      }
    }
    catch (value) {
      if (epoch !== seekEpochRef.current) return;
      const message = value instanceof Error ? value.message : String(value);
      report("ERROR", `Seek failed: ${message}`, { ...context(), phase: "seek", target: Math.round(bounded) });
      if (epoch === seekEpochRef.current) setError(describeError(value));
    }
    finally {
      if (started && started !== sessionRef.current) void api.stopPlayback(started).catch(() => undefined);
      if (epoch === seekEpochRef.current) { pendingSeekRef.current = null; seekInFlightRef.current = false; seekingRef.current = false; setBuffering(false); }
    }
  };

  recoverFromDecodeRef.current = (reason: string) => {
    // A restart is already on its way; whatever it produces decides the next step.
    if (abandonedRef.current || seekInFlightRef.current) return;
    const action = planDecodeRecovery(modeRef.current, decodeRecoversRef.current);
    if (action === "give-up") {
      abandon(t("player.browserRefused"));
      return;
    }
    decodeRecoversRef.current = recordDecodeRecover(decodeRecoversRef.current);
    escalateRef.current = action === "escalate";
    report("WARN", `Restarting conversion after a decode error (${reason})`, { ...context(), action });
    void seekTo(timeRef.current, true);
  };

  /** Subtitles are read beside the conversion, so switching them leaves the picture alone. */
  const changeSubtitle = async (subtitle: number | null) => {
    const id = sessionRef.current; if (!id) return;
    setError("");
    try {
      const next = await api.setTrack(id, { subtitle, time: timeRef.current });
      if (sessionRef.current !== next.id) return;
      if (next.sidecarUrl !== session?.sidecarUrl) { setSidecarReady(false); setSidecarPass(0); }
      setSession(next);
    } catch (value) {
      const message = value instanceof Error ? value.message : String(value);
      report("ERROR", `Subtitle switch failed: ${message}`, { ...context(), phase: "track", changes: { subtitle } });
      setError(`${t("player.subtitleSwitchFailed")} ${describeError(value)}`.trim());
    }
  };

  /** Another track or quality means another FFmpeg mapping, so the conversion restarts at the current position. */
  const changeTrack = async (changes: { audio?: number; subtitle?: number | null; quality?: number | null }) => {
    const id = sessionRef.current; if (!id) return;
    const at = timeRef.current;
    const video = videoRef.current;
    seekInFlightRef.current = true; seekingRef.current = true; setBuffering(true); setError("");
    video?.pause();
    try {
      // If the connection fails on the way, the server still performs the switch and the two
      // states drift apart; a second attempt returns what the session really holds.
      const next = await api.setTrack(id, { ...changes, time: at })
        .catch((error) => { if (error instanceof ApiError) throw error; return api.setTrack(id, { ...changes, time: at }); });
      applySession(next);
      // Going back to the original may end as direct playback from zero; we move the position ourselves.
      if (next.mode === "direct" && at > 0) {
        const moveDirect = () => { const current = videoRef.current; if (current) current.currentTime = at; showTime(at); };
        if (videoRef.current && videoRef.current.readyState >= 1) moveDirect();
        else videoRef.current?.addEventListener("loadedmetadata", moveDirect, { once: true });
      }
    }
    catch (value) {
      const message = value instanceof Error ? value.message : String(value);
      report("ERROR", `Track switch failed: ${message}`, { ...context(), phase: "track", changes });
      setError(describeError(value));
    }
    finally { seekInFlightRef.current = false; seekingRef.current = false; setBuffering(false); }
  };

  const changeQuality = (value: number | null) => {
    stallsRef.current = []; setQualityHint(null);
    void changeTrack({ quality: value });
  };

  /** A micro-stall under 400 ms never lights the notice up; it would blink on every buffer top-up. */
  const showBufferSoon = () => {
    if (bufferTimerRef.current !== undefined) return;
    bufferTimerRef.current = window.setTimeout(() => { bufferTimerRef.current = undefined; setBuffering(true); }, 400);
  };
  const clearBuffering = () => {
    if (bufferTimerRef.current !== undefined) { clearTimeout(bufferTimerRef.current); bufferTimerRef.current = undefined; }
    setBuffering(false);
  };

  /** Repeated stalls outside a seek signal a weak link; offer a lower quality. */
  const noteStall = () => {
    showBufferSoon();
    const video = videoRef.current;
    if (!video || video.seeking || seekingRef.current || video.currentTime < 1) return;
    const now = Date.now();
    stallsRef.current = [...stallsRef.current.filter((at) => now - at < 60_000), now];
    if (stallsRef.current.length < 3) return;
    // A lower quality cuts the bitrate, so it really does fix stalling caused by the network.
    // It also means transcoding, which a weak CPU cannot keep up with unaided -- the advice
    // would then hurt more than it helps. So we ask the server whether it has acceleration;
    // the hardware flag does not answer that, being always false while remuxing, where VAAPI
    // is not used at all.
    report("WARN", "Playback keeps stalling", {
      ...context(), stalls: stallsRef.current.length, quality: session?.quality ?? null,
      hardware: session?.hardware, acceleration: session?.acceleration,
    });
    if (!session?.acceleration) return;
    const target = lowerQuality(session?.quality ?? null);
    if (target !== null) setQualityHint(target);
  };

  /** Steps small enough to land on the line, large enough to get there quickly. */
  const nudgeSubtitles = (by: number) => {
    setSubtitlesHidden(false);
    setSubtitleDelay((value) => Math.max(-SUBTITLE_DELAY_LIMIT_S, Math.min(SUBTITLE_DELAY_LIMIT_S, Math.round((value + by) * 100) / 100)));
  };

  nudgeSubtitlesRef.current = nudgeSubtitles;

  const chooseSubtitle = async (value: string) => {
    // Touching the picker is an explicit instruction, so it always ends the quick hide:
    // the chosen track shows up right away and turning subtitles off clears the crossed icon.
    setSubtitlesHidden(false);
    if (value.startsWith("embedded:")) { setAddonSubtitle(null); await changeSubtitle(Number(value.slice(9))); return; }
    if (session?.subtitleTrack !== null && session !== null) await changeSubtitle(null);
    setAddonSubtitle(value.startsWith("addon:") ? addonSubtitles[Number(value.slice(6))] ?? null : null);
  };

  // The position is reported every ten seconds and once more on close, so nothing is lost.
  useEffect(() => {
    if (!open || !progressKey) return;
    const send = () => {
      const { position, duration } = reportRef.current;
      if (!duration || position < 5) return;
      void api.saveProgress({
        key: progressKey, position, duration, title,
        path: stream?.localPath,
        poster: progressPoster,
      }).catch(() => undefined);
    };
    const timer = setInterval(send, 10_000);
    return () => { clearInterval(timer); send(); };
  }, [open, progressKey, title, progressPoster]);

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      const id = sessionRef.current;
      if (id) void api.pingPlayback(id).catch(() => undefined);
    }, 30_000);
    return () => clearInterval(timer);
  }, [open]);

  // Closing the tab is not closing the player: nothing unmounts, so without this the server
  // keeps the conversion and its read of the source until it notices nobody is watching.
  useEffect(() => {
    if (!open) return;
    const leaving = () => { const id = sessionRef.current; if (id) api.stopPlaybackOnUnload(id); };
    window.addEventListener("pagehide", leaving);
    return () => window.removeEventListener("pagehide", leaving);
  }, [open]);

  const toggle = () => { const video = videoRef.current; if (!video) return; if (video.paused) void video.play().catch(() => undefined); else video.pause(); };

  const clearControlsTimer = () => {
    if (controlsTimerRef.current === undefined) return;
    clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = undefined;
  };
  const revealControls = () => {
    setControlsVisible(true);
    clearControlsTimer();
    if (videoRef.current?.paused || buffering || error || scrub !== null) return;
    controlsTimerRef.current = window.setTimeout(() => {
      controlsTimerRef.current = undefined;
      if (overlayRef.current?.querySelector(".player-settings") || (overlayRef.current?.contains(document.activeElement) && document.activeElement?.matches(":focus-visible"))) return;
      setControlsVisible(false);
    }, 3500);
  };
  useEffect(() => {
    if (!open) { clearControlsTimer(); setControlsVisible(true); return; }
    if (paused || buffering || error || scrub !== null) { clearControlsTimer(); setControlsVisible(true); return; }
    revealControls();
    return clearControlsTimer;
  }, [open, paused, buffering, error, scrub]);

  useEffect(() => {
    setCursorHidden(false);
    if (!open || !browserFullscreen) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      setCursorHidden(false);
      clearTimeout(timer);
      timer = setTimeout(() => setCursorHidden(true), 10_000);
    };
    const move = (event: PointerEvent) => { if (event.pointerType === "mouse") reset(); };
    const overlay = overlayRef.current;
    overlay?.addEventListener("pointermove", move);
    overlay?.addEventListener("pointerdown", reset);
    window.addEventListener("keydown", reset);
    reset();
    return () => {
      clearTimeout(timer);
      overlay?.removeEventListener("pointermove", move);
      overlay?.removeEventListener("pointerdown", reset);
      window.removeEventListener("keydown", reset);
    };
  }, [open, browserFullscreen]);

  const toggleFullscreen = async () => {
    setFullscreenUnavailable(false);
    if (playerIsFullscreen(overlayRef.current)) {
      await exitPlayerFullscreen();
    } else if (!await enterPlayerFullscreen(overlayRef.current)) {
      setFullscreenUnavailable(true);
    }
  };

  // Rotation may enter fullscreen only for our complete player overlay.
  useEffect(() => {
    if (!open) { setMobileLandscape(false); automaticFullscreenRef.current = false; return; }
    const orientation = window.matchMedia("(orientation: landscape)");
    let previous = false;
    let entering = false;
    let retry: number | undefined;
    const enterAutomatically = () => {
      if (entering || automaticFullscreenRef.current || playerIsFullscreen(overlayRef.current)) return;
      entering = true;
      void enterPlayerFullscreen(overlayRef.current).then((entered) => {
        automaticFullscreenRef.current = entered;
      }).finally(() => { entering = false; });
    };
    const update = () => {
      const touchDevice = navigator.maxTouchPoints > 0 || window.matchMedia("(pointer: coarse)").matches;
      const landscape = orientation.matches && Math.min(window.innerWidth, window.innerHeight) <= 700 && Math.max(window.innerWidth, window.innerHeight) <= 1200;
      setMobileLandscape(landscape);
      if (landscape && touchDevice && (!previous || !automaticFullscreenRef.current)) {
        enterAutomatically();
        window.clearTimeout(retry);
        retry = window.setTimeout(enterAutomatically, 80);
      } else if (!landscape && previous) {
        if (automaticFullscreenRef.current) void exitPlayerFullscreen();
        automaticFullscreenRef.current = false;

      }
      previous = landscape;
    };
    update();
    orientation.addEventListener?.("change", update);
    window.addEventListener("orientationchange", update);
    window.addEventListener("resize", update);
    return () => {
      window.clearTimeout(retry);
      orientation.removeEventListener?.("change", update);
      window.removeEventListener("orientationchange", update);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  /** Playback keeps running; the queue gets the very stream that is playing. */
  const download = async () => {
    if (downloadState !== "idle") return;
    setDownloadState("busy");
    setDownloadState(await onDownload() ? "done" : "idle");
  };

  const downloadToDevice = async () => {
    if (deviceDownloadBusy) return;
    setDeviceDownloadBusy(true);
    try { await onDeviceDownload(); }
    finally { setDeviceDownloadBusy(false); }
  };

  const closePlayer = () => {
    videoRef.current?.pause();
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();

    const fullscreen = playerIsFullscreen(overlayRef.current);
    onClose();
    // The overlay goes first, fullscreen second. Otherwise Safari slides its tabs out
    // over the video when the close button is up there.
    if (fullscreen) window.setTimeout(() => {
      void exitPlayerFullscreen();
    }, 80);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLSelectElement) return;
      if (event.target instanceof HTMLInputElement && event.target.type !== "range") return;
      revealControls();
      // A mouse click leaves focus on the button. The browser draws no ring for it, but the
      // first shortcut switches it to keyboard modality and lights the ring on a control that
      // has nothing to do with that shortcut, so the player drops focus first.
      if (SHORTCUT_KEYS.has(event.key)) {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body && overlayRef.current?.contains(active)) active.blur();
      }
      if (event.key === "Escape" && settingsOpen) { event.preventDefault(); setSettingsOpen(false); return; }
      if (event.key === " " || event.key === "k") { event.preventDefault(); toggle(); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); void seekTo(timeRef.current - 10); }
      else if (event.key === "ArrowRight") { event.preventDefault(); void seekTo(timeRef.current + 10); }
      else if (event.key === "c" || event.key === "t") { event.preventDefault(); setSubtitlesHidden((value) => !value); }
      else if (event.key === ",") { event.preventDefault(); nudgeSubtitlesRef.current(-SUBTITLE_DELAY_STEP_S); }
      else if (event.key === ".") { event.preventDefault(); nudgeSubtitlesRef.current(SUBTITLE_DELAY_STEP_S); }
      else if (event.key === "f") void toggleFullscreen();
      else if (event.key === "Escape" && !document.fullscreenElement) closePlayer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, time, duration, browserFullscreen, settingsOpen]);

  if (!open) return null;
  const position = scrub ?? time;
  const seekable = duration || Math.max(time, 1);
  const subtitleValue = session?.subtitleTrack !== null && session?.subtitleTrack !== undefined
    ? `embedded:${session.subtitleTrack}`
    : addonSubtitle ? `addon:${addonSubtitles.indexOf(addonSubtitle)}` : "off";

  return <div ref={overlayRef} className={`player-overlay${nativeSubtitles ? " native-subtitles" : ""}${mobileLandscape ? " mobile-landscape" : ""}${controlsVisible ? "" : " controls-hidden"}${cursorHidden ? " cursor-hidden" : ""}`} role="dialog" aria-modal="true" onPointerMove={(event) => { if (event.pointerType !== "touch") revealControls(); }} onPointerDown={(event) => { if (!(event.target as HTMLElement).closest(".player-host")) revealControls(); }} onFocusCapture={revealControls} onBlurCapture={revealControls}>
    <div className="player-head">
      <div><small>{t(session ? MODE_KEY[session.mode] : "player.mode.preparing")}{session?.mode === "transcode" ? ` · ${t(session.hardware ? "player.hardware" : "player.software")}` : ""}</small><strong>{title}</strong></div>
      {onToggleFavorite && <button className={`player-star ${favorite ? "on" : ""}`} aria-label={favorite ? t("favorite.remove") : t("favorite.add")} aria-pressed={Boolean(favorite)} title={favorite ? t("favorite.remove") : t("favorite.add")} onClick={onToggleFavorite}>
        <Star/> <span>{favorite ? t("favorite.on") : t("favorite.off")}</span>
      </button>}
      <button className="icon-button" aria-label={t("player.close")} onClick={closePlayer}><X /></button>
    </div>
    <div className="player-host" onDoubleClick={(event) => {
      if ((event.target as HTMLElement).closest("button, input, select, a")) return;
      if (!window.matchMedia("(pointer: fine)").matches || !supportsPlayerFullscreen(overlayRef.current)) return;
      event.preventDefault();
      void toggleFullscreen();
    }} onClick={(event) => {
      if ((event.target as HTMLElement).closest("button, input, select, a")) return;
      setSettingsOpen(false);
      if (settingsOpen || controlsVisible) { clearControlsTimer(); setControlsVisible(false); }
      else revealControls();
    }}>
      <video ref={videoRef} playsInline disableRemotePlayback x-webkit-airplay="deny"
        onPlay={() => setPaused(false)} onPause={() => setPaused(true)}
        onTimeUpdate={(event) => {
          const absolute = offsetRef.current + event.currentTarget.currentTime;
          reportRef.current = { position: absolute, duration: duration || probeDurationRef.current };
          if (scrub === null && !seekingRef.current) showTime(absolute);
        }}
        onDurationChange={(event) => { const value = event.currentTarget.duration; if (Number.isFinite(value) && (modeRef.current === "direct" || !probeDurationRef.current)) setDuration(value); }}
        onWaiting={noteStall} onPlaying={clearBuffering}
        onError={(event) => {
          if (event.target !== event.currentTarget) return;
          if (seekInFlightRef.current || abandonedRef.current) return;
          const media = videoRef.current?.error;
          report("ERROR", `The video element refused the stream (code ${media?.code ?? "?"})`, {
            ...context(), code: media?.code, detail: media?.message,
            networkState: videoRef.current?.networkState, readyState: videoRef.current?.readyState,
            // Safari reports code 4 with an empty message, so the only way to tell
            // a source it would not load from one it could not decode is to say
            // what it was handed and whether hls.js was driving.
            src: hostOf(videoRef.current?.currentSrc) || undefined,
            viaHls: Boolean(hlsRef.current),
          });
          if (media?.code === 3) {
            recoverFromDecodeRef.current("element");
            return;
          }
          abandon(t("player.browserRefused"));
        }}>
        {sidecarReady && session?.sidecarUrl
          ? <track key={`${session.sidecarUrl}:${sidecarPass}:${subtitleDelay}`} kind="subtitles" src={`${session.sidecarUrl}&pass=${sidecarPass}${subtitleDelay ? `&delay=${subtitleDelay.toFixed(2)}` : ""}`} srcLang={subtitleLanguage} label={t("player.subtitles")} default />
          : addonSubtitle && <track key={`${addonSubtitle.subtitleId}:${offset}:${subtitleDelay}`} kind="subtitles" src={subtitleUrl(subtitleIds[addonSubtitle.subtitleId] ?? addonSubtitle.subtitleId, offset, subtitleDelay)} srcLang={addonSubtitle.lang || subtitleLanguage} label={label(addonSubtitle.lang)} default />}
      </video>
      {subtitleText && <div className="player-subtitles" aria-live="off">{subtitleText}</div>}
      {resumedFrom > 0 && <div className="player-resumed">{t("player.resumedAt", { time: fmt(resumedFrom) })}<button onClick={() => { setResumedFrom(0); void seekTo(0); }}>{t("player.playFromStart")}</button></div>}
      {buffering && !error && <div className="player-buffer">{t("common.loading")}</div>}
      {error && <div className="player-error">{error}</div>}
      {qualityHint !== null && !error && <div className="player-hint">
        <span>{t("player.stalling")}</span>
        <button onClick={() => changeQuality(qualityHint)}>{t("player.lowerQualityTo", { height: qualityHint })}</button>
        <button className="icon-button" aria-label={t("player.hideHint")} onClick={() => { stallsRef.current = []; setQualityHint(null); }}><X /></button>
      </div>}
    </div>
    <div ref={bottomRef} className="player-bottom">
      <div className="timeline">
        <span>{fmt(position)}</span>
        <TimelineBar sessionId={session?.id} value={Math.min(position, seekable)} max={seekable}
          onScrub={(next) => { revealControls(); setScrub(next); }}
          onSeek={(next) => void seekTo(next)}
          onReveal={revealControls} />
        <span>{fmt(duration)}</span>
      </div>
      <div className="player-controls">
        <div className={`transport-controls${onPrevious || onNext ? " has-episodes" : ""}`}>
          {onPrevious && <button className="previous-episode" disabled={nextBusy} aria-label={t("player.previousEpisode")} title={t("player.previousEpisodeTitle", { title: previousTitle ?? "" })} onClick={() => void onPrevious()}><SkipBack /></button>}
        <button className="seek-step" onClick={() => void seekTo(timeRef.current - 10)}><RotateCcw /> 10</button>
        <button className="play-toggle" aria-label={paused ? t("player.play") : t("player.pause")} onClick={toggle}>{paused ? <Play /> : <Pause />}</button>
        <button className="seek-step" onClick={() => void seekTo(timeRef.current + 10)}>10 <RotateCw /></button>
          {onNext && <button className="next-episode" disabled={nextBusy} aria-label={t("player.nextEpisode")} title={t("player.nextEpisodeTitle", { title: nextTitle ?? "" })} onClick={() => void onNext()}><SkipForward /></button>}
        </div>
        <Volume2 />
        <input aria-label={t("player.volume")} className="volume" type="range" min="0" max="100" defaultValue="100" onChange={(event) => { const video = videoRef.current; if (video) video.volume = Number(event.target.value) / 100; }} />

        {((session?.subtitleTracks.length ?? 0) > 0 || addonSubtitles.length > 0 || session?.sidecarUrl) && <button disabled={subtitleValue === "off" && !session?.sidecarUrl} aria-label={subtitlesHidden ? t("player.showSubtitles") : t("player.hideSubtitles")} title={subtitlesHidden ? t("player.showSubtitlesKey") : t("player.hideSubtitlesKey")} aria-pressed={!subtitlesHidden} onClick={() => setSubtitlesHidden(!subtitlesHidden)}>{subtitlesHidden ? <CaptionsOff /> : <Captions />}</button>}
        <button className="player-settings-toggle" aria-label={t("player.settings")} title={t("player.settings")} aria-expanded={settingsOpen} aria-controls="player-settings" onClick={() => setSettingsOpen(!settingsOpen)}><Settings /></button>
        {fullscreenSupported && <button className="player-action fullscreen-action" onClick={() => void toggleFullscreen()} title={t(browserFullscreen ? "player.exitFullscreen" : "player.fullscreen")} aria-label={t(browserFullscreen ? "player.exitFullscreen" : "player.fullscreen")}>{browserFullscreen ? <Minimize/> : <Maximize/>} <span>{t(browserFullscreen ? "player.exitFullscreen" : "player.fullscreen")}</span></button>}
      </div>
    </div>
    {fullscreenUnavailable && <div className="fullscreen-notice" role="status">{t("player.fullscreenUnavailable")}</div>}
    {settingsOpen && <div id="player-settings" className="player-settings" role="region" aria-label={t("player.settings")}>
      <div className="player-settings-head"><strong>{t("player.settings")}</strong><button aria-label={t("player.closeSettings")} onClick={() => setSettingsOpen(false)}><X /></button></div>
      {session && <label className="track-picker" title={t("player.quality")}>
        <SlidersHorizontal />
        <select aria-label={t("player.quality")} value={session.quality ?? "original"}
          onChange={(event) => changeQuality(event.target.value === "original" ? null : Number(event.target.value))}>
          <option value="original">{t("player.qualityOriginal")}</option>
          {QUALITIES.map((height) => <option key={height} value={height}>{height}p</option>)}
        </select>
      </label>}

      {(session?.audioTracks.length ?? 0) > 1 && <label className="track-picker" title={t("player.audioTrack")}>
        <AudioLines />
        <select aria-label={t("player.audioTrack")} value={session?.audioTrack ?? 0} onChange={(event) => void changeTrack({ audio: Number(event.target.value) })}>
          {session?.audioTracks.map((track) => <option key={track.index} value={track.index}>{trackLabel(track)}</option>)}
        </select>
      </label>}

      {((session?.subtitleTracks.length ?? 0) > 0 || addonSubtitles.length > 0) && <div className="track-picker">
        <button className={`picker-toggle${subtitlesHidden ? " off" : ""}`} disabled={subtitleValue === "off"}
          onClick={() => setSubtitlesHidden(!subtitlesHidden)}
          title={subtitleValue === "off" ? t("player.subtitles") : subtitlesHidden ? t("player.showSubtitlesKey") : t("player.hideSubtitlesKey")}
          aria-pressed={!subtitlesHidden} aria-label={subtitlesHidden ? t("player.showSubtitles") : t("player.hideSubtitles")}>
          {subtitlesHidden ? <CaptionsOff /> : <Captions />}
        </button>
        <select aria-label={t("player.subtitles")} value={subtitleValue} onChange={(event) => void chooseSubtitle(event.target.value)}>
          <option value="off">{t("player.subtitlesOff")}</option>
          {session?.subtitleTracks.map((track) => <option key={`e${track.index}`} value={`embedded:${track.index}`}>{t("player.embedded")} · {trackLabel(track)}</option>)}
          {addonSubtitles.map((item, index) => <option key={`a${index}`} value={`addon:${index}`}>{t("player.fromAddon")} · {label(item.lang)}{item.addonName ? ` · ${item.addonName}` : ""}</option>)}
        </select>
      </div>}

      {(subtitleValue !== "off" || session?.sidecarUrl) && <div className="track-picker subtitle-delay">
        <Captions />
        <span className="subtitle-delay-label">{t("player.subtitleDelay")}</span>
        <button aria-label={t("player.subtitleEarlier")} title={t("player.subtitleEarlierKey")} onClick={() => nudgeSubtitles(-SUBTITLE_DELAY_STEP_S)}>−</button>
        <output aria-live="off">{subtitleDelay ? `${subtitleDelay > 0 ? "+" : ""}${subtitleDelay.toFixed(2)} s` : t("player.subtitleInStep")}</output>
        <button aria-label={t("player.subtitleLater")} title={t("player.subtitleLaterKey")} onClick={() => nudgeSubtitles(SUBTITLE_DELAY_STEP_S)}>+</button>
        <button className="subtitle-delay-reset" disabled={!subtitleDelay} aria-label={t("player.subtitleDelayReset")} onClick={() => setSubtitleDelay(0)}><RotateCcw /></button>
      </div>}

      {session?.video && <span className="codec-badge"><Gauge /> {session.video}{session.audio ? ` · ${session.audio}` : ""}</span>}
      {!isLocal && <button className="player-action" disabled={downloadState === "busy"} onClick={() => void download()} title={t("save.toLibraryHint")} aria-label={t("save.toLibraryHint")}>
        {downloadState === "done" ? <><Check /> <span>{t("save.queued")}</span></> : <><HardDrive /> <span>{downloadState === "busy" ? t("save.adding") : t("save.toLibrary")}</span></>}
      </button>}
      <button className="player-action" disabled={deviceDownloadBusy} onClick={() => void downloadToDevice()} title={t("save.toDeviceHint")} aria-label={t("save.toDeviceHint")}>
        <Download /> <span>{deviceDownloadBusy ? t("save.preparing") : t("save.toDevice")}</span>
      </button>
    </div>}
  </div>;
}
