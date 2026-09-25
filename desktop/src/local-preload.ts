// The page of the backend this app runs itself gets one narrow, versioned bridge; a remote
// server's page gets none. A sandboxed preload is a classic script, so the API comes from require.
(() => {
  const { contextBridge, ipcRenderer } = require("electron") as {
    contextBridge: import("electron").ContextBridge;
    ipcRenderer: import("electron").IpcRenderer;
  };

  contextBridge.exposeInMainWorld("stremioDesktop", {
    version: 1,
    pickFolder: () => ipcRenderer.invoke("desktop:pick-folder") as Promise<string | null>,
  });
})();
