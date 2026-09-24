import type express from "express";
import path from "node:path";
import { mkdir, rename, stat } from "node:fs/promises";
import { artworks } from "../artwork-cache.js";
import type { ArtShape } from "../artwork.js";
import { folderMosaicUnits, pendingSuggestionKeys, type GalleryEntry, type LibraryMetaRecord, type LibrarySuggestion, type TitleUnit } from "../library-match.js";
import { AppError } from "../errors.js";
import { assertStillAdmin } from "../roles.js";
import { libraryFor, libraryPath, libraryVisible, parseLibraryPath, posixBase, posixDir, posixJoin, resolveLibraryPath, sameFile, visibleLibraries, type LibraryRecord, type Viewer } from "../libraries.js";
import { browseDirectory, holdsLibraryRoot, isVideo, listFolders, type LibraryEntry } from "../library.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import type { LibraryHealth } from "../library-probe.js";
import type { TransferProgress } from "../library-transfer.js";
import { log } from "../logger.js";
import { assertUsableName } from "../naming.js";
import type { StoredProgress, UserPrefs } from "../store.js";
import type { UserData } from "../users.js";
import { asyncRoute, viewerOf, type RouteContext } from "./context.js";

/** Browsing a library and the file operations under it. */
export interface ContentDeps extends RouteContext {
  attachBrowseMeta<T extends { path: string; kind: string; name?: string; label?: string }>(item: T, language: string): Promise<{ item: T; backfill: boolean }>;
  carveOutsOf(library: LibraryRecord): Set<string>;
  dataOf(req: express.Request): UserData;
  deleteLibraryItem(relative: string): Promise<void>;
  fileExists(file: string): Promise<boolean>;
  /** What the binding says the title's gallery holds, slot by slot. */
  galleryOf(key: string): GalleryEntry[];
  /** Where one gallery slot's picture sits, or nothing where the store cannot place it. */
  galleryArtwork(key: string, index: number): string | undefined;
  healthOf(library: LibraryRecord): LibraryHealth;
  invalidateLibrary(): void;
  libraryEntries(): Promise<LibraryEntry[]>;
  libraryKey(value: string): string;
  libraryPathBusy(keys: string[]): Promise<string | undefined>;
  libraryRootBrowse(viewer: Viewer): Promise<{ path: string; items: unknown[]; total: number; pending: boolean }>;
  /** Every title unit of every library, the walk the browse folder mosaic groups. */
  libraryUnits(): Promise<TitleUnit[]>;
  locateArtwork(entry: LibraryEntry, shape?: ArtShape): Promise<string | undefined>;
  locateFileArtwork(key: string, shape?: ArtShape): Promise<string | undefined>;
  locateFolderArtwork(key: string, shape?: ArtShape): Promise<string | undefined>;
  locateFolderArtworkPair(key: string): Promise<{ poster: string | undefined; wide: string | undefined }>;
  markBrowsed(library: LibraryRecord): void;
  metaStore: LibraryMetaStore;
  prefsOf(req?: express.Request): UserPrefs;
  progressOf(data: UserData): Record<string, StoredProgress>;
  relativeKeyIn(libraryId: string, key: string): string | undefined;
  relocateLibraryPath(key: string, nextKey: string, pin?: boolean): Promise<void>;
  scheduleFileArtwork(key: string, shape?: ArtShape): void;
  scheduleFolderArtwork(key: string, shape?: ArtShape): void;
  sweepArtwork(): Promise<void>;
  thumbUrl(param: "path" | "dir" | "key", value: string, art: string | undefined, shape?: ArtShape): Promise<string | undefined>;
  transferLibraryItem(relative: string, folder: string, copy?: boolean, progress?: TransferProgress, confirmTypeMismatch?: boolean): Promise<string>;
  wirePath(key: string): string;
  withFavorites<T extends { path: string }>(items: T[], data: UserData): Array<T & { favorite: boolean }>;
}

