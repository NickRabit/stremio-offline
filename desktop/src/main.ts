import { app, BaseWindow, dialog, ipcMain, session, shell as electronShell, utilityProcess, WebContentsView, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addProfile,
  findProfile,
  normalizeProfileName,
  normalizeProfileOrigin,
  readProfiles,
  removeProfile,
  selectProfile,
  updateProfile,
  writeProfiles,
  type ProfileStore,
  type ServerProfile,
} from "./connection-file.js";
import { downloadProgressPercent, isDeviceTicketDownload } from "./downloads.js";
import { catalogue } from "./i18n.js";
import { layout, type LayoutMode } from "./layout.js";
import { LOCAL_PARTITION, LocalBackend, type LocalBackendConnection } from "./local-backend.js";
import { externalBrowserUrl, httpAllowedHost, parseServerOrigin, partitionForOrigin, type ServerOrigin } from "./origin.js";
import { SerialQueue } from "./serial-queue.js";
import { fetchStatus, type ProbeFailure, type ProbeResult } from "./status.js";

type MessageKey = keyof ReturnType<typeof catalogue>;

type ProfileResult =
  | { ok: true; profiles: ServerProfile[]; selectedProfileId: string | null }
  | { ok: false; reason: "invalid-name" | "invalid-data" | "save-failed" };

type LocalConnectResult =
  | { ok: true; version: string; restricted: boolean; secure: boolean }
  | { ok: false; reason: "startup" };

// The player asks for fullscreen. Copy on an HTTPS server uses the sanitized clipboard write.
const ALLOWED_PERMISSIONS = new Set<string>(["fullscreen", "clipboard-sanitized-write"]);
const ABORTED = -3;
const DOWNLOAD_NOTICE_INTERVAL = 500;
/** How long a server page gets to save the position and stop playback before its view goes. */
const RETIRE_TIMEOUT_MS = 1_500;

const CONNECTION_PAGE = fileURLToPath(new URL("../static/connection.html", import.meta.url));
const CONNECTION_PRELOAD = fileURLToPath(new URL("./preload.js", import.meta.url));
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
  connection: WebContentsView;
  remote: WebContentsView | null;
  remotePartition: string | null;
}

let shell: Shell | null = null;
let connected: ServerOrigin | null = null;
let mode: LayoutMode = "connect";
let loadFailure: ProbeFailure | null = null;
let localBackend: LocalBackend | null = null;
let localConnection: LocalBackendConnection | null = null;
/** Quitting retires the page itself, so a window closing on the way out does not wait for it again. */
let quitting = false;
const preparedPartitions = new Set<string>();
let profileStore: ProfileStore = { profiles: [], selectedProfileId: null };

const windowTitle = () => catalogue(app.getLocale())["connect.title"];

const applyMode = (next: LayoutMode) => {
  const current = shell;
  if (!current) return;
  mode = next;
  const { width, height } = current.window.getContentBounds();
  const bounds = layout({ width, height }, mode);
  current.connection.setBounds(bounds.chrome);
  current.remote?.setBounds(bounds.remote);
};

/** The local page owns the wording, so main only names the message it wants shown. */
const notifyConnection = (key: MessageKey) => {
  const current = shell;
  if (!current) return;
  void current.connection.webContents.executeJavaScript(`window.desktopNotice?.(${JSON.stringify(key)})`).catch(() => {});
};

