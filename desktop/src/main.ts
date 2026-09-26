import { app, BaseWindow, clipboard, dialog, ipcMain, Menu, Notification, powerSaveBlocker, screen, session, shell as electronShell, utilityProcess, WebContentsView, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addProfile,
  findProfile,
  normalizeProfileName,
  normalizeProfileOrigin,
  readProfiles,
  removeProfile,
  updateProfile,
  writeProfiles,
  type ProfileStore,
  type ServerProfile,
} from "./connection-file.js";
import { isDeviceTicketDownload } from "./downloads.js";
import { catalogue } from "./i18n.js";
import { layout, type PageMode } from "./layout.js";
import { bundledMediaTools, LOCAL_PARTITION, LocalBackend, LocalPortBusyError, type LocalBackendConnection } from "./local-backend.js";
import { defaultLocalSettings, parseLocalSettings, readLocalSettings, writeLocalSettings, type LocalSettings } from "./local-settings.js";
import { buildMenuTemplate } from "./menu.js";
import { externalBrowserUrl, httpAllowedHost, parseServerOrigin, partitionForOrigin, type ServerOrigin } from "./origin.js";
import { localPageSent } from "./bridge-sender.js";
import { SettingsWindow } from "./settings-window.js";
import type { FailureReason, MainScreen, ProfileResult, ProbeResult, ShellState, Target, Toast } from "./shell-api.js";
import { effectiveLocale, readShellPrefs, readShellPrefsSync, writeShellPrefs, type ShellLocale } from "./shell-prefs.js";
import { downloadFraction, nextToastId, safeFileName } from "./shell-text.js";
import { SerialQueue } from "./serial-queue.js";
import { SleepGuard } from "./sleep-guard.js";
import { MAX_TARGET_ID, LatestRequest, fallbackApplies, launchPlan, readStartupChoice, writeStartupChoice, STARTUP_FILE } from "./startup.js";
import { fetchStatus, type ProbeFailure } from "./status.js";
import { Debounced, DEFAULT_SIZE, MIN_SIZE, readWindowState, restoreBounds, writeWindowState, type WindowState } from "./window-state.js";

const ALLOWED_PERMISSIONS = new Set<string>(["fullscreen", "clipboard-sanitized-write"]);
const ABORTED = -3;
/** How long a server page gets to save the position and stop playback before its view goes. */
const RETIRE_TIMEOUT_MS = 1_500;
const PROBE_TIMEOUT_MS = 4_000;
const REPOLL_INTERVAL_MS = 30_000;
const TOAST_TIMEOUT_MS = 8_000;
const MAX_CLIPBOARD_TEXT = 2_000;
const APP_NAME = "Stremio Offline";
const WINDOW_BACKGROUND = "#0b0e13";
const PROJECT_URL = "https://github.com/NickRabit/stremio-offline";
const WINDOW_SAVE_DELAY_MS = 500;

const RENDERER_PAGE = fileURLToPath(new URL("../renderer/desktop.html", import.meta.url));
const SHELL_PRELOAD = fileURLToPath(new URL("./shell-preload.js", import.meta.url));
const LOCAL_PRELOAD = fileURLToPath(new URL("./local-preload.js", import.meta.url));
/** The staged runtime keeps the server's `../../web` layout: `runtime/server/dist` and `runtime/web`. */
const LOCAL_BACKEND_ENTRY = fileURLToPath(new URL("../runtime/server/dist/index.js", import.meta.url));
/** CI starts the packaged app with this flag instead of a window: start, probe, stop, exit. */
const SMOKE_LOCAL_BACKEND = "--smoke-local-backend";

const CAPABILITIES = `() => {
  const supports = (type) => {
    try { if (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported) return MediaSource.isTypeSupported(type); } catch { /* MSE may be unavailable */ }
    try { return document.createElement("video").canPlayType(type) !== ""; } catch { return false; }
  };
  const ua = navigator.userAgent;
  const touch = navigator.maxTouchPoints || 0;
  const appleMobile = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch > 1);
  return {
    h264: supports('video/mp4; codecs="avc1.640029"'),
    hevc: supports('video/mp4; codecs="hvc1.1.6.L93.B0"'),
    hevc10: supports('video/mp4; codecs="hvc1.2.4.L153.B0"'),
    vp8: supports('video/webm; codecs="vp8"'),
    vp9: supports('video/mp4; codecs="vp09.00.10.08"'),
    av1: supports('video/mp4; codecs="av01.0.05M.08"'),
    aac: supports('audio/mp4; codecs="mp4a.40.2"'),
    mp3: supports('audio/mp4; codecs="mp4a.40.34"'),
    opus: supports('audio/mp4; codecs="opus"'),
    vorbis: supports('audio/webm; codecs="vorbis"'),
    ac3: !appleMobile && supports('audio/mp4; codecs="ac-3"'),
    eac3: !appleMobile && supports('audio/mp4; codecs="ec-3"'),
    flac: supports('audio/mp4; codecs="flac"'),
  };
}`;

