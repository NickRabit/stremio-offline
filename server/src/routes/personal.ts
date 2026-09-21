import type express from "express";
import { allowedAddons } from "../addons.js";
import type { ArtShape } from "../artwork.js";
import { AppError } from "../errors.js";
import { images } from "../images.js";
import { knownTitleEntry } from "../library-match.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import { sortFiles, type BrowseItem } from "../library.js";
import { libraryFor, libraryPath, libraryVisible, parseLibraryPath, showsInContinueWatching, type LibraryRecord, type Viewer } from "../libraries.js";
import { log } from "../logger.js";
import { markersOwingRow, nextEpisodeOf } from "../next-episode.js";
import { groupSeriesProgress, seriesOf, type ProgressSeries } from "../progress-series.js";
import { groupResumeRows } from "../resume-group.js";
import type { StoredProgress, UserPrefs, WatchedMarker, WatchlistEntry } from "../store.js";
import type { MetaItem } from "../types.js";
import type { UserData } from "../users.js";
import { applyPatch, parseViews } from "../views.js";
import { asyncRoute, viewerOf, type RouteContext } from "./context.js";

/** The shape of the personal maps, pinned beside the endpoints that read and write them. */

export interface PersonalDeps extends RouteContext {
  attachBrowseMeta<T extends { path: string; kind: string; name?: string; label?: string }>(item: T, language: string): { item: T; backfill: boolean };
  cachedMeta(type: string, id: string, language?: string, viewer?: Viewer): Promise<MetaItem | null>;
  dataOf(req: express.Request): UserData;
  describeLibraryPath(key: string): Promise<BrowseItem | undefined>;
  libraryKey(value: string): string;
  libraryOfKey(key: string): { library: LibraryRecord; relative: string };
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
}