/** A download notice arrives as finished text, because it carries a percentage the shell formats. */
const notifyDownload = (text: string) => {
  const current = shell;
  if (!current) return;
  void current.connection.webContents.executeJavaScript(`window.desktopDownloadNotice?.(${JSON.stringify(text)})`).catch(() => {});
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

const messageFor = (reason: ProbeFailure): MessageKey => reason === "insecure-transport" ? "connect.insecure" : reason === "unreachable" ? "connect.unreachable" : "connect.notStatus";

const blankRemote = () => {
  const remote = shell?.remote;
  if (!remote || remote.webContents.isDestroyed()) return;
  void remote.webContents.loadURL("about:blank")?.catch(() => {});
};

const failConnection = (reason: ProbeFailure) => {
  loadFailure = reason;
  const wasConnected = connected !== null;
  connected = null;
  if (mode !== "connect") {
    applyMode("connect");
    shell?.window.setTitle(windowTitle());
    notifyConnection(messageFor(reason));
  }
  if (wasConnected) blankRemote();
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
  applyMode("connect");
  notifyConnection("connect.notStatus");
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
  failConnection("insecure-transport");
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
  const activeDownloads = new Map<object, string>();
  const updateActiveDownload = (item: object, text: string) => {
    activeDownloads.delete(item);
    activeDownloads.set(item, text);
  };
  // Only a ticket this server's own page downloaded stays local. Everything else keeps Electron's
  // routine: the download is not prevented, renamed or given a save path.
  ses.on("will-download", (_event, item, contents) => {
    const expectedOrigin = serverOrigin();
    if (expectedOrigin === null || !isDeviceTicketDownload(item.getURL(), item.getInitiatorOrigin(), expectedOrigin)) return;
    const current = shell;
    if (!current?.remote || current.remotePartition !== partition || current.remote.webContents !== contents) return;
    const strings = catalogue(app.getLocale());
    const name = path.basename(item.getFilename());
    item.setSaveDialogOptions({ title: strings["download.saveTitle"], defaultPath: name.length > 0 ? name : "video" });
    const showLatestActiveDownload = () => {
      const latest = Array.from(activeDownloads.values()).at(-1);
      const active = shell;
      if (latest && active?.remote?.webContents === contents && active.remotePartition === partition) notifyDownload(latest);
    };
    updateActiveDownload(item, strings["download.saving"]);
    showLatestActiveDownload();
    let lastPercent: number | null = null;
    let lastNoticeAt = Date.now();
    item.on("updated", (_updated, state) => {
      if (state !== "progressing") return;
      const now = Date.now();
      if (now - lastNoticeAt < DOWNLOAD_NOTICE_INTERVAL) return;
      const percent = downloadProgressPercent(item.getReceivedBytes(), item.getTotalBytes());
      if (percent === lastPercent) return;
      lastNoticeAt = now;
      lastPercent = percent;
      updateActiveDownload(item, percent === null ? strings["download.saving"] : strings["download.progress"].replace("{percent}", String(percent)));
      showLatestActiveDownload();
    });
    item.once("done", (_done, state) => {
      activeDownloads.delete(item);
      if (activeDownloads.size > 0) showLatestActiveDownload();
      else {
        const active = shell;
        if (active?.remote?.webContents === contents && active.remotePartition === partition) {
          notifyDownload(state === "completed" ? strings["download.completed"] : state === "cancelled" ? strings["download.cancelled"] : strings["download.interrupted"]);
        }
      }
    });
  });
};

const wireRemote = (remote: WebContentsView) => {
  const contents = remote.webContents;
  contents.setBackgroundThrottling(false);
  contents.setWindowOpenHandler(openExternally);
  contents.on("will-navigate", (event, url) => guardRemoteNavigation(remote, event, url));
  contents.on("will-redirect", (event, url) => guardRemoteNavigation(remote, event, url));
  contents.on("enter-html-full-screen", () => { if (shell?.remote === remote) applyMode("fullscreen"); });
  contents.on("leave-html-full-screen", () => { if (shell?.remote === remote) applyMode(connected ? "remote" : "connect"); });
  contents.on("did-finish-load", () => {
    if (shell?.remote !== remote || !onConnectedOrigin(contents.getURL())) return;
    void contents.executeJavaScript(`(${CAPABILITIES})()`).then(
      (value) => console.log("capabilities " + JSON.stringify(value)),
      () => console.log("capabilities unavailable"),
    );
  });
  contents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
    if (shell?.remote !== remote || !isMainFrame || errorCode === ABORTED || !connected) return;
    failConnection(loadFailure ?? "unreachable");
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
  // Under the connection bar, which is already the top child.
  current.window.contentView.addChildView(remote, 0);
  current.remote = remote;
  current.remotePartition = partition;
  applyMode(mode);
  return remote;
};

const createShell = () => {
  const window = new BaseWindow({ width: 1100, height: 720, title: windowTitle() });
  const connection = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, preload: CONNECTION_PRELOAD } });

  connection.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  connection.webContents.on("will-navigate", (event) => event.preventDefault());
  void connection.webContents.loadFile(CONNECTION_PAGE);

  window.contentView.addChildView(connection);
  window.on("resize", () => applyMode(mode));
  window.on("enter-full-screen", () => applyMode(mode));
  window.on("leave-full-screen", () => applyMode(mode));
  let retired = false;
  window.on("close", (event) => {
    if (retired || quitting || !liveRemote()) return;
    event.preventDefault();
    retired = true;
    void retireRemote().finally(() => window.close());
  });
  window.on("closed", () => { shell = null; });
  shell = { window, connection, remote: null, remotePartition: null };
  applyMode("connect");
};

