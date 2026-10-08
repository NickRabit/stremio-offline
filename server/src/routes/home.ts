import type express from "express";
import type { ArtShape } from "../artwork.js";
import { messageKeyOf } from "../errors.js";
import {
  HOME_CANDIDATES, HOME_LOOKUP_DEADLINE_MS, HOME_MARKER_LIMIT,
  boundCards, mergeResume,
  type HomeCard, type HomeResponse, type HomeRow, type HomeRowError, type HomeRowId,
  type ResumeCatalogueItem, type ResumeFileItem,
} from "../home.js";
import { libraryFor, libraryPath, parseLibraryPath, type LibraryRecord, type Viewer } from "../libraries.js";
import type { BrowseItem } from "../library.js";
import type { UserData } from "../users.js";
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

export interface HomeDeps extends RouteContext {
  personal: PersonalApi;
  completedJobs(): CompletedJobView[];
  describeLibraryPath(key: string, read?: { stale?: boolean }): Promise<BrowseItem | undefined>;
  locateFileArtwork(key: string, shape?: ArtShape): Promise<string | undefined>;
  locateFolderArtworkPair(key: string): Promise<{ poster: string | undefined; wide: string | undefined }>;
  thumbUrl(param: "path" | "dir" | "key", value: string, art: string | undefined, shape?: ArtShape): Promise<string | undefined>;
  scheduleFileArtwork(key: string, shape?: ArtShape): void;
  scheduleFolderArtwork(key: string, shape?: ArtShape): void;
  wirePath(key: string): string;
  dataOf(req: express.Request): UserData;
  /** Tests inject a few milliseconds instead of waiting the real deadline out. */
  homeLookupDeadlineMs?: number;
}

const ALL_ROWS: HomeRowId[] = ["resume", "completed", "favorites"];

const requestedRows = (raw: unknown): HomeRowId[] => {
  if (raw === undefined) return ALL_ROWS;
  const value = Array.isArray(raw) ? raw.join(",") : String(raw);
  const wanted = new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean));
  return ALL_ROWS.filter((id) => wanted.has(id));
};

const rowError = (error: unknown): HomeRowError => ({
  error: error instanceof Error ? error.message : String(error),
  ...(typeof (error as { code?: unknown })?.code === "string" ? { code: (error as { code: string }).code } : {}),
  ...(messageKeyOf(error) ? { messageKey: messageKeyOf(error)! } : {}),
});

export function registerHomeRoutes(app: express.Application, deps: HomeDeps): void {
  const { store, currentUser, personal, completedJobs, describeLibraryPath, locateFileArtwork, locateFolderArtworkPair, thumbUrl, scheduleFileArtwork, scheduleFolderArtwork, wirePath, dataOf, homeLookupDeadlineMs = HOME_LOOKUP_DEADLINE_MS } = deps;

  /** A key the caller may open now: its library is still configured, switched on and granted.
   *  `pathVisible` covers the removed and the lost-grant case; the enabled switch is Home's.
   *  A key with no library id is the single-library pass-through and stays visible. */
  const pathOpen = (key: string, viewer: Viewer, libraries: LibraryRecord[]): boolean => {
    if (!personal.pathVisible(key, viewer, libraries)) return false;
    const parsed = parseLibraryPath(key);
    if (!parsed) return true;
    return libraryFor(libraries, parsed.libraryId)?.enabled === true;
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
      personal.libraryResumeItems(req),
    ]);
    // The addon's own switch for Continue watching, as the catalogue row reads it: a row whose
    // addon is gone, or that never recorded one, stays.
    const addons = store.addons();
    const catalogue: ResumeCatalogueItem[] = progress.items
      .filter((row) => !row.key.startsWith("file:"))
      .filter((row) => addons.find((addon) => addon.key === row.addonKey)?.showInContinueWatching !== false)
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
      if (!job.target || !pathOpen(key, viewer, libraries)) return undefined;
      const item = await describeLibraryPath(key);
      if (!item || item.kind !== "file") return undefined;
      const { poster, wide } = await fileArtwork(key, item.path);
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
    const visible = dataOf(req).favorites.filter((key) => personal.pathVisible(key, viewer, libraries));
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
      const { poster, wide } = item.kind === "folder" ? await folderArtwork(key, item.path) : await fileArtwork(key, item.path);
      return {
        kind: "favorite", key, path: wirePath(key), itemKind: item.kind, label,
        ...(poster ? { poster } : {}),
        ...(wide ? { wide } : {}),
      };
    }));
    return { status: "ok", items: cards, hasMore };
  };

  const builders: Record<HomeRowId, (req: express.Request, viewer: Viewer) => Promise<HomeRow>> = {
    resume: (req) => resumeRow(req),
    completed: completedRow,
    favorites: favoritesRow,
  };

  app.get("/api/home", asyncRoute(async (req, res) => {
    // Sign-in first, even when every named row is unknown: the answer is the same 401 the
    // personal routes give, never a filtered envelope for a request that names nobody.
    const viewer = viewerOf(currentUser(req));
    res.set("Cache-Control", "private, no-store");
    const rows: Partial<Record<HomeRowId, HomeRow>> = {};
    await Promise.all(requestedRows(req.query.rows).map(async (id) => {
      try {
        rows[id] = await builders[id](req, viewer);
      } catch (error) {
        rows[id] = { status: "error", error: rowError(error), items: [], hasMore: false };
      }
    }));
    const response: HomeResponse = { generatedAt: new Date().toISOString(), rows };
    res.json(response);
  }));
}
