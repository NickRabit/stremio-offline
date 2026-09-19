import type express from "express";
import path from "node:path";
import { mkdir, rename, stat } from "node:fs/promises";
import { artworks } from "../artwork-cache.js";
import type { ArtShape } from "../artwork.js";
import { AppError } from "../errors.js";
import { libraryPath, posixDir, posixJoin, resolveLibraryPath, sameFile, type LibraryRecord } from "../libraries.js";
import { browseDirectory, listFolders, type LibraryEntry } from "../library.js";
import type { TransferProgress } from "../library-transfer.js";
import { log } from "../logger.js";
import { safeName } from "../naming.js";
import type { StoredProgress, UserPrefs } from "../store.js";
import type { UserData } from "../users.js";
import { asyncRoute, type RouteContext } from "./context.js";

/** Browsing a library and the file operations under it. */
export interface ContentDeps extends RouteContext {
  attachBrowseMeta<T extends { path: string; kind: string; name?: string; label?: string }>(item: T, language: string): { item: T; backfill: boolean };
  carveOutsOf(library: LibraryRecord): Set<string>;
  dataOf(req: express.Request): UserData;
  deleteLibraryItem(relative: string): Promise<void>;
  fileExists(file: string): Promise<boolean>;
  invalidateLibrary(): void;
  libraryEntries(): Promise<LibraryEntry[]>;
  libraryKey(value: string): string;
  libraryRootBrowse(): Promise<{ path: string; items: unknown[]; total: number; pending: boolean }>;
  locateArtwork(entry: LibraryEntry, shape?: ArtShape): Promise<string | undefined>;
  locateFileArtwork(key: string, shape?: ArtShape): Promise<string | undefined>;
  locateFolderArtwork(key: string, shape?: ArtShape): Promise<string | undefined>;
  locateFolderArtworkPair(key: string): Promise<{ poster: string | undefined; wide: string | undefined }>;
  markBrowsed(library: LibraryRecord): void;
  prefsOf(req?: express.Request): UserPrefs;
  progressOf(data: UserData): Record<string, StoredProgress>;
  relativeKeyIn(libraryId: string, key: string): string | undefined;
  relocateLibraryPath(key: string, nextKey: string, pin?: boolean): Promise<void>;
  scheduleFileArtwork(key: string, shape?: ArtShape): void;
  scheduleFolderArtwork(key: string, shape?: ArtShape): void;
  singleLibrary(): LibraryRecord;
  sweepArtwork(): Promise<void>;
  thumbUrl(param: "path" | "dir" | "key", value: string, art: string | undefined, shape?: ArtShape): Promise<string | undefined>;
  transferLibraryItem(relative: string, folder: string, copy?: boolean, progress?: TransferProgress, confirmTypeMismatch?: boolean): Promise<string>;
  wirePath(key: string): string;
  withFavorites<T extends { path: string }>(items: T[], data: UserData): Array<T & { favorite: boolean }>;
}