const fromConnection = (event: IpcMainInvokeEvent | IpcMainEvent) => event.sender === shell?.connection.webContents;

const queue = new SerialQueue();

const persistProfiles = async (next: ProfileStore): Promise<ProfileResult> => {
  try {
    await writeProfiles(app.getPath("userData"), next);
  } catch {
    return { ok: false, reason: "save-failed" };
  }
  profileStore = next;
  return { ok: true, profiles: next.profiles, selectedProfileId: next.selectedProfileId };
};

const profileIdOf = (value: unknown) => typeof value === "string" && value.length > 0 ? value : null;

const saveProfile = (input: { id: string | null; name: unknown; origin: unknown }): Promise<ProfileResult> =>
  queue.run(async (): Promise<ProfileResult> => {
    const name = normalizeProfileName(input.name);
    if (name === null) return { ok: false, reason: "invalid-name" };
    const origin = normalizeProfileOrigin(input.origin);
    if (origin === null) return { ok: false, reason: "invalid-data" };
    const next = input.id === null
      ? addProfile(profileStore, randomUUID(), { name, origin })
      : updateProfile(profileStore, input.id, { name, origin });
    if (!next) return { ok: false, reason: "invalid-data" };
    return persistProfiles(next);
  });

const deleteProfile = (id: string | null): Promise<ProfileResult> =>
  queue.run(async (): Promise<ProfileResult> => {
    if (id === null || !findProfile(profileStore, id)) return { ok: false, reason: "invalid-data" };
    return persistProfiles(removeProfile(profileStore, id));
  });

const selectSavedProfile = (id: string | null): Promise<ProfileResult> =>
  queue.run(async (): Promise<ProfileResult> => {
    const next = selectProfile(profileStore, id);
    if (!next) return { ok: false, reason: "invalid-data" };
    return persistProfiles(next);
  });

const connectProfile = (id: string | null): Promise<ProbeResult> =>
  queue.run(async (): Promise<ProbeResult> => {
    const profile = findProfile(profileStore, id);
    const server = profile ? parseServerOrigin(profile.origin) : null;
    if (!profile || !server) return { ok: false, reason: "invalid" };
    const result = await fetchStatus(server.origin);
    if (!result.ok) return result;
    await persistProfiles({ ...profileStore, selectedProfileId: profile.id });
    const partition = partitionForOrigin(server.origin);
    if (shell?.remotePartition !== partition) await retireRemote();
    const remote = mountRemote(partition, () => server.origin);
    if (!remote) return { ok: false, reason: "unreachable" };
    loadFailure = null;
    connected = server;
    try {
      await remote.webContents.loadURL(server.origin + "/");
    } catch {
      const reason = loadFailure ?? "unreachable";
      loadFailure = null;
      connected = null;
      applyMode("connect");
      shell?.window.setTitle(windowTitle());
      blankRemote();
      return { ok: false, reason };
    }
    if (!connected) return { ok: false, reason: loadFailure ?? "unreachable" };
    shell?.window.setTitle(server.origin);
    applyMode("remote");
    // A remote profile that answered takes over from the local backend for good.
    await closeLocalBackend();
    return result;
  });

/** The live local origin, or null when nothing local is running. Never a saved profile. */
const localOrigin = (): string | null => localConnection?.server.origin ?? null;

const failLocalConnection = () => {
  localConnection = null;
  const wasConnected = connected !== null;
  connected = null;
  loadFailure = null;
  if (mode !== "connect") {
    applyMode("connect");
    shell?.window.setTitle(windowTitle());
    notifyConnection("connect.localFailed");
  }
  if (wasConnected) blankRemote();
};

const closeLocalBackend = async (): Promise<void> => {
  localConnection = null;
  const backend = localBackend;
  if (!backend) return;
  await backend.stop().catch(() => {});
};

