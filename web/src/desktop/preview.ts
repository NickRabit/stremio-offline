import type { ShellBridge, ShellState, ShellView, Target } from "./bridge";

/**
 * A stand-in bridge for looking at the shell's pages in an ordinary browser:
 * desktop.html?preview=main&screen=welcome|connecting|error|connected, ?preview=settings,
 * ?preview=toast&toast=fallback|download-done. It keeps its state in memory and changes nothing.
 */
export function previewBridge(search: string): ShellBridge | null {
  const query = new URLSearchParams(search);
  const view = query.get("preview") as ShellView | null;
  if (view !== "main" && view !== "settings" && view !== "toast") return null;
  const nas: Target = { kind: "profile", id: "nas" };
  const screenKind = query.get("screen") ?? "welcome";
  let state: ShellState = {
    locale: query.get("locale") === "en" ? "en" : "cs",
    localeChoice: null,
    appVersion: "0.4.85",
    screen: screenKind === "connecting" ? { kind: "connecting", target: nas, name: "NAS v obýváku", origin: "http://192.168.1.20:8090" }
      : screenKind === "error" ? { kind: "error", target: nas, name: "NAS v obýváku", origin: "http://192.168.1.20:8090", reason: (query.get("reason") as never) ?? "unreachable", port: 8091 }
      : screenKind === "local" ? { kind: "connecting", target: { kind: "local" }, name: "", origin: null }
      : screenKind === "connected" ? { kind: "connected" }
      : { kind: "welcome" },
    connection: { target: { kind: "local" }, name: "", origin: "http://127.0.0.1:51234", version: "0.4.85", restricted: false, secure: true, fallbackFrom: query.get("fallback") ? "NAS v obýváku" : null },
    chosen: nas,
    profiles: [
      { id: "nas", name: "NAS v obýváku", origin: "http://192.168.1.20:8090" },
      { id: "office", name: "Kancelář", origin: "https://media.example.cz" },
    ],
    local: {
      settings: { allowPrivateAddons: false, publish: true, publishPort: 8091, downloadDir: null },
      downloadDir: "/Users/ondrej/Movies/Stremio Offline",
      suggestedDownloadDir: "/Users/ondrej/Movies/Stremio Offline",
      initialized: query.get("initialized") !== "0",
      downloadDirOwned: query.get("owned") !== "0",
      running: true,
      addresses: ["http://192.168.1.41:8091", "http://ondrej-macbook-pro.local:8091"],
      ffmpeg: "ffmpeg 9.0.2 + openssl 3.5.8, macOS 12.0, arm64",
      busy: query.get("busy") === "1",
    },
    toast: view === "toast"
      ? (query.get("toast") === "download-done" ? { id: 1, kind: "download-done", file: "Film.2021.mkv" } : { id: 1, kind: "fallback", server: "NAS v obýváku" })
      : null,
  };
  const listeners = new Set<(next: ShellState) => void>();
  const emit = (next: ShellState) => { state = next; for (const listener of listeners) listener(state); };
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    version: 1,
    view,
    getState: async () => state,
    onState: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    connect: async (target) => { emit({ ...state, chosen: target }); },
    saveProfile: async (input) => {
      const profile = { id: input.id ?? `p${Date.now()}`, name: input.name.trim(), origin: input.origin.trim() };
      if (!profile.name) return { ok: false, reason: "invalid-name" };
      if (!/^https?:\/\/[^/]+\/?$/.test(profile.origin)) return { ok: false, reason: "invalid-data" };
      emit({ ...state, profiles: [...state.profiles.filter((p) => p.id !== profile.id), profile] });
      return { ok: true, profile };
    },
    deleteProfile: async (id) => { emit({ ...state, profiles: state.profiles.filter((p) => p.id !== id) }); return { ok: true }; },
    probe: async (origin) => { await wait(600); return origin.includes("192.168.1.20") ? { ok: true, version: "0.4.84", restricted: false, secure: true } : { ok: false, reason: "unreachable" }; },
    setLocalSettings: async (settings) => { emit({ ...state, local: { ...state.local, settings } }); return { ok: true, restartNeeded: state.local.running }; },
    restartLocal: async () => { await wait(800); return { ok: true }; },
    setLocale: async (locale) => { emit({ ...state, locale: locale ?? "cs", localeChoice: locale }); },
    openSettings: () => undefined,
    toastAction: () => undefined,
    dismissToast: () => undefined,
    pickFolder: async () => "/Volumes/Filmy/Stremio",
    prepareDownloadDir: async (dir) => dir.startsWith("/") ? { ok: true, dir } : { ok: false, reason: "not-absolute" },
    resetLocal: async () => { await wait(500); emit({ ...state, screen: { kind: "welcome" }, chosen: null }); return { ok: true, cancelled: false, downloadsKept: true }; },
    copyText: (text) => { void navigator.clipboard?.writeText(text).catch(() => undefined); },
  };
}
