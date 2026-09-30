// The page of the backend this app runs itself gets one narrow, versioned bridge; a remote
// server's page gets none. A sandboxed preload is a classic script, so the API comes from require.
(() => {
  const { contextBridge, ipcRenderer } = require("electron") as {
    contextBridge: import("electron").ContextBridge;
    ipcRenderer: import("electron").IpcRenderer;
  };

  // The language the app's own screens speak, read as the page loads: a first run of the server
  // has no account yet, and Chromium's language is still the one the app started with.
  let locale: string | null = null;
  try { locale = ipcRenderer.sendSync("desktop:locale") as string | null; } catch { /* an older shell */ }

  contextBridge.exposeInMainWorld("stremioDesktop", {
    version: 1,
    locale,
    pickFolder: () => ipcRenderer.invoke("desktop:pick-folder") as Promise<string | null>,
  });
})();