const connectLocal = (): Promise<LocalConnectResult> =>
  queue.run(async (): Promise<LocalConnectResult> => {
    const backend = localBackend;
    if (!backend) return { ok: false, reason: "startup" };
    let connection: LocalBackendConnection;
    try {
      connection = await backend.start();
    } catch (error) {
      console.warn("local backend: " + (error instanceof Error ? error.message : String(error)));
      // Nothing was mounted and nothing was given up, so the shell stays where it is.
      return { ok: false, reason: "startup" };
    }
    localConnection = connection;
    if (shell?.remotePartition !== LOCAL_PARTITION) await retireRemote();
    const remote = mountRemote(LOCAL_PARTITION, localOrigin, LOCAL_PRELOAD);
    if (!remote) {
      await closeLocalBackend();
      failLocalConnection();
      return { ok: false, reason: "startup" };
    }
    loadFailure = null;
    connected = connection.server;
    try {
      await remote.webContents.loadURL(connection.server.origin + "/");
    } catch {
      console.warn("local backend: the local page did not load (" + (loadFailure ?? "unreachable") + ")");
      await closeLocalBackend();
      failLocalConnection();
      return { ok: false, reason: "startup" };
    }
    if (!connected) {
      await closeLocalBackend();
      return { ok: false, reason: "startup" };
    }
    shell?.window.setTitle(connection.server.origin);
    applyMode("remote");
    return { ok: true, ...connection.status };
  });

const registerHandlers = () => {
  ipcMain.handle("desktop:bootstrap", async (event) => {
    if (!fromConnection(event)) throw new Error("desktop: unexpected sender");
    return { strings: catalogue(app.getLocale()), profiles: profileStore.profiles, selectedProfileId: profileStore.selectedProfileId };
  });

  ipcMain.handle("desktop:save-profile", async (event, input: unknown): Promise<ProfileResult> => {
    if (!fromConnection(event)) throw new Error("desktop: unexpected sender");
    const record = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
    return saveProfile({ id: profileIdOf(record.id), name: record.name, origin: record.origin });
  });

  ipcMain.handle("desktop:delete-profile", async (event, input: unknown): Promise<ProfileResult> => {
    if (!fromConnection(event)) throw new Error("desktop: unexpected sender");
    return deleteProfile(profileIdOf(input));
  });

  ipcMain.handle("desktop:select-profile", async (event, input: unknown): Promise<ProfileResult> => {
    if (!fromConnection(event)) throw new Error("desktop: unexpected sender");
    return selectSavedProfile(profileIdOf(input));
  });

  ipcMain.handle("desktop:connect", async (event, input: unknown): Promise<ProbeResult> => {
    if (!fromConnection(event)) throw new Error("desktop: unexpected sender");
    return connectProfile(profileIdOf(input));
  });

  ipcMain.handle("desktop:connect-local", async (event): Promise<LocalConnectResult> => {
    if (!fromConnection(event)) throw new Error("desktop: unexpected sender");
    return connectLocal();
  });

  // Only the top frame of the page the local backend serves, while it is the page on screen.
  ipcMain.handle("desktop:pick-folder", async (event): Promise<string | null> => {
    const current = shell;
    const origin = localOrigin();
    const frame = event.senderFrame;
    if (!current?.remote || current.remotePartition !== LOCAL_PARTITION || event.sender !== current.remote.webContents
      || !frame || frame.parent !== null || origin === null || originOf(frame.url) !== origin) {
      throw new Error("desktop: unexpected sender");
    }
    const result = await dialog.showOpenDialog(current.window, {
      title: catalogue(app.getLocale())["folder.pickTitle"],
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle("desktop:disconnect", async (event) => {
    if (!fromConnection(event)) throw new Error("desktop: unexpected sender");
    // The page saves its position to its own server, so the local backend outlives the page.
    await retireRemote();
    connected = null;
    loadFailure = null;
    await closeLocalBackend();
    destroyRemote();
    applyMode("connect");
    shell?.window.setTitle(windowTitle());
  });
};

app.on("window-all-closed", () => app.quit());

const createLocalBackend = (): LocalBackend => new LocalBackend({
  entry: LOCAL_BACKEND_ENTRY,
  userDataDir: app.getPath("userData"),
  fork: (entry, options) => utilityProcess.fork(entry, [], options),
  probeStatus: fetchStatus,
  onUnexpectedExit: () => failLocalConnection(),
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
    if (!shell) createShell();
  });

  let backendShutdownComplete = false;
  let backendShutdown: Promise<void> | null = null;
  app.on("before-quit", (event) => {
    if (backendShutdownComplete) return;
    event.preventDefault();
    if (backendShutdown) return;
    quitting = true;
    backendShutdown = retireRemote().then(closeLocalBackend).finally(() => {
      backendShutdownComplete = true;
      app.quit();
    });
  });

  void app.whenReady().then(async () => {
    profileStore = await readProfiles(app.getPath("userData"));
    localBackend = createLocalBackend();
    registerHandlers();
    createShell();
  });
} else {
  app.quit();
}
