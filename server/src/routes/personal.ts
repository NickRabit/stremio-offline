import type express from "express";
import { allowedAddons } from "../addons.js";
import type { ArtShape } from "../artwork.js";
import { AppError } from "../errors.js";
import { favoriteIdentity, titleOfPath } from "../favorite-identity.js";
import {
  filterFavorites, mergeFavorites, parseFavoriteFilter, type FavoriteCatalogItem, type FavoriteEntry,
  type FavoriteEntryCatalog, type FavoriteEntryLibrary, type FavoriteItem, type FavoriteLibraryItem,
  type FavoriteRemoteItem,
} from "../favorites.js";
import type { RemoteHomeCard } from "../home.js";
import type { MediaServerAuthority } from "../media-server-manager.js";
import { CARD_LIMIT_MAX as REMOTE_FAVORITE_LIMIT, type MediaServerPersonal } from "../media-server-personal.js";
import { HOME_FORGET_LIMIT, HOME_RESUME_FILE_LIMIT, type ResumeIdentity } from "../home.js";
import { images } from "../images.js";
import { remoteArtworkPath } from "../media-server-types.js";
import { stableKeyOfFile, stableKeyOfRemote } from "../media-resources.js";
import { knownTitleEntry, type LibraryMetaRecord, type TitleUnit } from "../library-match.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import { isVideo, sortFiles, type BrowseItem, type BrowseMeta, type LibraryFile } from "../library.js";
import { libraryFor, libraryPath, libraryVisible, parseLibraryPath, posixBase, showsInContinueWatching, showsInFavorites, showsOnHome, type LibraryRecord, type Viewer } from "../libraries.js";
import { log } from "../logger.js";
import { remoteLibraryVisibleTo } from "../media-server-access.js";
import { markersOwingRow, nextEpisodeOf } from "../next-episode.js";
import { fileProgressKeys, newestProgress, titleProgressKey } from "../progress-identity.js";
import { groupSeriesProgress, seriesOf, type ProgressSeries } from "../progress-series.js";
import { groupResumeRows } from "../resume-group.js";
import { defaultSearchState, parseRecordBody, parseSearchPreferencesPatch, parseSearchState, publicSearchState, withRecorded, withoutQuery, type SearchState } from "../search-state.js";
import type { RemoteProgressWriter, StoredProgress, UserPrefs, WatchedMarker, WatchlistEntry } from "../store.js";
import type { MetaItem } from "../types.js";
import type { UserData } from "../users.js";
import { applyPatch, parseViews } from "../views.js";
import { asyncRoute, viewerOf, type RouteContext } from "./context.js";

/** The shape of the personal maps, pinned beside the endpoints that read and write them. */

export interface PersonalDeps extends RouteContext {
  attachBrowseMeta<T extends { path: string; kind: string; name?: string; label?: string }>(item: T, language: string): Promise<{ item: T; backfill: boolean }>;
  cachedMeta(type: string, id: string, language?: string, viewer?: Viewer): Promise<MetaItem | null>;
  dataOf(req: express.Request): UserData;
  describeLibraryPath(key: string, read?: { stale?: boolean }): Promise<BrowseItem | undefined>;
  libraryKey(value: string): string;
  libraryOfKey(key: string): { library: LibraryRecord; relative: string };
  /** The title units the library walk found, the same grouping the library listing resolves
   *  a file's identity through. */
  libraryUnits(): Promise<TitleUnit[]>;
  locateFileArtwork(key: string, shape?: ArtShape): Promise<string | undefined>;
  locateFolderArtworkPair(key: string): Promise<{ poster: string | undefined; wide: string | undefined }>;
  markersOf(data: UserData): Record<string, WatchedMarker>;
  metaStore: LibraryMetaStore;
  posterOf(value: unknown): string | undefined;
  prefsOf(req?: express.Request): UserPrefs;
  progressOf(data: UserData): Record<string, StoredProgress>;
  scheduleFileArtwork(key: string, shape?: ArtShape): void;
  scheduleFolderArtwork(key: string, shape?: ArtShape): void;
  setLibraryFavorite(relative: string, wanted: boolean, userId: string | undefined): Promise<void>;
  thumbUrl(param: "path" | "dir" | "key", value: string, art: string | undefined, shape?: ArtShape): Promise<string | undefined>;
  updateData(req: express.Request | undefined, mutate: (data: UserData) => void): Promise<void>;
  watchlistOf(data: UserData): Record<string, WatchlistEntry>;
  wirePath(key: string): string;
  /** The account's own verified media-server cards, read for the one merged Favourites list. */
  remotePersonal: MediaServerPersonal;
  /** The media-server authority for the request, built the way the media-server routes build it. */
  authorityOf(req: express.Request): MediaServerAuthority;
}

/** What `GET /api/progress` hands the interface: one row per show, already wire-keyed and
 *  with its poster proxied. `partial` is set for Home when a marker lookup timed out. */
export interface ProgressPageItem {
  key: string;
  position: number;
  duration: number;
  title: string;
  path?: string;
  poster?: string;
  addonKey?: string;
  series?: ProgressSeries;
  /** The source the stored position was played from, as the player named it. */
  stableKey?: string;
  /** The media-server version that wrote the row, while its library is the caller's. */
  remote?: RemoteProgressWriter;
  pending?: true;
  updatedAt: string;
}
export interface ProgressPage { items: ProgressPageItem[]; partial: boolean }

export interface ProgressRowOptions {
  /** Only the newest markers are looked up, so a big history cannot fan out on Home. */
  markerLimit?: number;
  /** Each lookup races this deadline; a miss leaves the marker alone and sets `partial`. */
  deadlineMs?: number;
  /** Drop stored rows whose addon the caller may not use. Home asks for this; the route does not. */
  addonFilter?: boolean;
  /** How many rows survive the cut. `Infinity` keeps every candidate for the caller to merge. */
  limit?: number;
}

export interface ResumeRowOptions {
  /** Drop stored rows whose library was switched off for Home. Home asks for this; the route
   *  keeps showing a library whose Home switch is off, because that switch is not its own. */
  onHome?: boolean;
  /** Home and the merged Continue watching route read candidates, not a page: they pass their
   *  own cut so the query's `skip`/`limit` (the merged list's) never reaches this list. */
  skip?: number;
  limit?: number;
}

/** One row of `GET /api/library/resume` as the handler serialises it, plus the title
 *  identity Home needs -- the handler strips it, exactly as it strips the show key today. */
