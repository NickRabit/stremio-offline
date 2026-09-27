import type { MenuItemConstructorOptions } from "electron";
import type { ServerProfile } from "./connection-file.js";
import type { MenuStrings } from "./menu.js";
import type { Target } from "./shell-api.js";

export interface TrayActions {
  open: () => void;
  openSettings: () => void;
  connect: (target: Target) => void;
  quit: () => void;
}

export interface TrayInput {
  strings: MenuStrings;
  profiles: readonly ServerProfile[];
  /** The target the app is on, or the remembered one while it connects. */
  current: Target | null;
  connected: boolean;
  platform?: NodeJS.Platform;
  actions: TrayActions;
}

const isLocal = (target: Target | null): boolean => target?.kind === "local";

const isProfile = (target: Target | null, id: string): boolean => target?.kind === "profile" && target.id === id;

/** Pure: the tray's menu, tested without Electron's `Tray`, which needs a ready app. */
export function buildTrayTemplate(input: TrayInput): MenuItemConstructorOptions[] {
  const { strings, profiles, current, connected, platform = process.platform, actions } = input;
  return [
    { label: strings["tray.open"], click: () => actions.open() },
    { type: "separator" },
    {
      label: platform === "win32" ? strings["window.thisPC"] : strings["window.thisMac"],
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
    { label: strings["tray.settings"], click: () => actions.openSettings() },
    { type: "separator" },
    { label: strings["tray.quit"], click: () => actions.quit() },
  ];
}
