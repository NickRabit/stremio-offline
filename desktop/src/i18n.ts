import { de } from "./i18n/de.js";
import { es } from "./i18n/es.js";
import { fr } from "./i18n/fr.js";
import { it } from "./i18n/it.js";
import { pl } from "./i18n/pl.js";
import { ptBR } from "./i18n/ptBR.js";
import { ru } from "./i18n/ru.js";
import { sk } from "./i18n/sk.js";
import type { ShellLocale } from "./shell-prefs.js";

// Strings the main process itself needs: the window title and the native dialogs and
// notifications. Everything the shell's own pages render is translated in web/src/i18n.
export const en = {
  "window.thisMac": "This Mac",
  "window.thisPC": "This PC",
  "download.saveTitle": "Save to this device",
  "folder.pickTitle": "Choose a library folder",
  "notify.downloadDone": "Saved {file}",
  "notify.downloadFailed": "Saving {file} did not finish",
  "menu.file": "File",
  "menu.settings": "Settings…",
  "menu.view": "View",
  "menu.reload": "Reload",
  "menu.devTools": "Developer tools",
  "menu.server": "Server",
  "menu.reconnect": "Reconnect",
  "menu.serverSettings": "Server settings…",
  "menu.exit": "Exit",
  "menu.help": "Help",
  "menu.project": "Stremio Offline on GitHub",
  "settings.title": "Settings",
  "quit.title": "Quit Stremio Offline?",
  "quit.detail": "Something is still downloading or playing on this Mac. Quitting stops it; unfinished downloads carry on the next time the app starts.",
  "quit.confirm": "Quit",
  "quit.cancel": "Cancel",
  "reset.title": "Reset this Mac?",
  "reset.detail": "The server on this Mac stops and you are signed out of it. Its accounts, library records, history and settings move to the Trash, the app's own settings are deleted, and the app starts again with the welcome screen.",
  "reset.detailDownloads": "The download folder {dir} moves to the Trash too.",
  "reset.confirm": "Reset",
  "reset.cancel": "Cancel",
  "reset.downloadsKept": "The download folder stayed where it is: {dir}",
  "reset.detailServers": "The saved servers and the sign-ins to them are forgotten as well.",
  "reset.detailKeepsFilms": "Downloaded films stay where they are.",
  "tray.open": "Open Stremio Offline",
  "tray.settings": "Settings…",
  "tray.quit": "Quit",
  "tray.stillRunningTitle": "Stremio Offline is still running",
  "tray.stillRunningBody": "Downloads carry on in the background. Open or quit it from the icon in the notification area.",
};

export const cs: typeof en = {
  "window.thisMac": "Tento Mac",
  "window.thisPC": "Tento počítač",
  "download.saveTitle": "Uložit do tohoto zařízení",
  "folder.pickTitle": "Vyberte složku knihovny",
  "notify.downloadDone": "Uloženo {file}",
  "notify.downloadFailed": "Ukládání {file} nedoběhlo",
  "menu.file": "Soubor",
  "menu.settings": "Nastavení…",
  "menu.view": "Zobrazení",
  "menu.reload": "Znovu načíst",
  "menu.devTools": "Vývojářské nástroje",
  "menu.server": "Server",
  "menu.reconnect": "Připojit znovu",
  "menu.serverSettings": "Nastavení serverů…",
  "menu.exit": "Ukončit",
  "menu.help": "Nápověda",
  "menu.project": "Stremio Offline na GitHubu",
  "settings.title": "Nastavení",
  "quit.title": "Ukončit Stremio Offline?",
  "quit.detail": "Na tomto Macu se ještě něco stahuje nebo přehrává. Ukončením se to zastaví; nedokončená stahování pokračují po příštím spuštění aplikace.",
  "quit.confirm": "Ukončit",
  "quit.cancel": "Zrušit",
  "reset.title": "Obnovit tento Mac?",
  "reset.detail": "Server na tomto Macu se zastaví a odhlásíte se z něj. Jeho účty, záznamy knihoven, historie a nastavení se přesunou do Koše, nastavení aplikace se smaže a aplikace začne znovu úvodní obrazovkou.",
  "reset.detailDownloads": "Do Koše se přesune i složka pro stahování {dir}.",
  "reset.confirm": "Obnovit",
  "reset.cancel": "Zrušit",
  "reset.downloadsKept": "Složka pro stahování zůstala na místě: {dir}",
  "reset.detailServers": "Zapomenou se i uložené servery a přihlášení k nim.",
  "reset.detailKeepsFilms": "Stažené filmy zůstanou na místě.",
  "tray.open": "Otevřít Stremio Offline",
  "tray.settings": "Nastavení…",
  "tray.quit": "Ukončit",
  "tray.stillRunningTitle": "Stremio Offline dál běží",
  "tray.stillRunningBody": "Stahování pokračuje na pozadí. Aplikaci otevřete nebo ukončíte ikonou v oznamovací oblasti.",
};

/** The strings that name a Mac, said for Windows: the same words, a PC and a Recycle Bin. */
const win32En: Partial<typeof en> = {
  "window.thisMac": "This PC",
  "quit.detail": "Something is still downloading or playing on this PC. Quitting stops it; unfinished downloads carry on the next time the app starts.",
  "reset.title": "Reset this PC?",
  "reset.detail": "The server on this PC stops and you are signed out of it. Its accounts, library records, history and settings move to the Recycle Bin, the app's own settings are deleted, and the app starts again with the welcome screen.",
  "reset.detailDownloads": "The download folder {dir} moves to the Recycle Bin too.",
};

const win32Cs: Partial<typeof cs> = {
  "window.thisMac": "Tento počítač",
  "quit.detail": "Na tomto počítači se ještě něco stahuje nebo přehrává. Ukončením se to zastaví; nedokončená stahování pokračují po příštím spuštění aplikace.",
  "reset.title": "Obnovit tento počítač?",
  "reset.detail": "Server na tomto počítači se zastaví a odhlásíte se z něj. Jeho účty, záznamy knihoven, historie a nastavení se přesunou do Koše, nastavení aplikace se smaže a aplikace začne znovu úvodní obrazovkou.",
};

const native: Record<Exclude<ShellLocale, "cs" | "en">, Record<string, string>> = { sk, de, es, fr, it, pl, "pt-BR": ptBR, ru };

export function catalogue(locale: ShellLocale, platform: NodeJS.Platform = process.platform): typeof en {
  const own: Record<string, string> = locale === "cs" ? cs : locale === "en" ? en : native[locale];
  if (platform !== "win32") {
    const strings = { ...own };
    for (const key of ["quit.detail.win", "reset.title.win", "reset.detail.win", "reset.detailDownloads.win"]) delete strings[key];
    return strings as typeof en;
  }
  const windows = locale === "en" ? win32En : locale === "cs" ? win32Cs : {
    "window.thisMac": own["window.thisPC"],
    "quit.detail": own["quit.detail.win"],
    "reset.title": own["reset.title.win"],
    "reset.detail": own["reset.detail.win"],
    "reset.detailDownloads": own["reset.detailDownloads.win"],
  };
  const strings: Record<string, string> = { ...own, ...windows };
  for (const key of ["quit.detail.win", "reset.title.win", "reset.detail.win", "reset.detailDownloads.win"]) delete strings[key];
  return strings as typeof en;
}
