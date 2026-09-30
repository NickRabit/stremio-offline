import assert from "node:assert/strict";
import test from "node:test";
import type { MenuItemConstructorOptions } from "electron";
import type { ServerProfile } from "./connection-file.js";
import { catalogue, en } from "./i18n.js";
import { buildMenuTemplate, type MenuActions, type MenuInput } from "./menu.js";
import type { Target } from "./shell-api.js";

const profiles: ServerProfile[] = [
  { id: "one", name: "Living room", origin: "http://192.168.1.10:8090" },
  { id: "two", name: "NAS", origin: "https://nas.local" },
];

interface Call { action: string; target: Target | null }

const build = (over: Partial<MenuInput> = {}) => {
  const calls: Call[] = [];
  const actions: MenuActions = {
    openSettings: () => { calls.push({ action: "openSettings", target: null }); },
    reload: () => { calls.push({ action: "reload", target: null }); },
    devTools: () => { calls.push({ action: "devTools", target: null }); },
    connect: (target) => { calls.push({ action: "connect", target }); },
    reconnect: () => { calls.push({ action: "reconnect", target: null }); },
    openProject: () => { calls.push({ action: "openProject", target: null }); },
  };
  const template = buildMenuTemplate({
    strings: en, profiles, current: null, connected: false, isPackaged: false, actions, platform: "darwin", ...over,
  });
  return { template, calls };
};

const submenu = (item: MenuItemConstructorOptions): MenuItemConstructorOptions[] => {
  const sub = item.submenu;
  return Array.isArray(sub) ? sub : [];
};

const shape = (items: MenuItemConstructorOptions[]): string[] =>
  items.map((item) => item.role ?? item.label ?? item.type ?? "?");

const fire = (items: MenuItemConstructorOptions[]): void => {
  for (const item of items) {
    (item.click as (() => void) | undefined)?.();
    fire(submenu(item));
  }
};

const serverItems = (template: MenuItemConstructorOptions[]) => submenu(template[3]);

const checkboxes = (items: MenuItemConstructorOptions[]) => items.filter((item) => item.type === "checkbox");

test("the menus and their items keep the order the template names", () => {
  const { template } = build();
  assert.deepEqual(shape(template), ["Stremio Offline", "editMenu", "View", "Server", "windowMenu", "help"]);
  assert.deepEqual(shape(submenu(template[0])),
    ["about", "separator", en["menu.settings"], "separator", "services", "separator", "hide", "hideOthers", "unhide", "separator", "quit"]);
  assert.deepEqual(shape(submenu(template[2])), [en["menu.reload"], "togglefullscreen", en["menu.devTools"]]);
  assert.deepEqual(shape(serverItems(template)),
    [en["window.thisMac"], "Living room", "NAS", "separator", en["menu.reconnect"], en["menu.serverSettings"]]);
  assert.deepEqual(shape(submenu(template[5])), [en["menu.project"]]);
});

test("Settings carries the usual accelerator", () => {
  const { template } = build();
  const settings = submenu(template[0]).find((item) => item.label === en["menu.settings"]);
  assert.equal(settings?.accelerator, "CmdOrCtrl+,");
  assert.equal(settings?.role, undefined);
});

test("Reload is a click, not a role", () => {
  const { template, calls } = build();
  const reload = submenu(template[2])[0];
  assert.equal(reload.label, en["menu.reload"]);
  assert.equal(reload.role, undefined);
  assert.equal(reload.accelerator, "CmdOrCtrl+R");
  (reload.click as () => void)();
  assert.deepEqual(calls, [{ action: "reload", target: null }]);
});

test("the checkboxes follow the current server and the connection", () => {
  const local = build({ current: { kind: "local" }, connected: true });
  assert.deepEqual(checkboxes(serverItems(local.template)).map((item) => item.checked), [true, false, false]);

  const profile = build({ current: { kind: "profile", id: "two" }, connected: true });
  assert.deepEqual(checkboxes(serverItems(profile.template)).map((item) => item.checked), [false, false, true]);

  const away = build({ current: { kind: "local" }, connected: false });
  assert.deepEqual(checkboxes(serverItems(away.template)).map((item) => item.checked), [false, false, false]);

  const idle = build({ current: null, connected: false });
  assert.deepEqual(checkboxes(serverItems(idle.template)).map((item) => item.checked), [false, false, false]);
});