export function registerContentRoutes(app: express.Application, deps: ContentDeps): void {
  const { store, currentUser, attachBrowseMeta, carveOutsOf, dataOf, deleteLibraryItem, fileExists, galleryArtwork, galleryOf, healthOf, invalidateLibrary, libraryEntries, libraryKey, libraryPathBusy, libraryRootBrowse, libraryUnits, locateArtwork, locateFileArtwork, locateFolderArtwork, locateFolderArtworkPair, markBrowsed, metaStore, prefsOf, progressOf, relativeKeyIn, relocateLibraryPath, scheduleFileArtwork, scheduleFolderArtwork, sweepArtwork, thumbUrl, transferLibraryItem, wirePath, withFavorites } = deps;

  /** The distinct films a folder holds, one catalogue picture each, bounded and deduplicated
   *  by identity. A folder that is one film or a series answers with nothing, so it keeps the
   *  single poster it has always had. Only artwork already on disk is used: grouping films
   *  into a mosaic never pays for a video frame of its own. */
  const folderPosters = async (folderKey: string, library: LibraryRecord, units: TitleUnit[]): Promise<string[]> => {
    if (library.mosaic === false) return [];
    const distinct = folderMosaicUnits(units, folderKey, metaStore.qualifiedMeta(), metaStore.qualifiedSuggestions(), 5);
    if (distinct.length < 2) return [];
    const posters: string[] = [];
    for (const unit of distinct) {
      const file = isVideo(posixBase(unit.key));
      const art = file ? await locateFileArtwork(unit.key) : await locateFolderArtwork(unit.key);
      const poster = await thumbUrl(file ? "path" : "dir", wirePath(unit.key), art);
      if (poster) posters.push(poster);
    }
    return posters.length > 1 ? posters : [];
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
    const libraryId = parseLibraryPath(key)?.libraryId;
    const library = libraryId ? libraryFor(store.libraries(), libraryId) : undefined;
    return Boolean(library && libraryVisible(library, viewer));
  };

  app.get("/api/library/browse", asyncRoute(async (req, res) => {
    const requested = String(req.query.path ?? "");
    const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 60));
    const sorts = new Set(["name", "added", "size", "random"]);
    const sort = sorts.has(String(req.query.sort)) ? String(req.query.sort) as "name" : "name";
    const onlyFavorites = req.query.favorites === "1";
    const onlyUnconfirmed = req.query.unconfirmed === "1";
    void sweepArtwork();
    const configured = store.libraries();
    const viewer = viewerOf(currentUser(req));
    const libraries = visibleLibraries(configured, viewer);
    // An empty path is the single library's root while that is the whole setup, and the list
    // of the libraries the viewer may see once more than one is configured. Configured is what
    // counts, not enabled and not reachable: a library switched off or on a disk that is away
    // is still part of the setup, and a browse root that changed shape when a drive spun down
    // would be worse than a row with a warning. The row says so instead of hiding it.
    if (!requested && configured.length !== 1) {
      res.json(await libraryRootBrowse(viewer));
      return;
    }
    const resolved = requested ? await resolveLibraryPath(libraries, requested) : undefined;
    if (requested && !resolved) throw new AppError("Invalid path.", "err.invalidPath");
    if (!libraries.length) throw new AppError("Invalid path.", "err.invalidPath");
    const library = resolved?.library ?? libraries[0]!;
    markBrowsed(library);
    const inLibrary = (path: string) => libraryPath(library.id, path);
    const data = dataOf(req);
    const favoritePaths = onlyFavorites
      ? new Set(data.favorites.map((key) => relativeKeyIn(library.id, key)).filter((value): value is string => value !== undefined))
      : undefined;
    const unconfirmedPaths = onlyUnconfirmed ? pendingPathsIn(library.id) : undefined;
    const onlyPaths = favoritePaths && unconfirmedPaths
      ? new Set([...favoritePaths].filter((path) => unconfirmedPaths.has(path)))
      : favoritePaths ?? unconfirmedPaths;
    const result = await browseDirectory(library.root, resolved?.relative ?? "", String(req.query.query ?? ""),
      Math.max(0, Number(req.query.skip) || 0), limit, sort, req.query.order === "desc", String(req.query.seed ?? ""), onlyPaths,
      carveOutsOf(library));
    const units = result.items.some((item) => item.kind === "folder") ? await libraryUnits() : [];
    // Missing thumbnails are produced in the background; the client asks for the page again shortly.
    const items = await Promise.all(result.items.map(async (item) => {
      const key = inLibrary(item.path);
      const path = wirePath(key);
      if (item.kind === "folder") {
        const { item: withMeta, backfill } = await attachBrowseMeta({ ...item, path }, prefsOf(req).uiLanguage);
        // A collection stands for several films: it shows their posters rather than a folder
        // frame of its own, and no frame is scheduled for it.
        const posters = await folderPosters(key, library, units);
        if (posters.length > 1) return { ...withMeta, path, posters, poster: undefined, wide: undefined, backfill };
        const { poster: art, wide } = await locateFolderArtworkPair(key);
        if (!art) scheduleFolderArtwork(key);
        if (!wide) scheduleFolderArtwork(key, "wide");
        return {
          ...withMeta, path,
          poster: await thumbUrl("dir", path, art),
          wide: await thumbUrl("dir", path, wide, "wide"),
          backfill,
        };
      }
      const art = await locateFileArtwork(key);
      if (!art) scheduleFileArtwork(key);
      const wide = await locateFileArtwork(key, "wide");
      if (!wide) scheduleFileArtwork(key, "wide");
      const watched = progressOf(data)[`file:${key}`];
      const { item: withMeta, backfill } = await attachBrowseMeta({ ...item, path }, prefsOf(req).uiLanguage);
      return {
        ...withMeta,
        path,
        poster: await thumbUrl("path", path, art),
        wide: await thumbUrl("path", path, wide, "wide"),
        progress: watched ? { position: watched.position, duration: watched.duration } : undefined,
        backfill,
      };
    }));
    const marked = withFavorites(items, data);
    const collage = (item: { kind: string; posters?: string[] }) => item.kind === "folder" && (item.posters?.length ?? 0) > 1;
    res.json({
      ...result, path: wirePath(inLibrary(result.path)),
      items: marked.map(({ backfill: _backfill, ...item }) => item),
      pending: marked.some((item) => (collage(item) ? Boolean(item.backfill) : !item.poster || !item.wide || item.backfill)),
    });
  }));

  app.delete("/api/library/item", asyncRoute(async (req, res) => {
    const relative = String(req.query.path ?? "").trim();
    assertStillAdmin(store.users(), currentUser(req));
    if (await libraryPathBusy([relative])) throw new AppError("The item is busy with another library operation.", "err.pathBusy", 409);
    await deleteLibraryItem(relative);
    res.status(204).end();
  }));

  app.post("/api/library/folder", asyncRoute(async (req, res) => {
    const parent = String(req.body?.path ?? "").trim();
    const resolved = await resolveLibraryPath(store.libraries(), parent);
    if (!resolved) throw new AppError("Invalid path.", "err.invalidPath");
    const info = await stat(resolved.absolute).catch(() => undefined);
    if (!info?.isDirectory()) throw new AppError("The destination folder does not exist.", "err.targetMissing");
    const name = assertUsableName(String(req.body?.name ?? ""));
    const relative = posixJoin(resolved.relative, name);
    const target = await resolveLibraryPath(store.libraries(), libraryPath(resolved.library.id, relative));
    if (!target) throw new AppError("Invalid path.", "err.invalidPath");
    if (await fileExists(target.absolute)) throw new AppError("A file with that name already exists.", "err.nameTaken");
    assertStillAdmin(store.users(), currentUser(req));
    await mkdir(target.absolute);
    invalidateLibrary();
    res.status(201).json({ path: wirePath(target.key) });
  }));

  app.post("/api/library/rename", asyncRoute(async (req, res) => {
    const actor = currentUser(req);
    const relative = String(req.body.path ?? "").trim();
    const resolved = relative ? await resolveLibraryPath(store.libraries(), relative) : undefined;
    if (!resolved || !resolved.relative) throw new AppError("Invalid path.", "err.invalidPath");
    if (await libraryPathBusy([relative])) throw new AppError("The item is busy with another library operation.", "err.pathBusy", 409);
    const info = await stat(resolved.absolute).catch(() => undefined);
    if (!info) throw new AppError("The file or folder does not exist.", "err.pathMissing");
    // The fold comes from the volume the folder sits on: the carve-outs are compared as
    // spellings inside this library's tree, so this library's probe decides.
    if (holdsLibraryRoot(carveOutsOf(resolved.library), resolved.relative, healthOf(resolved.library).caseInsensitive)) {
      throw new AppError("This folder holds another library. Move that library out first.", "err.libraryHoldsAnother", 409);
    }

    const extension = info.isDirectory() ? "" : path.extname(relative);
    const typed = String(req.body.name ?? "").trim();
    // Only the item's own extension is taken off what was typed. Any other dot belongs to the
    // name -- "S.W.A.T. 2017" is not a file called "S.W.A.T" -- and cutting it would rename
    // the item to something else than was asked for.
    const stem = extension && typed.toLowerCase().endsWith(extension.toLowerCase()) ? typed.slice(0, -extension.length) : typed;
    const wanted = assertUsableName(stem);
    const nextRelative = posixJoin(posixDir(relative), `${wanted}${extension}`);
    const target = await resolveLibraryPath(store.libraries(), nextRelative);
    if (!target) throw new AppError("Invalid path.", "err.invalidPath");
    // A rename that only changes the case of a name is a real rename where the filesystem folds
    // case; there the target is the same file, and `fileExists` must not be read as a clash.
    if (!sameFile(target.absolute, resolved.absolute) && await fileExists(target.absolute)) throw new AppError("A file with that name already exists.", "err.nameTaken");

    // The last moment before anything on disk moves. Checking here rather than at the state
    // write is what closes the window without risking an inconsistency: refuse now and nothing
    // has happened; refuse after the rename and the state would describe a file that moved.
    assertStillAdmin(store.users(), actor);
    await rename(resolved.absolute, target.absolute);
    await relocateLibraryPath(resolved.key, target.key);
    invalidateLibrary();
    log("INFO", "Renamed in the library", { from: relative, to: nextRelative });
    res.json({ path: nextRelative });
  }));

  /** The destination picker. Browsing hides folders with no video in them; moving something
   *  into one of them is perfectly reasonable, so this lists them all. */
  app.get("/api/library/folders", asyncRoute(async (req, res) => {
    const relative = String(req.query.path ?? "").trim();
    const resolved = await resolveLibraryPath(visibleLibraries(store.libraries(), viewerOf(currentUser(req))), relative);
    if (!resolved) throw new AppError("Invalid path.", "err.invalidPath");
    markBrowsed(resolved.library);
    const folders = await listFolders(resolved.library.root, resolved.relative, carveOutsOf(resolved.library));
    // A move destination travels back through resolveLibraryPath, so it is qualified too.
    res.json({ path: relative, folders: folders.map((folder) => ({ ...folder, path: wirePath(libraryPath(resolved.library.id, folder.path)) })) });
  }));

  app.post("/api/library/move", asyncRoute(async (req, res) => {
    assertStillAdmin(store.users(), currentUser(req));
    const relative = String(req.body.path ?? "").trim();
    if (await libraryPathBusy([relative])) throw new AppError("The item is busy with another library operation.", "err.pathBusy", 409);
    // `copy` is honoured rather than ignored: the field was silently dropped before, so a client
    // that asked for a copy got a move -- the original deleted -- with a success in the response.
    const moved = await transferLibraryItem(relative, String(req.body.folder ?? "").trim(),
      req.body.copy === true, undefined, req.body.confirmTypeMismatch === true);
    res.json({ path: moved });
  }));

  /** What a title's stored gallery holds, in the order the catalogue showed it. Only the
   *  manifest travels: each picture is fetched from `thumb` as the viewer looks at it. */
  app.get("/api/library/gallery", asyncRoute(async (req, res) => {
    const viewer = viewerOf(currentUser(req));
    const relative = String(req.query.path ?? "").trim();
    const key = libraryKey(relative);
    if (!keyVisible(key, viewer)) throw new AppError("The item was not found.", "err.itemNotFound", 404);
    const wire = wirePath(key);
    res.json({
      images: galleryOf(key).map((entry, index) => ({
        ...entry,
        url: `/api/library/thumb?path=${encodeURIComponent(wire)}&gallery=${index}`,
      })),
    });
  }));

  app.get("/api/library/thumb", asyncRoute(async (req, res) => {
    // An unknown shape asks for the poster, the way an unknown tile size is the medium one: every
    // address the interface already holds names no shape at all.
    const viewer = viewerOf(currentUser(req));
    const shape: ArtShape = String(req.query.shape ?? "") === "wide" ? "wide" : "poster";
    const filePath = req.query.path ? libraryKey(String(req.query.path)) : undefined;
    const dirPath = req.query.dir ? libraryKey(String(req.query.dir)) : undefined;
    // A gallery slot is answered by its number, and only for a slot the binding says is there.
    const slot = req.query.gallery === undefined ? undefined : Number(req.query.gallery);
    if (slot !== undefined) {
      const key = filePath ?? dirPath;
      if (!key || !keyVisible(key, viewer) || !Number.isInteger(slot) || slot < 0 || slot >= galleryOf(key).length) return res.status(404).end();
      const file = galleryArtwork(key, slot);
      if (!file || !await fileExists(file)) return res.status(404).end();
      void artworks.served(file);
      res.setHeader("cache-control", "private, no-store");
      return res.sendFile(file, { dotfiles: "allow" }, (error) => { if (error && !res.headersSent) res.status(404).end(); });
    }
    let art: string | undefined;
    if (filePath) art = keyVisible(filePath, viewer) ? await locateFileArtwork(filePath, shape) : undefined;
    else if (dirPath) art = keyVisible(dirPath, viewer) ? await locateFolderArtwork(dirPath, shape) : undefined;
    else {
      const selected = String(req.query.key ?? "");
      const entry = (await libraryEntries()).find((item) => item.key === libraryKey(selected) && keyVisible(item.key, viewer));
      art = entry && await locateArtwork(entry, shape);
    }
    if (!art) return res.status(404).end();
    void artworks.served(art);
    res.setHeader("cache-control", "private, no-store");
    res.sendFile(art, { dotfiles: "allow" }, (error) => { if (error && !res.headersSent) res.status(404).end(); });
  }));
}