export function registerPersonalRoutes(app: express.Application, deps: PersonalDeps): void {
  const { store, currentUser, attachBrowseMeta, cachedMeta, dataOf, describeLibraryPath, libraryKey, libraryOfKey, locateFileArtwork, locateFolderArtworkPair, markersOf, metaStore, posterOf, prefsOf, progressOf, scheduleFileArtwork, scheduleFolderArtwork, setLibraryFavorite, thumbUrl, updateData, watchlistOf, wirePath } = deps;

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
    await updateData(req, (data) => {
      const all = { ...watchlistOf(data) };
      if (wanted) all[key] = { type, id, name: String(req.body.name ?? id), poster: posterOf(req.body.poster), addedAt: new Date().toISOString() };
      else delete all[key];
      data.watchlist = all;
    });
    res.json({ key, favorite: wanted });
  }));

  // Browsing chrome: the sort, the filter and the layout each account left the library and the
  // download queue in. Personal, like the watchlist, and never part of the settings backup.
  app.get("/api/views", (req, res) => {
    res.json(parseViews(dataOf(req).views));
  });
  app.patch("/api/views", asyncRoute(async (req, res) => {
    const next = applyPatch(parseViews(dataOf(req).views), req.body);
    await updateData(req, (data) => { data.views = next; });
    res.json(next);
  }));

  // Resume list: the position is reported as it goes, and a finished title forgets itself.
  const PROGRESS_DONE = 0.94;
  /** The client speaks relative paths; a stored progress entry is keyed by the qualified
   *  one. A catalogue title key is not a path and travels untouched. */
  const storedProgressKey = (key: string) => key.startsWith("file:") ? `file:${libraryKey(key.slice(5))}` : key;
  const wireProgressKey = (key: string) => key.startsWith("file:") ? `file:${wirePath(key.slice(5))}` : key;
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
  /** One row of Continue watching, either a stored position or the next episode a finished
   *  one left behind. */
  type ProgressRow = StoredProgress & { key: string; pending?: true };
  app.get("/api/progress", asyncRoute(async (req, res) => {
    const data = dataOf(req);
    const all = progressOf(data);
    const viewer = viewerOf(currentUser(req));
    const libraries = store.libraries();
    // One row per series, whichever episode was watched last. The cut to 40 titles happens
    // after the markers have had their say, so a show does not spend the row on every episode.
    // A row whose file is in a library the caller has lost drops out here, the way it does
    // from the resume list: it is the same row, read through a different door.
    const rows = groupSeriesProgress(Object.entries(all)
      .filter(([, value]) => !value.path || pathVisible(value.path, viewer, libraries))
      .map(([key, value]) => ({ ...value, key })));
    const shown = rows.flatMap((row) => (row.series ? [row.series.id] : []));
    const over: string[] = [];
    const language = prefsOf(req).uiLanguage;
    const allowed = new Set(allowedAddons(store.addons(), viewer).map((addon) => addon.key));
    // A marker remembers which addon the show came from. One the caller may no longer use
    // has no row here: showing it would offer a next episode from a source this account is
    // not allowed to ask, and finding that out by asking is itself the leak.
    const owed = markersOwingRow(markersOf(data), shown)
      .filter(([, marker]) => !marker.addonKey || allowed.has(marker.addonKey));
    const pending = await Promise.all(owed.map(async ([id, marker]): Promise<ProgressRow | undefined> => {
      // The six-hour cache answers most of these. An addon that stays quiet answers null,
      // which leaves the marker alone: one unreachable show must fail by itself.
      //
      // The viewer goes with it: without one the lookup merges every addon on the instance,
      // so a request for the next episode reaches addons this account was never given.
      const meta = await cachedMeta("series", id, language, viewer);
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
      .slice(0, 40)
      .map((value) => ({ ...value, key: wireProgressKey(value.key), path: value.path ? wirePath(value.path) : value.path, poster: images.proxied(value.poster) }));
    res.json(items);
  }));
  app.get("/api/progress/:key", (req, res) => {
    const found = progressOf(dataOf(req))[storedProgressKey(String(req.params.key))];
    const visible = !found?.path || pathVisible(found.path, viewerOf(currentUser(req)), store.libraries());
    res.json(found && visible ? { ...found, poster: images.proxied(found.poster) } : null);
  });
  app.post("/api/progress", asyncRoute(async (req, res) => {
    // With tracking switched off the position is written nowhere.
    if (!prefsOf(req).trackProgress) return res.status(204).end();
    const key = storedProgressKey(String(req.body.key ?? "").trim());
    const position = Number(req.body.position) || 0;
    const duration = Number(req.body.duration) || 0;
    if (!key) throw new AppError("Missing title key.", "err.missingTitleKey");
    await updateData(req, (data) => {
      const all = { ...progressOf(data) };
      const previous = all[key];
      const title = String(req.body.title ?? previous?.title ?? "Video");
      const record: StoredProgress = {
        position, duration,
        title,
        path: req.body.path ? libraryKey(String(req.body.path)) : previous?.path,
        poster: posterOf(req.body.poster) ?? previous?.poster,
        addonKey: typeof req.body.addonKey === "string" ? req.body.addonKey : previous?.addonKey,
        series: reportedSeries(key, title, req.body.series) ?? previous?.series,
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
    await updateData(req, (data) => {
      const key = storedProgressKey(String(req.params.key));
      const all = { ...progressOf(data) };
      const removed = all[key];
      delete all[key];
      data.progress = all;
      // The row a finished episode leaves behind is not stored, so forgetting that row has
      // to forget the marker that draws it.
      const series = seriesOf(key, { title: removed?.title ?? "", series: removed?.series });
      if (series) {
        const markers = { ...markersOf(data) };
        delete markers[series.id];
        data.watchedSeries = markers;
      }
    });
    res.status(204).end();
  }));

  app.post("/api/library/favorite", asyncRoute(async (req, res) => {
    const relative = String(req.body.path ?? "").trim();
    const wanted = Boolean(req.body.favorite);
    await setLibraryFavorite(relative, wanted, currentUser(req)?.id);
    res.json({ path: relative, favorite: wanted });
  }));

  app.get("/api/library/resume", asyncRoute(async (req, res) => {
    const data = dataOf(req);
    const favorites = new Set(data.favorites);
    const query = String(req.query.query ?? "").trim().toLocaleLowerCase();
    const viewer = viewerOf(currentUser(req));
    const libraries = store.libraries();
    const records = metaStore.qualifiedMeta();
    const entries = Object.entries(progressOf(data)).filter(([key, entry]) =>
      key.startsWith("file:") && Boolean(entry.path) && showsInContinueWatching(entry.path!, libraries) && pathVisible(entry.path!, viewer, libraries));
    const described = await Promise.all(entries.map(async ([, entry]) => {
      const item = await describeLibraryPath(entry.path!);
      if (!item || item.kind !== "file") return [];
      // `describePath` answers library-relative, and the row already knows which library it
      // came from. Qualifying it through the single-library shim instead asks an install with
      // two of them a question it cannot answer, and the whole resume row returns 400.
      const libraryId = libraryOfKey(entry.path!).library.id;
      const key = libraryPath(libraryId, item.path);
      // The binding sits on the show's folder, so two season folders of one show answer with the
      // same key and the grouping below turns them into a single tile.
      const bound = knownTitleEntry(libraryKey(key), records);
      const series = bound?.record.type === "series" ? { key: bound.key, name: bound.record.name } : undefined;
      return [{ ...item, path: wirePath(key), label: entry.title || item.label, modified: entry.updatedAt,
        progress: { position: entry.position, duration: entry.duration }, favorite: favorites.has(key),
        seriesKey: series?.key,
        ...(series?.name ? { series: { name: series.name } } : {}) }];
    }));
    // One tile per show before the filters, the sort and the slice, so `total` and the paging
    // both count what the interface can open.
    const items = groupResumeRows(described.flat())
      .filter((item) => (!query || item.label.toLocaleLowerCase().includes(query)) && (req.query.favorites !== "1" || item.favorite));
    const sorts = new Set(["name", "added", "size", "random"]);
    const sort = sorts.has(String(req.query.sort)) ? String(req.query.sort) as "name" : "added";
    const ordered = sortFiles(items, sort, req.query.order !== "asc", String(req.query.seed ?? ""));
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 60));
    const page = await Promise.all(ordered.slice(skip, skip + limit).map(async (item) => {
      const key = libraryKey(item.path);
      const art = await locateFileArtwork(key);
      if (!art) scheduleFileArtwork(key);
      const wide = await locateFileArtwork(key, "wide");
      if (!wide) scheduleFileArtwork(key, "wide");
      const { item: withMeta, backfill } = attachBrowseMeta(item, prefsOf(req).uiLanguage);
      return { ...withMeta, poster: await thumbUrl("path", item.path, art), wide: await thumbUrl("path", item.path, wide, "wide"), backfill };
    }));
    res.json({ path: ":resume", items: page.map(({ backfill: _backfill, seriesKey: _seriesKey, ...item }) => item), total: ordered.length, pending: page.some((item) => !item.poster || !item.wide || item.backfill) });
  }));

  app.get("/api/library/favorites", asyncRoute(async (req, res) => {
    const sorts = new Set(["name", "added", "size", "random"]);
    const sort = sorts.has(String(req.query.sort)) ? String(req.query.sort) as "name" : "name";
    const viewer = viewerOf(currentUser(req));
    const libraries = store.libraries();
    const described = await Promise.all(dataOf(req).favorites.filter((stored) => pathVisible(stored, viewer, libraries)).map(async (stored) => {
      const item = await describeLibraryPath(stored);
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
      const { item: withMeta, backfill } = attachBrowseMeta(item, prefsOf(req).uiLanguage);
      return { ...withMeta, favorite: true, poster, wide: wideUrl, backfill };
    }));
    res.json({ path: ":favorites", items: page.map(({ backfill: _backfill, ...item }) => item), total: ordered.length, pending: page.some((item) => !item.poster || !item.wide || item.backfill) });
  }));
}
