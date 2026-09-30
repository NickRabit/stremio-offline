import { app, BaseWindow, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, powerSaveBlocker, screen, session, shell as electronShell, Tray, utilityProcess, WebContentsView, type IpcMainEvent, type IpcMainInvokeEvent, type MessageBoxOptions, type MessageBoxReturnValue, type OpenDialogOptions, type OpenDialogReturnValue } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
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
import { mayTrashDownloadDirReal, OWNERSHIP_FILE, prepareDownloadDir, readOwnership, suggestedDownloadDir, writeOwnership, type Ownership, type Places } from "./download-dir.js";
import { isDeviceTicketDownload } from "./downloads.js";
import { catalogue } from "./i18n.js";
import { layout, type PageMode } from "./layout.js";
import { autostartExecutable, autostartFile, launchedHidden, launchExecutable, loginItemQuery, loginItemStatus, loginItemUpdate, readAutostart, removeAutostart, writeAutostart, type LoginItemReadings, loginItemOn } from "./login-item.js";
import { bundledMediaTools, DOWNLOADS_DIRECTORY, INSTANCE_DIRECTORY, LOCAL_PARTITION, LocalBackend, LocalPortBusyError, PORT_FILE, type LocalBackendConnection } from "./local-backend.js";
import { defaultLocalSettings, parseLocalSettings, readLocalSettings, SETTINGS_FILE, writeLocalSettings, type LocalSettings } from "./local-settings.js";
import { buildMenuTemplate } from "./menu.js";
import { externalBrowserUrl, httpAllowedHost, isAccessSignInUrl, parseServerOrigin, partitionForOrigin, type ServerOrigin } from "./origin.js";
import { localPageSent } from "./bridge-sender.js";
import { SettingsWindow } from "./settings-window.js";
import { sessionFetch } from "./session-fetch.js";
import type { AppPrefs, FailureReason, MainScreen, ProfileResult, ProbeResult, ShellState, Target, Toast } from "./shell-api.js";
import { effectiveLocale, readShellPrefs, readShellPrefsSync, SHELL_LOCALES, writeShellPrefs, type ShellLocale } from "./shell-prefs.js";
import { downloadFraction, nextToastId, safeFileName } from "./shell-text.js";
import { SerialQueue } from "./serial-queue.js";
import { SleepGuard } from "./sleep-guard.js";
import { MAX_TARGET_ID, LatestRequest, fallbackApplies, launchPlan, readStartupChoice, writeStartupChoice, STARTUP_FILE } from "./startup.js";
import { fetchStatus, type ProbeFailure } from "./status.js";
import { findSystemFfmpeg, type SystemFfmpeg } from "./system-ffmpeg.js";
import { buildTrayTemplate } from "./tray.js";
import { checkForUpdate, readRelease, UPDATE_FEED_URL, type Release } from "./update-check.js";
import { Debounced, DEFAULT_SIZE, MIN_SIZE, readWindowState, restoreBounds, writeWindowState, type WindowState } from "./window-state.js";

const ALLOWED_PERMISSIONS = new Set<string>(["fullscreen", "clipboard-sanitized-write"]);
const ABORTED = -3;
/** How long a server page gets to save the position and stop playback before its view goes. */
const RETIRE_TIMEOUT_MS = 1_500;
const PROBE_TIMEOUT_MS = 4_000;
const REPOLL_INTERVAL_MS = 30_000;
const TOAST_TIMEOUT_MS = 8_000;
const UPDATE_INTERVAL_MS = 24 * 60 * 60_000;
const UPDATE_TIMEOUT_MS = 5_000;
const MAX_CLIPBOARD_TEXT = 2_000;
const APP_NAME = "Stremio Offline";
const WINDOW_BACKGROUND = "#0b0e13";
const PROJECT_URL = "https://github.com/NickRabit/stremio-offline";
const WINDOW_SAVE_DELAY_MS = 500;
/** The operating system whose rules the shell follows, read once. */
const PLATFORM = process.platform;

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
/** The notification-area icon on Windows and Linux; null on macOS and once the app is quitting. */
let tray: Tray | null = null;
/** Whether the close-to-tray balloon has already been shown on this install. */
let trayNoticeShown = false;
let connected: ServerOrigin | null = null;
let remoteFullscreen = false;
let loadFailure: ProbeFailure | null = null;
/** A profile whose probe hit Cloudflare Access: while this is set, the server's own view shows
 *  Cloudflare's sign-in page and the connection is completed when it lands back on the server. */
let signIn: { ticket: number; target: Target; profile: ServerProfile; server: ServerOrigin } | null = null;
let localBackend: LocalBackend | null = null;
let localConnection: LocalBackendConnection | null = null;
/** The last streaming report from the running backend. */
let localStreaming = false;
/** The last downloading report from the running backend. */
let localDownloading = false;
let ffmpegLine: string | null = null;
/** The system FFmpeg a Linux desktop may run instead of the bundled one, found once at startup. */
let systemFfmpeg: SystemFfmpeg | null = null;
const sleepGuard = new SleepGuard(powerSaveBlocker);
/** Quitting retires the page itself, so a window closing on the way out does not wait for it again. */
let quitting = false;
/** The user said yes in the quit dialog; the next `before-quit` goes through. */
let quitConfirmed = false;
/** The quit dialog itself, so a second `before-quit` waits for it instead of opening another. */
let quitPrompt: Promise<void> | null = null;
const preparedPartitions = new Set<string>();
let profileStore: ProfileStore = { profiles: [], selectedProfileId: null };
let localSettings: LocalSettings = defaultLocalSettings();
/** Whether `<userData>/<INSTANCE_DIRECTORY>` exists; cached, so a push does not touch the disk. */
let localInitialized = false;
/** Electron shows the newest of these while a download runs; the shell counts them for `busy`. */
const deviceDownloads = new Map<object, number>();
const queue = new SerialQueue();
/** The newest connect request wins; a stale result is dropped instead of applied. */
const requests = new LatestRequest();
let repoll: NodeJS.Timeout | null = null;
let repollNotified = false;
let toastTimer: NodeJS.Timeout | null = null;
let updateTimer: NodeJS.Timeout | null = null;
/** The version this launch has already announced, so the same one is not shown twice. */
let updateNotified: string | null = null;

const shellState: ShellState = {
  platform: PLATFORM === "win32" ? "win32" : PLATFORM === "darwin" ? "darwin" : "linux",
  locale: "en",
  localeChoice: null,
  appVersion: "",
  screen: { kind: "welcome" },
  connection: null,
  chosen: null,
  profiles: [],
  local: {
    settings: defaultLocalSettings(),
    running: false,
    addresses: [],
    ffmpeg: null,
    systemFfmpeg: null,
    busy: false,
    downloadDir: "",
    suggestedDownloadDir: "",
    initialized: false,
    downloadDirOwned: false,
    restartNeeded: false,
  },
  app: {
    prefs: { openAtLogin: false, checkUpdates: true },
    loginItem: "unsupported",
    update: null,
  },
  toast: null,
};

