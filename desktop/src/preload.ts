// A sandboxed preload runs as plain JavaScript and cannot import, so this file stays a
// classic script: the Electron API comes from require.
(() => {
  interface Bootstrap {
    strings: Record<string, string>;
    savedOrigin: string | null;
  }

  const { contextBridge, ipcRenderer } = require("electron") as {
    contextBridge: import("electron").ContextBridge;
    ipcRenderer: import("electron").IpcRenderer;
  };

  const ready = ipcRenderer.invoke("desktop:bootstrap") as Promise<Bootstrap>;
  const live: Bootstrap = { strings: {}, savedOrigin: null };
  void ready.then((state) => {
    live.strings = state.strings;
    live.savedOrigin = state.savedOrigin;
  });

  contextBridge.exposeInMainWorld("desktop", {
    bootstrap: () => ready,
    get strings() { return live.strings; },
    get savedOrigin() { return live.savedOrigin; },
    probe: (origin: string) => ipcRenderer.invoke("desktop:probe", origin),
    open: (origin: string) => ipcRenderer.invoke("desktop:open", origin),
    disconnect: () => ipcRenderer.invoke("desktop:disconnect") as Promise<void>,
  });
})();
