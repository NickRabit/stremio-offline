import type { MenuItemConstructorOptions } from "electron";
import type { ServerProfile } from "./connection-file.js";
import { catalogue } from "./i18n.js";
import type { Target } from "./shell-api.js";

export type MenuStrings = ReturnType<typeof catalogue>;

const APP_NAME = "Stremio Offline";

export interface MenuActions {
  openSettings: () => void;
  reload: () => void;
  devTools: () => void;
  connect: (target: Target) => void;
  reconnect: () => void;
  openProject: () => void;
}

export interface MenuInput {
  strings: MenuStrings;
  profiles: readonly ServerProfile[];
  /** The target the app is on, or the remembered one while it connects. */
  current: Target | null;
  connected: boolean;
  isPackaged: boolean;
  actions: MenuActions;
}

const isLocal = (target: Target | null): boolean => target?.kind === "local";

const isProfile = (target: Target | null, id: string): boolean => target?.kind === "profile" && target.id === id;

/** Pure: the shell tests the template without Electron's `Menu`, which needs a ready app. */
export function buildMenuTemplate(input: MenuInput): MenuItemConstructorOptions[] {
  const { strings, profiles, current, connected, isPackaged, actions } = input;

  const view: MenuItemConstructorOptions[] = [
    // An explicit click, not `role: "reload"`, which acts on the focused contents.
    { label: strings["menu.reload"], accelerator: "CmdOrCtrl+R", click: () => actions.reload() },
    { role: "togglefullscreen" },
  ];
  if (!isPackaged) {
    view.push({ label: strings["menu.devTools"], accelerator: "Alt+CmdOrCtrl+I", click: () => actions.devTools() });
  }

  const server: MenuItemConstructorOptions[] = [
    {
      label: strings["window.thisMac"],
      type: "checkbox",
      checked: isLocal(current) && connected,
      click: () => actions.connect({ kind: "local" }),
    },
    ...profiles.map((profile): MenuItemConstructorOptions => ({
      label: profile.name,
      type: "checkbox",
      checked: isProfile(current, profile.id),
      click: () => actions.connect({ kind: "profile", id: profile.id }),
    })),
    { type: "separator" },
    { label: strings["menu.reconnect"], accelerator: "CmdOrCtrl+Shift+R", click: () => actions.reconnect() },
    { label: strings["menu.serverSettings"], click: () => actions.openSettings() },
  ];

  return [
    {
      label: APP_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: strings["menu.settings"], accelerator: "CmdOrCtrl+,", click: () => actions.openSettings() },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { label: strings["menu.view"], submenu: view },
    { label: strings["menu.server"], submenu: server },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: strings["menu.project"], click: () => actions.openProject() }] },
  ];
}