test("developer tools show only in a development run", () => {
  const development = submenu(build({ isPackaged: false }).template[2]);
  const tools = development.find((item) => item.label === en["menu.devTools"]);
  assert.equal(tools?.accelerator, "Alt+CmdOrCtrl+I");
  assert.equal(submenu(build({ isPackaged: true }).template[2]).some((item) => item.label === en["menu.devTools"]), false);
  assert.deepEqual(shape(submenu(build({ isPackaged: true }).template[2])), [en["menu.reload"], "togglefullscreen"]);
});

test("every click reaches its own action", () => {
  const { template, calls } = build({ current: { kind: "profile", id: "one" }, connected: true });
  fire(template);
  assert.deepEqual(calls.map((call) => call.action === "connect" ?
    `connect:${call.target?.kind === "profile" ? call.target.id : "local"}` : call.action).sort(),
  ["connect:local", "connect:one", "connect:two", "devTools", "openProject", "openSettings", "openSettings", "reconnect", "reload"]);
});

test("Reconnect and the server pickers hand over the target", () => {
  const { template, calls } = build();
  const items = serverItems(template);
  (items[0].click as () => void)();
  (items[2].click as () => void)();
  (items[4].click as () => void)();
  (submenu(template[0])[2].click as () => void)();
  (submenu(template[5])[0].click as () => void)();
  assert.deepEqual(calls, [
    { action: "connect", target: { kind: "local" } },
    { action: "connect", target: { kind: "profile", id: "two" } },
    { action: "reconnect", target: null },
    { action: "openSettings", target: null },
    { action: "openProject", target: null },
  ]);
});

const windows = (over: Partial<MenuInput> = {}) =>
  build({ platform: "win32", strings: catalogue("en", "win32"), ...over });

const roles = (items: MenuItemConstructorOptions[]): string[] =>
  items.flatMap((item) => [item.role ?? "", ...roles(submenu(item))]).filter((role) => role.length > 0);

test("the Windows bar is File, Edit, View, Server and Help, with no app menu", () => {
  const strings = catalogue("en", "win32");
  const { template } = windows();
  assert.deepEqual(shape(template), [strings["menu.file"], "editMenu", strings["menu.view"], strings["menu.server"], "help"]);
  assert.deepEqual(shape(submenu(template[0])), [strings["menu.settings"], "separator", "quit"]);
  assert.equal(submenu(template[0])[2].label, strings["menu.exit"]);
  assert.deepEqual(shape(submenu(template[2])), [strings["menu.reload"], "togglefullscreen", strings["menu.devTools"]]);
  assert.deepEqual(shape(serverItems(template)),
    [strings["window.thisPC"], "Living room", "NAS", "separator", strings["menu.reconnect"], strings["menu.serverSettings"]]);
  assert.deepEqual(shape(submenu(template[4])), [strings["menu.project"]]);
});

test("Settings in the File menu carries the usual accelerator and Exit is the quit role", () => {
  const { template } = windows();
  const file = submenu(template[0]);
  assert.equal(file[0].accelerator, "CmdOrCtrl+,");
  assert.equal(file[0].role, undefined);
  assert.equal(file[2].label, catalogue("en", "win32")["menu.exit"]);
  assert.equal(file[2].role, "quit");
});

test("no macOS-only role reaches the Windows bar", () => {
  const macOnly = ["about", "services", "hide", "hideOthers", "unhide", "windowMenu"];
  for (const platform of ["win32", "linux"] as const) {
    const { template } = windows({ platform });
    for (const role of macOnly) assert.equal(roles(template).includes(role), false, `${platform} ${role}`);
    assert.equal(roles(template).includes("editMenu"), true);
    assert.equal(roles(template).includes("quit"), true);
  }
});

test("the Linux bar names the local server a computer, not a Mac", () => {
  const strings = catalogue("en", "linux");
  const { template } = windows({ platform: "linux", strings });
  assert.deepEqual(shape(template), [strings["menu.file"], "editMenu", strings["menu.view"], strings["menu.server"], "help"]);
  assert.deepEqual(shape(serverItems(template)),
    [strings["window.thisComputer"], "Living room", "NAS", "separator", strings["menu.reconnect"], strings["menu.serverSettings"]]);
});

test("every Windows entry reaches its own action", () => {
  const { template, calls } = windows({ current: { kind: "profile", id: "one" }, connected: true });
  fire(template);
  assert.deepEqual(calls.map((call) => call.action === "connect" ?
    `connect:${call.target?.kind === "profile" ? call.target.id : "local"}` : call.action).sort(),
  ["connect:local", "connect:one", "connect:two", "devTools", "openProject", "openSettings", "openSettings", "reconnect", "reload"]);
});
