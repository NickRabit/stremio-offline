import type express from "express";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { artworks } from "../artwork-cache.js";
import { askedSurface, imageSurface, logPoster, noteImage, type ImageFrom } from "../image-stats.js";
import { etagMatches, FileSnapCache, fileEtag } from "../byte-cache.js";
import type { ArtShape } from "../artwork.js";
import { episodeNumberOf, folderMosaicUnits, knownTitleForUnit, mosaicIdentities, mosaicSkipped, pendingSuggestionKeys, unitFor, type GalleryEntry, type LibraryMetaRecord, type LibrarySuggestion, type TitleUnit } from "../library-match.js";
import { AppError } from "../errors.js";
import { statUnlessMissing } from "../folder-access.js";
import { assertStillAdmin } from "../roles.js";
import { libraryFor, libraryPath, libraryVisible, parseLibraryPath, placed, posixBase, posixDir, posixJoin, relativeWithin, resolveLibraryPath, toFs, visibleLibraries, type LibraryRecord, type Viewer } from "../libraries.js";
import { composeMosaic, MOSAIC_CACHE_CONTROL, MOSAIC_IMMUTABLE_CACHE_CONTROL, MosaicCache, mosaicShape } from "../mosaic.js";
import { browseDirectory, holdsLibraryRoot, isPathWithin, isVideo, listFolders, type LibraryEntry } from "../library.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import type { LibraryHealth } from "../library-probe.js";
import type { TransferProgress } from "../library-transfer.js";
import { localSeriesId, markerCovers } from "../local-series.js";
import { assertUsableName } from "../naming.js";
import { fileProgressKeys, newestProgress, titleProgressKey } from "../progress-identity.js";
import type { StoredProgress, UserPrefs, WatchedMarker } from "../store.js";
import type { UserData } from "../users.js";
import { asyncRoute, viewerOf, type RouteContext } from "./context.js";
import { destinationOf, type HeldPath, type PathReservations } from "../path-reservations.js";
import type { RenameRequest } from "../library-rename-recovery.js";
import { parsePattern, planRenames, type RenameCandidate } from "../library-rename-plan.js";
import { createRenameEntry } from "../library-rename-entry.js";
import { subtitleSidecars } from "../library-sidecars.js";

/** Browsing a library and the file operations under it. */
export interface ContentDeps extends RouteContext {
  attachBrowseMeta<T extends { path: string; kind: string; name?: string; label?: string }>(item: T, language: string, options?: { prewarm?: boolean; units?: TitleUnit[] }): Promise<{ item: T; backfill: boolean }>;
  carveOutsOf(library: LibraryRecord): Set<string>;
  nestedHidden(library: LibraryRecord, relative: string, viewer: Viewer | undefined): boolean;
  dataOf(req: express.Request): UserData;
  deleteLibraryItem(relative: string): Promise<void>;
  fileExists(file: string): Promise<boolean>;
  /** What the binding says the title's gallery holds, slot by slot. */
  galleryOf(key: string): GalleryEntry[];
  /** Where one gallery slot's picture sits, or nothing where the store cannot place it. */
  galleryArtwork(key: string, index: number): string | undefined;
  healthOf(library: LibraryRecord): LibraryHealth;
  invalidateLibrary(): void;
  libraryEntries(read?: { stale?: boolean }): Promise<LibraryEntry[]>;
  libraryKey(value: string): string;
  libraryPathBusy(keys: string[], options?: { ignoreReservations?: boolean }): Promise<string | undefined>;
  libraryPathsBusy(keys: string[]): Promise<Set<string>>;
  /** Keys a request is changing on disk outside the queue; `libraryPathBusy` reads them too. */
  pathReservations: PathReservations;
  libraryRootBrowse(viewer: Viewer, options?: { prewarm?: boolean }): Promise<{ path: string; items: unknown[]; total: number; pending: boolean }>;
  /** Every title unit of every library, the walk the browse folder mosaic groups. */
  libraryUnits(read?: { stale?: boolean }): Promise<TitleUnit[]>;
  markersOf(data: UserData): Record<string, WatchedMarker>;
  locateArtwork(entry: LibraryEntry, shape?: ArtShape): Promise<string | undefined>;
  locateFileArtwork(key: string, shape?: ArtShape): Promise<string | undefined>;
  locateFolderArtwork(key: string, shape?: ArtShape): Promise<string | undefined>;
  locateFolderArtworkPair(key: string): Promise<{ poster: string | undefined; wide: string | undefined }>;
  markBrowsed(library: LibraryRecord): void;
  metaStore: LibraryMetaStore;
  prefsOf(req?: express.Request): UserPrefs;
  progressOf(data: UserData): Record<string, StoredProgress>;
  relativeKeyIn(libraryId: string, key: string): string | undefined;
  renameLibraryItem(request: RenameRequest): Promise<void>;
  scheduleFileArtwork(key: string, shape?: ArtShape): void;
  scheduleFolderArtwork(key: string, shape?: ArtShape): void;
  sweepArtwork(): Promise<void>;
  thumbUrl(param: "path" | "dir" | "key", value: string, art: string | undefined, shape?: ArtShape): Promise<string | undefined>;
  transferLibraryItem(relative: string, folder: string, copy?: boolean, progress?: TransferProgress, confirmTypeMismatch?: boolean): Promise<string>;
  wirePath(key: string): string;
  /** Whether each row's path is starred -- its own star, or the star of the title it stands for. */
  withFavorites<T extends { path: string }>(items: T[], data: UserData, records: Record<string, LibraryMetaRecord>, units: TitleUnit[]): Array<T & { favorite: boolean }>;
  /** The memory copy of the library poster and wide bytes. Omitted, one is built here. */
  fileSnaps?: FileSnapCache;
  /** Composed fans: one picture per folder that stands for several films. Omitted in tests. */
  mosaics?: MosaicCache;
  /** The version a generated picture is at, so a fan's address changes with its pictures. */
  artStamp(file: string): Promise<string>;
  /** Whether a picture this key draws is being written right now, queued or running. */
  artworkBusy(key: string): boolean;
}

