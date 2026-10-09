import type express from "express";
import type { ArtShape } from "../artwork.js";
import { messageKeyOf } from "../errors.js";
import type { NewEpisode } from "../follows.js";
import { images } from "../images.js";
import { allowedAddons, catalogWithExtras } from "../addons.js";
import {
  HOME_BUILTIN_ROWS, HOME_CANDIDATES, HOME_LOOKUP_DEADLINE_MS, HOME_MARKER_LIMIT, HOME_ROW_LIMIT,
  boundCards, homeCatalogRowId, homeCatalogSelectionKey, mergeResume,
  type HomeCard, type HomeResponse, type HomeRow, type HomeRowError, type HomeRowId,
  type BuiltinHomeRowId, type ResumeCatalogueItem, type ResumeFileItem,
} from "../home.js";
import { libraryFor, libraryPath, libraryVisible, parseLibraryPath, showsInFavorites, showsOnHome, type LibraryRecord, type Viewer } from "../libraries.js";
import { isPathWithin, type BrowseItem } from "../library.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import { knownTitleEntry } from "../library-match.js";
import type { LibrarySeenStore } from "../library-seen.js";
import type { StoredProgress, WatchedMarker } from "../store.js";
import type { UserData } from "../users.js";
import type { MetaItem } from "../types.js";
import { asyncRoute, viewerOf, type RouteContext } from "./context.js";
import type { PersonalApi } from "./personal.js";

/** One finished job as `completedJobs()` hands it out; the rest of the queue record is not
 *  read here. */
export interface CompletedJobView {
  id: string;
  title: string;
  ownerUserId?: string;
  status: string;
  target: string;
  completedAt?: string;
}

/** One pending library proposal as the curate route serialises it; Home reads the candidate
 *  it names and nothing else. */
export interface HomeSuggestion {
  key: string;
  label: string;
  libraryId: string;
  library: string;
  path: string;
  suggestion: { name: string; year?: number; poster?: string };
}

/** Tonight picks this many cards, drawn from a slightly larger hash-ordered pool so a file
 *  that vanished since the scan does not shorten the row. */
const TONIGHT_CARDS = 12;
const TONIGHT_SPARES = 6;

/** A title at or past this share of its duration counts as finished, so Tonight does not top
 *  up from it. The same threshold `POST /api/progress` uses to forget a position. */
const PROGRESS_DONE = 0.94;

export interface HomeDeps extends RouteContext {
  personal: PersonalApi;
  completedJobs(): CompletedJobView[];
  /** The owner's unseen episodes, read exactly the way `GET /api/follows/new-episodes` reads them. */
  newEpisodes(ownerUserId: string, watched: (metaId: string) => { season: number; episode: number } | undefined): NewEpisode[];
  describeLibraryPath(key: string, read?: { stale?: boolean }): Promise<BrowseItem | undefined>;
  locateFileArtwork(key: string, shape?: ArtShape): Promise<string | undefined>;
  locateFolderArtworkPair(key: string): Promise<{ poster: string | undefined; wide: string | undefined }>;
  thumbUrl(param: "path" | "dir" | "key", value: string, art: string | undefined, shape?: ArtShape): Promise<string | undefined>;
  scheduleFileArtwork(key: string, shape?: ArtShape): void;
  scheduleFolderArtwork(key: string, shape?: ArtShape): void;
  wirePath(key: string): string;
  dataOf(req: express.Request): UserData;
  markersOf(data: UserData): Record<string, WatchedMarker>;
  progressOf(data: UserData): Record<string, StoredProgress>;
  metaStore: LibraryMetaStore;
  /** The first-seen index: the times this app met each library file, not the file's own dates. */
  seen: LibrarySeenStore;
  suggestionRows(libraryId?: string): Promise<HomeSuggestion[]>;
  /** Injectable for route tests; production reads the selected catalog from its addon. */
  homeCatalog?(addon: import("../types.js").AddonRecord, type: string, catalogId: string, extras: Record<string, string | number>): Promise<MetaItem[]>;
  /** Injected so the tonight seed is testable without a real date. */
  now?: () => number;
  /** Tests inject a few milliseconds instead of waiting the real deadline out. */
  homeLookupDeadlineMs?: number;
}

const ALL_ROWS: BuiltinHomeRowId[] = [...HOME_BUILTIN_ROWS];

/** The row asks the index for more than it draws, so a file that vanished since the walk does
 *  not shorten it, and it never reads the disk for more than this many keys. */
const RECENT_CANDIDATES = 60;