interface Shell {
  window: BaseWindow;
  page: WebContentsView;
  toast: WebContentsView;
  remote: WebContentsView | null;
  remotePartition: string | null;
}

let shell: Shell | null = null;
let connected: ServerOrigin | null = null;
let remoteFullscreen = false;
let loadFailure: ProbeFailure | null = null;
let localBackend: LocalBackend | null = null;
let localConnection: LocalBackendConnection | null = null;
/** The last streaming report from the running backend. */
let localStreaming = false;
let ffmpegLine: string | null = null;
const sleepGuard = new SleepGuard(powerSaveBlocker);
/** Quitting retires the page itself, so a window closing on the way out does not wait for it again. */
let quitting = false;
const preparedPartitions = new Set<string>();
let profileStore: ProfileStore = { profiles: [], selectedProfileId: null };
let localSettings: LocalSettings = defaultLocalSettings();
/** Electron shows the newest of these while a download runs; the shell counts them for `busy`. */
const deviceDownloads = new Map<object, number>();
const queue = new SerialQueue();
/** The newest connect request wins; a stale result is dropped instead of applied. */
const requests = new LatestRequest();
let repoll: NodeJS.Timeout | null = null;
let repollNotified = false;
let toastTimer: NodeJS.Timeout | null = null;

const shellState: ShellState = {
  locale: "en",
  localeChoice: null,
  appVersion: "",
  screen: { kind: "welcome" },
  connection: null,
  chosen: null,
  profiles: [],
  local: { settings: defaultLocalSettings(), running: false, addresses: [], ffmpeg: null, busy: false },
  toast: null,
};

const settingsWindow = new SettingsWindow({
  rendererPage: RENDERER_PAGE,
  preload: SHELL_PRELOAD,
  userDataDir: () => app.getPath("userData"),
  title: () => catalogue(shellState.locale)["settings.title"],
});

const openSettings = (): void => settingsWindow.open();

const targetKey = (target: Target | null): string =>
  target === null ? "-" : target.kind === "local" ? "local" : `profile:${target.id}`;

let menuKey = "";

const applyMenu = (): void => {
  const target = shellState.connection?.target ?? null;
  const live = shellState.connection !== null;
  const key = [
    shellState.locale,
    shellState.profiles.map((profile) => `${profile.id}:${profile.name}`).join(","),
    targetKey(target),
    live ? "connected" : "idle",
  ].join("|");
  if (key === menuKey) return;
  menuKey = key;
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({
    strings: catalogue(shellState.locale),
    profiles: shellState.profiles,
    current: target,
    connected: live,
    isPackaged: app.isPackaged,
    actions: {
      openSettings,
      reload: () => {
        const current = shell;
        if (!current) return;
        if (connected !== null && current.remote !== null && !current.remote.webContents.isDestroyed()) {
          current.remote.webContents.reloadIgnoringCache();
          return;
        }
        if (!current.page.webContents.isDestroyed()) current.page.webContents.reload();
      },
      devTools: () => {
        const current = shell;
        if (!current) return;
        if (connected !== null && current.remote !== null && !current.remote.webContents.isDestroyed()) current.remote.webContents.toggleDevTools();
        else if (!current.page.webContents.isDestroyed()) current.page.webContents.toggleDevTools();
      },
      connect: (target) => { void connectTarget(target, { launch: false }); },
      reconnect: () => { void connectTarget(shellState.chosen ?? { kind: "local" }, { launch: false }); },
      openProject: () => { void electronShell.openExternal(PROJECT_URL).catch(() => {}); },
    },
  })));
};

const sameLocalSettings = (a: LocalSettings, b: LocalSettings) =>
  a.allowPrivateAddons === b.allowPrivateAddons && a.publish === b.publish && a.publishPort === b.publishPort;

const syncAwake = () => sleepGuard.update({ published: localConnection?.published === true, streaming: localStreaming });

const pageMode = (): PageMode =>
  shellState.screen.kind !== "connected" ? "shell" : remoteFullscreen ? "fullscreen" : "remote";

const applyLayout = () => {
  const current = shell;
  if (!current) return;
  const { width, height } = current.window.getContentBounds();
  const bounds = layout({ width, height }, pageMode(), shellState.toast !== null);
  current.page.setBounds(bounds.shell);
  current.remote?.setBounds(bounds.remote);
  current.toast.setBounds(bounds.toast);
  current.toast.setVisible(shellState.toast !== null);
};

const titleFor = (screen: MainScreen): string => {
  if (screen.kind === "welcome") return APP_NAME;
  const name = screen.kind === "connected" ? shellState.connection?.name ?? "" : screen.name;
  const label = name.trim().length > 0 ? name : catalogue(shellState.locale)["window.thisMac"];
  return `${APP_NAME} — ${label}`;
};

