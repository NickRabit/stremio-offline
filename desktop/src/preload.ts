// A sandboxed preload runs as plain JavaScript and cannot import, so this file stays a
// classic script: the Electron API comes from require.
(() => {
  interface ServerProfile {
    id: string;
    name: string;
    origin: string;
  }

  interface LocalSettings {
    allowPrivateAddons: boolean;
  }

  interface Bootstrap {
    strings: Record<string, string>;
    profiles: ServerProfile[];
    selectedProfileId: string | null;
    localSettings: LocalSettings;
  }

  const { contextBridge, ipcRenderer } = require("electron") as {
    contextBridge: import("electron").ContextBridge;
    ipcRenderer: import("electron").IpcRenderer;
  };

  const ready = ipcRenderer.invoke("desktop:bootstrap") as Promise<Bootstrap>;
  const live: Bootstrap = { strings: {}, profiles: [], selectedProfileId: null, localSettings: { allowPrivateAddons: false } };
  void ready.then((state) => {
    live.strings = state.strings;
    live.profiles = state.profiles;
    live.selectedProfileId = state.selectedProfileId;
    live.localSettings = state.localSettings;
  });

  contextBridge.exposeInMainWorld("desktop", {
    bootstrap: () => ready,
    get strings() { return live.strings; },
    get profiles() { return live.profiles; },
    get selectedProfileId() { return live.selectedProfileId; },
    get localSettings() { return live.localSettings; },
    saveProfile: (input: { id: string | null; name: string; origin: string }) => ipcRenderer.invoke("desktop:save-profile", input),
    deleteProfile: (id: string) => ipcRenderer.invoke("desktop:delete-profile", id),
    selectProfile: (id: string | null) => ipcRenderer.invoke("desktop:select-profile", id),
    setLocalSettings: (input: { allowPrivateAddons: boolean }) => ipcRenderer.invoke("desktop:set-local-settings", input),
    connect: (id: string) => ipcRenderer.invoke("desktop:connect", id),
    connectLocal: () => ipcRenderer.invoke("desktop:connect-local"),
    disconnect: () => ipcRenderer.invoke("desktop:disconnect") as Promise<void>,
  });
})();