const requestedRows = (raw: unknown, catalogRows: Map<HomeRowId, { addon: import("../types.js").AddonRecord; definition: import("../types.js").CatalogDefinition }>): HomeRowId[] => {
  if (raw === undefined) return [...ALL_ROWS, ...catalogRows.keys()];
  const value = Array.isArray(raw) ? raw.join(",") : String(raw);
  const wanted = new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean));
  return [...ALL_ROWS.filter((id) => wanted.has(id)), ...[...catalogRows.keys()].filter((id) => wanted.has(id))];
};

const rowError = (error: unknown): HomeRowError => ({
  error: error instanceof Error ? error.message : String(error),
  ...(typeof (error as { code?: unknown })?.code === "string" ? { code: (error as { code: string }).code } : {}),
  ...(messageKeyOf(error) ? { messageKey: messageKeyOf(error)! } : {}),
});

/** FNV-1a, over the seed and the key together. Deterministic, so the same request on the
 *  same day orders a row the same way; the shuffle query only changes the seed. */
const seedHash = (value: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return hash >>> 0;
};

const shuffleOf = (raw: unknown): number => {
  const value = Math.trunc(Number(Array.isArray(raw) ? raw[0] : raw));
  return Number.isFinite(value) ? Math.min(99, Math.max(0, value)) : 0;
};