const refreshLocal = () => {
  shellState.profiles = profileStore.profiles;
  shellState.local = {
    settings: localSettings,
    running: localConnection !== null,
    addresses: localConnection?.addresses ?? [],
    ffmpeg: ffmpegLine,
    busy: localStreaming || deviceDownloads.size > 0,
  };
};

const pushState = () => {
  const current = shell;
  if (!current) return;
  refreshLocal();
  applyLayout();
  applyMenu();
  for (const view of [current.page, current.toast]) {
    if (!view.webContents.isDestroyed()) view.webContents.send("shell:state", shellState);
  }
  settingsWindow.push(shellState);
  current.window.setTitle(titleFor(shellState.screen));
};

const setScreen = (screen: MainScreen) => {
  shellState.screen = screen;
  pushState();
};

const hideToast = () => {
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  if (shellState.toast === null) return;
  shellState.toast = null;
  pushState();
};

const showToast = (toast: Toast) => {
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  shellState.toast = toast;
  pushState();
  // A fallback stays until it is dismissed or acted on; everything else goes by itself.
  if (toast.kind === "fallback") return;
  toastTimer = setTimeout(() => {
    toastTimer = null;
    if (shellState.toast?.id !== toast.id) return;
    shellState.toast = null;
    pushState();
  }, TOAST_TIMEOUT_MS);
};

const stopRepoll = () => {
  if (repoll) { clearInterval(repoll); repoll = null; }
  repollNotified = false;
};

const startRepoll = (origin: string, name: string) => {
  stopRepoll();
  repoll = setInterval(() => {
    void fetchStatus(origin, fetch, PROBE_TIMEOUT_MS).then((result) => {
      if (!result.ok || repollNotified) return;
      repollNotified = true;
      if (repoll) { clearInterval(repoll); repoll = null; }
      showToast({ id: nextToastId(), kind: "server-back", server: name });
    }).catch(() => {});
  }, REPOLL_INTERVAL_MS);
};

const updateDownloadProgress = () => {
  const current = shell;
  if (!current) return;
  current.window.setProgressBar(Array.from(deviceDownloads.values()).at(-1) ?? -1);
};

const notifyDownload = (kind: "download-done" | "download-failed", file: string) => {
  const current = shell;
  if (!current || current.window.isFocused()) return;
  if (!Notification.isSupported()) return;
  const strings = catalogue(shellState.locale);
  const body = (kind === "download-done" ? strings["notify.downloadDone"] : strings["notify.downloadFailed"]).replace("{file}", file);
  new Notification({ title: APP_NAME, body }).show();
};

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

const onConnectedOrigin = (url: string) => connected !== null && originOf(url) === connected.origin;

const sameConnectedHost = (url: string) => {
  const host = hostOf(url);
  return connected !== null && host !== null && host.toLowerCase() === connected.host.toLowerCase();
};

const blankRemote = () => {
  const remote = shell?.remote;
  if (!remote || remote.webContents.isDestroyed()) return;
  void remote.webContents.loadURL("about:blank")?.catch(() => {});
};

/** A failure while connected: the shell page comes back with the reason and no automatic fallback. */
const failConnected = (reason: FailureReason) => {
  const connection = shellState.connection;
  const wasConnected = connected !== null;
  if (reason === "invalid" || reason === "insecure-transport" || reason === "unreachable" || reason === "not-status") loadFailure = reason;
  connected = null;
  shellState.connection = null;
  if (wasConnected) blankRemote();
  setScreen({
    kind: "error",
    target: connection?.target ?? shellState.chosen ?? { kind: "local" },
    name: connection?.name ?? "",
    origin: connection?.origin ?? null,
    reason,
    port: null,
  });
};

/**
 * Loading a blank page runs the server page's `pagehide`, which saves the playback position and
 * stops the session with keepalive requests; closing the contents outright gives it no such
 * chance. Bounded, because a page that never finishes unloading must not hold the shell.
 */
const liveRemote = () => {
  const contents = shell?.remote?.webContents;
  if (!contents || contents.isDestroyed()) return null;
  const url = contents.getURL();
  return url === "" || url === "about:blank" ? null : contents;
};

const retireRemote = async (): Promise<void> => {
  const contents = liveRemote();
  if (!contents) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    contents.loadURL("about:blank").catch(() => {}),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, RETIRE_TIMEOUT_MS); }),
  ]);
  clearTimeout(timer);
};

const destroyRemote = () => {
  const current = shell;
  if (!current?.remote) return;
  current.window.contentView.removeChildView(current.remote);
  if (!current.remote.webContents.isDestroyed()) current.remote.webContents.close();
  current.remote = null;
  current.remotePartition = null;
};

const guardRemoteNavigation = (remote: WebContentsView, event: { preventDefault: () => void }, url: string) => {
  if (shell?.remote !== remote) return;
  if (onConnectedOrigin(url)) return;
  event.preventDefault();
  if (!connected || originOf(url) === null) return;
  failConnected("not-status");
};

