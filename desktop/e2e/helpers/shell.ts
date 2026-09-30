import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalogue } from "../../src/i18n";
import type { ShellState } from "../../src/shell-api";
import "./bridge";

/** The desktop workspace, from this file rather than the working directory. */
export const DESKTOP_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ELECTRON = createRequire(import.meta.url)("electron") as string;
/** A dead feed keeps the update check out of the scenarios that are not about it. */
const NO_FEED = "http://127.0.0.1:9/latest";

/** Windows never offers a download folder to the Recycle Bin; everywhere else one the app
 *  created is its own. */
export const APP_OWNS_FOLDER = process.platform !== "win32";

export interface Box {
  type: string;
  message: string;
  detail: string;
  buttons: string[];
}

export interface OpenDialogCall {
  title?: string;
  defaultPath?: string;
  properties?: string[];
}

/** One test's scratch space; the app never leaves it, and nothing in it is the user's. */
export interface Sandbox {
  root: string;
  userData: string;
  downloads: string;
  trash: string;
  boxes: string;
  openDialogs: string;
  openedLinks: string;
}

export async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-desktop-e2e-"));
  const box = {
    root,
    userData: path.join(root, "user-data"),
    downloads: path.join(root, "Filmy"),
    trash: path.join(root, "trash"),
    boxes: path.join(root, "boxes.jsonl"),
    openDialogs: path.join(root, "open-dialogs.jsonl"),
    openedLinks: path.join(root, "opened-links.jsonl"),
  };
  // The fake Trash has to exist before the app moves anything into it.
  await mkdir(box.trash, { recursive: true });
  return box;
}

export interface LaunchOptions {
  box: Sandbox;
  /** What the stubbed folder dialog answers; null cancels it. */
  openDialogPath?: string | null;
  /** Which button the stubbed message boxes answer with. */
  messageBoxResponse?: number;
  env?: NodeJS.ProcessEnv;
}

export interface Shell {
  app: ElectronApplication;
  page: Page;
  box: Sandbox;
}

export async function launchShell(options: LaunchOptions): Promise<Shell> {
  const { box } = options;
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [DESKTOP_DIR, `--user-data-dir=${box.userData}`],
    env: {
      ...process.env,
      STREMIO_OFFLINE_UPDATE_FEED: NO_FEED,
      // The backend inherits this environment; these keep a run from scanning or refreshing
      // in the middle of a scenario.
      LIBRARY_AUTO_SCAN: "0",
      ADDON_AUTO_REFRESH: "0",
      ...options.env,
    },
  });
  await stubDialogs(app, {
    openDialogPath: options.openDialogPath ?? null,
    messageBoxResponse: options.messageBoxResponse ?? 1,
    box,
  });
  const page = await waitForPage(app, (url) => url.includes("view=main"));
  return { app, page, box };
}

interface StubOptions {
  openDialogPath: string | null;
  messageBoxResponse: number;
  box: Sandbox;
}

/** Neither a real dialog, a real folder picker nor the real Trash is ever touched. */
async function stubDialogs(app: ElectronApplication, options: StubOptions): Promise<void> {
  await app.evaluate(({ dialog, shell }, stub) => {
    const fs = process.getBuiltinModule("node:fs");
    const path = process.getBuiltinModule("node:path");
    const record = (file: string, value: unknown) => fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
    const globals = globalThis as unknown as { __boxes: unknown[]; __openDialogs: unknown[]; __opened: string[] };
    globals.__boxes = [];
    globals.__openDialogs = [];
    globals.__opened = [];

    dialog.showOpenDialog = async (...args: unknown[]) => {
      const call = (args.at(-1) ?? {}) as { title?: string; defaultPath?: string; properties?: string[] };
      globals.__openDialogs.push(call);
      record(stub.openDialogs, { title: call.title, defaultPath: call.defaultPath, properties: call.properties });
      return stub.openDialog
        ? { canceled: false, filePaths: [stub.openDialog] }
        : { canceled: true, filePaths: [] };
    };
    dialog.showMessageBox = async (...args: unknown[]) => {
      const call = (args.at(-1) ?? {}) as { type?: string; message?: string; detail?: string; buttons?: string[] };
      const box = { type: call.type ?? "", message: call.message ?? "", detail: call.detail ?? "", buttons: call.buttons ?? [] };
      globals.__boxes.push(box);
      record(stub.boxes, box);
      return { response: stub.messageBoxResponse, checkboxChecked: false };
    };
    shell.openExternal = async (url: string) => {
      globals.__opened.push(url);
      record(stub.openedLinks, url);
    };
    shell.trashItem = async (item: string) => {
      fs.renameSync(item, path.join(stub.trash, `${path.basename(item)}-${Date.now()}`));
    };
  }, {
    openDialog: options.openDialogPath,
    messageBoxResponse: options.messageBoxResponse,
    boxes: options.box.boxes,
    openDialogs: options.box.openDialogs,
    openedLinks: options.box.openedLinks,
    trash: options.box.trash,
  });
}

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForPage(
  app: ElectronApplication,
  match: (url: string) => boolean,
  timeoutMs = 60_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = app.context().pages().filter((page) => !page.isClosed() && match(page.url())).at(-1);
    if (found) return found;
    if (Date.now() > deadline) throw new Error("No window answered in time.");
    await delay(100);
  }
}