export function registerHomeRoutes(app: express.Application, deps: HomeDeps): void {
  const { store, currentUser, personal, completedJobs, newEpisodes, describeLibraryPath, locateFileArtwork, locateFolderArtworkPair, thumbUrl, scheduleFileArtwork, scheduleFolderArtwork, wirePath, dataOf, markersOf, progressOf, metaStore, seen, suggestionRows, now = Date.now, homeLookupDeadlineMs = HOME_LOOKUP_DEADLINE_MS } = deps;

  /** A key the caller may open now: its library is still configured, switched on and granted.
   *  `pathVisible` covers the removed and the lost-grant case; the enabled switch is Home's.
   *  A key with no library id is the single-library pass-through and stays visible. */
  const pathOpen = (key: string, viewer: Viewer, libraries: LibraryRecord[]): boolean => {
    if (!personal.pathVisible(key, viewer, libraries)) return false;
    const parsed = parseLibraryPath(key);
    if (!parsed) return true;
    return libraryFor(libraries, parsed.libraryId)?.enabled === true;
  };

  /** A key whose owning library can still be shown on Home: switched on and reachable. A key
   *  no library claims -- an unqualified one, or one whose library is gone -- is left to the
   *  caller's own rules, which keep it. */
  const libraryOnHome = (key: string, libraries: LibraryRecord[]): boolean => {
    const parsed = parseLibraryPath(key);
    if (!parsed) return true;
    const library = libraryFor(libraries, parsed.libraryId);
    // A path whose library record is already gone keeps the showsOnHome answer.
    // Enabled and reachable are checked only for a library that is still here.
    if (!library) return true;
    return library.enabled && !library.unreachable;
  };

  const fileArtwork = async (key: string, relative: string) => {
    const art = await locateFileArtwork(key);
    if (!art) scheduleFileArtwork(key);
    const wide = await locateFileArtwork(key, "wide");
    if (!wide) scheduleFileArtwork(key, "wide");
    return { poster: await thumbUrl("path", relative, art), wide: await thumbUrl("path", relative, wide, "wide") };
  };

  const folderArtwork = async (key: string, relative: string) => {
    const { poster: art, wide } = await locateFolderArtworkPair(key);
    if (!art) scheduleFolderArtwork(key);
    if (!wide) scheduleFolderArtwork(key, "wide");
    return { poster: await thumbUrl("dir", relative, art), wide: await thumbUrl("dir", relative, wide, "wide") };
  };

  const resumeRow = async (req: express.Request): Promise<HomeRow> => {
    const [progress, resume] = await Promise.all([
      personal.progressRows(req, {
        markerLimit: HOME_MARKER_LIMIT, deadlineMs: homeLookupDeadlineMs, addonFilter: true,
        // Every candidate of a shown show has to reach the merge, or forgetting the card
        // would leave the other half behind; the merge does the real cut to 20.
        limit: Number.POSITIVE_INFINITY,
      }),
      personal.libraryResumeItems(req, { onHome: true }),
    ]);
    // The addon's own switches for the row, as the catalogue row reads them: a row whose addon
    // is gone, or that never recorded one, stays.
    const addons = store.addons();
    const catalogue: ResumeCatalogueItem[] = progress.items
      .filter((row) => !row.key.startsWith("file:"))
      .filter((row) => {
        const addon = addons.find((entry) => entry.key === row.addonKey);
        return addon?.showInContinueWatching !== false && addon?.showOnHome !== false;
      })
      .map((row) => {
        const series = row.series;
        const colon = row.key.indexOf(":");
        const type = series ? "series" : colon > 0 ? row.key.slice(0, colon) : "movie";
        const id = series ? series.id : colon > 0 ? row.key.slice(colon + 1) : row.key;
        return {
          key: row.key, updatedAt: row.updatedAt, title: row.title,
          ...(row.poster ? { poster: row.poster } : {}),
          type, id, name: series ? series.name : row.title,
          ...(series?.season !== undefined ? { season: series.season } : {}),
          ...(series?.episode !== undefined ? { episode: series.episode } : {}),
          ...(row.pending ? { pending: true as const } : { progress: { position: row.position, duration: row.duration } }),
          ...(row.addonKey ? { addonKey: row.addonKey } : {}),
          ...(series ? { seriesId: series.id, seriesType: "series" } : {}),
        };
      });
    const files: ResumeFileItem[] = resume.items.map((item) => ({
      key: `file:${item.path}`,
      updatedAt: item.modified,
      title: item.label,
      ...(item.poster ? { poster: item.poster } : {}),
      ...(item.wide ? { wide: item.wide } : {}),
      path: item.path, progress: item.progress,
      ...(typeof item.season === "number" ? { season: item.season } : {}),
      ...(typeof item.episode === "number" ? { episode: item.episode } : {}),
      ...(item.seriesId ? { seriesId: item.seriesId, seriesType: item.seriesType } : {}),
    }));
    const merged = mergeResume({ catalogue, files });
    return { status: "ok", items: merged.items, hasMore: merged.hasMore, ...(progress.partial ? { partial: true } : {}) };
  };

  const completedRow = async (_req: express.Request, viewer: Viewer): Promise<HomeRow> => {
    const libraries = store.libraries();
    const jobs = completedJobs()
      .filter((job) => job.ownerUserId === viewer.id && job.status === "completed")
      .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? "") || a.id.localeCompare(b.id))
      .slice(0, HOME_CANDIDATES);
    const resolved = await Promise.all(jobs.map(async (job) => {
      const parsed = parseLibraryPath(job.target);
      if (!parsed && libraries.length !== 1) return undefined;
      const key = parsed ? job.target : libraryPath(libraries[0]!.id, job.target);
      if (!job.target || !pathOpen(key, viewer, libraries) || !showsOnHome(key, libraries)) return undefined;
      const item = await describeLibraryPath(key);
      if (!item || item.kind !== "file") return undefined;
      const { poster, wide } = await fileArtwork(key, wirePath(key));
      return { job, item, key, poster, wide };
    }));
    const cards: HomeCard[] = resolved
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      .map(({ job, item, key, poster, wide }) => ({
        kind: "completed", key, title: job.title || item.label, path: wirePath(key),
        completedAt: job.completedAt ?? item.modified,
        ...(poster ? { poster } : {}),
        ...(wide ? { wide } : {}),
        ...(typeof item.season === "number" ? { season: item.season } : {}),
        ...(typeof item.episode === "number" ? { episode: item.episode } : {}),
      }));
    const bounded = boundCards(cards);
    return { status: "ok", items: bounded.items, hasMore: bounded.hasMore };
  };

  const favoritesRow = async (req: express.Request, viewer: Viewer): Promise<HomeRow> => {
    const libraries = store.libraries();
    const visible = dataOf(req).favorites.filter((key) =>
      personal.pathVisible(key, viewer, libraries) && showsOnHome(key, libraries)
      && showsInFavorites(key, libraries) && libraryOnHome(key, libraries));
    // Newest first, and only as many as a row can use: a long list of favourites is not
    // described on every visit to Home.
    const stored = visible.slice(-HOME_CANDIDATES).reverse();
    const described = await Promise.all(stored.map(async (key) => {
      const item = await describeLibraryPath(key, { stale: true });
      return item ? { key, item } : undefined;
    }));
    const present = described.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    const ordered = present.map(({ key, item }) => ({ key, item, label: item.kind === "folder" ? item.name : item.label }));
    const bounded = boundCards(ordered);
    const page = bounded.items;
    const hasMore = bounded.hasMore || visible.length > stored.length;
    const cards: HomeCard[] = await Promise.all(page.map(async ({ key, item, label }) => {
      const { poster, wide } = item.kind === "folder" ? await folderArtwork(key, wirePath(key)) : await fileArtwork(key, wirePath(key));
      return {
        kind: "favorite", key, path: wirePath(key), itemKind: item.kind, label,
        ...(poster ? { poster } : {}),
        ...(wide ? { wide } : {}),
      };
    }));
    return { status: "ok", items: cards, hasMore };
  };

  /** Files the app first met after its baseline, newest first. A file the library knows as an
   *  episode of a bound show collapses into the show's one card, kept on the newest file. */
  const recentRow = async (viewer: Viewer): Promise<HomeRow> => {
    const libraries = store.libraries();
    const ids = libraries
      .filter((library) => library.enabled && !library.unreachable && libraryVisible(library, viewer) && showsOnHome(library.id, libraries))
      .map((library) => library.id);
    const described = (await Promise.all(seen.recent(ids, RECENT_CANDIDATES).map(async (entry) => {
      const key = libraryPath(entry.libraryId, entry.relative);
      const item = await describeLibraryPath(key);
      return item ? { entry, key, item } : undefined;
    }))).filter((row): row is NonNullable<typeof row> => row !== undefined);
    const records = metaStore.qualifiedMeta();
    // The index is newest first, so the first file of a group is its newest and the card.
    const kept = new Map<string, (typeof described)[number]>();
    for (const row of described) {
      const bound = knownTitleEntry(row.key, records);
      const group = bound?.record.type === "series" ? bound.key : row.key;
      if (kept.has(group)) continue;
      kept.set(group, row);
    }
    const bounded = boundCards([...kept.values()]);
    const cards: HomeCard[] = await Promise.all(bounded.items.map(async ({ entry, key, item }) => {
      const bound = knownTitleEntry(key, records);
      const series = bound?.record.type === "series" ? bound.record : undefined;
      const relative = wirePath(key);
      const { poster, wide } = await fileArtwork(key, relative);
      const season = item.kind === "file" ? item.season : null;
      const episode = item.kind === "file" ? item.episode : null;
      return {
        kind: "recent", key, path: relative, label: series?.name || (item.kind === "folder" ? item.name : item.label),
        addedAt: entry.at, libraryId: entry.libraryId,
        ...(season != null ? { season } : {}),
        ...(episode != null ? { episode } : {}),
        ...(poster ? { poster } : {}),
        ...(wide ? { wide } : {}),
      };
    }));
    return { status: "ok", items: cards, hasMore: bounded.hasMore };
  };

  /** A followed show belongs to the account, not to a library or an add-on, so the Home
   *  switch does not apply to this row. */
  const episodesRow = (req: express.Request, viewer: Viewer): HomeRow => {
    const markers = markersOf(dataOf(req));
    const items = newEpisodes(viewer.id, (metaId) => {
      const marker = markers[metaId];
      return marker ? { season: marker.season, episode: marker.episode } : undefined;
    })
      .sort((a, b) => b.released.localeCompare(a.released) || a.followId.localeCompare(b.followId) || a.videoId.localeCompare(b.videoId))
      .map((item): HomeCard => ({
        kind: "episode", key: `episode:${item.followId}:${item.videoId}`,
        followId: item.followId, type: item.type, metaId: item.metaId, name: item.name,
        // Stored as the provider's address; the page only ever loads our own proxy.
        ...(item.poster ? { poster: images.proxied(item.poster) } : {}),
        season: item.season, episode: item.episode,
        ...(item.title ? { title: item.title } : {}),
        released: item.released,
      }));
    const bounded = boundCards(items);
    return { status: "ok", items: bounded.items, hasMore: bounded.hasMore };
  };

  /** A whole title the caller has not started, drawn from the libraries Home shows, in a
   *  per-day order that is the same for the same request and changes with `?shuffle=`. */
  const tonightRow = async (req: express.Request, viewer: Viewer): Promise<HomeRow> => {
    const libraries = store.libraries();
    const records = metaStore.qualifiedMeta();
    const progress = Object.entries(progressOf(dataOf(req)));

    const started = (key: string, id: string): boolean => progress.some(([progressKey, value]) =>
      value.series?.id === id || progressKey === `movie:${id}` || Boolean(value.path && isPathWithin(value.path, key)));

    // Finished only when every position that covers the favourite is at the end. One
    // finished episode of a show that is still in progress must not hide the show.
    const finished = (key: string): boolean => {
      const id = records[key]?.id ?? "";
      const covering = progress.filter(([progressKey, value]) =>
        (id !== "" && (value.series?.id === id || progressKey === `movie:${id}`))
        || Boolean(value.path && isPathWithin(value.path, key)));
      return covering.length > 0 && covering.every(([, value]) => value.duration > 0 && value.position / value.duration >= PROGRESS_DONE);
    };

    const eligible = Object.entries(records).flatMap(([key, record]) => {
      if (record.type !== "movie" && record.type !== "series") return [];
      if (!record.id || record.unmatched || record.season !== undefined || record.episode !== undefined) return [];
      const target = parseLibraryPath(key);
      if (!target) return [];
      const library = libraryFor(libraries, target.libraryId);
      if (!library || !library.enabled || library.unreachable || !libraryVisible(library, viewer)) return [];
      if (!showsOnHome(key, libraries)) return [];
      if (started(key, record.id)) return [];
      return [key];
    });

    const utcDate = new Date(now()).toISOString().slice(0, 10);
    const seed = `${viewer.id}:${utcDate}:${shuffleOf(req.query.shuffle)}`;
    const hashSort = (keys: string[]): string[] => keys
      .map((key) => ({ key, hash: seedHash(`${seed}:${key}`) }))
      .sort((a, b) => a.hash - b.hash || a.key.localeCompare(b.key))
      .map((entry) => entry.key);

    // Only when the unstarted pool is short of a full row: unfinished favourites top it up,
    // in the same per-day order and after the unstarted titles.
    const known = new Set(eligible);
    const topUp = eligible.length >= TONIGHT_CARDS ? [] : dataOf(req).favorites.filter((key) =>
      !known.has(key) && personal.pathVisible(key, viewer, libraries) && showsOnHome(key, libraries)
      && showsInFavorites(key, libraries) && libraryOnHome(key, libraries) && !finished(key));
    const ordered = [...hashSort(eligible), ...hashSort(topUp)].slice(0, TONIGHT_CARDS + TONIGHT_SPARES);

    const described = await Promise.all(ordered.map(async (key) => {
      const item = await describeLibraryPath(key);
      return item ? { key, item } : undefined;
    }));
    const present = described
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      .slice(0, TONIGHT_CARDS);
    const cards: HomeCard[] = await Promise.all(present.map(async ({ key, item }) => {
      const record = records[key];
      const relative = wirePath(key);
      const { poster, wide } = item.kind === "folder" ? await folderArtwork(key, relative) : await fileArtwork(key, relative);
      return {
        kind: "tonight", key, path: relative, itemKind: item.kind,
        label: record?.name || (item.kind === "folder" ? item.name : item.label),
        ...(record?.year ? { year: record.year } : {}),
        ...(poster ? { poster } : {}),
        ...(wide ? { wide } : {}),
        // A favourite carried over from before libraries names no library; it still draws, and
        // only its single-library install can resolve the card.
        libraryId: parseLibraryPath(key)?.libraryId ?? "",
      };
    }));
    return { status: "ok", items: cards, hasMore: false };
  };

  /** Library titles the scan proposed and nobody has confirmed. The list is built in memory,
   *  so its count is exact; an ordinary account never reaches it, and the suggestions are
   *  not read for one. */
  const confirmRow = async (viewer: Viewer): Promise<HomeRow> => {
    if (viewer.role !== "admin") return { status: "ok", items: [], hasMore: false };
    const libraries = store.libraries();
    const rows = (await suggestionRows())
      .filter((row) => libraryFor(libraries, row.libraryId)?.showOnHome !== false)
      .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
    const cards: HomeCard[] = rows.slice(0, HOME_ROW_LIMIT).map((row) => ({
      kind: "confirm", key: row.key, libraryId: row.libraryId, library: row.library,
      label: row.label, path: row.path,
      candidate: {
        name: row.suggestion.name,
        ...(row.suggestion.year !== undefined ? { year: String(row.suggestion.year) } : {}),
        ...(row.suggestion.poster ? { poster: row.suggestion.poster } : {}),
      },
    }));
    return { status: "ok", items: cards, hasMore: rows.length > HOME_ROW_LIMIT, total: rows.length };
  };

  const addonCatalogRows = (viewer: Viewer) => {
    const rows = new Map<HomeRowId, { addon: import("../types.js").AddonRecord; definition: import("../types.js").CatalogDefinition }>();
    for (const addon of allowedAddons(store.addons(), viewer)) {
      if (!addon.enabled || addon.role === "source" || addon.showOnHome === false) continue;
      for (const definition of addon.manifest.catalogs ?? []) {
        if (addon.homeCatalogs !== undefined && !addon.homeCatalogs.includes(homeCatalogSelectionKey(definition.type, definition.id))) continue;
        const row = homeCatalogRowId(addon.key, definition.type, definition.id);
        if (!rows.has(row)) rows.set(row, { addon, definition });
      }
    }
    return rows;
  };

  const addonCatalogRow = async (req: express.Request, viewer: Viewer, rowId: HomeRowId,
    addon: import("../types.js").AddonRecord, definition: import("../types.js").CatalogDefinition): Promise<HomeRow> => {
    const rawRequired = definition.extraRequired as unknown;
    const requiredNames = Array.isArray(rawRequired)
      ? rawRequired.filter((name): name is string => typeof name === "string")
      : typeof rawRequired === "string" ? [rawRequired] : [];
    const required = new Set([...requiredNames, ...(definition.extra ?? []).filter((extra) => extra.isRequired).map((extra) => extra.name)]);
    const extras: Record<string, string | number> = {};
    for (const extra of required) {
      if (extra === "skip") extras.skip = 0;
      else {
        const option = definition.extra?.find((candidate) => candidate.name === extra)?.options?.[0];
        if (option) extras[extra] = option;
      }
    }
    const fetch = deps.homeCatalog ?? ((entry: import("../types.js").AddonRecord, type: string, id: string, values: Record<string, string | number>) =>
      catalogWithExtras(entry, type, id, values));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let response: MetaItem[] | undefined;
    try {
      response = await Promise.race([
        fetch(addon, definition.type, definition.id, extras),
        new Promise<undefined>((resolve) => { deadline = setTimeout(() => resolve(undefined), homeLookupDeadlineMs); }),
      ]);
    } finally {
      if (deadline) clearTimeout(deadline);
    }
    if (!response) return { status: "ok", items: [], hasMore: false, partial: true };
    const seed = `${viewer.id}:${new Date(now()).toISOString().slice(0, 10)}:${rowId}:${shuffleOf(req.query.shuffle)}`;
    const cards: HomeCard[] = [];
    const seen = new Set<string>();
    for (const meta of response) {
      if (!meta.id || !meta.name) continue;
      const key = `${definition.type}:${meta.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rewritten = images.rewriteMeta(meta);
      cards.push({ kind: "discovery", key, type: definition.type,
        id: meta.id, name: meta.name, title: meta.name,
        ...(rewritten.poster ? { poster: rewritten.poster } : {}),
        ...(rewritten.background ? { wide: rewritten.background } : {}),
        ...(meta.year ? { year: String(meta.year) } : meta.releaseInfo ? { year: meta.releaseInfo } : {}) });
    }
    cards.sort((a, b) => seedHash(`${seed}:${a.key}`) - seedHash(`${seed}:${b.key}`) || a.key.localeCompare(b.key));
    const bounded = boundCards(cards);
    return { status: "ok", items: bounded.items, hasMore: bounded.hasMore };
  };

  const builders: Record<BuiltinHomeRowId, (req: express.Request, viewer: Viewer) => Promise<HomeRow>> = {
    resume: (req) => resumeRow(req),
    completed: completedRow,
    favorites: favoritesRow,
    recent: (_req, viewer) => recentRow(viewer),
    episodes: (req, viewer) => Promise.resolve(episodesRow(req, viewer)),
    tonight: tonightRow,
    confirm: (_req, viewer) => Promise.resolve(confirmRow(viewer)),
  };

  app.get("/api/home", asyncRoute(async (req, res) => {
    // Sign-in first, even when every named row is unknown: the answer is the same 401 the
    // personal routes give, never a filtered envelope for a request that names nobody.
    const viewer = viewerOf(currentUser(req));
    res.set("Cache-Control", "private, no-store");
    const rows: Partial<Record<HomeRowId, HomeRow>> = {};
    const catalogRows = addonCatalogRows(viewer);
    await Promise.all(requestedRows(req.query.rows, catalogRows).map(async (id) => {
      try {
        const catalogRow = catalogRows.get(id);
        rows[id] = catalogRow
          ? await addonCatalogRow(req, viewer, id, catalogRow.addon, catalogRow.definition)
          : await builders[id as BuiltinHomeRowId](req, viewer);
      } catch (error) {
        rows[id] = { status: "error", error: rowError(error), items: [], hasMore: false };
      }
    }));
    const response: HomeResponse = { generatedAt: new Date().toISOString(), rows };
    res.json(response);
  }));
}