const openExternally = ({ url }: { url: string }) => {
  const target = externalBrowserUrl(url);
  if (target) void electronShell.openExternal(target).catch(() => {});
  return { action: "deny" as const };
};

const httpRequestBlocked = (rawUrl: string): boolean => {
  const host = hostOf(rawUrl);
  return !host || !httpAllowedHost(host);
};

const refusePublicHttp = (rawUrl: string, resourceType: string) => {
  if (connected?.transport !== "http") return;
  if (resourceType !== "mainFrame" && !sameConnectedHost(rawUrl)) return;
  failConnected("insecure-transport");
};

/** The origin the ticket check compares against is read at download time: the local server may
 *  come back on another port while its partition stays the same. */
const preparePartition = (partition: string, serverOrigin: () => string | null) => {
  if (preparedPartitions.has(partition)) return;
  preparedPartitions.add(partition);
  const ses = session.fromPartition(partition);
  ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  ses.webRequest.onBeforeRequest({ urls: ["http://*/*"] }, (details, callback) => {
    const cancel = httpRequestBlocked(details.url);
    callback({ cancel });
    if (cancel) refusePublicHttp(details.url, details.resourceType);
  });
  // Only a ticket this server's own page downloaded stays local. Everything else keeps Electron's
  // routine: the download is not prevented, renamed or given a save path.
  ses.on("will-download", (_event, item, contents) => {
    const expectedOrigin = serverOrigin();
    if (expectedOrigin === null || !isDeviceTicketDownload(item.getURL(), item.getInitiatorOrigin(), expectedOrigin)) return;
    const current = shell;
    if (!current?.remote || current.remotePartition !== partition || current.remote.webContents !== contents) return;
    const file = safeFileName(item.getFilename());
    item.setSaveDialogOptions({ title: catalogue(shellState.locale)["download.saveTitle"], defaultPath: file });
    deviceDownloads.set(item, 2);
    updateDownloadProgress();
    pushState();
    item.on("updated", (_updated, state) => {
      if (state !== "progressing") return;
      deviceDownloads.set(item, downloadFraction(item.getReceivedBytes(), item.getTotalBytes()));
      updateDownloadProgress();
    });
    item.once("done", (_done, state) => {
      deviceDownloads.delete(item);
      updateDownloadProgress();
      if (state === "completed" || state === "interrupted") {
        const kind = state === "completed" ? "download-done" : "download-failed";
        showToast({ id: nextToastId(), kind, file });
        notifyDownload(kind, file);
      }
      pushState();
    });
  });
};

const wireRemote = (remote: WebContentsView) => {
  const contents = remote.webContents;
  contents.setBackgroundThrottling(false);
  contents.setWindowOpenHandler(openExternally);
  contents.on("will-navigate", (event, url) => guardRemoteNavigation(remote, event, url));
  contents.on("will-redirect", (event, url) => guardRemoteNavigation(remote, event, url));
  contents.on("enter-html-full-screen", () => { if (shell?.remote === remote) { remoteFullscreen = true; applyLayout(); } });
  contents.on("leave-html-full-screen", () => { if (shell?.remote === remote) { remoteFullscreen = false; applyLayout(); } });
  contents.on("did-finish-load", () => {
    if (shell?.remote !== remote || !onConnectedOrigin(contents.getURL())) return;
    void contents.executeJavaScript(`(${CAPABILITIES})()`).then(
      (value) => console.log("capabilities " + JSON.stringify(value)),
      () => console.log("capabilities unavailable"),
    );
  });
  contents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
    if (shell?.remote !== remote || !isMainFrame || errorCode === ABORTED || !connected) return;
    failConnected(loadFailure ?? "unreachable");
  });
};

const mountRemote = (partition: string, serverOrigin: () => string | null, preload?: string): WebContentsView | null => {
  const current = shell;
  if (!current) return null;
  if (current.remote && current.remotePartition === partition) return current.remote;
  destroyRemote();
  preparePartition(partition, serverOrigin);
  const remote = new WebContentsView({
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, partition, ...(preload ? { preload } : {}) },
  });
  wireRemote(remote);
  // Below the shell's own pages, which stay on top.
  current.window.contentView.addChildView(remote, 0);
  current.remote = remote;
  current.remotePartition = partition;
  applyLayout();
  return remote;
};

/** The live local origin, or null when nothing local is running. Never a saved profile. */
const localOrigin = (): string | null => localConnection?.server.origin ?? null;

const closeLocalBackend = async (): Promise<void> => {
  localConnection = null;
  localStreaming = false;
  syncAwake();
  const backend = localBackend;
  if (!backend) return;
  await backend.stop().catch(() => {});
};

const parseTarget = (value: unknown): Target | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "local") return { kind: "local" };
  if (record.kind !== "profile") return null;
  const id = record.id;
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_TARGET_ID) return null;
  return { kind: "profile", id };
};