export const settingsPage = (app: ElectronApplication) => waitForPage(app, (url) => url.includes("view=settings"));

export async function openSettings(shell: Shell): Promise<Page> {
  await shell.page.evaluate(() => window.stremioShell.openSettings());
  return settingsPage(shell.app);
}

export const stateOf = (page: Page): Promise<ShellState> =>
  page.evaluate(() => window.stremioShell.getState());

/** The main process's own strings for a state's language, which is what its dialogs say. */
export const shellStrings = (state: ShellState) => catalogue(state.locale, state.platform);

/** Waits for a state the shell reaches on its own, reporting the last one when it does not. */
export async function until(
  read: () => Promise<ShellState>,
  ready: (state: ShellState) => boolean,
  label: string,
  timeoutMs = 60_000,
): Promise<ShellState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await read();
    if (ready(state)) return state;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}; the screen is ${JSON.stringify(state.screen)}.`);
    }
    await delay(150);
  }
}

export const connected = (state: ShellState) => state.screen.kind === "connected";

/** Welcome screen → This Mac → the folder the dialog picks → a running local server. */
export async function connectThisMac(shell: Shell): Promise<ShellState> {
  await shell.page.click(".shell-choice >> nth=0");
  await shell.page.click(".shell-folder-step .shell-folder button");
  await shell.page.click(".shell-folder-step .primary");
  return until(
    () => stateOf(shell.page),
    (state) => state.screen.kind === "connected" && state.connection?.target.kind === "local",
    "the local server",
  );
}

async function jsonLines<T>(file: string): Promise<T[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

export const boxes = (box: Sandbox) => jsonLines<Box>(box.boxes);
export const openDialogs = (box: Sandbox) => jsonLines<OpenDialogCall>(box.openDialogs);
export const openedLinks = (box: Sandbox) => jsonLines<string>(box.openedLinks);

export async function waitForBoxes(box: Sandbox, count: number, timeoutMs = 30_000): Promise<Box[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await boxes(box);
    if (found.length >= count) return found;
    if (Date.now() > deadline) throw new Error(`Only ${found.length} of ${count} dialogs were asked for.`);
    await delay(150);
  }
}

/** Closes every window the way the user does, which is not the same as quitting on any platform. */
export const closeWindows = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ BaseWindow }) => { for (const window of BaseWindow.getAllWindows()) window.close(); });

export const windowCount = (app: ElectronApplication): Promise<number> =>
  app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length);

export const webContentsCount = (app: ElectronApplication): Promise<number> =>
  app.evaluate(({ webContents }) => webContents.getAllWebContents().length);

export const appQuit = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ app: application }) => application.quit());

export function waitForExit(app: ElectronApplication, timeoutMs = 30_000): Promise<void> {
  if (app.process().exitCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The app did not quit in time.")), timeoutMs);
    app.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

export const backendStatus = (app: ElectronApplication, origin: string): Promise<number> =>
  app.evaluate(async (_electron, url) => fetch(`${url}/api/status`).then((response) => response.status, () => 0), origin);

export const activate = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ app: application }) => { application.emit("activate"); });

export const homeDir = (app: ElectronApplication): Promise<string> =>
  app.evaluate(({ app: application }) => application.getPath("home"));

/** Opens the settings window from the app menu, the way a keyboard shortcut does. */
export const openSettingsFromMenu = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.accelerator === "CmdOrCtrl+,") return item;
        const found = item.submenu ? find(item.submenu.items) : undefined;
        if (found) return found;
      }
      return undefined;
    };
    find(Menu.getApplicationMenu()?.items ?? [])?.click();
  });

/** Clicks the menu's answer to "This Mac"; it is the first item of the Server submenu. */
export const chooseThisMacFromMenu = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ Menu }) => {
    const items = Menu.getApplicationMenu()?.items ?? [];
    for (const item of items) {
      const local = item.submenu?.items.find((entry) => entry.type === "checkbox");
      if (local) { local.click(); return; }
    }
    throw new Error("The menu has no This Mac item.");
  });

export const closeSettingsWindow = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.webContents.getURL().includes("view=settings")) window.close();
    }
  });
