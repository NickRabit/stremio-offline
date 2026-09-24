import { app, BaseWindow, ipcMain, session, shell as electronShell, WebContentsView, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
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
import { catalogue } from "./i18n.js";
import { layout, type LayoutMode } from "./layout.js";
import { externalBrowserUrl, httpAllowedHost, parseServerOrigin, partitionForOrigin, type ServerOrigin } from "./origin.js";
import { SerialQueue } from "./serial-queue.js";
import { fetchStatus, type ProbeFailure, type ProbeResult } from "./status.js";

type MessageKey = keyof ReturnType<typeof catalogue>;

type ProfileResult =
  | { ok: true; profiles: ServerProfile[]; selectedProfileId: string | null }
  | { ok: false; reason: "invalid-name" | "invalid-data" | "save-failed" };

// The player asks for fullscreen. Copy on an HTTPS server uses the sanitized clipboard write.
const ALLOWED_PERMISSIONS = new Set<string>(["fullscreen", "clipboard-sanitized-write"]);
const ABORTED = -3;

const CONNECTION_PAGE = fileURLToPath(new URL("../static/connection.html", import.meta.url));
const CONNECTION_PRELOAD = fileURLToPath(new URL("./preload.js", import.meta.url));

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

const preparePartition = (partition: string) => {
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

const mountRemote = (server: ServerOrigin): WebContentsView | null => {
  const current = shell;
  if (!current) return null;
  const partition = partitionForOrigin(server.origin);
  if (current.remote && current.remotePartition === partition) return current.remote;
  destroyRemote();
  preparePartition(partition);
  const remote = new WebContentsView({
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, partition },
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
    const remote = mountRemote(server);
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
    return result;
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

  ipcMain.handle("desktop:disconnect", async (event) => {
    if (!fromConnection(event)) throw new Error("desktop: unexpected sender");
    connected = null;
    loadFailure = null;
    destroyRemote();
    applyMode("connect");
    shell?.window.setTitle(windowTitle());
  });
};

app.on("window-all-closed", () => app.quit());

app.on("activate", () => {
  if (!shell) createShell();
});

void app.whenReady().then(async () => {
  profileStore = await readProfiles(app.getPath("userData"));
  registerHandlers();
  createShell();
});
