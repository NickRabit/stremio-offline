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
  "reset.title": "Reset this Mac?",
  "reset.detail": "The server on this Mac stops. Its accounts, libraries, history and settings move to the Trash, and the app starts again with the welcome screen.",
  "reset.detailDownloads": "The download folder {dir} moves to the Trash too.",
  "reset.confirm": "Reset",
  "reset.cancel": "Cancel",
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
  "reset.title": "Obnovit tento Mac?",
  "reset.detail": "Server na tomto Macu se zastaví. Jeho účty, knihovny, historie a nastavení se přesunou do Koše a aplikace začne znovu úvodní obrazovkou.",
  "reset.detailDownloads": "Do Koše se přesune i složka pro stahování {dir}.",
  "reset.confirm": "Obnovit",
  "reset.cancel": "Zrušit",
};

export function catalogue(locale: "cs" | "en"): typeof en {
  return locale === "cs" ? cs : en;
}
