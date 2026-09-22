import { app, BaseWindow, ipcMain, session, WebContentsView, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { fileURLToPath } from "node:url";
import { readSavedOrigin, writeSavedOrigin } from "./connection-file.js";
import { catalogue } from "./i18n.js";
import { layout, type LayoutMode } from "./layout.js";
import { httpAllowedHost, parseServerOrigin, type ServerOrigin } from "./origin.js";
import { fetchStatus, type ProbeResult } from "./status.js";

type MessageKey = keyof ReturnType<typeof catalogue>;

const PARTITION = "persist:stremio-desktop";
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
  remote: WebContentsView;
}

let shell: Shell | null = null;
let connected: ServerOrigin | null = null;
let mode: LayoutMode = "connect";

const windowTitle = () => catalogue(app.getLocale())["connect.title"];

const applyMode = (next: LayoutMode) => {
  const current = shell;
  if (!current) return;
  mode = next;
  const { width, height } = current.window.getContentBounds();
  const bounds = layout({ width, height }, mode);
  current.connection.setBounds(bounds.chrome);
  current.remote.setBounds(bounds.remote);
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

const onConnectedOrigin = (url: string) => connected !== null && originOf(url) === connected.origin;

const guardRemoteNavigation = (event: { preventDefault: () => void }, url: string) => {
  if (onConnectedOrigin(url)) return;
  event.preventDefault();
  if (!connected || originOf(url) === null) return;
  applyMode("connect");
  notifyConnection("connect.notStatus");
};

const watchRemoteResponses = () => {
  session.fromPartition(PARTITION).webRequest.onResponseStarted({ urls: ["http://*/*"] }, (details) => {
    if (connected?.transport !== "http") return;
    // The shipped typings leave `ip` out of this event; the runtime details carry it.
    const ip = (details as { ip?: string }).ip;
    if (!ip || httpAllowedHost(ip)) return;
    connected = null;
    void shell?.remote.webContents.loadURL("about:blank")?.catch(() => {});
    applyMode("connect");
    notifyConnection("connect.insecure");
  });
};

const createShell = () => {
  const window = new BaseWindow({ width: 1100, height: 720, title: windowTitle() });
  const remote = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, partition: PARTITION } });
  const connection = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, preload: CONNECTION_PRELOAD } });

  remote.webContents.setBackgroundThrottling(false);
  remote.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  remote.webContents.on("will-navigate", guardRemoteNavigation);
  remote.webContents.on("will-redirect", guardRemoteNavigation);
  remote.webContents.on("enter-html-full-screen", () => applyMode("fullscreen"));
  remote.webContents.on("leave-html-full-screen", () => applyMode(connected ? "remote" : "connect"));
  remote.webContents.on("did-finish-load", () => {
    if (!onConnectedOrigin(remote.webContents.getURL())) return;
    void remote.webContents.executeJavaScript(`(${CAPABILITIES})()`).then(
      (value) => console.log("capabilities " + JSON.stringify(value)),
      () => console.log("capabilities unavailable"),
    );
  });

  connection.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  connection.webContents.on("will-navigate", (event) => event.preventDefault());
  void connection.webContents.loadFile(CONNECTION_PAGE);

  // The bar is added last so it stays above the server page.
  window.contentView.addChildView(remote);
  window.contentView.addChildView(connection);
  window.on("resize", () => applyMode(mode));
  window.on("enter-full-screen", () => applyMode(mode));
  window.on("leave-full-screen", () => applyMode(mode));
  window.on("closed", () => { shell = null; });
  shell = { window, connection, remote };
  applyMode("connect");
};

const fromConnection = (event: IpcMainInvokeEvent | IpcMainEvent) => event.sender === shell?.connection.webContents;

const registerHandlers = () => {
  ipcMain.handle("desktop:bootstrap", async (event) => {
    if (!fromConnection(event)) throw new Error("desktop: unexpected sender");
    return { strings: catalogue(app.getLocale()), savedOrigin: await readSavedOrigin(app.getPath("userData")) };
  });

  ipcMain.handle("desktop:probe", async (event, origin: string): Promise<ProbeResult> => {
    if (!fromConnection(event)) throw new Error("desktop: unexpected sender");
    return fetchStatus(origin);
  });

  ipcMain.handle("desktop:open", async (event, origin: string): Promise<ProbeResult> => {
    if (!fromConnection(event)) throw new Error("desktop: unexpected sender");
    const result = await fetchStatus(origin);
    if (!result.ok) return result;
    const server = parseServerOrigin(origin);
    if (!server) return { ok: false, reason: "invalid" };
    await writeSavedOrigin(app.getPath("userData"), server.origin);
    connected = server;
    void shell?.remote.webContents.loadURL(server.origin + "/")?.catch(() => {});
    shell?.window.setTitle(server.origin);
    applyMode("remote");
    return result;
  });

  ipcMain.handle("desktop:disconnect", async (event) => {
    if (!fromConnection(event)) throw new Error("desktop: unexpected sender");
    connected = null;
    void shell?.remote.webContents.loadURL("about:blank")?.catch(() => {});
    applyMode("connect");
    shell?.window.setTitle(windowTitle());
  });
};

app.on("window-all-closed", () => app.quit());

app.on("activate", () => {
  if (!shell) createShell();
});

void app.whenReady().then(() => {
  registerHandlers();
  watchRemoteResponses();
  createShell();
});
