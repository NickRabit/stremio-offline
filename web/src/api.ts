import { serverText, t } from "./i18n";
import type { ActiveStream, Diagnostics, BuildInfo, AuthStatus, StatsSummary, Addon, AddonDownloadSettings, Capabilities, Catalog, Download, DownloadSelection, DownloadSnapshot, Inspection, BrowseResult, IdentityPreview, LibraryFolder, LibraryOp, LibraryOpsState, ProgressEntry, WatchlistEntry, GrantBrowse, LibraryEstimate, LibraryGrant, LibrarySummary, LibraryType, LibraryView, Meta, PlaybackSession, ScanState, SearchResult, SearchableCatalog, SiteLink, SuggestionRow, Session, Settings, SettingsBackup, SettingsPatch, Stream, Subtitle, Trailer, UserAccount, UserPermissions, UserRole } from "./types";

/** The status code has to reach the top, or a sign-out is indistinguishable from an ordinary error. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string,
    /** Catalogue key for the message, so it can be shown in the reader's language. */
    readonly messageKey?: string, readonly vars?: Record<string, string | number>) { super(message); }
}

/** Every failure the interface shows goes through here: a known key wins, the
 *  server's English text is the fallback. */
export const describeError = (error: unknown): string => error instanceof ApiError
  ? serverText(error.messageKey, error.message, error.vars)
  : error instanceof Error ? error.message : String(error);

/** Every call gets a deadline. A stalled connection would otherwise be held until the
 * operating system gives up, which takes minutes, and six of those exhaust the browser's
 * per-origin pool -- the app then looks dead on that one device while others are fine. */
async function request<T>(url: string, options?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const { timeoutMs = 30_000, ...init } = options ?? {};
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", ...init.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") throw new ApiError(t("api.timeout"), 408, "REQUEST_TIMEOUT");
    throw error;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({} as { error?: string; code?: string; messageKey?: string; vars?: Record<string, string | number> }));
    throw new ApiError(body.error ?? `HTTP ${response.status}`, response.status, body.code, body.messageKey, body.vars);
  }
  return response.status === 204 ? undefined as T : response.json();
}
/** A conversion restart waits for the first segments and retries once. */
const PLAYBACK_RESTART_MS = 120_000;
const PLAYBACK_START_MS = 180_000;