/** The local backend comes up and its page loads; a superseded start is stopped again. */
const startLocal = async (ticket: number, target: Target, fallback: { profileName: string; origin: string } | null): Promise<void> => {
  const name = fallback?.profileName ?? "";
  const failWith = (reason: FailureReason, port: number | null = null) => {
    if (requests.isCurrent(ticket)) setScreen({ kind: "error", target, name, origin: fallback?.origin ?? null, reason, port });
  };
  const backend = localBackend;
  if (!backend) { failWith("local-startup"); return; }
  let connection: LocalBackendConnection;
  try {
    connection = await backend.start();
  } catch (error) {
    console.warn("local backend: " + (error instanceof Error ? error.message : String(error)));
    if (!requests.isCurrent(ticket)) { await closeLocalBackend(); return; }
    if (error instanceof LocalPortBusyError) failWith("port-busy", error.port);
    else failWith("local-startup");
    return;
  }
  if (!requests.isCurrent(ticket)) { await closeLocalBackend(); return; }
  localConnection = connection;
  localStreaming = false;
  syncAwake();
  if (shell?.remotePartition !== LOCAL_PARTITION) await retireRemote();
  const remote = mountRemote(LOCAL_PARTITION, localOrigin, LOCAL_PRELOAD);
  if (!remote) { await closeLocalBackend(); failWith("local-startup"); return; }
  loadFailure = null;
  connected = connection.server;
  try {
    await remote.webContents.loadURL(connection.server.origin + "/");
  } catch {
    console.warn("local backend: the local page did not load (" + (loadFailure ?? "unreachable") + ")");
    await closeLocalBackend();
    failWith("local-startup");
    return;
  }
  if (!requests.isCurrent(ticket)) { await closeLocalBackend(); return; }
  if (!connected) { await closeLocalBackend(); return; }
  shellState.connection = {
    target,
    name: "",
    origin: connection.server.origin,
    version: connection.status.version,
    restricted: connection.status.restricted,
    secure: connection.status.secure,
    fallbackFrom: fallback?.profileName ?? null,
  };
  if (fallback === null) {
    shellState.chosen = target;
    await writeStartupChoice(app.getPath("userData"), target).catch(() => {});
  }
  setScreen({ kind: "connected" });
  if (fallback) {
    showToast({ id: nextToastId(), kind: "fallback", server: fallback.profileName });
    startRepoll(fallback.origin, fallback.profileName);
  }
};

/** A saved profile: probe, then take over the window. An unreachable one falls back on launch. */
const connectProfile = async (ticket: number, target: Target, profile: ServerProfile, server: ServerOrigin, launch: boolean): Promise<void> => {
  let result = await fetchStatus(server.origin, fetch, PROBE_TIMEOUT_MS);
  if (!result.ok && result.reason === "unreachable") result = await fetchStatus(server.origin, fetch, PROBE_TIMEOUT_MS);
  if (!requests.isCurrent(ticket)) return;
  if (!result.ok) {
    if (launch && fallbackApplies(target, result.reason)) {
      shellState.chosen = target;
      await startLocal(ticket, target, { profileName: profile.name, origin: server.origin });
      return;
    }
    setScreen({ kind: "error", target, name: profile.name, origin: server.origin, reason: result.reason, port: null });
    return;
  }
  const partition = partitionForOrigin(server.origin);
  if (shell?.remotePartition !== partition) await retireRemote();
  const remote = mountRemote(partition, () => server.origin);
  if (!remote) {
    setScreen({ kind: "error", target, name: profile.name, origin: server.origin, reason: "unreachable", port: null });
    return;
  }
  loadFailure = null;
  connected = server;
  try {
    await remote.webContents.loadURL(server.origin + "/");
  } catch {
    const reason = loadFailure ?? "unreachable";
    loadFailure = null;
    connected = null;
    if (requests.isCurrent(ticket)) setScreen({ kind: "error", target, name: profile.name, origin: server.origin, reason, port: null });
    return;
  }
  if (!requests.isCurrent(ticket)) return;
  if (!connected) return;
  shellState.connection = {
    target,
    name: profile.name,
    origin: server.origin,
    version: result.version,
    restricted: result.restricted,
    secure: result.secure,
    fallbackFrom: null,
  };
  shellState.chosen = target;
  await writeStartupChoice(app.getPath("userData"), target).catch(() => {});
  // A remote profile that answered takes over from the local backend for good.
  await closeLocalBackend();
  setScreen({ kind: "connected" });
};

