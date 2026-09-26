import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setLocale } from "../i18n";
import type { ShellBridge, ShellState, ShellView } from "./bridge";
import { shellBridge } from "./bridge";
import { ShellApp } from "./ShellApp";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const baseState = (over: Partial<ShellState> = {}): ShellState => ({
  locale: "en", localeChoice: null, appVersion: "0.4.87", screen: { kind: "welcome" }, connection: null, chosen: null,
  profiles: [{ id: "nas", name: "NAS", origin: "http://192.168.1.20:8090" }],
  local: {
    settings: { allowPrivateAddons: false, publish: false, publishPort: 8091, downloadDir: null }, running: false, addresses: [], ffmpeg: null, busy: false,
    downloadDir: "/Users/me/Library/Application Support/Stremio Offline/downloads", suggestedDownloadDir: "/Users/me/Movies/Stremio Offline", initialized: true, downloadDirOwned: true,
  },
  app: { prefs: { openAtLogin: false, checkUpdates: true }, loginItem: "not-registered", update: null },
  toast: null, ...over,
});

const makeBridge = (view: ShellView, state: ShellState) => {
  const bridge = {
    version: 1 as const, view,
    getState: vi.fn(async () => state),
    onState: vi.fn(() => () => undefined),
    connect: vi.fn(async () => undefined),
    cancelSetup: vi.fn(async () => undefined),
    saveProfile: vi.fn(async (input: { id: string | null; name: string; origin: string }) => ({ ok: true as const, profile: { id: "new", name: input.name, origin: input.origin } })),
    deleteProfile: vi.fn(async () => ({ ok: true })),
    probe: vi.fn(async () => ({ ok: false as const, reason: "unreachable" as const })),
    setLocalSettings: vi.fn(async () => ({ ok: true, restartNeeded: true })),
    restartLocal: vi.fn(async () => ({ ok: true })),
    setLocale: vi.fn(async () => undefined),
    setAppPrefs: vi.fn(async () => ({ ok: true })),
    openUpdate: vi.fn(),
    openSettings: vi.fn(), toastAction: vi.fn(), dismissToast: vi.fn(), copyText: vi.fn(),
    pickFolder: vi.fn(async () => "/Volumes/Films"),
    prepareDownloadDir: vi.fn(async (dir: string) => ({ ok: true as const, dir })),
    resetLocal: vi.fn(async () => ({ ok: true, cancelled: false, downloadsKept: true })),
  } satisfies ShellBridge;
  return bridge;
};

const render = async (bridge: ShellBridge) => {
  await act(async () => { root.render(<ShellApp bridge={bridge}/>); });
  await act(async () => { await Promise.resolve(); });
};
const button = (text: string) => {
  const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  expect(found, `"${text}" is on screen`).toBeTruthy();
  return found!;
};
// The General section's two switches come first; sharing is the first of This Mac's.
const shareSwitch = () => host.querySelectorAll<HTMLInputElement>(".shell-controls input[type=checkbox]")[2]!;
const click = async (element: HTMLElement) => { await act(async () => { element.click(); await Promise.resolve(); }); };
const type = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
};

it("only the desktop app's own bridge of version 1 is taken", () => {
  expect(shellBridge({})).toBeNull();
  expect(shellBridge({ stremioShell: { version: 2, getState: () => undefined } })).toBeNull();
  const bridge = makeBridge("main", baseState());
  expect(shellBridge({ stremioShell: bridge })).toBe(bridge);
});

it("the welcome screen runs the server on this Mac with one click", async () => {
  const bridge = makeBridge("main", baseState());
  await render(bridge);
  await click(button("This Mac"));
  expect(bridge.connect).toHaveBeenCalledWith({ kind: "local" });
});

it("a server added on the welcome screen is saved and connected to", async () => {
  const bridge = makeBridge("main", baseState());
  await render(bridge);
  await click(button("A server on your network"));
  const [name, origin] = [...host.querySelectorAll("input")];
  await type(name!, "Living room");
  await type(origin!, "http://192.168.1.30:8090");
  await click(button("Connect"));
  await act(async () => { await Promise.resolve(); });
  expect(bridge.saveProfile).toHaveBeenCalledWith({ id: null, name: "Living room", origin: "http://192.168.1.30:8090" });
  expect(bridge.connect).toHaveBeenCalledWith({ kind: "profile", id: "new" });
});

