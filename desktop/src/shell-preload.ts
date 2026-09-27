// The shell's own pages get the versioned bridge the contract names; a sandboxed preload is a
// classic script, so the Electron API comes from require. The view is fixed by the query string,
// and an unknown one leaves `window.stremioShell` undefined.
(() => {
  type ShellView = "main" | "settings" | "toast";

  const view = new URLSearchParams(location.search).get("view");
  if (view !== "main" && view !== "settings" && view !== "toast") return;

  const { contextBridge, ipcRenderer } = require("electron") as {
    contextBridge: import("electron").ContextBridge;
    ipcRenderer: import("electron").IpcRenderer;
  };

  contextBridge.exposeInMainWorld("stremioShell", {
    version: 1,
    view: view as ShellView,
    getState: () => ipcRenderer.invoke("shell:getState"),
    onState: (listener: (state: unknown) => void) => {
      const wrapped = (_event: unknown, state: unknown) => listener(state);
      ipcRenderer.on("shell:state", wrapped);
      return () => ipcRenderer.removeListener("shell:state", wrapped);
    },
    connect: (target: unknown) => ipcRenderer.invoke("shell:connect", target),
    cancelSetup: () => ipcRenderer.invoke("shell:cancelSetup"),
    saveProfile: (input: unknown) => ipcRenderer.invoke("shell:saveProfile", input),
    deleteProfile: (id: string) => ipcRenderer.invoke("shell:deleteProfile", id),
    probe: (origin: string) => ipcRenderer.invoke("shell:probe", origin),
    setLocalSettings: (settings: unknown) => ipcRenderer.invoke("shell:setLocalSettings", settings),
    restartLocal: () => ipcRenderer.invoke("shell:restartLocal"),
    setLocale: (locale: unknown) => ipcRenderer.invoke("shell:setLocale", locale),
    openSettings: () => ipcRenderer.send("shell:openSettings"),
    toastAction: (id: number) => ipcRenderer.send("shell:toastAction", id),
    dismissToast: (id: number) => ipcRenderer.send("shell:dismissToast", id),
    copyText: (text: string) => ipcRenderer.send("shell:copyText", text),
    pickFolder: (defaultPath: string | null) => ipcRenderer.invoke("shell:pickFolder", defaultPath),
    prepareDownloadDir: (dir: string) => ipcRenderer.invoke("shell:prepareDownloadDir", dir),
    resetLocal: (options: unknown) => ipcRenderer.invoke("shell:resetLocal", options),
  });
})();