const settingsWindow = new SettingsWindow({
  rendererPage: RENDERER_PAGE,
  preload: SHELL_PRELOAD,
  userDataDir: () => app.getPath("userData"),
  title: () => catalogue(shellState.locale, PLATFORM)["settings.title"],
  platform: PLATFORM,
});

/** The login item is the OS's to remember: it is read back rather than stored. Windows and macOS
 *  answer through Electron, Linux through its own XDG autostart file, and a development run cannot
 *  register the Electron binary, so it has no answer at all. */
const refreshLoginItem = async (): Promise<void> => {
  let settings: LoginItemReadings = {};
  try {
    if (PLATFORM === "linux") {
      settings = { openAtLogin: (await readAutostart(autostartFile(app.getPath("home"), process.env))).enabled };
    } else {
      settings = app.getLoginItemSettings(loginItemQuery(PLATFORM));
    }
  } catch {
    settings = {};
  }
  shellState.app = {
    ...shellState.app,
    prefs: { ...shellState.app.prefs, openAtLogin: loginItemOn(settings, PLATFORM) },
    loginItem: loginItemStatus(settings, PLATFORM, app.isPackaged),
  };
};

/** A renamed or replaced AppImage leaves an enabled entry pointing at the old file: this launch's
 *  executable is written back so a login start keeps working. */
const refreshAutostartExec = async (): Promise<void> => {
  const file = autostartFile(app.getPath("home"), process.env);
  if (!(await readAutostart(file)).enabled) return;
  const current = launchExecutable(process.env, process.execPath);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  if (autostartExecutable(text) === current) return;
  // A login entry that cannot be rewritten (a read-only folder, a full disk) is no reason to stop
  // the app from starting; it keeps the old path and says so.
  try {
    await writeAutostart(file, current);
  } catch (error) {
    console.warn("autostart: the login entry could not be updated: " + (error instanceof Error ? error.message : String(error)));
  }
};

const openSettings = (): void => {
  settingsWindow.open();
  void refreshLoginItem().then(() => pushState());
};

const targetKey = (target: Target | null): string =>
  target === null ? "-" : target.kind === "local" ? "local" : `profile:${target.id}`;

let menuKey = "";

const applyMenu = (): void => {
  const live = shellState.screen.kind === "connected" && shellState.connection !== null;
  const target = live ? shellState.connection?.target ?? null : null;
  const key = [
    shellState.locale,
    shellState.profiles.map((profile) => `${profile.id}:${profile.name}`).join(","),
    targetKey(target),
    live ? "connected" : "idle",
    targetKey(shellState.chosen),
    localConnection !== null ? "local-running" : "local-stopped",
  ].join("|");
  if (key === menuKey) return;
  menuKey = key;
  const strings = catalogue(shellState.locale, PLATFORM);
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({
    strings,
    profiles: shellState.profiles,
    current: target,
    connected: live,
    isPackaged: app.isPackaged,
    platform: PLATFORM,
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
      // Electron flips a clicked checkbox itself; rebuilding puts the tick back where the state says.
      connect: (target) => { menuKey = ""; applyMenu(); void connectTarget(target, { launch: false }); },
      reconnect: () => { void connectTarget(shellState.chosen ?? { kind: "local" }, { launch: false }); },
      openProject: () => { void electronShell.openExternal(PROJECT_URL).catch(() => {}); },
    },
  })));
  if (PLATFORM !== "darwin") {
    // Windows and Linux put the application menu on every window: the main window keeps it in
    // view, the settings window loses it again after each rebuild.
    shell?.window.setMenu(Menu.getApplicationMenu());
    settingsWindow.removeMenu();
  }
  tray?.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate({
    strings,
    profiles: shellState.profiles,
    // Without a window the tray still shows what runs: a local backend started hidden, or the choice.
    current: target ?? (localConnection !== null ? { kind: "local" } : shellState.chosen),
    connected: live,
    platform: PLATFORM,
    actions: {
      open: () => { void showMainWindow(); },
      openSettings,
      connect: (target) => { menuKey = ""; applyMenu(); void connectTarget(target, { launch: false }); },
      quit: () => app.quit(),
    },
  })));
};

const sameLocalSettings = (a: LocalSettings, b: LocalSettings) =>
  a.allowPrivateAddons === b.allowPrivateAddons && a.publish === b.publish && a.publishPort === b.publishPort
  && a.useSystemFfmpeg === b.useSystemFfmpeg;

const syncAwake = () =>
  sleepGuard.update({ published: localConnection?.published === true, streaming: localStreaming, downloading: localDownloading });

/** Both the connected server page and Cloudflare's sign-in page take the whole window. */
const serverPageShown = (): boolean =>
  shellState.screen.kind === "connected" || shellState.screen.kind === "sign-in";

const pageMode = (): PageMode =>
  !serverPageShown() ? "shell" : remoteFullscreen ? "fullscreen" : "remote";

/** Windows gives the menu bar back a moment after a window leaves full screen, and that shrinks
 *  the content area without a resize event: laid out at once, the page runs under the bottom edge.
 *  So the layout is taken again once the frame has settled. */
const settleLayout = () => {
  applyLayout();
  if (PLATFORM !== "win32") return;
  for (const delay of [50, 200, 500]) setTimeout(applyLayout, delay).unref();
};

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
  const name = screen.kind === "connected" ? shellState.connection?.name ?? "" : screen.kind === "setup" ? "" : screen.name;
  const label = name.trim().length > 0 ? name : catalogue(shellState.locale, PLATFORM)["window.thisMac"];
  return `${APP_NAME} — ${label}`;
};

/** The folder downloads go to: the stored one, else the default every install before the setup
 *  step keeps. */
/** Whose the stored download folder is, recorded when it was adopted. */
let ownership: Ownership | null = null;
/** Folders that passed the check in this session, and whether each was the app's to own; only
 *  these can become the download folder. */
const preparedDirs = new Map<string, boolean>();
/** The folders a download folder is measured against; a known folder the system does not have is
 *  skipped rather than failing the whole check. */
const places = (): Places => {
  const knownFolders: string[] = [];
  for (const name of ["videos", "desktop", "documents", "downloads", "music", "pictures"] as const) {
    try {
      knownFolders.push(app.getPath(name));
    } catch {
      // Not every platform knows every folder.
    }
  }
  // A development run's executable is Electron in node_modules, which nobody picks.
  const installDir = app.isPackaged ? path.dirname(process.execPath) : undefined;
  return { home: app.getPath("home"), userData: app.getPath("userData"), platform: PLATFORM, knownFolders, installDir };
};

