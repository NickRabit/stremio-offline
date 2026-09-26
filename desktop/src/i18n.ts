// Strings the main process itself needs: the window title and the native dialogs and
// notifications. Everything the shell's own pages render is translated in web/src/i18n.
export const en = {
  "window.thisMac": "This Mac",
  "download.saveTitle": "Save to this device",
  "folder.pickTitle": "Choose a library folder",
  "notify.downloadDone": "Saved {file}",
  "notify.downloadFailed": "Saving {file} did not finish",
  "menu.settings": "Settings…",
  "menu.view": "View",
  "menu.reload": "Reload",
  "menu.devTools": "Developer tools",
  "menu.server": "Server",
  "menu.reconnect": "Reconnect",
  "menu.serverSettings": "Server settings…",
  "menu.project": "Stremio Offline on GitHub",
  "settings.title": "Settings",
};

export const cs: typeof en = {
  "window.thisMac": "Tento Mac",
  "download.saveTitle": "Uložit do tohoto zařízení",
  "folder.pickTitle": "Vyberte složku knihovny",
  "notify.downloadDone": "Uloženo {file}",
  "notify.downloadFailed": "Ukládání {file} nedoběhlo",
  "menu.settings": "Nastavení…",
  "menu.view": "Zobrazení",
  "menu.reload": "Znovu načíst",
  "menu.devTools": "Vývojářské nástroje",
  "menu.server": "Server",
  "menu.reconnect": "Připojit znovu",
  "menu.serverSettings": "Nastavení serverů…",
  "menu.project": "Stremio Offline na GitHubu",
  "settings.title": "Nastavení",
};

export function catalogue(locale: "cs" | "en"): typeof en {
  return locale === "cs" ? cs : en;
}