export function registerContentRoutes(app: express.Application, deps: ContentDeps): void {
  const { artStamp, artworkBusy, store, currentUser, attachBrowseMeta, carveOutsOf, nestedHidden, dataOf, deleteLibraryItem, fileExists, galleryArtwork, galleryOf, healthOf, invalidateLibrary, libraryEntries, libraryKey, libraryPathBusy, libraryPathsBusy, libraryRootBrowse, libraryUnits, locateArtwork, pathReservations, locateFileArtwork, locateFolderArtwork, locateFolderArtworkPair, markBrowsed, markersOf, metaStore, prefsOf, progressOf, relativeKeyIn, renameLibraryItem, scheduleFileArtwork, scheduleFolderArtwork, sweepArtwork, thumbUrl, transferLibraryItem, wirePath, withFavorites } = deps;
  const fileSnaps = deps.fileSnaps ?? new FileSnapCache();
  const mosaics = deps.mosaics ?? new MosaicCache(path.join(os.tmpdir(), `mosaics-${randomBytes(6).toString("hex")}`));
  const renameEntry = createRenameEntry({
    store, carveOutsOf, healthOf, fileExists, libraryPathBusy, pathReservations,
    renameLibraryItem, invalidateLibrary,
  });

  /** The distinct films a folder holds, one catalogue picture each, bounded and deduplicated
   *  by identity. A folder that is one film or a series answers with nothing, so it keeps the
   *  single poster it has always had. Only artwork already on disk is used: grouping films
   *  into a mosaic never pays for a video frame of its own. */
  const folderPosters = async (folderKey: string, library: LibraryRecord, units: TitleUnit[]): Promise<string[]> =>
    (await folderFan(folderKey, library, units)).posters;

  /** One folder's fan: the pictures it draws, the files behind them and the versions those files
   *  are at. The listing hands out the addresses, the mosaic route composes the same set into one
   *  picture, and both name it by the same stamp so a changed fan is a changed address. */
  const folderFan = async (folderKey: string, library: LibraryRecord, units: TitleUnit[]): Promise<{ posters: string[]; files: string[]; stamp: string; moving: boolean }> => {
    const empty = { posters: [], files: [], stamp: "", moving: false };
    if (library.mosaic === false) return empty;
    const distinct = folderMosaicUnits(units, folderKey, metaStore.qualifiedMeta(), metaStore.qualifiedSuggestions(), 5);
    if (distinct.length < 2) return empty;
    const found = await Promise.all(distinct.map(async (unit) => {
      const file = isVideo(posixBase(unit.key));
      const art = file ? await locateFileArtwork(unit.key) : await locateFolderArtwork(unit.key);
      if (!art) return undefined;
      return { art, poster: await thumbUrl(file ? "path" : "dir", wirePath(unit.key), art) };
    }));
    const kept = found.filter((entry): entry is { art: string; poster: string | undefined } => entry !== undefined);
    const posters = kept.map((entry) => entry.poster).filter((poster): poster is string => Boolean(poster));
    if (posters.length < 2) return empty;
    // The stamp is the version of every file that went into the fan, drawn the way the listing
    // draws it: the same pictures are the same stamp, and one new film is a new one.
    const versions = await Promise.all(kept.map((entry) => artStamp(entry.art)));
    // A cell the server is rewriting is a reason to ask again too: the fan's own address is
    // minted from those files.
    return { posters, files: kept.map((entry) => entry.art), stamp: MosaicCache.stamp(versions), moving: distinct.some((unit) => artworkBusy(unit.key)) };
  };

  /** The relative paths a pending suggestion covers: its own row, plus every folder above
   *  it, so a folder holding an unconfirmed title is listed too. */
  const pendingPathsIn = (libraryId: string): Set<string> => {
    const paths = new Set<string>();
    for (const key of pendingSuggestionKeys(metaStore.qualifiedMeta(), metaStore.qualifiedSuggestions())) {
      const relative = relativeKeyIn(libraryId, key);
      if (relative === undefined) continue;
      const parts = relative.split("/");
      for (let depth = parts.length; depth >= 1; depth -= 1) paths.add(parts.slice(0, depth).join("/"));
    }
    return paths;
  };

  /** Whether a key names a library the viewer may see. A key in an invisible library is
   *  refused wherever a key to a missing one is, so the two cannot be told apart. */
  const keyVisible = (key: string, viewer: Viewer) => {
    const parsed = parseLibraryPath(key);
    const library = parsed ? libraryFor(store.libraries(), parsed.libraryId) : undefined;
    return Boolean(parsed && library && libraryVisible(library, viewer) && !nestedHidden(library, parsed.relative, viewer));
  };

  app.get("/api/library/browse", asyncRoute(async (req, res) => {
    const requested = String(req.query.path ?? "");
    const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 60));
    const sorts = new Set(["name", "added", "size", "random"]);
    const sort = sorts.has(String(req.query.sort)) ? String(req.query.sort) as "name" : "name";
    const onlyFavorites = req.query.favorites === "1";
    const onlyUnconfirmed = req.query.unconfirmed === "1";
    // A prewarm only wants the rows and their existing pictures. It skips the maintenance and
    // the missing-artwork scheduling the ordinary flow does, so it never produces a poster.
    const prewarm = req.query.prewarm === "1";
    if (!prewarm) void sweepArtwork();
    const configured = store.libraries();
    const viewer = viewerOf(currentUser(req));
    const libraries = visibleLibraries(configured, viewer);
    // An empty path is the single library's root while that is the whole setup, and the list
    // of the libraries the viewer may see once more than one is configured. Configured is what
    // counts, not enabled and not reachable: a library switched off or on a disk that is away
    // is still part of the setup, and a browse root that changed shape when a drive spun down
    // would be worse than a row with a warning. The row says so instead of hiding it.
    if (!requested && configured.length !== 1) {
      res.json(await libraryRootBrowse(viewer, { prewarm }));
      return;
    }
    const resolved = requested ? await resolveLibraryPath(libraries, requested) : undefined;
    if (requested && !resolved) throw new AppError("Invalid path.", "err.invalidPath");
    // A folder of a nested library this account was not given reads as a folder that is not
    // there: an error here would tell a guessed name apart from a wrong one.
    const hidden = Boolean(resolved && nestedHidden(resolved.library, resolved.relative, viewer));
    // The root of a setup whose one library this account was not given: an empty library, the
    // answer a setup with no library at all gives, rather than an error on every visit.
    if (!libraries.length) { res.json({ path: "", items: [], total: 0, pending: false }); return; }
    const library = resolved?.library ?? libraries[0]!;
    if (!prewarm) markBrowsed(library);
    const inLibrary = (path: string) => libraryPath(library.id, path);
    const data = dataOf(req);
    const favoritePaths = onlyFavorites
      ? new Set(data.favorites.map((key) => relativeKeyIn(library.id, key)).filter((value): value is string => value !== undefined))
      : undefined;
    const unconfirmedPaths = onlyUnconfirmed ? pendingPathsIn(library.id) : undefined;
    const onlyPaths = favoritePaths && unconfirmedPaths
      ? new Set([...favoritePaths].filter((path) => unconfirmedPaths.has(path)))
      : favoritePaths ?? unconfirmedPaths;
    // A file is numbered the way its whole show writes it only inside a series: every file of
    // a series library sits in one, while a film in a mixed library is a title of its own.
    const seriesTyped = library.type === "series";
    const units = seriesTyped ? [] : await libraryUnits({ stale: true });
    // A file bound to a title keeps its position under the title's key; the walk answers which
    // title that is. Read once, so a page of file rows does not ask per row.
    const progressUnits = await libraryUnits({ stale: true });
    const progressRecords = metaStore.qualifiedMeta();
    const progress = progressOf(data);
    const markers = markersOf(data);
    const relative = resolved?.relative ?? "";
    const looseEpisodes = seriesTyped || unitFor(libraryPath(library.id, relative), units)?.kind === "series";
    const result = hidden ? { path: relative, items: [], total: 0 } : await browseDirectory(library.root, relative, String(req.query.query ?? ""),
      Math.max(0, Number(req.query.skip) || 0), limit, sort, req.query.order === "desc", String(req.query.seed ?? ""), onlyPaths,
      carveOutsOf(library), looseEpisodes);
    // Missing thumbnails are produced in the background; the client asks for the page again shortly.
    const items = await Promise.all(result.items.map(async (item) => {
      const key = inLibrary(item.path);
      const path = wirePath(key);
      // A job already writing this row's picture leaves the address minted from the file it is
      // about to replace, so the row says "ask again" for as long as the write is in flight.
      const moving = artworkBusy(key);
      if (item.kind === "folder") {
        const { item: withMeta, backfill } = await attachBrowseMeta({ ...item, path }, prefsOf(req).uiLanguage, { prewarm, units: progressUnits });
        // A collection stands for several films: it shows their posters rather than a folder
        // frame of its own, and no frame is scheduled for it.
        const fan = await folderFan(key, library, units);
        if (fan.posters.length > 1) {
          const mosaic = `/api/library/mosaic?key=${encodeURIComponent(key)}&v=${encodeURIComponent(fan.stamp)}`;
          return { ...withMeta, path, posters: fan.posters, mosaic, poster: undefined, wide: undefined, backfill, moving: moving || fan.moving };
        }
        const { poster: art, wide } = await locateFolderArtworkPair(key);
        if (!prewarm) {
          if (!art) scheduleFolderArtwork(key);
          if (!wide) scheduleFolderArtwork(key, "wide");
        }
        return {
          ...withMeta, path,
          poster: await thumbUrl("dir", path, art),
          wide: await thumbUrl("dir", path, wide, "wide"),
          backfill, moving,
        };
      }
      const art = await locateFileArtwork(key);
      const wide = await locateFileArtwork(key, "wide");
      if (!prewarm) {
        if (!art) scheduleFileArtwork(key);
        if (!wide) scheduleFileArtwork(key, "wide");
      }
      const fileKey = `file:${key}`;
      const titleKey = titleProgressKey(key, progressRecords, progressUnits, { season: item.season, episode: item.episode })?.key;
      // A bound file's position may sit under the title key a catalogue play wrote, or under a
      // key the file was moved away from; every row that names this file is a candidate.
      const keys = new Set([...fileProgressKeys(progress, key), ...(titleKey ? [titleKey] : [])]);
      const watched = newestProgress(
        [...keys].filter((stored) => progress[stored] !== undefined).map((stored): [string, StoredProgress] => [stored, progress[stored]!]),
        titleKey ?? fileKey,
      )?.[1];
      const covered = !watched && !titleKey && markerCovers(markers[localSeriesId(key, progressUnits)], item);
      const { item: withMeta, backfill } = await attachBrowseMeta({ ...item, path }, prefsOf(req).uiLanguage, { prewarm, units: progressUnits });
      return {
        ...withMeta,
        path,
        poster: await thumbUrl("path", path, art),
        wide: await thumbUrl("path", path, wide, "wide"),
        progress: watched
          ? { position: watched.position, duration: watched.duration }
          : covered ? { position: 1, duration: 1 } : undefined,
        backfill, moving,
      };
    }));
    const marked = withFavorites(items, data, progressRecords, progressUnits);
    const collage = (item: { kind: string; posters?: string[] }) => item.kind === "folder" && (item.posters?.length ?? 0) > 1;
    res.json({
      ...result, path: wirePath(inLibrary(result.path)),
      items: marked.map(({ backfill: _backfill, moving: _moving, ...item }) => item),
      // A picture still being written is as much a reason to ask again as one that is missing:
      // the address the row carries names the file that job is about to replace, and the browser
      // keeps an address of the thumbnail route for a year.
      pending: marked.some((item) => (collage(item)
        ? Boolean(item.backfill) || item.moving
        : !item.poster || !item.wide || item.backfill || item.moving)),
    });
  }));

  /** Holds `paths` for one piece of library work done inside a request, then asks the queue with
   *  them held, so neither another request nor a job queued meanwhile can work on the same item.
   *  Refuses as busy when either already does, and refuses an `actor` who is no longer an
   *  administrator after that wait -- the last moment before anything on disk changes. */
  const holdingPaths = async <T>(paths: HeldPath[], actor: Parameters<typeof assertStillAdmin>[1], work: () => Promise<T>): Promise<T> => {
    const busy = () => new AppError("The item is busy with another library operation.", "err.pathBusy", 409);
    const release = pathReservations.reserve(paths);
    if (!release) throw busy();
    try {
      if (await libraryPathBusy(paths.map((held) => held.key), { ignoreReservations: true })) throw busy();
      assertStillAdmin(store.users(), actor);
      return await work();
    } finally {
      release();
    }
  };

  /** The paths that resolve. One that does not is left to the work itself, which refuses it
   *  with its own error. */
  const heldPaths = async (values: string[]): Promise<HeldPath[]> =>
    Promise.all((await Promise.all(values.map((value) => resolveLibraryPath(store.libraries(), value))))
      .flatMap((resolved) => resolved ? [placed(resolved)] : []));

  app.delete("/api/library/item", asyncRoute(async (req, res) => {
    const relative = String(req.query.path ?? "").trim();
    assertStillAdmin(store.users(), currentUser(req));
    if (await libraryPathBusy([relative])) throw new AppError("The item is busy with another library operation.", "err.pathBusy", 409);
    await holdingPaths(await heldPaths([relative]), currentUser(req), () => deleteLibraryItem(relative));
    res.status(204).end();
  }));

  app.post("/api/library/folder", asyncRoute(async (req, res) => {
    const parent = String(req.body?.path ?? "").trim();
    const resolved = await resolveLibraryPath(store.libraries(), parent);
    if (!resolved) throw new AppError("Invalid path.", "err.invalidPath");
    const info = await statUnlessMissing(resolved.absolute);
    if (!info?.isDirectory()) throw new AppError("The destination folder does not exist.", "err.targetMissing");
    const name = assertUsableName(String(req.body?.name ?? ""));
    const relative = posixJoin(resolved.relative, name);
    const target = await resolveLibraryPath(store.libraries(), libraryPath(resolved.library.id, relative));
    if (!target) throw new AppError("Invalid path.", "err.invalidPath");
    if (await fileExists(target.absolute)) throw new AppError("A file with that name already exists.", "err.nameTaken");
    // Held like any other change: a rename or move in flight may be about to take this name.
    await holdingPaths([await placed(target)], currentUser(req), () => mkdir(target.absolute));
    invalidateLibrary();
    res.status(201).json({ path: wirePath(target.key) });
  }));

  app.post("/api/library/rename", asyncRoute(async (req, res) => {
    const nextRelative = await renameEntry(String(req.body.path ?? "").trim(), String(req.body.name ?? ""), currentUser(req));
    res.json({ path: nextRelative });
  }));

  app.post("/api/library/rename-plan", asyncRoute(async (req, res) => {
    const actor = currentUser(req);
    assertStillAdmin(store.users(), actor);
    const viewer = viewerOf(actor);
    const requested = req.body?.items;
    if (!Array.isArray(requested) || !requested.length) throw new AppError("At least one library item is required.", "err.missingLibraryItems");
    if (requested.length > 500) throw new AppError("A library operation may contain at most 500 items.", "err.tooManyItems");
    if (!requested.every((item) => typeof item === "string")) throw new AppError("At least one library item is required.", "err.missingLibraryItems");
    const items = [...new Set(requested.map((item) => item.trim()).filter(Boolean))];
    if (!items.length) throw new AppError("At least one library item is required.", "err.missingLibraryItems");
    const moviePattern = parsePattern(String(req.body.moviePattern ?? ""));
    const episodePattern = parsePattern(String(req.body.episodePattern ?? ""));
    const resolved = await Promise.all(items.map((item) => resolveLibraryPath(store.libraries(), item)));
    if (resolved.some((item) => !item || nestedHidden(item.library, item.relative, viewer))) {
      throw new AppError("Invalid path.", "err.invalidPath");
    }
    const selected = resolved.flatMap((item) => item ? [item] : []);
    const selectedContains = (key: string) => selected.some((item) =>
      item.relative === ""
        ? parseLibraryPath(key)?.libraryId === item.library.id
        : isPathWithin(key, item.key));
    const units = await libraryUnits();
    const covering = new Set(selected.flatMap((item) => {
      const unit = unitFor(item.key, units);
      return unit ? [unit] : [];
    }));
    const chosen = units.filter((unit) => covering.has(unit) || selectedContains(unit.key));
    const records = metaStore.qualifiedMeta();
    const ownRecord = (key: string) => records[key]?.id ? records[key] : undefined;
    const candidateFields = (record: LibraryMetaRecord | undefined) => ({
      ...(record?.name ? { title: record.name } : {}),
      ...(record?.year ? { year: record.year } : {}),
    });
    const candidates: RenameCandidate[] = [];
    for (const unit of chosen) {
      const identity = knownTitleForUnit(unit, records);
      const name = posixBase(unit.key);
      if (!identity) {
        candidates.push({ key: unit.key, folder: posixDir(unit.key), name, isFile: isVideo(name), kind: "unknown", fields: {} });
        continue;
      }
      // The identification decides, not the folder's shape: a series kept as one flat folder is
      // still renamed episode by episode, and a film the walk read as a series stays one item.
      if (identity.type !== "series") {
        const isFile = isVideo(name);
        // A film keyed by one of its files holds its other parts or versions beside it; renaming
        // the key alone would split the set (and drop a CD marker), so that row is refused.
        const parts = isFile && unit.sampleFiles.some((file) => file !== unit.key && !isPathWithin(file, unit.key));
        candidates.push({ key: unit.key, folder: posixDir(unit.key), name, isFile, kind: "movie", fields: candidateFields(identity), ...(parts ? { parts: true as const } : {}) });
        continue;
      }
      for (const file of unit.sampleFiles.filter(selectedContains)) {
        // Each file is read as the library reads it: one bound to another title, or unmatched on
        // its own, is not named after the series.
        const own = knownTitleForUnit(unit, records, file);
        const base = { key: file, folder: posixDir(file), name: posixBase(file), isFile: true };
        if (!own) { candidates.push({ ...base, kind: "unknown", fields: {} }); continue; }
        if (own.type !== "series") { candidates.push({ ...base, kind: "movie", fields: candidateFields(own) }); continue; }
        const parsed = parseLibraryPath(file);
        const numbers = episodeNumberOf(relativeWithin(parsed?.libraryId ?? "", file), ownRecord(file), { loose: true });
        candidates.push({
          ...base,
          kind: "episode",
          fields: { ...candidateFields(own), ...(numbers ? { season: numbers.season, episode: numbers.episode } : {}) },
        });
      }
    }
    if (candidates.length > 2000) throw new AppError("A rename preview may hold at most 2000 titles.", "err.tooManyItems");

    const libraries = store.libraries();
    const folders = [...new Set(candidates.map((candidate) => candidate.folder))];
    const siblings = new Map<string, string[]>(await Promise.all(folders.map(async (folder): Promise<[string, string[]]> => {
      const parsed = parseLibraryPath(folder);
      const library = parsed ? libraryFor(libraries, parsed.libraryId) : undefined;
      if (!library) return [folder, []];
      // The walk can still list a folder that left the disk a moment ago: refuse with the usual
      // answer rather than a raw error naming the host path.
      const names = await readdir(parsed?.relative ? path.join(library.root, toFs(parsed.relative)) : library.root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new AppError("The file or folder does not exist.", "err.pathMissing", 409);
        throw error;
      });
      return [folder, names];
    })));
    const sidecarNames = new Map<string, string[]>(await Promise.all(candidates.map(async (candidate): Promise<[string, string[]]> => {
      const none: string[] = [];
      if (!candidate.isFile) return [candidate.key, none];
      const parsed = parseLibraryPath(candidate.key);
      const library = parsed ? libraryFor(libraries, parsed.libraryId) : undefined;
      if (!library || !parsed) return [candidate.key, none];
      const info = await subtitleSidecars(path.join(library.root, toFs(parsed.relative)));
      return [candidate.key, info.names];
    })));
    const sidecarKeys = [...sidecarNames].flatMap(([key, names]) => names.map((name) => posixJoin(posixDir(key), name)));
    const busy = await libraryPathsBusy([...candidates.map((candidate) => candidate.key), ...sidecarKeys]);
    res.json({
      rows: planRenames({
        candidates,
        moviePattern,
        episodePattern,
        siblings,
        caseInsensitive: (folder) => {
          const parsed = parseLibraryPath(folder);
          const library = parsed ? libraryFor(libraries, parsed.libraryId) : undefined;
          return library ? healthOf(library).caseInsensitive : true;
        },
        sidecarsOf: (key) => sidecarNames.get(key) ?? [],
        busy,
      }),
    });
  }));

  /** The destination picker. Browsing hides folders with no video in them; moving something
   *  into one of them is perfectly reasonable, so this lists them all. */
  app.get("/api/library/folders", asyncRoute(async (req, res) => {
    const relative = String(req.query.path ?? "").trim();
    const viewer = viewerOf(currentUser(req));
    // An ordinary user may only walk into libraries they could save to: a picker that names a
    // library it cannot write to would offer a destination the download would then refuse. An
    // administrator keeps seeing every library, as elsewhere.
    const walkable = viewer.role === "admin"
      ? store.libraries()
      : visibleLibraries(store.libraries(), viewer).filter((library) => library.enabled && !library.readOnly && !library.unreachable);
    const resolved = await resolveLibraryPath(walkable, relative);
    if (!resolved) throw new AppError("Invalid path.", "err.invalidPath");
    markBrowsed(resolved.library);
    const folders = nestedHidden(resolved.library, resolved.relative, viewer)
      ? []
      : await listFolders(resolved.library.root, resolved.relative, carveOutsOf(resolved.library));
    // A move destination travels back through resolveLibraryPath, so it is qualified too.
    res.json({ path: relative, folders: folders.map((folder) => ({ ...folder, path: wirePath(libraryPath(resolved.library.id, folder.path)) })) });
  }));

  app.post("/api/library/move", asyncRoute(async (req, res) => {
    assertStillAdmin(store.users(), currentUser(req));
    const relative = String(req.body.path ?? "").trim();
    if (await libraryPathBusy([relative])) throw new AppError("The item is busy with another library operation.", "err.pathBusy", 409);
    // `copy` is honoured rather than ignored: the field was silently dropped before, so a client
    // that asked for a copy got a move -- the original deleted -- with a success in the response.
    const folder = String(req.body.folder ?? "").trim();
    // The source, and the name it will take in the destination: a rename of either while the
    // transfer runs -- which can take minutes across volumes -- would act under the copy.
    const held = await heldPaths([relative, destinationOf(folder, relative)]);
    const moved = await holdingPaths(held, currentUser(req), () => transferLibraryItem(relative, folder,
      req.body.copy === true, undefined, req.body.confirmTypeMismatch === true));
    res.json({ path: moved });
  }));

  /** What a title's stored gallery holds, in the order the catalogue showed it. Only the
   *  manifest travels: each picture is fetched from `thumb` as the viewer looks at it. */
  app.get("/api/library/gallery", asyncRoute(async (req, res) => {
    const viewer = viewerOf(currentUser(req));
    const relative = String(req.query.path ?? "").trim();
    const key = libraryKey(relative);
    if (!keyVisible(key, viewer)) throw new AppError("The item was not found.", "err.itemNotFound", 404);
    const resolved = await resolveLibraryPath(store.libraries(), key);
    // An absent path must answer like a hidden nested one: the difference confirms a guessed folder.
    if (!resolved || !(await statUnlessMissing(resolved.absolute))) throw new AppError("The item was not found.", "err.itemNotFound", 404);
    const wire = wirePath(key);
    res.json({
      images: await Promise.all(galleryOf(key).map(async (entry, index) => {
        const file = galleryArtwork(key, index);
        const info = file ? await stat(file).catch(() => undefined) : undefined;
        const version = file && info?.isFile() ? `${info.size.toString(36)}-${await artStamp(file)}` : "0";
        return {
          ...entry,
          url: `/api/library/thumb?path=${encodeURIComponent(wire)}&gallery=${index}&v=${encodeURIComponent(version)}`,
        };
      })),
    });
  }));

  /** One folder's fan, composed here from the pictures the tile would have drawn itself. The
   *  address carries the stamp of those pictures and the shape the tile draws; the bytes are kept
   *  under both. Private, a year, and immutable only while the client's stamp is the current one. */
  app.get("/api/library/mosaic", asyncRoute(async (req, res) => {
    const viewer = viewerOf(currentUser(req));
    const shape = mosaicShape(req.query.shape);
    const resolved = await resolveLibraryPath(store.libraries(), String(req.query.key ?? ""));
    if (!resolved || !libraryVisible(resolved.library, viewer) || nestedHidden(resolved.library, resolved.relative, viewer)) return void res.status(404).end();
    // The library's own tile draws one picture per film it stands for, whichever kind that film
    // is: a series library shows its series, the way its listing has always chosen them. A folder
    // inside it keeps the folder rule below.
    const fan = resolved.relative === ""
      ? await rootFan(resolved.library, viewer)
      : await folderFan(resolved.key, resolved.library, await libraryUnits({ stale: true }));
    if (fan.files.length < 2 || !fan.stamp) return void res.status(404).end();
    const versioned = typeof req.query.v === "string" && req.query.v === fan.stamp;
    const etag = `"${fan.stamp}"`;
    if (req.headers["if-none-match"] === etag) {
      res.setHeader("etag", etag);
      res.setHeader("cache-control", versioned ? MOSAIC_IMMUTABLE_CACHE_CONTROL : MOSAIC_CACHE_CONTROL);
      return void res.status(304).end();
    }
    const key = `${resolved.key}\u0000${shape}\u0000${fan.stamp}`;
    const composed = await mosaics.compose(key, async () => composeMosaic(
      await Promise.all(fan.files.map((file) => readFile(file))), shape));
    res.setHeader("content-type", "image/jpeg");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", versioned ? MOSAIC_IMMUTABLE_CACHE_CONTROL : MOSAIC_CACHE_CONTROL);
    res.setHeader("etag", etag);
    res.send(composed);
  }));

  /** The fan a library's own tile draws: one picture per distinct film or series the library
   *  holds, exactly as the root listing picked them. */
  const rootFan = async (library: LibraryRecord, viewer: Viewer): Promise<{ posters: string[]; files: string[]; stamp: string }> => {
    const empty = { posters: [], files: [], stamp: "" };
    if (library.mosaic === false) return empty;
    const entries = (await libraryEntries({ stale: true }))
      .filter((entry) => entry.key.startsWith(`${library.id}/`))
      .filter((entry) => {
        const relative = relativeKeyIn(library.id, entry.key);
        return relative !== undefined && !mosaicSkipped(relative, metaStore.meta(library.id));
      });
    const distinct = mosaicIdentities(entries.map((entry) => ({ key: entry.key, meta: entry.meta })), 5);
    const found = await Promise.all(distinct.map(async (source) => {
      const entry = entries.find((candidate) => candidate.key === source.key);
      if (!entry) return undefined;
      const art = await locateArtwork(entry);
      return art ? { key: entry.key, art } : undefined;
    }));
    const posters: string[] = [];
    const files: string[] = [];
    for (const entry of found) {
      if (!entry) continue;
      const poster = await thumbUrl("key", wirePath(entry.key), entry.art);
      if (!poster) continue;
      posters.push(poster);
      files.push(entry.art);
    }
    if (posters.length < 2) return empty;
    const versions = await Promise.all(files.map((file) => artStamp(file)));
    return { posters, files, stamp: MosaicCache.stamp(versions) };
  };

  /** The fan a folder's tile draws: the same pictures its collage used. */

  app.get("/api/library/thumb", asyncRoute(async (req, res) => {
    // An unknown shape asks for the poster, the way an unknown tile size is the medium one: every
    // address the interface already holds names no shape at all.
    const viewer = viewerOf(currentUser(req));
    const shape: ArtShape = String(req.query.shape ?? "") === "wide" ? "wide" : "poster";
    // Resolve before the artwork lookup: a key with a `.`/`..` segment, an absolute path or a
    // library the viewer may not see is answered like a picture that is not there, and never
    // reaches the file system. `libraryKey` alone only qualified it, so a traversal slipped past.
    const keyOf = async (value: unknown) => {
      if (!value) return undefined;
      const resolved = await resolveLibraryPath(store.libraries(), String(value));
      return resolved && libraryVisible(resolved.library, viewer) && !nestedHidden(resolved.library, resolved.relative, viewer) ? resolved.key : undefined;
    };
    const filePath = await keyOf(req.query.path);
    const dirPath = await keyOf(req.query.dir);
    // A gallery slot is answered by its number, and only for a slot the binding says is there.
    const slot = req.query.gallery === undefined ? undefined : Number(req.query.gallery);
    if (slot !== undefined) {
      const key = filePath ?? dirPath;
      if (!key || !Number.isInteger(slot) || slot < 0 || slot >= galleryOf(key).length) return res.status(404).end();
      const file = galleryArtwork(key, slot);
      const info = file ? await stat(file).catch(() => undefined) : undefined;
      if (!file || !info?.isFile()) return res.status(404).end();
      const stamp = `${info.size.toString(36)}-${await artStamp(file)}`;
      const versioned = typeof req.query.v === "string" && req.query.v === stamp;
      const etag = fileEtag(info.size, info.mtime.getTime());
      res.setHeader("cache-control", versioned ? "private, max-age=31536000, immutable" : "private, no-store");
      res.setHeader("etag", etag);
      void artworks.served(file);
      if (etagMatches(req.headers["if-none-match"], etag)) return res.status(304).end();
      return res.sendFile(file, { dotfiles: "allow" }, (error) => { if (error && !res.headersSent) res.status(404).end(); });
    }
    let art: string | undefined;
    if (filePath) art = await locateFileArtwork(filePath, shape);
    else if (dirPath) art = await locateFolderArtwork(dirPath, shape);
    else {
      const selected = await keyOf(req.query.key);
      // A mosaic tile only draws, so it takes the walk the page was built from rather than
      // waiting for a new one of every library each time the last has aged out.
      const entry = selected ? (await libraryEntries({ stale: true })).find((item) => item.key === selected) : undefined;
      art = entry && await locateArtwork(entry, shape);
    }
    if (!art) return res.status(404).end();
    // The listing address carries the file's mtime, so a replaced picture is a new URL the
    // browser has never seen. This one may therefore be kept for a year, and the bytes may come
    // straight from memory -- as long as they are still what this file holds. A request that does
    // arrive still resolves the path and refuses a library the viewer cannot see before any cache
    // is touched.
    const cacheControl = "private, max-age=31536000, immutable";
    const surface = imageSurface(req.query.surface, "library");
    const asked = askedSurface(req.query.surface);
    const poster = (from: ImageFrom | undefined, status: number, bytes: number) =>
      logPoster({ kind: "library", surface, asked, from, status, bytes, cache: cacheControl });
    // A snapshot is only a copy, and the file behind it can be replaced under the same address:
    // a re-assignment writes the new picture over the old one, a bind clears it, a frame grab
    // fills a hole. Answering from memory without looking would hand the browser the picture it
    // has just stopped drawing, under the new address it would then keep for a year.
    const snap = fileSnaps.get(art);
    const info = await stat(art).catch(() => undefined);
    if (!info?.isFile()) return res.status(404).end();
    const etag = fileEtag(info.size, info.mtime.getTime());
    res.setHeader("cache-control", cacheControl);
    res.setHeader("etag", etag);
    if (etagMatches(req.headers["if-none-match"], etag)) {
      // The snapshot is only a copy: the file may have been replaced under the same address,
      // in which case the fresh bytes are read now so the next unconditional GET is up to date.
      if (snap && (snap.size !== info.size || snap.mtimeMs !== info.mtime.getTime())) {
        const fresh = await readFile(art).catch(() => undefined);
        if (fresh) fileSnaps.put(art, { bytes: fresh, etag, size: info.size, mtimeMs: info.mtime.getTime() });
      }
      artworks.touch(art);
      poster(undefined, 304, 0);
      return res.status(304).end();
    }
    if (snap && snap.size === info.size && snap.mtimeMs === info.mtime.getTime()) {
      artworks.touch(art);
      noteImage(surface, "memory");
      poster("memory", 200, snap.bytes.length);
      res.type(path.extname(art));
      res.end(snap.bytes);
      return;
    }
    const data = await readFile(art).catch(() => undefined);
    if (!data) return res.status(404).end();
    fileSnaps.put(art, { bytes: data, etag, size: info.size, mtimeMs: info.mtime.getTime() });
    artworks.touch(art);
    noteImage(surface, "disk");
    poster("disk", 200, data.length);
    res.type(path.extname(art));
    res.end(data);
  }));
}
