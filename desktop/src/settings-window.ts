import { BrowserWindow, screen, type WebContents } from "electron";
import type { ShellState } from "./shell-api.js";
import { Debounced, readWindowState, restoreBounds, SETTINGS_MIN_SIZE, writeWindowState, type WindowState } from "./window-state.js";

const SETTINGS_SIZE = { width: 680, height: 780 };

const BACKGROUND = "#0b0e13";
const SAVE_DELAY_MS = 500;

export interface SettingsWindowOptions {
  rendererPage: string;
  preload: string;
  userDataDir: () => string;
  title: () => string;
}

/** The settings window: one instance, opened from the menu or the shell page, closed with the main window. */
export class SettingsWindow {
  private window: BrowserWindow | null = null;
  private opening: Promise<void> | null = null;

  constructor(private readonly options: SettingsWindowOptions) {}

  get contents(): WebContents | null {
    const window = this.window;
    return window !== null && !window.isDestroyed() ? window.webContents : null;
  }

  open(): void {
    const existing = this.window;
    if (existing !== null && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return;
    }
    if (this.opening) return;
    this.opening = this.create().finally(() => { this.opening = null; });
  }

  push(state: ShellState): void {
    const window = this.window;
    if (window === null || window.isDestroyed()) return;
    if (!window.webContents.isDestroyed()) window.webContents.send("shell:state", state);
    window.setTitle(this.options.title());
  }

  close(): void {
    const window = this.window;
    if (window === null || window.isDestroyed()) return;
    window.close();
  }

  private async create(): Promise<void> {
    const saved: WindowState | null = await readWindowState(this.options.userDataDir(), "settings");
    const restored = restoreBounds(
      saved,
      screen.getAllDisplays().map((display) => display.workArea),
      screen.getPrimaryDisplay().workArea,
      SETTINGS_SIZE,
    );
    const window = new BrowserWindow({
      ...restored.bounds,
      minWidth: SETTINGS_MIN_SIZE.width,
      minHeight: SETTINGS_MIN_SIZE.height,
      show: false,
      title: this.options.title(),
      titleBarStyle: "hiddenInset",
      backgroundColor: BACKGROUND,
      fullscreenable: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        preload: this.options.preload,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    // The page is called Stremio Offline; the window keeps its own title.
    window.on("page-title-updated", (event) => event.preventDefault());
    window.once("ready-to-show", () => {
      window.show();
      // A hidden window is not maximized on macOS, so the restored flag has to wait for the show.
      if (restored.maximized) window.maximize();
    });
    const save = new Debounced(() => {
      void writeWindowState(this.options.userDataDir(), "settings",
        { bounds: window.getNormalBounds(), maximized: window.isMaximized() }).catch(() => {});
    }, SAVE_DELAY_MS);
    window.on("resize", () => save.schedule());
    window.on("move", () => save.schedule());
    window.on("maximize", () => save.schedule());
    window.on("unmaximize", () => save.schedule());
    window.on("close", () => { this.window = null; save.flush(); });
    window.on("closed", () => { if (this.window === window) this.window = null; });
    this.window = window;
    void window.loadFile(this.options.rendererPage, { query: { view: "settings" } }).catch(() => {});
  }
}
