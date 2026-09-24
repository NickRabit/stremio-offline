// A sandboxed preload runs as plain JavaScript and cannot import, so this file stays a
// classic script: the Electron API comes from require.
(() => {
  interface ServerProfile {
    id: string;
    name: string;
    origin: string;
  }

  interface Bootstrap {
    strings: Record<string, string>;
    profiles: ServerProfile[];
    selectedProfileId: string | null;
  }

  const { contextBridge, ipcRenderer } = require("electron") as {
    contextBridge: import("electron").ContextBridge;
    ipcRenderer: import("electron").IpcRenderer;
  };

  const ready = ipcRenderer.invoke("desktop:bootstrap") as Promise<Bootstrap>;
  const live: Bootstrap = { strings: {}, profiles: [], selectedProfileId: null };
  void ready.then((state) => {
    live.strings = state.strings;
    live.profiles = state.profiles;
    live.selectedProfileId = state.selectedProfileId;
  });

  contextBridge.exposeInMainWorld("desktop", {
    bootstrap: () => ready,
    get strings() { return live.strings; },
    get profiles() { return live.profiles; },
    get selectedProfileId() { return live.selectedProfileId; },
    saveProfile: (input: { id: string | null; name: string; origin: string }) => ipcRenderer.invoke("desktop:save-profile", input),
    deleteProfile: (id: string) => ipcRenderer.invoke("desktop:delete-profile", id),
    selectProfile: (id: string | null) => ipcRenderer.invoke("desktop:select-profile", id),
    connect: (id: string) => ipcRenderer.invoke("desktop:connect", id),
    disconnect: () => ipcRenderer.invoke("desktop:disconnect") as Promise<void>,
  });
})();