const effectiveDownloadDir = (): string =>
  localSettings.downloadDir ?? path.join(app.getPath("userData"), DOWNLOADS_DIRECTORY);

const refreshInitialized = () => {
  try {
    localInitialized = statSync(path.join(app.getPath("userData"), INSTANCE_DIRECTORY)).isDirectory();
  } catch {
    localInitialized = false;
  }
};

/** The running backend was started with other settings than those stored now. */
const localRestartNeeded = (): boolean => {
  if (localConnection === null) return false;
  const launched = localBackend?.launchedSettings() ?? null;
  return launched === null || !sameLocalSettings(launched, localSettings);
};

/** Whether the download folder is the app's to move to the Trash. The folder's real location is
 *  read asynchronously, so the state carries the last answer and a different one is pushed again. */
let downloadDirOwned = false;

const refreshDownloadDirOwned = async (): Promise<void> => {
  let owned = false;
  if (PLATFORM !== "win32") {
    try {
      owned = await mayTrashDownloadDirReal(effectiveDownloadDir(), localSettings.downloadDir, ownership, places());
    } catch {
      owned = false;
    }
  }
  if (owned === downloadDirOwned) return;
  downloadDirOwned = owned;
  pushState();
};

const refreshLocal = () => {
  shellState.profiles = profileStore.profiles;
  shellState.local = {
    settings: localSettings,
    running: localConnection !== null,
    addresses: localConnection?.addresses ?? [],
    ffmpeg: ffmpegLine,
    systemFfmpeg: systemFfmpeg?.ffmpeg ?? null,
    busy: localStreaming || localDownloading || deviceDownloads.size > 0,
    downloadDir: effectiveDownloadDir(),
    suggestedDownloadDir: suggestedDownloadDir(app.getPath("home"), app.getPath("videos"), PLATFORM),
    initialized: localInitialized,
    // Windows may delete a folder too large for the Recycle Bin for good, so it is never offered.
    downloadDirOwned,
    restartNeeded: localRestartNeeded(),
  };
};