export function registerContentRoutes(app: express.Application, deps: ContentDeps): void {
  const { store, attachBrowseMeta, carveOutsOf, dataOf, deleteLibraryItem, fileExists, invalidateLibrary, libraryEntries, libraryKey, libraryRootBrowse, locateArtwork, locateFileArtwork, locateFolderArtwork, locateFolderArtworkPair, markBrowsed, prefsOf, progressOf, relativeKeyIn, relocateLibraryPath, scheduleFileArtwork, scheduleFolderArtwork, singleLibrary, sweepArtwork, thumbUrl, transferLibraryItem, wirePath, withFavorites } = deps;

  app.get("/api/library/browse", asyncRoute(async (req, res) => {
    const requested = String(req.query.path ?? "");
    const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 60));
    const sorts = new Set(["name", "added", "size", "random"]);
    const sort = sorts.has(String(req.query.sort)) ? String(req.query.sort) as "name" : "name";
    const onlyFavorites = req.query.favorites === "1";
    void sweepArtwork();
    const libraries = store.libraries();
    // An empty path is the single library's root while that is the whole setup, and the list
    // of libraries once there are more. Configured is what counts, not enabled and not
    // reachable: a library switched off or on a disk that is away is still part of the setup,
    // and a browse root that changed shape when a drive spun down would be worse than a row
    // with a warning. The row says so instead of hiding it.
    if (!requested && libraries.length !== 1) {
      res.json(await libraryRootBrowse());
      return;
    }
    const resolved = requested ? await resolveLibraryPath(libraries, requested) : undefined;
    if (requested && !resolved) throw new AppError("Invalid path.", "err.invalidPath");
    const library = resolved?.library ?? singleLibrary();
    markBrowsed(library);
    const inLibrary = (path: string) => libraryPath(library.id, path);
    const data = dataOf(req);
    const favoritePaths = onlyFavorites
      ? new Set(data.favorites.map((key) => relativeKeyIn(library.id, key)).filter((value): value is string => value !== undefined))
      : undefined;
    const result = await browseDirectory(library.root, resolved?.relative ?? "", String(req.query.query ?? ""),
      Math.max(0, Number(req.query.skip) || 0), limit, sort, req.query.order === "desc", String(req.query.seed ?? ""), favoritePaths,
      carveOutsOf(library));
    // Missing thumbnails are produced in the background; the client asks for the page again shortly.
    const items = await Promise.all(result.items.map(async (item) => {
      const key = inLibrary(item.path);
      const path = wirePath(key);
      if (item.kind === "folder") {
        const { poster: art, wide } = await locateFolderArtworkPair(key);
        if (!art) scheduleFolderArtwork(key);
        if (!wide) scheduleFolderArtwork(key, "wide");
        const { item: withMeta, backfill } = attachBrowseMeta({ ...item, path }, prefsOf(req).uiLanguage);
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
      const { item: withMeta, backfill } = attachBrowseMeta({ ...item, path }, prefsOf(req).uiLanguage);
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
    res.json({ ...result, path: wirePath(inLibrary(result.path)), items: marked.map(({ backfill: _backfill, ...item }) => item), pending: marked.some((item) => !item.poster || !item.wide || item.backfill) });
  }));

  app.delete("/api/library/item", asyncRoute(async (req, res) => {
    const relative = String(req.query.path ?? "").trim();
    await deleteLibraryItem(relative);
    res.status(204).end();
  }));

  app.post("/api/library/folder", asyncRoute(async (req, res) => {
    const parent = String(req.body?.path ?? "").trim();
    const resolved = await resolveLibraryPath(store.libraries(), parent);
    if (!resolved) throw new AppError("Invalid path.", "err.invalidPath");
    const info = await stat(resolved.absolute).catch(() => undefined);
    if (!info?.isDirectory()) throw new AppError("The destination folder does not exist.", "err.targetMissing");
    const rawName = String(req.body?.name ?? "").trim();
    if (!rawName || /^\.+$/.test(rawName)) throw new AppError("Invalid name.", "err.invalidName");
    const name = safeName(rawName);
    const relative = posixJoin(resolved.relative, name);
    const target = await resolveLibraryPath(store.libraries(), libraryPath(resolved.library.id, relative));
    if (!target) throw new AppError("Invalid path.", "err.invalidPath");
    if (await fileExists(target.absolute)) throw new AppError("A file with that name already exists.", "err.nameTaken");
    await mkdir(target.absolute);
    invalidateLibrary();
    res.status(201).json({ path: wirePath(target.key) });
  }));

  app.post("/api/library/rename", asyncRoute(async (req, res) => {
    const relative = String(req.body.path ?? "").trim();
    const resolved = relative ? await resolveLibraryPath(store.libraries(), relative) : undefined;
    if (!resolved || !resolved.relative) throw new AppError("Invalid path.", "err.invalidPath");
    const info = await stat(resolved.absolute).catch(() => undefined);
    if (!info) throw new AppError("The file or folder does not exist.", "err.pathMissing");

    const extension = info.isDirectory() ? "" : path.extname(relative);
    const wanted = safeName(String(req.body.name ?? "").replace(/\.[^.]+$/, ""));
    const nextRelative = posixJoin(posixDir(relative), `${wanted}${extension}`);
    const target = await resolveLibraryPath(store.libraries(), nextRelative);
    if (!target) throw new AppError("Invalid name.", "err.invalidName");
    // A rename that only changes the case of a name is a real rename where the filesystem folds
    // case; there the target is the same file, and `fileExists` must not be read as a clash.
    if (!sameFile(target.absolute, resolved.absolute) && await fileExists(target.absolute)) throw new AppError("A file with that name already exists.", "err.nameTaken");

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
    const resolved = await resolveLibraryPath(store.libraries(), relative);
    if (!resolved) throw new AppError("Invalid path.", "err.invalidPath");
    markBrowsed(resolved.library);
    const folders = await listFolders(resolved.library.root, resolved.relative, carveOutsOf(resolved.library));
    // A move destination travels back through resolveLibraryPath, so it is qualified too.
    res.json({ path: relative, folders: folders.map((folder) => ({ ...folder, path: wirePath(libraryPath(resolved.library.id, folder.path)) })) });
  }));

  app.post("/api/library/move", asyncRoute(async (req, res) => {
    // `copy` is honoured rather than ignored: the field was silently dropped before, so a client
    // that asked for a copy got a move -- the original deleted -- with a success in the response.
    const moved = await transferLibraryItem(String(req.body.path ?? "").trim(), String(req.body.folder ?? "").trim(),
      req.body.copy === true, undefined, req.body.confirmTypeMismatch === true);
    res.json({ path: moved });
  }));

  app.get("/api/library/thumb", asyncRoute(async (req, res) => {
    // An unknown shape asks for the poster, the way an unknown tile size is the medium one: every
    // address the interface already holds names no shape at all.
    const shape: ArtShape = String(req.query.shape ?? "") === "wide" ? "wide" : "poster";
    const filePath = req.query.path ? libraryKey(String(req.query.path)) : undefined;
    const dirPath = req.query.dir ? libraryKey(String(req.query.dir)) : undefined;
    let art: string | undefined;
    if (filePath) art = await locateFileArtwork(filePath, shape);
    else if (dirPath) art = await locateFolderArtwork(dirPath, shape);
    else {
      const selected = String(req.query.key ?? "");
      const entry = (await libraryEntries()).find((item) => item.key === libraryKey(selected));
      art = entry && await locateArtwork(entry, shape);
    }
    if (!art) return res.status(404).end();
    void artworks.served(art);
    res.setHeader("cache-control", "private, no-store");
    res.sendFile(art, { dotfiles: "allow" }, (error) => { if (error && !res.headersSent) res.status(404).end(); });
  }));
}
