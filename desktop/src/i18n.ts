// Strings the main process itself needs: the window title and the native dialogs and
// notifications. Everything the shell's own pages render is translated in web/src/i18n.
export const en = {
  "window.thisMac": "This Mac",
  "download.saveTitle": "Save to this device",
  "folder.pickTitle": "Choose a library folder",
  "notify.downloadDone": "Saved {file}",
  "notify.downloadFailed": "Saving {file} did not finish",
};

export const cs: typeof en = {
  "window.thisMac": "Tento Mac",
  "download.saveTitle": "Uložit do tohoto zařízení",
  "folder.pickTitle": "Vyberte složku knihovny",
  "notify.downloadDone": "Uloženo {file}",
  "notify.downloadFailed": "Ukládání {file} nedoběhlo",
};

export function catalogue(locale: "cs" | "en"): typeof en {
  return locale === "cs" ? cs : en;
}