it("an unreachable server offers a retry, this Mac and the settings", async () => {
  const target = { kind: "profile" as const, id: "nas" };
  const bridge = makeBridge("main", baseState({ screen: { kind: "error", target, name: "NAS", origin: "http://192.168.1.20:8090", reason: "unreachable", port: null } }));
  await render(bridge);
  expect(host.textContent).toContain("NAS is not answering");
  await click(button("Try again"));
  expect(bridge.connect).toHaveBeenLastCalledWith(target);
  await click(button("Use this Mac"));
  expect(bridge.connect).toHaveBeenLastCalledWith({ kind: "local" });
  await click(button("Settings"));
  expect(bridge.openSettings).toHaveBeenCalled();
});

it("a taken port names the port", async () => {
  const bridge = makeBridge("main", baseState({ screen: { kind: "error", target: { kind: "local" }, name: "", origin: null, reason: "port-busy", port: 8091 } }));
  await render(bridge);
  expect(host.textContent).toContain("Port 8091 is taken");
  expect(host.textContent).not.toContain("Use this Mac");
});

it("the connected main window draws nothing over the server page", async () => {
  await render(makeBridge("main", baseState({ screen: { kind: "connected" } })));
  expect(host.textContent).toBe("");
});

it("settings refuse a port outside 1024–65535 and store a valid one", async () => {
  const state = baseState({ local: { ...baseState().local, settings: { allowPrivateAddons: false, publish: true, publishPort: 8091, downloadDir: null }, running: true } });
  const bridge = makeBridge("settings", state);
  await render(bridge);
  const port = host.querySelector<HTMLInputElement>(".shell-port input")!;
  await type(port, "80");
  await act(async () => { port.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  expect(host.textContent).toContain("Enter a port between 1024 and 65535.");
  expect(bridge.setLocalSettings).not.toHaveBeenCalled();
  await type(port, "8095");
  await act(async () => { port.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  expect(bridge.setLocalSettings).toHaveBeenCalledWith({ allowPrivateAddons: false, publish: true, publishPort: 8095, downloadDir: null });
  await act(async () => { await Promise.resolve(); });
  expect(host.textContent).toContain("The changes apply once the server on this Mac restarts.");
});

it("a restart while something plays asks first", async () => {
  const state = baseState({ local: { ...baseState().local, running: true, busy: true } });
  const bridge = makeBridge("settings", state);
  await render(bridge);
  await click(shareSwitch().closest("label")!);
  await act(async () => { await Promise.resolve(); });
  await click(button("Restart the server"));
  expect(bridge.restartLocal).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Restart anyway?");
  await click(button("Restart the server"));
  expect(bridge.restartLocal).toHaveBeenCalledTimes(1);
});

it("the fallback toast says the libraries are separate and retries on its button", async () => {
  const bridge = makeBridge("toast", baseState({ toast: { id: 7, kind: "fallback", server: "NAS" } }));
  await render(bridge);
  expect(host.textContent).toContain("Its library and accounts are separate.");
  await click(button("Try again"));
  expect(bridge.toastAction).toHaveBeenCalledWith(7);
  await click(host.querySelector<HTMLButtonElement>("button[aria-label=Close]")!);
  expect(bridge.dismissToast).toHaveBeenCalledWith(7);
});

it("the first screen offers the language before anything else, and settings can follow the system", async () => {
  const bridge = makeBridge("main", baseState());
  await render(bridge);
  await click(button("Čeština"));
  expect(bridge.setLocale).toHaveBeenCalledWith("cs");
  act(() => root.unmount());
  root = createRoot(host);
  const settings = makeBridge("settings", baseState({ localeChoice: "en" }));
  await render(settings);
  const select = host.querySelector<HTMLSelectElement>(".shell-controls select")!;
  expect(select.value).toBe("en");
  await act(async () => { select.value = "system"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(settings.setLocale).toHaveBeenCalledWith(null);
});

it("This Mac on the welcome screen leaves the first-start question to the main process", async () => {
  const bridge = makeBridge("main", baseState({ local: { ...baseState().local, initialized: false } }));
  await render(bridge);
  await click(button("This Mac"));
  expect(bridge.connect).toHaveBeenCalledWith({ kind: "local" });
});

it("the setup screen goes back to what the window showed before", async () => {
  const bridge = makeBridge("main", baseState({ screen: { kind: "setup" }, local: { ...baseState().local, initialized: false } }));
  await render(bridge);
  await click(button("Back"));
  expect(bridge.cancelSetup).toHaveBeenCalled();
});

it("a first start on this Mac asks where downloads go, and starts with the chosen folder", async () => {
  const bridge = makeBridge("main", baseState({ screen: { kind: "setup" }, local: { ...baseState().local, initialized: false } }));
  await render(bridge);
  expect(host.textContent).toContain("/Users/me/Movies/Stremio Offline");
  await click(button("Choose another folder…"));
  expect(host.textContent).toContain("/Volumes/Films");
  await click(button("Start"));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(bridge.prepareDownloadDir).toHaveBeenCalledWith("/Volumes/Films");
  expect(bridge.setLocalSettings).toHaveBeenCalledWith({ allowPrivateAddons: false, publish: false, publishPort: 8091, downloadDir: "/Volumes/Films" });
  expect(bridge.connect).toHaveBeenCalledWith({ kind: "local" });
});

it("a folder the app cannot write to is refused before anything starts", async () => {
  const bridge = makeBridge("main", baseState({ screen: { kind: "setup" }, local: { ...baseState().local, initialized: false } }));
  bridge.prepareDownloadDir.mockResolvedValueOnce({ ok: false, reason: "not-writable" } as never);
  await render(bridge);
  await click(button("Start"));
  await act(async () => { await Promise.resolve(); });
  expect(host.textContent).toContain("The app cannot write to that folder.");
  expect(bridge.connect).not.toHaveBeenCalled();
});

it("an existing backend starts straight away and shows its folder as fixed in settings", async () => {
  const bridge = makeBridge("main", baseState());
  await render(bridge);
  await click(button("This Mac"));
  expect(bridge.connect).toHaveBeenCalledWith({ kind: "local" });
  act(() => root.unmount());
  root = createRoot(host);
  await render(makeBridge("settings", baseState()));
  expect(host.textContent).toContain("It is the first library now and stays where it is.");
  expect(host.textContent).not.toContain("Change…");
});

it("reset keeps the films unless asked, and forgets servers only when ticked", async () => {
  const bridge = makeBridge("settings", baseState());
  await render(bridge);
  await click(button("Reset this Mac…"));
  expect(bridge.resetLocal).toHaveBeenLastCalledWith({ deleteDownloads: false, forgetServers: false });
  const [downloads, servers] = [...host.querySelectorAll<HTMLInputElement>(".shell-check input")];
  await click(downloads!);
  await click(servers!);
  await click(button("Reset this Mac…"));
  expect(bridge.resetLocal).toHaveBeenLastCalledWith({ deleteDownloads: true, forgetServers: true });
});

it("reset offers no Trash for a download folder the app did not create", async () => {
  const bridge = makeBridge("settings", baseState({ local: { ...baseState().local, downloadDirOwned: false } }));
  await render(bridge);
  expect(host.textContent).toContain("a reset never moves it to the Trash");
  expect(host.querySelectorAll(".shell-check input")).toHaveLength(1);
  await click(button("Reset this Mac…"));
  expect(bridge.resetLocal).toHaveBeenLastCalledWith({ deleteDownloads: false, forgetServers: false });
});

it("the login item and the update check are switches that store both choices", async () => {
  const bridge = makeBridge("settings", baseState());
  await render(bridge);
  const [login, updates] = [...host.querySelectorAll<HTMLInputElement>(".switch input")];
  await click(login!);
  expect(bridge.setAppPrefs).toHaveBeenLastCalledWith({ openAtLogin: true, checkUpdates: true });
  await click(updates!);
  expect(bridge.setAppPrefs).toHaveBeenLastCalledWith({ openAtLogin: false, checkUpdates: false });
});

it("a login item waiting for approval says where to allow it, and an unsupported one is off", async () => {
  const approval = makeBridge("settings", baseState({ app: { prefs: { openAtLogin: true, checkUpdates: true }, loginItem: "requires-approval", update: null } }));
  await render(approval);
  expect(host.textContent).toContain("Login Items");
  act(() => root.unmount());
  root = createRoot(host);
  await render(makeBridge("settings", baseState({ app: { prefs: { openAtLogin: false, checkUpdates: true }, loginItem: "unsupported", update: null } })));
  expect(host.querySelector<HTMLInputElement>(".switch input")!.disabled).toBe(true);
  expect(host.textContent).toContain("Not available in this build.");
});

it("a newer release shows in About and opens through the shell", async () => {
  const bridge = makeBridge("settings", baseState({ app: { prefs: { openAtLogin: false, checkUpdates: true }, loginItem: "not-registered", update: { version: "0.4.90", url: "https://github.com/NickRabit/stremio-offline/releases/tag/v0.4.90" } } }));
  await render(bridge);
  await click(button("Download 0.4.90"));
  expect(bridge.openUpdate).toHaveBeenCalled();
});