export type ResumePageItem = LibraryFile & BrowseMeta & {
  kind: "file";
  favorite: boolean;
  progress: { position: number; duration: number };
  poster?: string;
  wide?: string;
  seriesKey?: string;
  identity?: ResumeIdentity;
  backfill?: boolean;
};
export interface ResumePage { items: ResumePageItem[]; total: number; pending: boolean }

export interface FavoritesOptions {
  filter?: ReturnType<typeof parseFavoriteFilter>;
  skip?: number;
  limit?: number;
  /** Home drops the library stars of a library switched off there, and the catalogue stars
   *  of an add-on switched off there. */
  onHome?: boolean;
  /** Whether this page reads the media server itself. Home's shelf mixes the local page with
   *  the remote cards on its own, so it asks for the local half alone. */
  remote?: boolean;
}
export interface FavoritesPage {
  items: FavoriteItem[];
  total: number;
  pending: boolean;
  /** A remote read that failed or could not confirm every library, with the local stars kept. */
  partial?: boolean;
}

/** The pieces `registerHomeRoutes` reads from the personal routes instead of reaching into
 *  the store itself, so exactly one place applies the permission rules. */
export interface PersonalApi {
  progressRows(req: express.Request, options?: ProgressRowOptions): Promise<ProgressPage>;
  libraryResumeItems(req: express.Request, options?: ResumeRowOptions): Promise<ResumePage>;
  favoritesPage(req: express.Request, options?: FavoritesOptions): Promise<FavoritesPage>;
  pathVisible(key: string, viewer: Viewer, libraries: LibraryRecord[]): boolean;
  /** The catalogue keys the account starred: a media-server record of one of them is that title,
   *  so a caller that draws the title itself leaves the record out. */
  watchlistKeys(req: express.Request): string[];
}

const LOOKUP_TIMEOUT = Symbol("home-lookup-timeout");