const connectTarget = (target: Target, options: { launch: boolean }): Promise<void> => {
  const ticket = requests.next();
  return queue.run(async () => {
    stopRepoll();
    const profile = target.kind === "profile" ? findProfile(profileStore, target.id) : null;
    const server = profile ? parseServerOrigin(profile.origin) : null;
    if (target.kind === "profile" && (!profile || !server)) {
      if (requests.isCurrent(ticket)) setScreen({ kind: "error", target, name: "", origin: null, reason: "invalid", port: null });
      return;
    }
    if (!requests.isCurrent(ticket)) return;
    setScreen({ kind: "connecting", target, name: profile?.name ?? "", origin: server?.origin ?? null });
    if (target.kind === "local") { await startLocal(ticket, target, null); return; }
    await connectProfile(ticket, target, profile as ServerProfile, server as ServerOrigin, options.launch);
  });
};

const restartLocal = async (): Promise<{ ok: boolean }> => {
  const showingLocal = shellState.connection?.target.kind === "local";
  const wasRunning = localConnection !== null;
  await closeLocalBackend();
  if (showingLocal) {
    await connectTarget({ kind: "local" }, { launch: false });
    if (shellState.screen.kind === "connected" && shellState.connection?.target.kind === "local") {
      showToast({ id: nextToastId(), kind: "local-restarted" });
    }
    return { ok: true };
  }
  // The window shows a remote server, but a running backend has to come back all the same.
  if (!wasRunning || !localBackend) return { ok: true };
  try {
    localConnection = await localBackend.start();
    syncAwake();
    pushState();
    showToast({ id: nextToastId(), kind: "local-restarted" });
  } catch (error) {
    console.warn("local backend: " + (error instanceof Error ? error.message : String(error)));
  }
  return { ok: true };
};

const shellWebPreferences = () => ({
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  preload: SHELL_PRELOAD,
});

const wireShellView = (view: WebContentsView, name: "main" | "toast") => {
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  view.webContents.on("will-navigate", (event) => event.preventDefault());
  void view.webContents.loadFile(RENDERER_PAGE, { query: { view: name } });
};

const createShell = (saved: WindowState | null) => {
  const restored = restoreBounds(
    saved,
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getPrimaryDisplay().workArea,
    DEFAULT_SIZE,
  );
  const window = new BaseWindow({
    ...restored.bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: APP_NAME,
    backgroundColor: WINDOW_BACKGROUND,
  });
  const page = new WebContentsView({ webPreferences: shellWebPreferences() });
  const toast = new WebContentsView({ webPreferences: shellWebPreferences() });
  wireShellView(page, "main");
  wireShellView(toast, "toast");
  toast.setBackgroundColor("#00000000");
  toast.setVisible(false);
  window.contentView.addChildView(page);
  window.contentView.addChildView(toast);
  window.on("resize", applyLayout);
  window.on("enter-full-screen", applyLayout);
  window.on("leave-full-screen", applyLayout);
  const save = new Debounced(() => {
    void writeWindowState(app.getPath("userData"), "main",
      { bounds: window.getNormalBounds(), maximized: window.isMaximized() }).catch(() => {});
  }, WINDOW_SAVE_DELAY_MS);
  window.on("resize", () => save.schedule());
  window.on("move", () => save.schedule());
  window.on("maximize", () => save.schedule());
  window.on("unmaximize", () => save.schedule());
  window.on("close", () => save.flush());
  let retired = false;
  window.on("close", (event) => {
    if (retired || quitting || !liveRemote()) return;
    event.preventDefault();
    retired = true;
    void retireRemote().finally(() => window.close());
  });
  window.on("closed", () => { shell = null; settingsWindow.close(); });
  shell = { window, page, toast, remote: null, remotePartition: null };
  if (restored.maximized) window.maximize();
  pushState();
};

const fromShellPage = (event: IpcMainInvokeEvent | IpcMainEvent): boolean => {
  const current = shell;
  if (current !== null && (event.sender === current.page.webContents || event.sender === current.toast.webContents)) return true;
  const settings = settingsWindow.contents;
  return settings !== null && event.sender === settings;
};

const assertShellSender = (event: IpcMainInvokeEvent | IpcMainEvent) => {
  if (!fromShellPage(event)) throw new Error("shell: unexpected sender");
};

const profileIdOf = (value: unknown) => typeof value === "string" && value.length > 0 ? value : null;

const persistProfiles = async (next: ProfileStore): Promise<boolean> => {
  try {
    await writeProfiles(app.getPath("userData"), next);
  } catch {
    return false;
  }
  profileStore = next;
  return true;
};

const saveProfile = (input: { id: string | null; name: unknown; origin: unknown }): Promise<ProfileResult> =>
  queue.run(async (): Promise<ProfileResult> => {
    const name = normalizeProfileName(input.name);
    if (name === null) return { ok: false, reason: "invalid-name" };
    const origin = normalizeProfileOrigin(input.origin);
    if (origin === null) return { ok: false, reason: "invalid-data" };
    const id = input.id ?? randomUUID();
    const next = input.id === null
      ? addProfile(profileStore, id, { name, origin })
      : updateProfile(profileStore, input.id, { name, origin });
    if (!next) return { ok: false, reason: "invalid-data" };
    if (!await persistProfiles(next)) return { ok: false, reason: "save-failed" };
    pushState();
    const profile = findProfile(profileStore, id);
    return profile ? { ok: true, profile } : { ok: false, reason: "not-found" };
  });