const pushState = () => {
  refreshLocal();
  applyMenu();
  const current = shell;
  if (current) {
    applyLayout();
    for (const view of [current.page, current.toast]) {
      if (!view.webContents.isDestroyed()) view.webContents.send("shell:state", shellState);
    }
    current.window.setTitle(titleFor(shellState.screen));
  }
  settingsWindow.push(shellState);
  void refreshDownloadDirOwned();
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
  // A fallback and an update notice stay until they are dismissed or acted on; the rest go by
  // themselves.
  if (toast.kind === "fallback" || toast.kind === "update") return;
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

/** A remote profile is probed through its own partition, so a signed-in Cloudflare Access
 *  cookie goes along; anything that does not parse as a server keeps the plain fetch. */
const probeProfile = (input: string) => {
  const server = parseServerOrigin(input);
  const ses = server ? session.fromPartition(partitionForOrigin(server.origin)) : null;
  return fetchStatus(input, ses ? sessionFetch(ses) : fetch, PROBE_TIMEOUT_MS);
};

const startRepoll = (origin: string, name: string) => {
  stopRepoll();
  repoll = setInterval(() => {
    void probeProfile(origin).then((result) => {
      // Access-protected is back too: the sign-in page answers, so the server is up again.
      if ((!result.ok && result.reason !== "access-required") || repollNotified) return;
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
  // With the window closed a notification is the only word the user gets.
  if (shell?.window.isFocused()) return;
  if (!Notification.isSupported()) return;
  const strings = catalogue(shellState.locale, PLATFORM);
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

/** Cloudflare Access's handshake runs under `/cdn-cgi/` on the server origin; a landing anywhere
 *  else on the origin means the sign-in is done. */
const onConnectedOriginOutsideCdnCgi = (url: string): boolean => {
  if (!onConnectedOrigin(url)) return false;
  try {
    return !new URL(url).pathname.startsWith("/cdn-cgi/");
  } catch {
    return false;
  }
};

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
  // A remote profile behind Cloudflare Access sends its sign-in page to the team's own host.
  if (connected !== null && shell?.remotePartition !== LOCAL_PARTITION && isAccessSignInUrl(url)) return;
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
    item.setSaveDialogOptions({ title: catalogue(shellState.locale, PLATFORM)["download.saveTitle"], defaultPath: file });
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
  contents.on("did-navigate", (_event, url) => {
    // Back on the server after the sign-in page: the cookie is there now, so probe and finish.
    if (shell?.remote !== remote || !signIn || !onConnectedOriginOutsideCdnCgi(url)) return;
    void queue.run(() => completeSignIn());
  });
  contents.on("enter-html-full-screen", () => { if (shell?.remote === remote) { remoteFullscreen = true; applyLayout(); } });
  contents.on("leave-html-full-screen", () => { if (shell?.remote === remote) { remoteFullscreen = false; settleLayout(); } });
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
  localDownloading = false;
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
const startLocal = async (ticket: number, target: Target, fallback: { profileName: string; origin: string } | null, announce = true): Promise<void> => {
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
    refreshInitialized();
    if (!requests.isCurrent(ticket)) { await closeLocalBackend(); return; }
    if (error instanceof LocalPortBusyError) failWith("port-busy", error.port);
    else failWith("local-startup");
    return;
  }
  if (!requests.isCurrent(ticket)) { await closeLocalBackend(); return; }
  // A backend that was already running keeps its last report; a fresh one reports within a tick.
  if (connection !== localConnection) {
    localStreaming = false;
    localDownloading = false;
  }
  localConnection = connection;
  refreshInitialized();
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
  // What the window shows is this Mac, also while it stands in for a profile: the menu, the
  // settings and a restart go by it. The profile it stands in for stays the remembered choice.
  shellState.connection = {
    target: { kind: "local" },
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
  if (fallback && announce) {
    showToast({ id: nextToastId(), kind: "fallback", server: fallback.profileName });
    startRepoll(fallback.origin, fallback.profileName);
  }
};

/** A remote profile that answered takes over the window: the local backend goes and the server
 *  page stays. Shared by the straight success and the sign-in that has just come back. */
const finishProfile = async (ticket: number, target: Target, profile: ServerProfile, server: ServerOrigin, result: { version: string; restricted: boolean; secure: boolean }): Promise<void> => {
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

/** A saved profile: probe, then take over the window. An unreachable one falls back on launch. */
const connectProfile = async (ticket: number, target: Target, profile: ServerProfile, server: ServerOrigin, launch: boolean): Promise<void> => {
  let result = await probeProfile(server.origin);
  if (!result.ok && result.reason === "unreachable") result = await probeProfile(server.origin);
  if (!requests.isCurrent(ticket)) return;
  if (!result.ok && result.reason !== "access-required") {
    refreshInitialized();
    // A stand-in that was never set up would start without its download folder chosen.
    if (launch && fallbackApplies(target, result.reason) && !needsSetup()) {
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
  if (result.ok) {
    await finishProfile(ticket, target, profile, server, result);
    return;
  }
  // The probe asked for a sign-in: the page on screen is Cloudflare's own.
  if (!requests.isCurrent(ticket)) return;
  signIn = { ticket, target, profile, server };
  setScreen({ kind: "sign-in", target, name: profile.name, origin: server.origin });
  // A view that is already on the server, outside Cloudflare's own path, needs no further click.
  if (onConnectedOriginOutsideCdnCgi(remote.webContents.getURL())) void queue.run(() => completeSignIn());
};

/** Cloudflare Access sent the window back to the server: probe again through the partition now
 *  that the cookie is there, and either connect or leave the sign-in page up. */
const completeSignIn = async (): Promise<void> => {
  const pending = signIn;
  if (!pending) return;
  signIn = null;
  if (!requests.isCurrent(pending.ticket)) return;
  const result = await probeProfile(pending.server.origin);
  // A connect asked for while the probe ran wins; the sign-in is abandoned silently.
  if (!requests.isCurrent(pending.ticket)) return;
  if (result.ok) {
    await finishProfile(pending.ticket, pending.target, pending.profile, pending.server, result);
    return;
  }
  if (result.reason === "access-required") {
    signIn = pending;
    return;
  }
  // Not failConnected: there is no connection yet, and the error screen should name the profile.
  connected = null;
  blankRemote();
  setScreen({ kind: "error", target: pending.target, name: pending.profile.name, origin: pending.server.origin, reason: result.reason, port: null });
};

/** The page on screen goes before another is tried: a failed attempt must not leave the old
 *  server playing behind the error screen. Retiring it first lets it save its position. */
const dropCurrentPage = async () => {
  await retireRemote();
  connected = null;
  signIn = null;
  shellState.connection = null;
};

/** A first start of the local backend waits for a download folder; an install that has run it keeps its own. */
const needsSetup = (): boolean => !localInitialized && localSettings.downloadDir === null;
/** What the window showed before the download-folder step, for its Back button. */
let setupReturn: Target | null = null;

const connectTarget = (target: Target, options: { launch: boolean }): Promise<void> => {
  // With the window closed a connection has nowhere to show, and the local backend would be
  // stopped for it: the window comes back first, on this target.
  if (!shell) return showMainWindow(target);
  const ticket = requests.next();
  return queue.run(async () => {
    stopRepoll();
    signIn = null;
    const profile = target.kind === "profile" ? findProfile(profileStore, target.id) : null;
    const server = profile ? parseServerOrigin(profile.origin) : null;
    if (target.kind === "profile" && (!profile || !server)) {
      if (requests.isCurrent(ticket)) setScreen({ kind: "error", target, name: "", origin: null, reason: "invalid", port: null });
      return;
    }
    if (!requests.isCurrent(ticket)) return;
    if (target.kind === "local") refreshInitialized();
    if (target.kind === "local" && needsSetup()) {
      if (shellState.screen.kind !== "setup") {
        setupReturn = shellState.screen.kind === "connected" ? shellState.connection?.target ?? null
          : shellState.screen.kind === "welcome" ? null : shellState.screen.target;
      }
      setScreen({ kind: "setup" });
      await dropCurrentPage();
      pushState();
      // Asked from the settings window or the menu, the question is in the main window.
      shell?.window.focus();
      return;
    }
    // A fallback notice belongs to the connection it announced.
    if (shellState.toast?.kind === "fallback" || shellState.toast?.kind === "server-back") hideToast();
    setScreen({ kind: "connecting", target, name: profile?.name ?? "", origin: server?.origin ?? null });
    await dropCurrentPage();
    if (target.kind === "local") { await startLocal(ticket, target, null); return; }
    await connectProfile(ticket, target, profile as ServerProfile, server as ServerOrigin, options.launch);
  });
};

const restartLocal = async (): Promise<{ ok: boolean }> => {
  const connection = shellState.connection;
  // With the window closed there is no page to reload, only a backend to restart.
  const showingLocal = shell !== null && shellState.screen.kind === "connected" && connection?.target.kind === "local";
  const backend = localBackend;
  if (showingLocal) {
    // A stand-in stays a stand-in: the profile it replaces and its re-poll carry on.
    const standIn = connection.fallbackFrom !== null && shellState.chosen?.kind === "profile"
      ? findProfile(profileStore, shellState.chosen.id) : null;
    const ticket = requests.next();
    const ok = await queue.run(async () => {
      setScreen({ kind: "connecting", target: { kind: "local" }, name: "", origin: null });
      await dropCurrentPage();
      await closeLocalBackend();
      await startLocal(ticket, standIn ? shellState.chosen as Target : { kind: "local" },
        standIn ? { profileName: standIn.name, origin: standIn.origin } : null, false);
      return shellState.screen.kind === "connected";
    });
    if (ok) showToast({ id: nextToastId(), kind: "local-restarted" });
    return { ok };
  }
  // The window shows a remote server, but a running backend has to come back all the same.
  if (localConnection === null || !backend) return { ok: true };
  return queue.run(async () => {
    await closeLocalBackend();
    try {
      localConnection = await backend.start();
    } catch (error) {
      console.warn("local backend: " + (error instanceof Error ? error.message : String(error)));
      pushState();
      return { ok: false };
    }
    refreshInitialized();
    syncAwake();
    pushState();
    showToast({ id: nextToastId(), kind: "local-restarted" });
    return { ok: true };
  });
};

/** A login start opens no window: the backend comes up on its own so other devices can reach it
 *  and downloads resume, and the tray is the only way in. A failure leaves it in the tray. */
const startLocalHidden = (): Promise<void> => {
  // In the queue with a ticket of its own, so a reset or a connect asked from the tray meanwhile
  // is not undone by a start that finishes after it.
  const ticket = requests.next();
  return queue.run(async () => {
    const backend = localBackend;
    if (!backend || !requests.isCurrent(ticket)) return;
    let connection: LocalBackendConnection;
    try {
      connection = await backend.start();
    } catch (error) {
      console.warn("local backend: " + (error instanceof Error ? error.message : String(error)));
      return;
    }
    if (!requests.isCurrent(ticket)) { await closeLocalBackend(); return; }
    localConnection = connection;
    refreshInitialized();
    syncAwake();
    pushState();
  });
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

/** The notification-area icon: the app's own icon, shrunk for the tray. Windows and Linux have one;
 *  a Linux desktop with no status notifier refuses it, which the app tolerates and logs once. */
const createTray = (): void => {
  try {
    const icon = nativeImage.createFromPath(path.join(app.getAppPath(), "build", "icon.png")).resize({ width: 16, height: 16 });
    const created = new Tray(icon);
    created.setToolTip(APP_NAME);
    created.on("click", () => { void showMainWindow(); });
    created.on("double-click", () => { void showMainWindow(); });
    tray = created;
  } catch (error) {
    console.warn("tray: " + (error instanceof Error ? error.message : String(error)));
  }
};

/** One balloon per install: the first close leaves the app running in the notification area. */
const showTrayNotice = (): void => {
  if (trayNoticeShown || !tray) return;
  trayNoticeShown = true;
  const strings = catalogue(shellState.locale, PLATFORM);
  tray.displayBalloon({ iconType: "info", title: strings["tray.stillRunningTitle"], content: strings["tray.stillRunningBody"] });
  void queue.run(async () => {
    await writeShellPrefs(app.getPath("userData"),
      { locale: shellState.localeChoice, checkUpdates: shellState.app.prefs.checkUpdates, trayNoticeShown: true });
  }).catch(() => {});
};

const createShell = (saved: WindowState | null, startMinimized = false) => {
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
    // A login start on Linux opens the window minimized, so it is still reachable from the taskbar.
    ...(startMinimized ? { show: false } : {}),
    // On Windows and Linux the menu bar stays in view: the server page fills the window, and a
    // menu hidden until Alt is one nobody finds, Settings with it.
    // A packaged app takes its icon from the executable, which neither Linux nor a development
    // run has, so both point the window at the icon file.
    ...(PLATFORM === "linux" || (PLATFORM === "win32" && !app.isPackaged)
      ? { icon: path.join(app.getAppPath(), "build", "icon.png") } : {}),
  });
  if (PLATFORM !== "darwin") window.setMenu(Menu.getApplicationMenu());
  const page = new WebContentsView({ webPreferences: shellWebPreferences() });
  const toast = new WebContentsView({ webPreferences: shellWebPreferences() });
  wireShellView(page, "main");
  wireShellView(toast, "toast");
  // Minimizing before the window is mapped is unreliable, on Wayland especially: it is shown once
  // its page is ready, then minimized.
  if (startMinimized) page.webContents.once("did-finish-load", () => { window.show(); window.minimize(); });
  toast.setBackgroundColor("#00000000");
  toast.setVisible(false);
  window.contentView.addChildView(page);
  window.contentView.addChildView(toast);
  window.on("resize", applyLayout);
  window.on("enter-full-screen", applyLayout);
  window.on("leave-full-screen", settleLayout);
  // Maximizing and restoring move the menu bar on Windows as well.
  window.on("maximize", settleLayout);
  window.on("unmaximize", settleLayout);
  window.on("restore", settleLayout);
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
    // Linux has no Dock to return to, and its tray is not relied on: closing the window is the way
    // out, through the same question the Quit item asks.
    if (PLATFORM === "linux" && !quitting) {
      event.preventDefault();
      app.quit();
      return;
    }
    if (retired || quitting || !liveRemote()) return;
    event.preventDefault();
    retired = true;
    void retireRemote().finally(() => window.close());
  });
  window.on("closed", () => {
    // A closed BaseWindow leaves its views' contents alive, and the app now outlives its window:
    // without this every close would leave a shell page, a toast and a server page behind.
    const closing = shell;
    shell = null;
    for (const view of [closing?.page, closing?.toast, closing?.remote]) {
      if (view && !view.webContents.isDestroyed()) view.webContents.close();
    }
    settingsWindow.close();
    if (PLATFORM === "win32" && !quitting) showTrayNotice();
  });
  shell = { window, page, toast, remote: null, remotePartition: null };
  if (restored.maximized && !startMinimized) window.maximize();
  pushState();
};

/** The window the app puts back when there is none: a Dock click, a second launch or a connect.
 *  It comes back on the target asked for, else on what was connected -- the local backend
 *  usually still runs, perhaps standing in for a profile -- else the remembered choice. */
const showMainWindow = (asked?: Target): Promise<void> => {
  const existing = shell;
  if (existing) {
    if (existing.window.isMinimized()) existing.window.restore();
    existing.window.focus();
    return asked ? connectTarget(asked, { launch: false }) : Promise.resolve();
  }
  return readWindowState(app.getPath("userData"), "main").then(async (saved) => {
    if (shell) { if (asked) await connectTarget(asked, { launch: false }); return; }
    const connection = shellState.connection;
    const localShown = localConnection !== null && connection?.target.kind === "local";
    const chosen = shellState.chosen;
    const standIn = !asked && localShown && connection.fallbackFrom !== null && chosen?.kind === "profile"
      ? findProfile(profileStore, chosen.id) : null;
    const target: Target | null = asked ?? (localShown ? { kind: "local" } : chosen);
    const profile = target?.kind === "profile" ? findProfile(profileStore, target.id) : null;
    // The window opens already saying where it goes, never on the screen it was closed with.
    shellState.screen = target
      ? { kind: "connecting", target, name: profile?.name ?? "", origin: profile?.origin ?? null }
      : { kind: "welcome" };
    createShell(saved);
    if (standIn && chosen) {
      // Still standing in: the profile stays the remembered choice and its re-poll carries on.
      const ticket = requests.next();
      await queue.run(() => startLocal(ticket, chosen, { profileName: standIn.name, origin: standIn.origin }, false));
      return;
    }
    if (target) await connectTarget(target, { launch: false });
  });
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

/** The window a native dialog belongs to: the settings window when it asked, the main one else.
 *  Null while there is no main window, which a dialog tolerates. */
const senderWindow = (event: IpcMainInvokeEvent): BaseWindow | null => {
  const settingsContents = settingsWindow.contents;
  if (settingsContents !== null && event.sender === settingsContents) {
    const settingsBrowserWindow = BrowserWindow.fromWebContents(event.sender);
    if (settingsBrowserWindow !== null) return settingsBrowserWindow;
  }
  return shell?.window ?? null;
};

/** The same dialogs, attached to the sender's window only when there is one. */
const showMessageBox = (owner: BaseWindow | null, options: MessageBoxOptions): Promise<MessageBoxReturnValue> =>
  owner === null ? dialog.showMessageBox(options) : dialog.showMessageBox(owner, options);

const showOpenDialog = (owner: BaseWindow | null, options: OpenDialogOptions): Promise<OpenDialogReturnValue> =>
  owner === null ? dialog.showOpenDialog(options) : dialog.showOpenDialog(owner, options);

/** Stops the local server, moves its data to the Trash and puts the app back on the welcome screen. */
const resetLocal = async (
  event: IpcMainInvokeEvent,
  options: { deleteDownloads: boolean; forgetServers: boolean },
): Promise<{ ok: boolean; cancelled: boolean; downloadsKept: boolean }> => {
  const strings = catalogue(shellState.locale, PLATFORM);
  // The folder the dialog names is the folder that goes, and only one the app owns.
  const shownDir = effectiveDownloadDir();
  // Windows never moves the download folder: the Recycle Bin has a quota, and a folder over it is
  // deleted for good. The instance data, which is small, still goes to the bin.
  const trashDownloads = PLATFORM !== "win32" && options.deleteDownloads
    && await mayTrashDownloadDirReal(shownDir, localSettings.downloadDir, ownership, places());
  const detail = [
    strings["reset.detail"],
    trashDownloads ? strings["reset.detailDownloads"].replace("{dir}", shownDir) : strings["reset.detailKeepsFilms"],
    ...(options.forgetServers ? [strings["reset.detailServers"]] : []),
  ].join("\n\n");
  const answer = await showMessageBox(senderWindow(event), {
    type: "warning",
    buttons: [strings["reset.confirm"], strings["reset.cancel"]],
    defaultId: 1,
    cancelId: 1,
    message: strings["reset.title"],
    detail,
  });
  if (answer.response !== 0) return { ok: false, cancelled: true, downloadsKept: true };
  const previous = shellState.connection?.target ?? null;
  const result = await queue.run(async (): Promise<{ ok: boolean; touched: boolean; downloadsKept: boolean; trashFailure: string | null }> => {
    if (effectiveDownloadDir() !== shownDir) return { ok: false, touched: false, downloadsKept: true, trashFailure: null };
    // A fresh ticket, so a connect still probing cannot land on the reset state afterwards.
    requests.next();
    stopRepoll();
    hideToast();
    await dropCurrentPage();
    await closeLocalBackend();
    const userDataDir = app.getPath("userData");
    // A backend that never started has no data to move; that is a reset already done, not a failure.
    const instance = path.join(userDataDir, INSTANCE_DIRECTORY);
    if (existsSync(instance)) {
      try {
        await electronShell.trashItem(instance);
      } catch (error) {
        return { ok: false, touched: true, downloadsKept: true, trashFailure: error instanceof Error ? error.message : String(error) };
      }
    }
    let downloadsKept = !trashDownloads;
    if (trashDownloads && existsSync(shownDir)) {
      try {
        await electronShell.trashItem(shownDir);
      } catch {
        downloadsKept = true;
      }
    }
    // Sign-ins go only once the data has: a reset that stopped above leaves them as they were.
    await session.fromPartition(LOCAL_PARTITION).clearStorageData().catch(() => {});
    for (const file of [SETTINGS_FILE, STARTUP_FILE, PORT_FILE, OWNERSHIP_FILE]) await unlink(path.join(userDataDir, file)).catch(() => {});
    if (options.forgetServers) {
      await writeProfiles(userDataDir, { profiles: [], selectedProfileId: null }).catch(() => {});
      for (const profile of profileStore.profiles) {
        await session.fromPartition(partitionForOrigin(profile.origin)).clearStorageData().catch(() => {});
      }
    }
    localSettings = defaultLocalSettings();
    ownership = null;
    preparedDirs.clear();
    shellState.chosen = null;
    shellState.connection = null;
    connected = null;
    profileStore = await readProfiles(userDataDir);
    refreshInitialized();
    shellState.screen = { kind: "welcome" };
    pushState();
    settingsWindow.close();
    return { ok: true, touched: true, downloadsKept, trashFailure: null };
  });
  // A reset that stopped half way brings back what the window showed rather than leave it blank.
  if (!result.ok && result.touched && previous) void connectTarget(previous, { launch: false });
  // Linux has no Trash on every mount, and the move fails loudly rather than delete: say so.
  if (PLATFORM === "linux" && result.trashFailure !== null) {
    void showMessageBox(senderWindow(event), {
      type: "warning",
      message: strings["reset.trashFailed"].replace("{reason}", result.trashFailure),
    }).catch(() => {});
  }
  if (result.ok && options.deleteDownloads && result.downloadsKept) {
    void dialog.showMessageBox({ type: "info", message: strings["reset.downloadsKept"].replace("{dir}", shownDir) }).catch(() => {});
  }
  return { ok: result.ok, cancelled: false, downloadsKept: result.downloadsKept };
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
    // Removing the server this Mac stands in for ends the stand-in: nothing is left to wait for.
    if (shellState.chosen?.kind === "profile" && shellState.chosen.id === id) {
      stopRepoll();
      if (shellState.toast?.kind === "fallback" || shellState.toast?.kind === "server-back") hideToast();
      const local: Target = { kind: "local" };
      shellState.chosen = shellState.connection?.target.kind === "local" ? local : null;
      if (shellState.connection) shellState.connection = { ...shellState.connection, fallbackFrom: null };
      await writeStartupChoice(app.getPath("userData"), shellState.chosen).catch(() => {});
    }
    pushState();
    return { ok: true };
  });

/** Exactly the two switches, both booleans; anything else is a page that has drifted. */
const parseAppPrefs = (value: unknown): AppPrefs | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("openAtLogin") || !keys.includes("checkUpdates")) return null;
  if (typeof record.openAtLogin !== "boolean" || typeof record.checkUpdates !== "boolean") return null;
  return { openAtLogin: record.openAtLogin, checkUpdates: record.checkUpdates };
};

/** The feed to ask, which a development run may point at a rehearsal server. */
const updateFeedUrl = (): string => {
  if (app.isPackaged) return UPDATE_FEED_URL;
  const override = process.env.STREMIO_OFFLINE_UPDATE_FEED?.trim() ?? "";
  return override.length > 0 ? override : UPDATE_FEED_URL;
};

const runUpdateCheck = async (): Promise<void> => {
  if (!shellState.app.prefs.checkUpdates) return;
  const release = await checkForUpdate(shellState.appVersion, fetch, updateFeedUrl(), UPDATE_TIMEOUT_MS);
  // The switch may have gone off while the feed was being asked.
  if (!shellState.app.prefs.checkUpdates) return;
  shellState.app = { ...shellState.app, update: release ? { version: release.version, url: release.url } : null };
  if (release && release.version !== updateNotified) {
    updateNotified = release.version;
    showToast({ id: nextToastId(), kind: "update", version: release.version });
  }
  pushState();
};

/** Turning the check off forgets the release it found and stops asking; turning it on asks now. */
const syncUpdateChecks = (enabled: boolean): void => {
  if (updateTimer) { clearInterval(updateTimer); updateTimer = null; }
  if (!enabled) {
    if (shellState.app.update !== null) shellState.app = { ...shellState.app, update: null };
    return;
  }
  void runUpdateCheck();
  updateTimer = setInterval(() => void runUpdateCheck(), UPDATE_INTERVAL_MS);
  updateTimer.unref();
};

/** Opens the release page of the announced update, and only a link the feed accepted. */
const openUpdatePage = (): void => {
  const update = shellState.app.update;
  if (update === null) return;
  const release: Release | null = readRelease({ tag_name: update.version, html_url: update.url });
  if (release === null) return;
  void electronShell.openExternal(release.url).catch(() => {});
};

const applyAppPrefs = async (prefs: AppPrefs): Promise<{ ok: boolean }> => {
  const previous = shellState.app.prefs;
  let ok = true;
  if (prefs.openAtLogin !== previous.openAtLogin) {
    if (!app.isPackaged) {
      // A development run would register the Electron binary itself as a login item.
      ok = false;
    } else if (PLATFORM === "linux") {
      try {
        const file = autostartFile(app.getPath("home"), process.env);
        if (prefs.openAtLogin) await writeAutostart(file, launchExecutable(process.env, process.execPath));
        else await removeAutostart(file);
      } catch {
        ok = false;
      }
    } else {
      try {
        // Windows matches the registry entry by path and arguments, so disabling clears both.
        for (const update of loginItemUpdate(prefs.openAtLogin, PLATFORM)) app.setLoginItemSettings(update);
      } catch {
        ok = false;
      }
    }
  }
  await refreshLoginItem();
  shellState.app = { ...shellState.app, prefs: { ...shellState.app.prefs, checkUpdates: prefs.checkUpdates } };
  await queue.run(async () => {
    await writeShellPrefs(app.getPath("userData"),
      { locale: shellState.localeChoice, checkUpdates: prefs.checkUpdates, trayNoticeShown });
  });
  if (prefs.checkUpdates !== previous.checkUpdates) syncUpdateChecks(prefs.checkUpdates);
  pushState();
  return { ok };
};

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

  ipcMain.handle("shell:cancelSetup", async (event): Promise<void> => {
    assertShellSender(event);
    if (shellState.screen.kind !== "setup") return;
    const previous = setupReturn;
    setupReturn = null;
    if (previous) { await connectTarget(previous, { launch: false }); return; }
    requests.next();
    await queue.run(async () => {
      if (shellState.screen.kind === "setup") setScreen({ kind: "welcome" });
    });
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
    return probeProfile(input);
  });

  ipcMain.handle("shell:setLocalSettings", async (event, input: unknown): Promise<{ ok: boolean; restartNeeded: boolean }> => {
    assertShellSender(event);
    const settings = parseLocalSettings(input);
    if (!settings) return { ok: false, restartNeeded: false };
    return queue.run(async (): Promise<{ ok: boolean; restartNeeded: boolean }> => {
      // Checked here, in the queue: a first start may still be creating the instance while the page asks.
      refreshInitialized();
      const folder = settings.downloadDir;
      const changing = folder !== localSettings.downloadDir;
      // The first library's root is fixed once the instance exists, and only a folder that passed
      // the check may become it.
      if (changing && (localInitialized || (folder !== null && !preparedDirs.has(folder)))) return { ok: false, restartNeeded: false };
      try {
        await writeLocalSettings(app.getPath("userData"), settings);
        if (changing) {
          ownership = folder === null ? null : { dir: folder, owned: preparedDirs.get(folder) === true };
          if (ownership) await writeOwnership(app.getPath("userData"), ownership);
          else await unlink(path.join(app.getPath("userData"), OWNERSHIP_FILE)).catch(() => {});
        }
      } catch {
        return { ok: false, restartNeeded: false };
      }
      localSettings = settings;
      const restartNeeded = localRestartNeeded();
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
    if (input !== null && !SHELL_LOCALES.includes(input as ShellLocale)) throw new Error("shell: invalid locale");
    const choice = input as ShellLocale | null;
    await queue.run(async () => {
      await writeShellPrefs(app.getPath("userData"),
        { locale: choice, checkUpdates: shellState.app.prefs.checkUpdates, trayNoticeShown });
    });
    shellState.localeChoice = choice;
    shellState.locale = effectiveLocale(choice, app.getLocale());
    pushState();
  });

  ipcMain.handle("shell:setAppPrefs", async (event, input: unknown): Promise<{ ok: boolean }> => {
    assertShellSender(event);
    const prefs = parseAppPrefs(input);
    if (!prefs) return { ok: false };
    return applyAppPrefs(prefs);
  });

  ipcMain.on("shell:openUpdate", (event) => {
    assertShellSender(event);
    openUpdatePage();
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
    if (toast.kind === "update") openUpdatePage();
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

  ipcMain.handle("shell:pickFolder", async (event, input: unknown): Promise<string | null> => {
    assertShellSender(event);
    const result = await showOpenDialog(senderWindow(event), {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: typeof input === "string" && path.isAbsolute(input) ? input : undefined,
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle("shell:prepareDownloadDir", async (event, input: unknown) => {
    assertShellSender(event);
    const result = await prepareDownloadDir(input, places());
    if (!result.ok) return result;
    preparedDirs.set(result.dir, result.owned);
    return { ok: true, dir: result.dir };
  });

  ipcMain.handle("shell:resetLocal", async (event, input: unknown): Promise<{ ok: boolean; cancelled: boolean; downloadsKept: boolean }> => {
    assertShellSender(event);
    const record = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
    if (typeof record.deleteDownloads !== "boolean" || typeof record.forgetServers !== "boolean") {
      throw new Error("shell: invalid reset options");
    }
    return resetLocal(event, { deleteDownloads: record.deleteDownloads, forgetServers: record.forgetServers });
  });

  // The language is no secret, but only the local backend's page asks for it.
  ipcMain.on("desktop:locale", (event) => {
    const current = shell;
    const frame = event.senderFrame;
    event.returnValue = current !== null && localPageSent({
      currentView: current.remote !== null && event.sender === current.remote.webContents,
      partition: current.remotePartition,
      frame: frame ? { url: frame.url, top: frame.parent === null } : null,
      localOrigin: localOrigin(),
    }) ? shellState.locale : null;
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
      title: catalogue(shellState.locale, PLATFORM)["folder.pickTitle"],
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
};

// macOS convention: closing the window leaves the app in the Dock, its backend still downloading.
app.on("window-all-closed", () => {});

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
  tools: bundledMediaTools(app.isPackaged ? process.resourcesPath : null, undefined, PLATFORM),
  systemTools: systemFfmpeg,
  onActivity: (activity) => {
    localStreaming = activity.streaming;
    localDownloading = activity.downloading;
    syncAwake();
    pushState();
  },
  onUnexpectedExit: () => {
    localConnection = null;
    localStreaming = false;
    localDownloading = false;
    syncAwake();
    failConnected("local-startup");
  },
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
    // A Windows GUI app does not hand its utility process's stdout on, so the server's own log is
    // what tells the smoke which FFmpeg and which encoder it found.
    try {
      const log = readFileSync(path.join(app.getPath("userData"), INSTANCE_DIRECTORY, "app.log"), "utf8");
      for (const line of log.split("\n")) if (line.trim()) process.stdout.write(`local-backend-log: ${line}\n`);
    } catch { /* no log is no worse than before */ }
    app.exit(0);
  } catch (error) {
    process.stdout.write(`local-backend-smoke: failed ${error instanceof Error ? error.message : String(error)}\n`);
    await backend.stop().catch(() => {});
    app.exit(1);
  }
};

// A development run keeps its own data: it shares the package name, and so the folder, with an
// installed app on the same machine, and would otherwise write into that app's server and log.
// An explicit --user-data-dir (tests, the smoke) already chose.
if (!app.isPackaged && !process.argv.some((arg) => arg.startsWith("--user-data-dir"))) {
  app.setPath("userData", `${app.getPath("userData")}-dev`);
}

// Chromium settles the server pages' language before the shell can, so an explicit choice has to
// reach the command line this early; `userData` is readable before the app is ready.
const earlyPrefs = readShellPrefsSync(app.getPath("userData"));
if (earlyPrefs.locale !== null) app.commandLine.appendSwitch("lang", earlyPrefs.locale);

// Windows toasts and the taskbar need the AUMID, which the NSIS installer's Start menu shortcut
// registers. The portable ZIP gets no notifications at all; nothing here waits for one.
if (PLATFORM === "win32") app.setAppUserModelId("com.stremiooffline.desktop");

// Electron derives WM_CLASS and the Wayland app id from this name, and xdg-desktop-portal refuses
// an id no desktop file answers to, which reaches the file dialog.
if (PLATFORM === "linux") app.setDesktopName("stremio-offline.desktop");

if (process.argv.includes(SMOKE_LOCAL_BACKEND)) {
  // The smoke gets its own instance directory, so it neither needs the single-instance lock
  // nor touches the data of an install that happens to be running.
  app.setPath("userData", path.join(app.getPath("temp"), `stremio-offline-smoke-${randomUUID()}`));
  void app.whenReady().then(runLocalBackendSmoke);
} else if (app.requestSingleInstanceLock()) {
  // A second launch must not start a second backend against the same instance directory.
  app.on("second-instance", () => { void showMainWindow(); });

  app.on("activate", () => { void showMainWindow(); });

  let backendShutdownComplete = false;
  let backendShutdown: Promise<void> | null = null;

  /** The quit the user has to confirm while this Mac still has a download or a stream in flight. */
  const confirmQuit = async (): Promise<void> => {
    const strings = catalogue(shellState.locale, PLATFORM);
    const answer = await showMessageBox(shell?.window ?? null, {
      type: "warning",
      buttons: [strings["quit.confirm"], strings["quit.cancel"]],
      defaultId: 1,
      cancelId: 1,
      message: strings["quit.title"],
      detail: strings["quit.detail"],
    });
    if (answer.response !== 0) return;
    quitConfirmed = true;
    app.quit();
  };

  app.on("before-quit", (event) => {
    if (backendShutdownComplete) return;
    refreshLocal();
    if (!quitConfirmed && shellState.local.busy) {
      event.preventDefault();
      if (quitPrompt) return;
      quitPrompt = confirmQuit().catch(() => {}).finally(() => { quitPrompt = null; });
      return;
    }
    event.preventDefault();
    if (backendShutdown) return;
    quitting = true;
    localStreaming = false;
    localDownloading = false;
    syncAwake();
    backendShutdown = retireRemote().then(closeLocalBackend).finally(() => {
      backendShutdownComplete = true;
      tray?.destroy();
      tray = null;
      app.quit();
    });
  });

  void app.whenReady().then(async () => {
    // 0.4.92 and older on Windows left the conversion's init.mp4 in this folder (FFmpeg's working
    // folder then). It is the app's own leftover, and nothing reads it.
    if (PLATFORM === "win32") await unlink(path.join(app.getPath("userData"), "init.mp4")).catch(() => {});
    profileStore = await readProfiles(app.getPath("userData"));
    localSettings = await readLocalSettings(app.getPath("userData"));
    ownership = await readOwnership(app.getPath("userData"));
    refreshInitialized();
    const prefs = await readShellPrefs(app.getPath("userData"));
    const savedWindow = await readWindowState(app.getPath("userData"), "main");
    shellState.localeChoice = prefs.locale;
    shellState.app = { ...shellState.app, prefs: { ...shellState.app.prefs, checkUpdates: prefs.checkUpdates } };
    shellState.locale = effectiveLocale(prefs.locale, app.getLocale());
    shellState.appVersion = app.getVersion();
    trayNoticeShown = prefs.trayNoticeShown;
    if (PLATFORM === "linux" && app.isPackaged) await refreshAutostartExec().catch(() => {});
    await refreshLoginItem();
    ffmpegLine = readFfmpegLine(app.isPackaged ? process.resourcesPath : null);
    if (PLATFORM === "linux") systemFfmpeg = await findSystemFfmpeg(process.env, PLATFORM);
    localBackend = createLocalBackend();
    registerHandlers();
    // A one-time migration: the old connection file's selected profile stands in for a choice
    // until the shell has written its own startup.json.
    const choice = await readStartupChoice(app.getPath("userData"));
    const legacy: Target | null = !existsSync(path.join(app.getPath("userData"), STARTUP_FILE)) && profileStore.selectedProfileId !== null
      ? { kind: "profile", id: profileStore.selectedProfileId }
      : null;
    const plan = launchPlan(choice ?? legacy, profileStore.profiles);
    // The migration happens once: from now on only startup.json decides, so a profile added later
    // and never connected cannot become the launch target through the old selected id.
    if (!existsSync(path.join(app.getPath("userData"), STARTUP_FILE))) {
      await writeStartupChoice(app.getPath("userData"), plan.screen === "connect" ? plan.target : null).catch(() => {});
    }
    // A login start on Windows opens no window; the tray is the only way in. On Linux the window
    // opens minimized instead, so it can still be reached from the taskbar.
    const hiddenLaunch = launchedHidden(process.argv);
    const startHidden = PLATFORM === "win32" && hiddenLaunch;
    const startMinimized = PLATFORM === "linux" && hiddenLaunch;
    // The window opens already saying where it connects, never flashing the welcome screen first.
    if (plan.screen === "connect") {
      const profile = plan.target.kind === "profile" ? findProfile(profileStore, plan.target.id) : null;
      shellState.screen = { kind: "connecting", target: plan.target, name: profile?.name ?? "", origin: profile?.origin ?? null };
      if (startHidden) shellState.chosen = plan.target;
    }
    if (PLATFORM === "win32" || PLATFORM === "linux") createTray();
    if (startHidden) {
      pushState();
      // Starting the backend with no window lets other devices reach it and downloads resume.
      if (plan.screen === "connect" && plan.target.kind === "local" && !needsSetup()) await startLocalHidden();
      syncUpdateChecks(prefs.checkUpdates);
      return;
    }
    createShell(savedWindow, startMinimized);
    syncUpdateChecks(prefs.checkUpdates);
    if (plan.screen === "connect") void connectTarget(plan.target, { launch: true });
  });
} else {
  app.quit();
}