/** Races one promise against a deadline. `undefined` means there is no deadline. */
async function withDeadline<T>(work: Promise<T>, ms?: number): Promise<T | typeof LOOKUP_TIMEOUT> {
  if (ms === undefined || ms <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<typeof LOOKUP_TIMEOUT>((resolve) => { timer = setTimeout(() => resolve(LOOKUP_TIMEOUT), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}

export function registerPersonalRoutes(app: express.Application, deps: PersonalDeps): PersonalApi {
  const { store, currentUser, attachBrowseMeta, cachedMeta, dataOf, describeLibraryPath, libraryKey, libraryOfKey, libraryUnits, locateFileArtwork, locateFolderArtworkPair, markersOf, metaStore, posterOf, prefsOf, progressOf, scheduleFileArtwork, scheduleFolderArtwork, setLibraryFavorite, thumbUrl, updateData, watchlistOf, wirePath, remotePersonal, authorityOf } = deps;

  /** Whether the caller may see the library a stored path names. A path that names no
   *  library -- an unqualified row from before, or one whose library is gone -- is kept:
   *  the row is the caller's, and what they can no longer open drops out further down. */
  /** A key with no library id at all is the single-library pass-through and is left alone.
   *  A key that names a library which is no longer configured is a miss: treating it as
   *  visible sends it on to be described, and the describing falls back to whichever library
   *  is left -- so the row comes back showing a file from a library this account may never
   *  have been granted. */
  const pathVisible = (key: string, viewer: Viewer, libraries: LibraryRecord[]) => {
    const parsed = parseLibraryPath(key);
    if (!parsed) return true;
    const library = libraryFor(libraries, parsed.libraryId);
    return Boolean(library) && libraryVisible(library!, viewer);
  };

  // Starred catalogue titles. The key is type and id, because no file has to exist for them.
  app.get("/api/watchlist", (req, res) => {
    const all = watchlistOf(dataOf(req));
    res.json(Object.entries(all)
      .map(([key, value]) => ({ key, ...value, poster: images.proxied(value.poster) }))
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt)));
  });
  app.post("/api/watchlist", asyncRoute(async (req, res) => {
    const type = String(req.body.type ?? "movie");
    const id = String(req.body.id ?? "").trim();
    if (!id) throw new AppError("Missing title id.", "err.missingTitleId");
    const key = `${type}:${id}`;
    const wanted = Boolean(req.body.favorite);
    const addonKey = typeof req.body.addonKey === "string" ? req.body.addonKey.trim() : "";
    // One title wears one star: clearing the catalogue's own clears the library paths that stand
    // for it too, or the star would come straight back from the other side.
    const records = wanted ? {} : metaStore.qualifiedMeta();
    const units = wanted ? [] : await libraryUnits();
    const starredPaths: ReadonlySet<string> = new Set(wanted ? [] : (dataOf(req).favorites ?? [])
      .filter((path) => { const title = titleOfPath(path, records, units); return Boolean(title && `${title.type}:${title.id}` === key); }));
    await updateData(req, (data) => {
      const all = { ...watchlistOf(data) };
      if (wanted) all[key] = { type, id, name: String(req.body.name ?? id), poster: posterOf(req.body.poster), addedAt: new Date().toISOString(), ...(addonKey ? { addonKey } : {}) };
      else delete all[key];
      data.watchlist = all;
      if (starredPaths.size) data.favorites = data.favorites.filter((path) => !starredPaths.has(path));
      // The title's star is one: clearing it clears the media-server records that stand for it.
      if (!wanted) remotePersonal.clearTitleFavorites(data, key);
    });
    res.json({ key, favorite: wanted });
  }));

  // Browsing chrome: the sort, the filter and the layout each account left the library and the
  // download queue in. Personal, like the watchlist, and never part of the settings backup.
  app.get("/api/views", (req, res) => {
    res.json(parseViews(dataOf(req).views));
  });
  app.patch("/api/views", asyncRoute(async (req, res) => {
    // Patched inside the mutator, against the views as they are when this write's turn comes:
    // two quick changes (a sort, then a filter) both land instead of the second undoing the first.
    let next = parseViews(undefined);
    await updateData(req, (data) => { next = applyPatch(parseViews(data.views), req.body); data.views = next; });
    res.json(next);
  }));

  // Catalog search history and preferences, one account's own. Outside UserPrefs on purpose,
  // so the settings backup never carries them. Reads and writes happen inside the single
  // `updateData` mutator, so two requests cannot lose each other's append.
  app.get("/api/search/state", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(publicSearchState(parseSearchState(dataOf(req).search)));
  });
  app.patch("/api/search/preferences", asyncRoute(async (req, res) => {
    const patch = parseSearchPreferencesPatch(req.body);
    const now = Date.now();
    let written = defaultSearchState();
    await updateData(req, (data) => {
      const merged: SearchState = { ...parseSearchState(data.search, now), ...patch };
      if (!merged.saveHistory) merged.recent = [];
      data.search = merged;
      written = merged;
    });
    res.set("Cache-Control", "no-store").json(publicSearchState(written));
  }));
  app.post("/api/search/history", asyncRoute(async (req, res) => {
    const query = parseRecordBody(req.body);
    const now = Date.now();
    await updateData(req, (data) => {
      const current = parseSearchState(data.search, now);
      if (!current.saveHistory) return;
      data.search = withRecorded(current, query, now);
    });
    res.set("Cache-Control", "no-store").status(204).end();
  }));
  app.post("/api/search/history/forget", asyncRoute(async (req, res) => {
    const query = parseRecordBody(req.body);
    const now = Date.now();
    let written = defaultSearchState();
    await updateData(req, (data) => {
      const current = parseSearchState(data.search, now);
      const next = withoutQuery(current, query);
      data.search = next;
      written = next;
    });
    res.set("Cache-Control", "no-store").json(publicSearchState(written));
  }));
  app.delete("/api/search/history", asyncRoute(async (req, res) => {
    const now = Date.now();
    let written = defaultSearchState();
    await updateData(req, (data) => {
      const next: SearchState = { ...parseSearchState(data.search, now), recent: [] };
      data.search = next;
      written = next;
    });
    res.set("Cache-Control", "no-store").json(publicSearchState(written));
  }));

  // Resume list: the position is reported as it goes, and a finished title forgets itself.
  const PROGRESS_DONE = 0.94;
  /** The client speaks relative paths; a stored progress entry is keyed by the qualified
   *  one. A catalogue title key is not a path and travels untouched. */
  const storedProgressKey = (key: string) => key.startsWith("file:") ? `file:${libraryKey(key.slice(5))}` : key;
  const wireProgressKey = (key: string) => key.startsWith("file:") ? `file:${wirePath(key.slice(5))}` : key;
  // The reserved prefix of the per-account remote map. The generic progress map never holds
  // one, so a forged key is refused at the door and a read of one never returns a row.
  const isRemoteProgressKey = (key: string) => key.startsWith("remote:");
  /** The handle a source is stored by: the one shape `stableSourceKey` mints, and nothing else. */
  const STABLE_SOURCE_KEY = /^[mtfau]:[0-9a-f]{24}$/;
  /** The stored key a client key stands for: a bound file's `file:` key becomes its title key. */
  const resolveProgressKey = async (stored: string): Promise<{ key: string; file?: string; title?: ReturnType<typeof titleProgressKey> }> => {
    if (!stored.startsWith("file:")) return { key: stored };
    const file = stored.slice(5);
    // A key naming a library that is gone cannot be described; it stays its own file key, so the
    // row stored under it is still read, and removed, as it was before this change.
    const item = await describeLibraryPath(file, { stale: true }).catch(() => undefined);
    const listed = item?.kind === "file" ? { season: item.season, episode: item.episode } : undefined;
    const title = titleProgressKey(file, metaStore.qualifiedMeta(), await libraryUnits(), listed);
    return title ? { key: title.key, file, title } : { key: stored, file };
  };
  /** Whether the caller may still see the remote library the version that wrote a row belongs to. */
  const remoteWriterVisible = (writer: RemoteProgressWriter, req: express.Request): boolean => {
    const user = currentUser(req);
    if (!user) return false;
    const library = store.remoteLibraries().find((candidate) => candidate.id === writer.libraryId);
    return Boolean(library) && remoteLibraryVisibleTo(store.mediaConnections(), library!, user);
  };
  /** The title keys among the stored keys a write touches: forgetting one also forgets the
   *  media-server version's own position of that title. A `file:` key already resolved to its
   *  title key by then. */
  const forgottenTitles = (keys: Iterable<string>): Set<string> =>
    new Set([...keys].filter((key) => key.startsWith("movie:") || key.startsWith("series:")));
  /** Every legacy `file:` key in `all` whose file resolves to `titleKey`. The stored progress
   *  map is bounded at 60 rows, so the scan behind it is bounded too. */
  const legacyKeysFor = (all: Record<string, StoredProgress>, titleKey: string, records: Record<string, LibraryMetaRecord>, units: TitleUnit[]): string[] =>
    Object.keys(all).filter((key) => key.startsWith("file:") && titleProgressKey(key.slice(5), records, units)?.key === titleKey);
  /** Every stored key that stands for one resolved key: the key itself, the file the caller
   *  read it through, and the legacy `file:` rows whose file resolves to it. The rows naming the
   *  file are what a move that renumbers it needs: its title row keeps the key it was written
   *  with, and only its `path` follows the file. */
  const standingKeys = (
    resolved: { key: string; file?: string },
    all: Record<string, StoredProgress>,
    records: Record<string, LibraryMetaRecord>,
    units: TitleUnit[],
  ): string[] => [
    ...new Set([
      resolved.key,
      ...(resolved.file ? fileProgressKeys(all, resolved.file) : []),
      ...(resolved.key.startsWith("file:") ? [] : legacyKeysFor(all, resolved.key, records, units)),
    ]),
  ];
  /** The `series` field of a report: the body names the series, and whatever it leaves
   *  out the episode key fills in. An id that is not a non-empty string means no series. */
  const reportedSeries = (key: string, title: string, body: unknown): ProgressSeries | undefined => {
    const field = body && typeof body === "object" ? body as { id?: unknown; name?: unknown; season?: unknown; episode?: unknown } : {};
    const id = typeof field.id === "string" ? field.id.trim() : "";
    if (!id) return undefined;
    const derived = seriesOf(key, { title });
    const name = typeof field.name === "string" ? field.name.trim() : "";
    const season = Number(field.season), episode = Number(field.episode);
    return {
      id,
      name: name || derived?.name || title,
      season: Number.isFinite(season) ? season : derived?.season ?? 0,
      episode: Number.isFinite(episode) ? episode : derived?.episode ?? 0,
    };
  };
  /** The media-server version a report was played from, when it names a usable one: three
   *  non-empty ids, each short enough to be a stored value rather than a payload. */
  const reportedRemote = (body: unknown): RemoteProgressWriter | undefined => {
    const field = body && typeof body === "object" ? body as { libraryId?: unknown; itemId?: unknown; mediaSourceId?: unknown } : {};
    const id = (raw: unknown) => {
      const value = typeof raw === "string" ? raw.trim() : "";
      return value && value.length <= 256 ? value : undefined;
    };
    const libraryId = id(field.libraryId), itemId = id(field.itemId), mediaSourceId = id(field.mediaSourceId);
    return libraryId && itemId && mediaSourceId ? { libraryId, itemId, mediaSourceId } : undefined;
  };
  /** One row of Continue watching, either a stored position or the next episode a finished
   *  one left behind. */
  type ProgressRow = StoredProgress & { key: string; pending?: true };
  /** The body of `GET /api/progress`, shared with Home so both read the same markers and
   *  apply the same permission rules. The options are Home's work bounds. */
  const progressRows = async (req: express.Request, options: ProgressRowOptions = {}): Promise<ProgressPage> => {
    const data = dataOf(req);
    const all = progressOf(data);
    const viewer = viewerOf(currentUser(req));
    const libraries = store.libraries();
    // One row per series, whichever episode was watched last. The cut to 40 titles happens
    // after the markers have had their say, so a show does not spend the row on every episode.
    // A row whose file is in a library the caller has lost drops out here, the way it does
    // from the resume list: it is the same row, read through a different door.
    const grouped = groupSeriesProgress(Object.entries(all)
      .filter(([, value]) => !value.path || pathVisible(value.path, viewer, libraries))
      .filter(([key]) => !isRemoteProgressKey(key))
      .map(([key, value]) => ({ ...value, key })));
    const allowed = new Set(allowedAddons(store.addons(), viewer).map((addon) => addon.key));
    const shown = grouped.flatMap((row) => (row.series ? [row.series.id] : []));
    // A stored catalogue row from an addon the caller may not use is dropped; the marker of
    // the same show stays suppressed, so a dropped row does not reappear as its next episode.
    const rows = options.addonFilter ? grouped.filter((row) => !row.addonKey || allowed.has(row.addonKey)) : grouped;
    const over: string[] = [];
    const language = prefsOf(req).uiLanguage;
    // A marker remembers which addon the show came from. One the caller may no longer use
    // has no row here: showing it would offer a next episode from a source this account is
    // not allowed to ask, and finding that out by asking is itself the leak.
    const owing = markersOwingRow(markersOf(data), shown)
      .filter(([, marker]) => !marker.addonKey || allowed.has(marker.addonKey));
    const owed = options.markerLimit === undefined
      ? owing
      : [...owing].sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt) || a[0].localeCompare(b[0])).slice(0, options.markerLimit);
    let partial = false;
    const pending = await Promise.all(owed.map(async ([id, marker]): Promise<ProgressRow | undefined> => {
      // The six-hour cache answers most of these. An addon that stays quiet answers null,
      // which leaves the marker alone: one unreachable show must fail by itself.
      //
      // The viewer goes with it: without one the lookup merges every addon on the instance,
      // so a request for the next episode reaches addons this account was never given.
      const meta = await withDeadline(cachedMeta("series", id, language, viewer), options.deadlineMs);
      if (meta === LOOKUP_TIMEOUT) { partial = true; return undefined; }
      if (!meta) return undefined;
      const next = nextEpisodeOf(meta.videos, marker);
      if (!next) { over.push(id); return undefined; }
      return {
        key: `series:${id}:${next.season}:${next.episode}`,
        position: 0, duration: 0,
        title: next.name ? `${marker.name} · ${next.name}` : marker.name,
        poster: marker.poster, addonKey: marker.addonKey,
        series: { id, name: marker.name, season: next.season, episode: next.episode },
        pending: true,
        updatedAt: marker.updatedAt,
      };
    }));
    // A show that ran out of episodes leaves Continue watching for good.
    if (over.length) await updateData(req, (fresh) => {
      const markers = { ...markersOf(fresh) };
      for (const id of over) delete markers[id];
      fresh.watchedSeries = markers;
    });
    const items = [...rows, ...pending.filter((row) => row !== undefined)]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, options.limit ?? 40)
      .map((value) => {
        // The media-server version that wrote a row is named only while its library is the caller's.
        const remote = value.remote && remoteWriterVisible(value.remote, req) ? value.remote : undefined;
        // A row a media-server version wrote without a poster takes that item's own picture.
        const poster = images.proxied(value.poster) ?? (remote ? remoteArtworkPath(remote.libraryId, remote.itemId, "Primary") : undefined);
        // A row stored before every write named its source can claim a file it was not last
        // played from: the source key wins, and the stale file is not offered as the way back.
        const path = value.path && !(value.stableKey && value.stableKey !== stableKeyOfFile(value.path)) ? wirePath(value.path) : undefined;
        return { ...value, key: wireProgressKey(value.key), path, poster, remote };
      });
    return { items, partial };
  };
  app.get("/api/progress", asyncRoute(async (req, res) => {
    res.json((await progressRows(req)).items);
  }));
  app.get("/api/progress/:key", asyncRoute(async (req, res) => {
    const raw = String(req.params.key);
    if (isRemoteProgressKey(raw)) return void res.json(null);
    const all = progressOf(dataOf(req));
    const resolved = await resolveProgressKey(storedProgressKey(raw));
    // Every row that stands for the same title is a candidate: the title's own, the legacy
    // `file:` rows resolving to it, and the file this key names. The newest of them answers.
    const rows = standingKeys(resolved, all, metaStore.qualifiedMeta(), await libraryUnits())
      .filter((key) => all[key] !== undefined)
      .map((key): [string, StoredProgress] => [key, all[key]!]);
    const found = newestProgress(rows, resolved.key)?.[1];
    const visible = !found?.path || pathVisible(found.path, viewerOf(currentUser(req)), store.libraries());
    const stalePath = Boolean(found?.path && found.stableKey && found.stableKey !== stableKeyOfFile(found.path));
    const answer = found && visible ? { ...found, poster: images.proxied(found.poster), ...(stalePath ? { path: undefined } : {}) } : null;
    res.json(answer && answer.remote && !remoteWriterVisible(answer.remote, req) ? { ...answer, remote: undefined } : answer);
  }));
  app.post("/api/progress", asyncRoute(async (req, res) => {
    // With tracking switched off the position is written nowhere.
    if (!prefsOf(req).trackProgress) return res.status(204).end();
    const sent = storedProgressKey(String(req.body.key ?? "").trim());
    const position = Number(req.body.position) || 0;
    const duration = Number(req.body.duration) || 0;
    // The source the position was played from, when the player named one it was handed.
    const stableKey = typeof req.body.stableKey === "string" && STABLE_SOURCE_KEY.test(req.body.stableKey) ? req.body.stableKey : undefined;
    if (!sent) throw new AppError("Missing title key.", "err.missingTitleKey");
    if (isRemoteProgressKey(sent)) throw new AppError("The item was not found.", "err.itemNotFound", 404);
    // A bound file is stored as its title, so one title keeps one position. The rows the write
    // replaces are read before the mutator, which stays synchronous.
    const resolved = await resolveProgressKey(sent);
    const key = resolved.key;
    const records = metaStore.qualifiedMeta();
    const units = await libraryUnits();
    const legacy = key.startsWith("file:") ? [] : legacyKeysFor(progressOf(dataOf(req)), key, records, units);
    await updateData(req, (data) => {
      const all = { ...progressOf(data) };
      for (const legacyKey of legacy) delete all[legacyKey];
      if (resolved.file && resolved.title) delete all[`file:${resolved.file}`];
      const previous = all[key];
      const title = String(req.body.title ?? previous?.title ?? "Video");
      // A file the title was read from carries the title's own series row, never the player's
      // idea of one: the binding states the show, and the file names the episode of it.
      const boundSeries = resolved.title?.type === "series"
        ? {
          id: resolved.title.id,
          name: resolved.title.name || seriesOf(key, { title })?.name || title,
          season: resolved.title.season!, episode: resolved.title.episode!,
        }
        : previous?.series;
      // The writer is read from this body alone: a write that names no version stores none, so a
      // row a catalogue play overwrote never keeps claiming a media-server version.
      const writer = reportedRemote(req.body.remote);
      const filePath = req.body.path ? libraryKey(String(req.body.path)) : resolved.title ? resolved.file : undefined;
      // The source this position was played from: the one the player named, else the file or the
      // media-server version the write names. A write that names its source never inherits the
      // previous one, so a switch is always the row's new source, whichever client wrote it.
      const source = stableKey ?? (filePath ? stableKeyOfFile(filePath) : writer ? stableKeyOfRemote(writer) : undefined);
      const record: StoredProgress = {
        position, duration,
        title,
        // A write that names its source takes the path from this body alone, so a row that moved
        // to an addon answer stops claiming the library file it used to be played from.
        path: source ? filePath : previous?.path,
        poster: posterOf(req.body.poster) ?? previous?.poster,
        addonKey: typeof req.body.addonKey === "string" ? req.body.addonKey : previous?.addonKey,
        series: reportedSeries(key, title, req.body.series) ?? boundSeries,
        ...(writer ? { remote: writer } : {}),
        ...(source ? { stableKey: source } : previous?.stableKey ? { stableKey: previous.stableKey } : {}),
        updatedAt: new Date().toISOString(),
      };
      const series = seriesOf(key, record);
      const markers = { ...markersOf(data) };
      // Any report beats the marker of the show it belongs to, so the next episode of a
      // finished one never stands beside the episode being watched now.
      if (series) delete markers[series.id];
      // Neither an almost-finished title nor the very beginning is worth keeping. A finished
      // episode leaves the show's next one behind instead of nothing at all.
      const finished = duration > 0 && position / duration > PROGRESS_DONE;
      if (finished || (duration > 0 && position < 30)) {
        delete all[key];
        if (finished && series) markers[series.id] = {
          name: series.name, poster: record.poster, addonKey: record.addonKey,
          season: series.season, episode: series.episode, updatedAt: record.updatedAt,
        };
      } else all[key] = record;
      // The list must not grow without bound.
      const keys = Object.keys(all).sort((a, b) => all[b]!.updatedAt.localeCompare(all[a]!.updatedAt));
      data.progress = Object.fromEntries(keys.slice(0, 60).map((item) => [item, all[item]!]));
      const markerIds = Object.keys(markers).sort((a, b) => markers[b]!.updatedAt.localeCompare(markers[a]!.updatedAt));
      data.watchedSeries = Object.fromEntries(markerIds.slice(0, 60).map((id) => [id, markers[id]!]));
    });
    res.status(204).end();
  }));
  app.delete("/api/progress", asyncRoute(async (req, res) => {
    await updateData(req, (data) => { data.progress = {}; data.watchedSeries = {}; });
    log("INFO", "Watch history cleared");
    res.status(204).end();
  }));
  app.delete("/api/progress/:key", asyncRoute(async (req, res) => {
    if (isRemoteProgressKey(String(req.params.key))) return void res.status(404).end();
    const resolved = await resolveProgressKey(storedProgressKey(String(req.params.key)));
    const keys = standingKeys(resolved, progressOf(dataOf(req)), metaStore.qualifiedMeta(), await libraryUnits());
    await updateData(req, (data) => {
      const all = { ...progressOf(data) };
      const markers = { ...markersOf(data) };
      // Forgetting either key forgets the title: every row standing for it goes, and every
      // key deleted takes the marker of the show it names with it.
      for (const key of keys) {
        const removed = all[key];
        delete all[key];
        const series = seriesOf(key, { title: removed?.title ?? "", series: removed?.series });
        if (series) delete markers[series.id];
      }
      data.progress = all;
      data.watchedSeries = markers;
    });
    const titles = forgottenTitles(keys);
    if (titles.size) await remotePersonal.forgetTitlePositions(currentUser(req)?.id, titles);
    res.status(204).end();
  }));
  /** Forgetting a merged Home card forgets every key it stands for, and the marker of any
   *  show it implies, in one owner-scoped write. */
  app.post("/api/progress/forget", asyncRoute(async (req, res) => {
    const raw = (req.body ?? {}) as { keys?: unknown };
    if (!Array.isArray(raw.keys)) throw new AppError("The forget request names no keys.", "err.invalidRequest");
    if (raw.keys.length > HOME_FORGET_LIMIT) throw new AppError("Too many keys to forget at once.", "err.invalidRequest");
    const sent = raw.keys.map((key) => storedProgressKey(String(key))).filter((key) => !isRemoteProgressKey(key));
    if (!sent.length) return res.status(204).end();
    const records = metaStore.qualifiedMeta();
    const units = await libraryUnits();
    const all = progressOf(dataOf(req));
    const resolved = await Promise.all(sent.map((key) => resolveProgressKey(key)));
    const keys = [...new Set(resolved.flatMap((entry) => standingKeys(entry, all, records, units)))];
    await updateData(req, (data) => {
      const stored = { ...progressOf(data) };
      const markers = { ...markersOf(data) };
      for (const key of keys) {
        const removed = stored[key];
        delete stored[key];
        const series = seriesOf(key, { title: removed?.title ?? "", series: removed?.series });
        if (series) delete markers[series.id];
      }
      data.progress = stored;
      data.watchedSeries = markers;
    });
    const titles = forgottenTitles(keys);
    if (titles.size) await remotePersonal.forgetTitlePositions(currentUser(req)?.id, titles);
    res.status(204).end();
  }));

  app.post("/api/library/favorite", asyncRoute(async (req, res) => {
    const relative = String(req.body.path ?? "").trim();
    const wanted = Boolean(req.body.favorite);
    await setLibraryFavorite(relative, wanted, currentUser(req)?.id);
    res.json({ path: relative, favorite: wanted });
  }));

  /** A library star drawn on Home belongs to a library that is switched on and reachable,
   *  the same two switches Home reads everywhere else. */
  const onHomePath = (key: string, libraries: LibraryRecord[]): boolean => {
    const parsed = parseLibraryPath(key);
    if (!parsed) return true;
    const library = libraryFor(libraries, parsed.libraryId);
    if (!library) return true;
    return library.enabled && !library.unreachable;
  };

  /** The merged Favourites list, ordered and permission-filtered but not yet described.
   *  Order: the account's own library stars first, newest star first by the stored order
   *  (a library star carries no time of its own and the storage stays as it is), then the
   *  catalogue stars with no local copy, newest `addedAt` first. */
  const favoritesEntries = async (req: express.Request, options: FavoritesOptions): Promise<FavoriteEntry[]> => {
    const data = dataOf(req);
    const viewer = viewerOf(currentUser(req));
    const libraries = store.libraries();
    const records = metaStore.qualifiedMeta();
    const units = await libraryUnits();
    const onHome = (key: string) => !options.onHome || (showsOnHome(key, libraries) && onHomePath(key, libraries));
    const visible = (key: string) =>
      pathVisible(key, viewer, libraries) && showsInFavorites(key, libraries) && onHome(key);

    // Every identified copy the account may see, so a catalogue star can fold onto the local
    // one. Two copies of a title answer with the shortest path, then the first by name, so
    // the same copy wins on every request.
    const boundByImdb = new Map<string, string>();
    for (const [key, record] of Object.entries(records)) {
      if (!record.id || record.unmatched || !visible(key)) continue;
      const identity = `${record.type}:${record.id}`;
      const previous = boundByImdb.get(identity);
      if (previous === undefined || key.length < previous.length || (key.length === previous.length && key < previous)) {
        boundByImdb.set(identity, key);
      }
    }

    // The stored array is oldest first, so reversing it is the library's newest first.
    const starred = data.favorites.filter(visible).reverse();

    const library: FavoriteEntryLibrary[] = [];
    /** The card already drawn for a path, and the card that stands for one identity. */
    const drawn = new Map<string, FavoriteEntryLibrary>();
    const owner = new Map<string, FavoriteEntryLibrary>();
    for (const key of starred) {
      const known = favoriteIdentity(key, records, units);
      const target = known?.key ?? key;
      // A newer star of the same title already drew this card.
      if (drawn.has(target)) continue;
      const title = titleOfPath(key, records, units);
      const entry: FavoriteEntryLibrary = { kind: "library", key: target, ...(title ? { title: { type: title.type, id: title.id } } : {}) };
      drawn.set(target, entry);
      if (known?.record.id) owner.set(`${known.record.type}:${known.record.id}`, entry);
      library.push(entry);
    }

    const catalog: FavoriteEntryCatalog[] = [];
    const addons = store.addons();
    const watchlist = Object.entries(watchlistOf(data))
      .map(([key, value]) => ({ key, ...value }))
      .filter((entry) => Boolean(entry.id))
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt) || a.key.localeCompare(b.key));
    for (const entry of watchlist) {
      const identity = `${entry.type}:${entry.id}`;
      // Starred in the library too: the library card becomes this catalogue star too.
      const starredCopy = owner.get(identity);
      if (starredCopy) { starredCopy.catalogId = entry.id; continue; }
      // Home leaves out a title starred from an add-on switched off there; an entry that never
      // recorded its add-on stays.
      if (options.onHome && entry.addonKey && addons.find((addon) => addon.key === entry.addonKey)?.showOnHome === false) continue;
      // Downloaded and identified: the account opens the local copy rather than the add-on.
      // The binding is looked up by the entry's own kind, never across kinds.
      const bound = boundByImdb.get(identity);
      if (bound !== undefined && !drawn.has(bound)) {
        const title = titleOfPath(bound, records, units);
        const card: FavoriteEntryLibrary = { kind: "library", key: bound, catalogId: entry.id, ...(title ? { title: { type: title.type, id: title.id } } : {}) };
        drawn.set(bound, card);
        owner.set(identity, card);
        library.push(card);
        continue;
      }
      catalog.push({
        kind: "catalog", type: entry.type, id: entry.id, name: entry.name,
        ...(entry.poster ? { poster: entry.poster } : {}),
      });
    }

    return filterFavorites(mergeFavorites(library, catalog), options.filter ?? "all");
  };

  const describeFavorite = async (req: express.Request, entry: FavoriteEntry): Promise<FavoriteItem | undefined> => {
    if (entry.kind === "catalog") {
      const poster = entry.poster ? images.proxied(entry.poster) : undefined;
      return { kind: "catalog", type: entry.type, id: entry.id, name: entry.name, ...(poster ? { poster } : {}) } satisfies FavoriteCatalogItem;
    }
    const item = await describeLibraryPath(entry.key, { stale: true });
    if (!item) return undefined;
    const key = libraryKey(entry.key);
    const { poster: art, wide } = item.kind === "folder"
      ? await locateFolderArtworkPair(key)
      : { poster: await locateFileArtwork(key), wide: await locateFileArtwork(key, "wide") };
    if (!art) (item.kind === "folder" ? scheduleFolderArtwork : scheduleFileArtwork)(key);
    if (!wide) (item.kind === "folder" ? scheduleFolderArtwork : scheduleFileArtwork)(key, "wide");
    const wire = wirePath(key);
    const poster = await thumbUrl(item.kind === "folder" ? "dir" : "path", wire, art);
    const wideUrl = await thumbUrl(item.kind === "folder" ? "dir" : "path", wire, wide, "wide");
    const records = metaStore.qualifiedMeta();
    const record = records[key];
    // A starred file draws the position of the title it is bound to, wherever that row sits.
    const all = progressOf(dataOf(req));
    const resolved = await resolveProgressKey(`file:${key}`);
    const units = await libraryUnits();
    const rows = standingKeys(resolved, all, records, units)
      .filter((stored) => all[stored] !== undefined)
      .map((stored): [string, StoredProgress] => [stored, all[stored]!]);
    const stored = newestProgress(rows, resolved.key)?.[1];
    const progress = stored && stored.duration > 0 ? { position: stored.position, duration: stored.duration } : undefined;
    // A copy that stands for a title is named as the title, never by its folder or file name.
    const titleName = entry.title ? favoriteIdentity(key, records, units)?.record.name : undefined;
    return {
      kind: "library", path: wire,
      label: titleName || (item.kind === "folder" ? item.name : item.label),
      ...(poster ? { poster } : {}),
      ...(wideUrl ? { wide: wideUrl } : {}),
      ...(record?.year ? { year: record.year } : {}),
      itemKind: item.kind,
      ...(progress ? { progress } : {}),
      ...(entry.catalogId ? { catalogId: entry.catalogId } : {}),
      // The copy stands for a title: the card opens that title's detail, not the file.
      ...(entry.title ? { title: entry.title } : {}),
    } satisfies FavoriteLibraryItem;
  };

  /** One remote card as the Favourites grid shows it: the library it belongs to and the item its
   *  own detail opens, never a token, a stream address or a user id. */
  const favoriteRemoteItem = (card: RemoteHomeCard): FavoriteRemoteItem => ({
    kind: "remote",
    libraryId: card.libraryId,
    itemId: card.itemId,
    title: card.title,
    provider: card.provider,
    libraryName: card.libraryName,
    itemType: card.itemType,
    ...(card.poster ? { poster: card.poster } : {}),
    ...(card.wide ? { wide: card.wide } : {}),
    ...(card.season === undefined ? {} : { season: card.season }),
    ...(card.episode === undefined ? {} : { episode: card.episode }),
  });

  /** The stars a media server holds. A library that cannot be confirmed, or a projection that
   *  no longer stands, leaves the answer partial instead of failing it or blocking the local
   *  stars, so the one list is never emptied by a server that is slow or down. */
  const remoteFavorites = async (req: express.Request, skip: number, limit: number, onHome: boolean, excludeTitles?: ReadonlySet<string>):
    Promise<{ items: FavoriteRemoteItem[]; total: number; partial: boolean } | undefined> => {
    try {
      const authority = authorityOf(req);
      const cards = await remotePersonal.cards(authority, {
        filter: "favorites", skip, limit,
        ...(onHome ? { onHome: true } : {}),
        ...(excludeTitles?.size ? { excludeTitles } : {}),
      });
      remotePersonal.assertCardsCurrent(authority, cards);
      return { items: cards.items.map(favoriteRemoteItem), total: cards.total, partial: cards.partial === true };
    } catch { return undefined; }
  };

  const favoritesPage = async (req: express.Request, options: FavoritesOptions = {}): Promise<FavoritesPage> => {
    const filter = options.filter ?? "all";
    const skip = Math.max(0, options.skip ?? 0);
    const limit = Math.max(1, Math.min(120, options.limit ?? 60));
    // The titles the account starred: the local half draws them, so a media-server record of one
    // of them is not drawn a second time.
    const starredTitles = new Set(Object.keys(watchlistOf(dataOf(req))));
    if (filter === "remote") {
      const remote = await remoteFavorites(req, skip, limit, options.onHome === true, starredTitles);
      return remote
        ? { items: remote.items, total: remote.total, pending: false, ...(remote.partial ? { partial: true } : {}) }
        : { items: [], total: 0, pending: false, partial: true };
    }
    // The two title filters read the media server's own stars too: one call for every card, kept
    // by the kind of item, and merged with the local half the way `all` merges them.
    if (filter === "movies" || filter === "series") {
      const wanted = filter === "movies" ? "movie" : "series";
      const entries = await favoritesEntries(req, options);
      const local = await Promise.all(entries.map((entry) => describeFavorite(req, entry)));
      const described = local.filter((item): item is FavoriteItem => item !== undefined);
      const remote = await remoteFavorites(req, 0, REMOTE_FAVORITE_LIMIT, options.onHome === true, starredTitles);
      const remoteItems = (remote?.items ?? []).filter((item) =>
        wanted === "movie" ? item.itemType === "movie" : item.itemType === "series" || item.itemType === "episode");
      const merged = [...described, ...remoteItems];
      return {
        items: merged.slice(skip, skip + limit),
        total: described.length + remoteItems.length,
        pending: described.some((item) => item.kind === "library" && (!item.poster || !item.wide)),
        ...(remote === undefined ? { partial: true } : {}),
      };
    }
    const entries = await favoritesEntries(req, options);
    // Every entry is described before the slice, so `total` counts only what can be returned:
    // a key the disk no longer answers cannot make a page repeat or stall the "load more".
    const local = (await Promise.all(entries.map((entry) => describeFavorite(req, entry))))
      .filter((item): item is FavoriteItem => item !== undefined);
    const pendingIn = (items: FavoriteItem[]) => items.some((item) => item.kind === "library" && (!item.poster || !item.wide));
    if (filter !== "all" || options.remote === false) {
      const items = local.slice(skip, skip + limit);
      return { items, total: local.length, pending: pendingIn(items) };
    }
    // The local stars lead the page and the media server's fill what is left of it. The remote
    // slice starts past the local entries the request already asked for, so a page boundary
    // never repeats a card or drops the local tail; a page the local half already fills asks
    // the server for one row alone, which is enough for `total`.
    const page = local.slice(skip, skip + limit);
    const remote = await remoteFavorites(req, Math.max(0, skip - local.length), page.length < limit ? limit : 1, options.onHome === true, starredTitles);
    if (!remote) return { items: page, total: local.length, pending: pendingIn(page), partial: true };
    const items = [...page, ...remote.items.slice(0, Math.max(0, limit - page.length))];
    return { items, total: local.length + remote.total, pending: pendingIn(items), ...(remote.partial ? { partial: true } : {}) };
  };
  /** One Favourites list for every signed-in account: its own library stars first (newest
   *  star first by the stored order, because a library star carries no time) and then the
   *  catalogue stars with no local copy (newest `addedAt` first). A catalogue star whose
   *  identified local copy exists folds into that copy, which then answers both filters. */
  app.get("/api/favorites", asyncRoute(async (req, res) => {
    res.json(await favoritesPage(req, {
      filter: parseFavoriteFilter(req.query.filter),
      skip: Math.max(0, Number(req.query.skip) || 0),
      limit: Math.max(1, Math.min(120, Number(req.query.limit) || 60)),
    }));
  }));

  const libraryResumeItems = async (req: express.Request, options: ResumeRowOptions = {}): Promise<ResumePage> => {
    const data = dataOf(req);
    const favorites = new Set(data.favorites);
    const query = String(req.query.query ?? "").trim().toLocaleLowerCase();
    const viewer = viewerOf(currentUser(req));
    const libraries = store.libraries();
    const records = metaStore.qualifiedMeta();
    const units = await libraryUnits();
    // A bound file's position is stored under its title, with the file as the row's `path`: that
    // row is still the file's own, so the library lists it as long as the file stands for it.
    const entries = Object.entries(progressOf(data)).filter(([key, entry]) =>
      (key.startsWith("file:") || (Boolean(entry.path) && isVideo(posixBase(entry.path!))))
      && Boolean(entry.path) && showsInContinueWatching(entry.path!, libraries)
      && (!options.onHome || showsOnHome(entry.path!, libraries)) && pathVisible(entry.path!, viewer, libraries));
    const described = await Promise.all(entries.map(async ([stored, entry]) => {
      const item = await describeLibraryPath(entry.path!);
      if (!item || item.kind !== "file") return [];
      if (!stored.startsWith("file:")
        && titleProgressKey(entry.path!, records, units, { season: item.season, episode: item.episode })?.key !== stored) return [];
      // `describePath` answers library-relative, and the row already knows which library it
      // came from. Qualifying it through the single-library shim instead asks an install with
      // two of them a question it cannot answer, and the whole resume row returns 400.
      const libraryId = libraryOfKey(entry.path!).library.id;
      const key = libraryPath(libraryId, item.path);
      // The binding sits on the show's folder, so two season folders of one show answer with the
      // same key and the grouping below turns them into a single tile.
      const bound = knownTitleEntry(libraryKey(key), records);
      const series = bound?.record.type === "series" ? { key: bound.key, id: bound.record.id, name: bound.record.name } : undefined;
      // A film gets no series key: that grouping would fold two films sharing a folder into one.
      const identity: ResumeIdentity | undefined = series
        ? { type: "series", id: series.id }
        : bound?.record.type === "movie" ? { type: "movie", id: bound.record.id } : undefined;
      return [{ ...item, path: wirePath(key), label: entry.title || item.label, modified: entry.updatedAt,
        progress: { position: entry.position, duration: entry.duration }, favorite: favorites.has(key),
        seriesKey: series?.key,
        ...(identity ? { identity } : {}),
        ...(series?.name ? { series: { name: series.name } } : {}) }];
    }));
    // One tile per show before the filters, the sort and the slice, so `total` and the paging
    // both count what the interface can open.
    const items = groupResumeRows(described.flat())
      .filter((item) => (!query || item.label.toLocaleLowerCase().includes(query)) && (req.query.favorites !== "1" || item.favorite));
    const sorts = new Set(["name", "added", "size", "random"]);
    const sort = sorts.has(String(req.query.sort)) ? String(req.query.sort) as "name" : "added";
    const ordered = sortFiles(items, sort, req.query.order !== "asc", String(req.query.seed ?? ""));
    const skip = Math.max(0, options.skip ?? (Number(req.query.skip) || 0));
    // The public `/api/library/resume` ceiling is 120; an internal caller may hand the merge
    // every file candidate it asked for, so the merged list can page past that bound.
    const limit = options.limit !== undefined
      ? Math.max(1, Math.min(HOME_RESUME_FILE_LIMIT, options.limit))
      : Math.max(1, Math.min(120, Number(req.query.limit) || 60));
    const page = await Promise.all(ordered.slice(skip, skip + limit).map(async (item) => {
      const key = libraryKey(item.path);
      const art = await locateFileArtwork(key);
      if (!art) scheduleFileArtwork(key);
      const wide = await locateFileArtwork(key, "wide");
      if (!wide) scheduleFileArtwork(key, "wide");
      const { item: withMeta, backfill } = await attachBrowseMeta(item, prefsOf(req).uiLanguage);
      return { ...withMeta, poster: await thumbUrl("path", item.path, art), wide: await thumbUrl("path", item.path, wide, "wide"), backfill };
    }));
    return { items: page, total: ordered.length, pending: page.some((item) => !item.poster || !item.wide || item.backfill) };
  };
  app.get("/api/library/resume", asyncRoute(async (req, res) => {
    const result = await libraryResumeItems(req);
    res.json({ path: ":resume", items: result.items.map(({ backfill: _backfill, seriesKey: _seriesKey, identity: _identity, ...item }) => item), total: result.total, pending: result.pending });
  }));

  app.get("/api/library/favorites", asyncRoute(async (req, res) => {
    const sorts = new Set(["name", "added", "size", "random"]);
    const sort = sorts.has(String(req.query.sort)) ? String(req.query.sort) as "name" : "name";
    const viewer = viewerOf(currentUser(req));
    const libraries = store.libraries();
    const described = await Promise.all(dataOf(req).favorites.filter((stored) => pathVisible(stored, viewer, libraries) && showsInFavorites(stored, libraries)).map(async (stored) => {
      const item = await describeLibraryPath(stored, { stale: true });
      return item && { ...item, path: wirePath(libraryKey(stored)) };
    }));
    // Paths that disappeared meanwhile are skipped but not dropped from the list:
    // the disk may be temporarily unavailable, and losing favourites over that is worse.
    const present = described.filter(Boolean) as NonNullable<typeof described[number]>[];
    const mixed = present.map((item) => ({
      ...item, label: item.kind === "folder" ? item.name : item.label,
    }));
    const ordered = sortFiles(mixed, sort, req.query.order === "desc", String(req.query.seed ?? ""));
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 60));
    const page = await Promise.all(ordered.slice(skip, skip + limit).map(async (item) => {
      const key = libraryKey(item.path);
      const { poster: art, wide } = item.kind === "folder"
        ? await locateFolderArtworkPair(key)
        : { poster: await locateFileArtwork(key), wide: await locateFileArtwork(key, "wide") };
      if (!art) (item.kind === "folder" ? scheduleFolderArtwork : scheduleFileArtwork)(key);
      if (!wide) (item.kind === "folder" ? scheduleFolderArtwork : scheduleFileArtwork)(key, "wide");
      const poster = await thumbUrl(item.kind === "folder" ? "dir" : "path", item.path, art);
      const wideUrl = await thumbUrl(item.kind === "folder" ? "dir" : "path", item.path, wide, "wide");
      const { item: withMeta, backfill } = await attachBrowseMeta(item, prefsOf(req).uiLanguage);
      return { ...withMeta, favorite: true, poster, wide: wideUrl, backfill };
    }));
    res.json({ path: ":favorites", items: page.map(({ backfill: _backfill, ...item }) => item), total: ordered.length, pending: page.some((item) => !item.poster || !item.wide || item.backfill) });
  }));

  return { progressRows, libraryResumeItems, favoritesPage, pathVisible, watchlistKeys: (req) => Object.keys(watchlistOf(dataOf(req))) };
}