const deleteProfile = (id: string | null): Promise<{ ok: boolean }> =>
  queue.run(async (): Promise<{ ok: boolean }> => {
    if (id === null || !findProfile(profileStore, id)) return { ok: false };
    // The profile the main window is showing must not vanish under it.
    if (shellState.connection?.target.kind === "profile" && shellState.connection.target.id === id) return { ok: false };
    if (!await persistProfiles(removeProfile(profileStore, id))) return { ok: false };
    pushState();
    return { ok: true };
  });

const registerHandlers = () => {
  ipcMain.handle("shell:getState", (event) => {
    assertShellSender(event);
    refreshLocal();
    return shellState;
  });

  ipcMain.handle("shell:connect", async (event, input: unknown): Promise<void> => {
    assertShellSender(event);
    const target = parseTarget(input);
    if (!target) throw new Error("shell: invalid target");
    await connectTarget(target, { launch: false });
  });

  ipcMain.handle("shell:saveProfile", async (event, input: unknown): Promise<ProfileResult> => {
    assertShellSender(event);
    const record = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
    return saveProfile({ id: profileIdOf(record.id), name: record.name, origin: record.origin });
  });

  ipcMain.handle("shell:deleteProfile", async (event, input: unknown): Promise<{ ok: boolean }> => {
    assertShellSender(event);
    return deleteProfile(profileIdOf(input));
  });

  ipcMain.handle("shell:probe", async (event, input: unknown): Promise<ProbeResult> => {
    assertShellSender(event);
    if (typeof input !== "string") return { ok: false, reason: "invalid" };
    return fetchStatus(input, fetch, PROBE_TIMEOUT_MS);
  });

  ipcMain.handle("shell:setLocalSettings", async (event, input: unknown): Promise<{ ok: boolean; restartNeeded: boolean }> => {
    assertShellSender(event);
    const settings = parseLocalSettings(input);
    if (!settings) return { ok: false, restartNeeded: false };
    return queue.run(async (): Promise<{ ok: boolean; restartNeeded: boolean }> => {
      try {
        await writeLocalSettings(app.getPath("userData"), settings);
      } catch {
        return { ok: false, restartNeeded: false };
      }
      localSettings = settings;
      const launched = localBackend?.launchedSettings() ?? null;
      const restartNeeded = localConnection !== null && (launched === null || !sameLocalSettings(launched, settings));
      pushState();
      return { ok: true, restartNeeded };
    });
  });

  ipcMain.handle("shell:restartLocal", async (event): Promise<{ ok: boolean }> => {
    assertShellSender(event);
    return restartLocal();
  });

  ipcMain.handle("shell:setLocale", async (event, input: unknown): Promise<void> => {
    assertShellSender(event);
    if (input !== null && input !== "cs" && input !== "en") throw new Error("shell: invalid locale");
    const choice = input as ShellLocale | null;
    await queue.run(async () => {
      await writeShellPrefs(app.getPath("userData"), { locale: choice });
    });
    shellState.localeChoice = choice;
    shellState.locale = effectiveLocale(choice, app.getLocale());
    pushState();
  });

  ipcMain.on("shell:openSettings", (event) => {
    assertShellSender(event);
    openSettings();
  });

  ipcMain.on("shell:toastAction", (event, input: unknown) => {
    assertShellSender(event);
    const id = typeof input === "number" && Number.isInteger(input) ? input : null;
    const toast = shellState.toast;
    if (id === null || !toast || toast.id !== id) return;
    if ((toast.kind === "fallback" || toast.kind === "server-back") && shellState.chosen) {
      void connectTarget(shellState.chosen, { launch: false });
    }
    hideToast();
  });

  ipcMain.on("shell:dismissToast", (event, input: unknown) => {
    assertShellSender(event);
    if (typeof input === "number" && shellState.toast?.id === input) hideToast();
  });

  ipcMain.on("shell:copyText", (event, input: unknown) => {
    assertShellSender(event);
    if (typeof input === "string" && input.length <= MAX_CLIPBOARD_TEXT) clipboard.writeText(input);
  });

  // Only the top frame of the page the local backend serves, while it is the page on screen.
  ipcMain.handle("desktop:pick-folder", async (event): Promise<string | null> => {
    const current = shell;
    const frame = event.senderFrame;
    if (!current || !localPageSent({
      currentView: current.remote !== null && event.sender === current.remote.webContents,
      partition: current.remotePartition,
      frame: frame ? { url: frame.url, top: frame.parent === null } : null,
      localOrigin: localOrigin(),
    })) throw new Error("desktop: unexpected sender");
    const result = await dialog.showOpenDialog(current.window, {
      title: catalogue(shellState.locale)["folder.pickTitle"],
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
};

app.on("window-all-closed", () => app.quit());

/** The first line of the bundled FFmpeg's build info, or null in a development run. */
const readFfmpegLine = (resourcesDir: string | null): string | null => {
  if (!resourcesDir) return null;
  try {
    const first = readFileSync(path.join(resourcesDir, "ffmpeg", "BUILDINFO.txt"), "utf8").split("\n")[0]?.trim() ?? "";
    return first.length > 0 ? first : null;
  } catch {
    return null;
  }
};

const createLocalBackend = (): LocalBackend => new LocalBackend({
  entry: LOCAL_BACKEND_ENTRY,
  userDataDir: app.getPath("userData"),
  fork: (entry, options) => utilityProcess.fork(entry, [], options),
  probeStatus: fetchStatus,
  tools: bundledMediaTools(app.isPackaged ? process.resourcesPath : null),
  onActivity: (streaming) => { localStreaming = streaming; syncAwake(); pushState(); },
  onUnexpectedExit: () => { localConnection = null; localStreaming = false; syncAwake(); failConnected("local-startup"); },
  log: (line) => console.warn("local backend: " + line),
});

/** The packaged smoke: start the managed backend, let it answer its status, stop it, exit. */
const runLocalBackendSmoke = async () => {
  const backend = createLocalBackend();
  try {
    const connection = await backend.start();
    process.stdout.write(`local-backend-smoke: ready ${connection.server.origin} api/status ${connection.status.version}\n`);
    await backend.stop();
    process.stdout.write("local-backend-smoke: stopped\n");
    app.exit(0);
  } catch (error) {
    process.stdout.write(`local-backend-smoke: failed ${error instanceof Error ? error.message : String(error)}\n`);
    await backend.stop().catch(() => {});
    app.exit(1);
  }
};

// Chromium settles the server pages' language before the shell can, so an explicit choice has to
// reach the command line this early; `userData` is readable before the app is ready.
const earlyPrefs = readShellPrefsSync(app.getPath("userData"));
if (earlyPrefs.locale !== null) app.commandLine.appendSwitch("lang", earlyPrefs.locale);

if (process.argv.includes(SMOKE_LOCAL_BACKEND)) {
  // The smoke gets its own instance directory, so it neither needs the single-instance lock
  // nor touches the data of an install that happens to be running.
  app.setPath("userData", path.join(app.getPath("temp"), `stremio-offline-smoke-${randomUUID()}`));
  void app.whenReady().then(runLocalBackendSmoke);
} else if (app.requestSingleInstanceLock()) {
  // A second launch must not start a second backend against the same instance directory.
  app.on("second-instance", () => {
    const current = shell;
    if (!current) return;
    if (current.window.isMinimized()) current.window.restore();
    current.window.focus();
  });

  app.on("activate", () => {
    if (shell) return;
    void readWindowState(app.getPath("userData"), "main").then((saved) => { if (!shell) createShell(saved); });
  });

  let backendShutdownComplete = false;
  let backendShutdown: Promise<void> | null = null;
  app.on("before-quit", (event) => {
    if (backendShutdownComplete) return;
    event.preventDefault();
    if (backendShutdown) return;
    quitting = true;
    localStreaming = false;
    syncAwake();
    backendShutdown = retireRemote().then(closeLocalBackend).finally(() => {
      backendShutdownComplete = true;
      app.quit();
    });
  });

  void app.whenReady().then(async () => {
    profileStore = await readProfiles(app.getPath("userData"));
    localSettings = await readLocalSettings(app.getPath("userData"));
    const prefs = await readShellPrefs(app.getPath("userData"));
    const savedWindow = await readWindowState(app.getPath("userData"), "main");
    shellState.localeChoice = prefs.locale;
    shellState.locale = effectiveLocale(prefs.locale, app.getLocale());
    shellState.appVersion = app.getVersion();
    ffmpegLine = readFfmpegLine(app.isPackaged ? process.resourcesPath : null);
    localBackend = createLocalBackend();
    registerHandlers();
    // A one-time migration: the old connection file's selected profile stands in for a choice
    // until the shell has written its own startup.json.
    const choice = await readStartupChoice(app.getPath("userData"));
    const legacy: Target | null = !existsSync(path.join(app.getPath("userData"), STARTUP_FILE)) && profileStore.selectedProfileId !== null
      ? { kind: "profile", id: profileStore.selectedProfileId }
      : null;
    const plan = launchPlan(choice ?? legacy, profileStore.profiles);
    // The window opens already saying where it connects, never flashing the welcome screen first.
    if (plan.screen === "connect") {
      const profile = plan.target.kind === "profile" ? findProfile(profileStore, plan.target.id) : null;
      shellState.screen = { kind: "connecting", target: plan.target, name: profile?.name ?? "", origin: profile?.origin ?? null };
    }
    createShell(savedWindow);
    if (plan.screen === "connect") void connectTarget(plan.target, { launch: true });
  });
} else {
  app.quit();
}
