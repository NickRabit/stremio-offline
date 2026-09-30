import assert from "node:assert/strict";
import test from "node:test";
import type { MenuItemConstructorOptions } from "electron";
import type { ServerProfile } from "./connection-file.js";
import { catalogue } from "./i18n.js";
import type { Target } from "./shell-api.js";
import { buildTrayTemplate, type TrayActions, type TrayInput } from "./tray.js";

const profiles: ServerProfile[] = [
  { id: "one", name: "Living room", origin: "http://192.168.1.10:8090" },
  { id: "two", name: "NAS", origin: "https://nas.local" },
];

interface Call { action: string; target: Target | null }

const build = (over: Partial<TrayInput> = {}) => {
  const calls: Call[] = [];
  const actions: TrayActions = {
    open: () => { calls.push({ action: "open", target: null }); },
    openSettings: () => { calls.push({ action: "openSettings", target: null }); },
    connect: (target) => { calls.push({ action: "connect", target }); },
    quit: () => { calls.push({ action: "quit", target: null }); },
  };
  const template = buildTrayTemplate({
    strings: catalogue("en", "win32"), profiles, current: null, connected: false, platform: "win32", actions, ...over,
  });
  return { template, calls };
};

test("the tray menu keeps the order: Open, the servers, Settings and Quit", () => {
  const strings = catalogue("en", "win32");
  const { template } = build();
  assert.deepEqual(template.map((item) => item.label ?? item.type ?? "?").filter((label) => label !== "separator"),
    [strings["tray.open"], strings["window.thisPC"], "Living room", "NAS", strings["tray.settings"], strings["tray.quit"]]);
  assert.deepEqual(template.map((item) => item.type ?? "normal"),
    ["normal", "separator", "checkbox", "checkbox", "checkbox", "separator", "normal", "separator", "normal"]);
});

test("the tray says PC on Windows, computer on Linux and Mac on macOS", () => {
  assert.equal(build().template[2].label, catalogue("en", "win32")["window.thisPC"]);
  assert.equal(build({ platform: "linux", strings: catalogue("en", "linux") }).template[2].label,
    catalogue("en", "linux")["window.thisComputer"]);
  assert.equal(build({ platform: "darwin", strings: catalogue("en", "darwin") }).template[2].label,
    catalogue("en", "darwin")["window.thisMac"]);
});

test("the checkmarks follow the current server and the connection", () => {
  const checkboxes = (items: MenuItemConstructorOptions[]) => items.filter((item) => item.type === "checkbox").map((item) => item.checked);
  assert.deepEqual(checkboxes(build({ current: { kind: "local" }, connected: true }).template), [true, false, false]);
  assert.deepEqual(checkboxes(build({ current: { kind: "local" }, connected: false }).template), [false, false, false]);
  assert.deepEqual(checkboxes(build({ current: { kind: "profile", id: "two" }, connected: true }).template), [false, false, true]);
  assert.deepEqual(checkboxes(build().template), [false, false, false]);
});

test("every entry reaches its own action, and the pickers hand over the target", () => {
  const { template, calls } = build({ current: { kind: "profile", id: "one" }, connected: true });
  for (const item of template) (item.click as (() => void) | undefined)?.();
  assert.deepEqual(calls, [
    { action: "open", target: null },
    { action: "connect", target: { kind: "local" } },
    { action: "connect", target: { kind: "profile", id: "one" } },
    { action: "connect", target: { kind: "profile", id: "two" } },
    { action: "openSettings", target: null },
    { action: "quit", target: null },
  ]);
});