const q = (values: Record<string, string | number | undefined>) => new URLSearchParams(Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();

export const api = {
  addons: () => request<Addon[]>("/api/addons"),
  addAddon: (url: string, role: string) => request<Addon>("/api/addons", { method: "POST", body: JSON.stringify({ url, role }) }),
  moveAddon: (key: string, direction: -1 | 1) => request<void>(`/api/addons/${key}/move`, { method: "POST", body: JSON.stringify({ direction }) }),
  setAddonOrder: (order: string[]) => request<void>("/api/addons/order", { method: "PUT", body: JSON.stringify({ order }) }),
  exportAddon: (key: string) => request<Record<string, unknown>>(`/api/addons/${key}/export`),
  deleteAddon: (key: string) => request<void>(`/api/addons/${key}`, { method: "DELETE" }),
  refreshAddon: (key: string) => request<{ addon: Addon; changed: boolean; previousVersion: string; version: string }>(`/api/addons/${key}/refresh`, { method: "POST" }),
  refreshAddons: () => request<{ changed: number; failed: number; addons: Addon[] }>("/api/addons/refresh", { method: "POST", timeoutMs: 120_000 }),
  stats: (hours: number) => request<StatsSummary>(`/api/stats?hours=${hours}`),
  activeStreams: () => request<ActiveStream[]>("/api/stats/streams"),
  updateAddon: (key: string, patch: { enabled?: boolean; globalSearch?: boolean; showInContinueWatching?: boolean; url?: string; role?: string; allowedUsers?: string[]; downloadSettings?: AddonDownloadSettings }) => request<Addon>(`/api/addons/${key}`, { method: "PATCH", body: JSON.stringify(patch) }),
  toggleAddon: (key: string, enabled: boolean) => request<Addon>(`/api/addons/${key}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  catalogs: () => request<Catalog[]>("/api/catalogs"),
  catalog: (catalog: Catalog, search = "", skip = 0, genre = "") => request<Meta[]>(`/api/catalog?${q({ addon: catalog.addonKey, type: catalog.type, id: catalog.id, search: search || undefined, skip: skip || undefined, genre: genre || undefined })}`),
  search: (query: string, options: { type?: string; cursor?: string; addonKey?: string; catalogType?: string; catalogId?: string } = {}) => request<SearchResult>(`/api/search?${q({ query, type: options.type || undefined, cursor: options.cursor || undefined, addon: options.addonKey || undefined, catalogType: options.catalogType || undefined, catalogId: options.catalogId || undefined })}`),
  searchable: () => request<SearchableCatalog[]>("/api/searchable"),
  meta: (type: string, id: string, language?: string) => request<Meta>(`/api/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}${language ? `?${q({ language })}` : ""}`),
  links: (type: string, id: string, language: string) => request<{ links: SiteLink[] }>(`/api/links/${encodeURIComponent(type)}/${encodeURIComponent(id)}?${q({ language })}`, { timeoutMs: 60_000 }),
  libraryLinks: (path: string, language: string) => request<{ links: SiteLink[] }>(`/api/library/links?${q({ path, language })}`, { timeoutMs: 60_000 }),
  trailer: (type: string, id: string, language: string) => request<{ trailer: Trailer | null }>(`/api/trailer/${encodeURIComponent(type)}/${encodeURIComponent(id)}?${q({ language })}`),
  libraryTrailer: (path: string, language: string) => request<{ trailer: Trailer | null }>(`/api/library/trailer?${q({ path, language })}`),
  streamSources: (type: string, id: string) => request<Array<{ key: string; name: string }>>(`/api/stream-sources/${encodeURIComponent(type)}/${encodeURIComponent(id)}`),
  streams: (type: string, id: string, addon?: string) => request<Stream[]>(`/api/streams/${encodeURIComponent(type)}/${encodeURIComponent(id)}${addon ? `?addon=${encodeURIComponent(addon)}` : ""}`),
  subtitles: (type: string, id: string) => request<Subtitle[]>(`/api/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}`),
  downloads: (timeoutMs?: number) => request<DownloadSnapshot>("/api/downloads", { timeoutMs }),
  download: (title: string, stream: Stream, media?: Record<string, unknown>) => request<Download>("/api/downloads", { method: "POST", body: JSON.stringify({ title, sourceId: stream.sourceId, media }) }),
  prepareDeviceDownload: (payload: { title?: string; stream?: Stream; media?: Record<string, unknown>; path?: string }) =>
    request<{ url: string; filename: string }>("/api/device-download", { method: "POST", body: JSON.stringify({ title: payload.title, sourceId: payload.stream?.sourceId, media: payload.media }) }),
  downloadBulk: (title: string, type: string, episodes: Array<{ id: string; season?: number; episode?: number; title?: string }>, selection: DownloadSelection, media?: { id?: string; metaType?: string; poster?: string }) => request<{ added: number; skipped: number }>("/api/downloads/bulk", { method: "POST", body: JSON.stringify({ title, type, episodes, selection, media }) }),
  downloadAction: (id: string, action: "pause" | "resume" | "retry") => request<void>(`/api/downloads/${id}/${action}`, { method: "POST" }),
  moveDownload: (id: string, direction: -1 | 1) => request<void>(`/api/downloads/${id}/move`, { method: "POST", body: JSON.stringify({ direction }) }),
  removeDownload: (id: string) => request<void>(`/api/downloads/${id}`, { method: "DELETE" }),
  clearCompleted: () => request<void>("/api/downloads", { method: "DELETE" }),
  settings: () => request<Settings>("/api/settings"),
  updateSettings: (patch: SettingsPatch) => request<Settings>("/api/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  exportSettings: () => request<SettingsBackup>("/api/settings/export"),
  importSettings: (backup: unknown) => request<{ settings: Settings; addons: Addon[]; remapped: number }>("/api/settings/import", { method: "POST", body: JSON.stringify(backup), timeoutMs: 120_000 }),
  languages: () => request<Array<{ code: string; name: string }>>("/api/languages"),
  inspect: (stream: Stream) => request<Inspection>("/api/inspect", { method: "POST", body: JSON.stringify({ sourceId: stream.sourceId }) }),
  logs: (options: { tail?: number; level?: string; hours?: number; search?: string; inline?: boolean } = {}) =>
    fetch(`/api/logs?${q({ tail: options.tail, level: options.level || undefined, hours: options.hours || undefined, q: options.search || undefined, inline: options.inline ? 1 : undefined })}`)
      .then(async (response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); }),
  clearLogs: () => request<void>("/api/logs", { method: "DELETE" }),
  diagnostics: () => request<Diagnostics>("/api/diagnostics"),
  // Start waits for the source probe (up to 20 s quick, 45 s deep) and then for FFmpeg's
  // first segments (up to 40 s). A shorter deadline does not cancel the session, it only
  // leaves it running with nobody watching.
  startPlayback: (stream: Stream, capabilities: Capabilities, time = 0, subtitleIds: string[] = [], preferences?: { audioLanguage?: string; subtitleLanguage?: string | null }) => request<PlaybackSession>("/api/playback", { method: "POST", body: JSON.stringify({ sourceId: stream.sourceId, capabilities, time, subtitleIds, ...preferences }), timeoutMs: PLAYBACK_START_MS }),
  setTrack: (id: string, changes: { audio?: number; subtitle?: number | null; quality?: number | null; time: number }) => request<PlaybackSession>(`/api/playback/${id}/track`, { method: "POST", body: JSON.stringify(changes), timeoutMs: PLAYBACK_RESTART_MS }),
  seekPlayback: (id: string, time: number) => request<PlaybackSession>(`/api/playback/${id}/seek`, { method: "POST", body: JSON.stringify({ time }), timeoutMs: PLAYBACK_RESTART_MS }),
  /** The browser refused the stream: the server stops copying and really transcodes. */
  escalatePlayback: (id: string, time: number) => request<PlaybackSession>(`/api/playback/${id}/escalate`, { method: "POST", body: JSON.stringify({ time }), timeoutMs: PLAYBACK_RESTART_MS }),
  pingPlayback: (id: string) => request<void>(`/api/playback/${id}/ping`, { method: "POST" }),
  stopPlayback: (id: string) => request<void>(`/api/playback/${id}`, { method: "DELETE" }),
  nextLibraryFile: (sourceId: string) => request<{ path: string; title: string } | null>(`/api/library/next/${encodeURIComponent(sourceId)}`),
  previousLibraryFile: (sourceId: string) => request<{ path: string; title: string } | null>(`/api/library/previous/${encodeURIComponent(sourceId)}`),
  librarySource: (path: string) => request<Stream>("/api/library/source", { method: "POST", body: JSON.stringify({ path }) }),
  library: () => request<LibrarySummary[]>("/api/library"),
  deleteLibraryItem: (path: string) => request<void>(`/api/library/item?${q({ path })}`, { method: "DELETE" }),
  renameLibraryItem: (path: string, name: string) => request<{ path: string }>("/api/library/rename", { method: "POST", body: JSON.stringify({ path, name }) }),
  libraryFolders: (path = "") => request<{ path: string; folders: LibraryFolder[] }>(`/api/library/folders?${q({ path: path || undefined })}`),
  moveLibraryItem: (path: string, folder: string) => request<{ path: string }>("/api/library/move", { method: "POST", body: JSON.stringify({ path, folder }) }),
  createLibraryFolder: (path: string, name: string) => request<{ path: string }>("/api/library/folder", { method: "POST", body: JSON.stringify({ path, name }) }),
  libraryOps: () => request<{ jobs: LibraryOpsState[] }>("/api/library/ops"),
  startLibraryOp: (operation: LibraryOp) => request<{ id: string }>("/api/library/ops", { method: "POST", body: JSON.stringify(operation) }),
  cancelLibraryOp: (id: string) => request<void>(`/api/library/ops/${encodeURIComponent(id)}`, { method: "DELETE" }),
  libraryIdentity: (path: string) => request<IdentityPreview>(`/api/library/identity?${q({ path })}`),
  matchLibraryItem: (body: { path?: string; key?: string; id?: string; type?: string; scope?: "unit" | "file"; season?: number; episode?: number; skipLookup?: boolean; skipMosaic?: boolean }) =>
    request<{ key: string; type: string; id: string | null }>("/api/library/match", { method: "POST", body: JSON.stringify(body) }),
  librarySuggestions: () => request<{ items: SuggestionRow[]; total: number }>("/api/library/suggestions"),
  dismissLibrarySuggestion: (key: string) => request<void>(`/api/library/suggestion?${q({ key })}`, { method: "DELETE" }),
  libraryScan: () => request<ScanState>("/api/library/scan"),
  startLibraryScan: (body: { force?: boolean; path?: string; libraryId?: string } = {}) =>
    request<ScanState>("/api/library/scan", { method: "POST", body: JSON.stringify(body) }),
  stopLibraryScan: () => request<void>("/api/library/scan/stop", { method: "POST" }),
  watchlist: () => request<WatchlistEntry[]>("/api/watchlist"),
  setWatchlist: (payload: { type: string; id: string; name?: string; poster?: string; favorite: boolean }) =>
    request<{ key: string; favorite: boolean }>("/api/watchlist", { method: "POST", body: JSON.stringify(payload) }),
  progressList: () => request<ProgressEntry[]>("/api/progress"),
  /** The page itself is going away -- a closed tab, a reload, the browser being quit. A
   *  keepalive request outlives the page that sent it, so the server hears that the film is
   *  over instead of converting and reading the source until it works out nobody is there. */
  stopPlaybackOnUnload: (id: string) => void fetch(`/api/playback/${id}`, { method: "DELETE", keepalive: true }).catch(() => undefined),
  progressOf: (key: string) => request<ProgressEntry | null>(`/api/progress/${encodeURIComponent(key)}`),
  saveProgress: (payload: { key: string; position: number; duration: number; title?: string; path?: string; poster?: string; addonKey?: string }) =>
    request<void>("/api/progress", { method: "POST", body: JSON.stringify(payload) }),
  clearProgress: () => request<void>("/api/progress", { method: "DELETE" }),
  forgetProgress: (key: string) => request<void>(`/api/progress/${encodeURIComponent(key)}`, { method: "DELETE" }),
  setFavorite: (path: string, favorite: boolean) => request<{ path: string; favorite: boolean }>("/api/library/favorite", { method: "POST", body: JSON.stringify({ path, favorite }) }),
  resumeLibrary: (options: { skip?: number; limit?: number; sort?: string; order?: string; seed?: string; query?: string; favorites?: boolean }) =>
    request<BrowseResult>(`/api/library/resume?${q({ ...options, favorites: options.favorites ? 1 : undefined })}`),
  favorites: (options: { skip?: number; limit?: number; sort?: string; order?: string; seed?: string }) =>
    request<BrowseResult>(`/api/library/favorites?${q({ skip: options.skip || undefined, limit: options.limit ?? 60, sort: options.sort || undefined, order: options.order || undefined, seed: options.seed || undefined })}`),
  /** The configured libraries. `root` is withheld in restricted mode. */
  libraries: () => request<LibraryView[]>("/api/libraries"),
  createLibrary: (body: { name: string; type: LibraryType; root: string; create?: boolean; writeArtwork?: boolean }) =>
    request<LibraryView>("/api/libraries", { method: "POST", body: JSON.stringify(body) }),
  updateLibrary: (id: string, patch: { name?: string; type?: LibraryType; enabled?: boolean; order?: number; writeArtwork?: boolean; mosaic?: boolean; showInContinueWatching?: boolean; defaultMovie?: boolean; defaultSeries?: boolean; visibleTo?: string[]; root?: string; create?: boolean }) =>
    request<LibraryView>(`/api/libraries/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  /** Re-rooting that carries the content over. Queued, so it answers with the job id and
   *  the library only follows once every item is across. */
  rerootLibrary: (id: string, body: { root: string; create?: boolean }) =>
    request<{ id: string }>(`/api/libraries/${encodeURIComponent(id)}/reroot`, { method: "POST", body: JSON.stringify({ ...body, moveContent: true }) }),
  deleteLibrary: (id: string, forget = false) =>
    request<void>(`/api/libraries/${encodeURIComponent(id)}${forget ? "?forget=1" : ""}`, { method: "DELETE" }),
  libraryGrants: () => request<LibraryGrant[]>("/api/libraries/grants"),
  grantLibraryRoot: (path: string) => request<LibraryGrant[]>("/api/libraries/grants", { method: "POST", body: JSON.stringify({ path }) }),
  revokeLibraryGrant: (path: string) => request<LibraryGrant[]>(`/api/libraries/grants?${q({ path })}`, { method: "DELETE" }),
  browseGrants: (path = "") => request<GrantBrowse>(`/api/libraries/browse?${q({ path: path || undefined })}`),
  previewLibrary: (body: { root: string; type: LibraryType }) =>
    request<LibraryEstimate>("/api/libraries/preview", { method: "POST", body: JSON.stringify(body) }),
  browse: (options: { path?: string; query?: string; skip?: number; limit?: number; sort?: string; order?: string; seed?: string; favorites?: boolean }) =>
    request<BrowseResult>(`/api/library/browse?${q({
      path: options.path || undefined, query: options.query || undefined,
      skip: options.skip || undefined, limit: options.limit ?? 60,
      sort: options.sort || undefined, order: options.order || undefined, seed: options.seed || undefined,
      favorites: options.favorites ? 1 : undefined,
    })}`),
  status: () => request<BuildInfo>("/api/status"),
  me: () => request<AuthStatus>("/api/auth/me"),
  setup: (username: string, password: string, language: string) => request<Session>("/api/auth/setup", { method: "POST", body: JSON.stringify({ username, password, language }) }),
  login: (username: string, password: string, remember: boolean) => request<Session>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password, remember }) }),
  logout: (everywhere = false) => request<void>("/api/auth/logout", { method: "POST", body: JSON.stringify({ everywhere }) }),
  changeCredentials: (payload: { username?: string; currentPassword?: string; newPassword: string }) => request<Session>("/api/auth/password", { method: "PATCH", body: JSON.stringify(payload) }),
  /** The accounts an administrator manages. The grants themselves live on the resource:
   *  a library tick writes `visibleTo` through `updateLibrary`, an addon tick
   *  `allowedUsers` through `updateAddon`. */
  users: () => request<UserAccount[]>("/api/users"),
  createUser: (body: { username: string; password: string; role?: UserRole; permissions?: Partial<UserPermissions> }) =>
    request<UserAccount>("/api/users", { method: "POST", body: JSON.stringify(body) }),
  updateUser: (id: string, patch: { role?: UserRole; disabled?: boolean; permissions?: Partial<UserPermissions> }) =>
    request<UserAccount>(`/api/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  setUserPassword: (id: string, password: string) =>
    request<UserAccount>(`/api/users/${encodeURIComponent(id)}/password`, { method: "PATCH", body: JSON.stringify({ password }) }),
  deleteUser: (id: string) => request<void>(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

/** Hand the same-origin ticket to the browser so large files never pass through JavaScript memory. */
export async function saveToDevice(payload: { title?: string; stream?: Stream; media?: Record<string, unknown>; path?: string }) {
  const stream = payload.stream ?? (payload.path ? await api.librarySource(payload.path) : undefined);
  const prepared = await api.prepareDeviceDownload({ ...payload, stream });
  const link = document.createElement("a");
  link.href = prepared.url;
  link.download = prepared.filename;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  return prepared.filename;
}

/** The download has to be the log the viewer is looking at, filters and all. */
export const logDownloadUrl = (options: { tail?: number; level?: string; hours?: number; search?: string } = {}) => {
  const query = [
    options.tail ? `tail=${options.tail}` : "",
    options.level ? `level=${encodeURIComponent(options.level)}` : "",
    options.hours ? `hours=${options.hours}` : "",
    options.search ? `q=${encodeURIComponent(options.search)}` : "",
  ].filter(Boolean).join("&");
  return `/api/logs${query ? `?${query}` : ""}`;
};

export const subtitleUrl = (subtitleId: string, offset = 0, delay = 0) => {
  const query = [offset ? `offset=${offset.toFixed(3)}` : "", delay ? `delay=${delay.toFixed(2)}` : ""].filter(Boolean).join("&");
  return `/api/subtitle/${encodeURIComponent(subtitleId)}${query ? `?${query}` : ""}`;
};
