import type express from "express";
import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { AppError } from "../errors.js";
import { normalizeLanguage } from "../language.js";
import { libraryFor, parseLibraryPath, posixBase, resolveLibraryPath, type Viewer } from "../libraries.js";
import type { LibraryAutoScan } from "../library-autoscan.js";
import { episodeNumberOf, knownTitleOf, lookupSkipped, matchKeyFor, matchStatus, needsBackfill, scanMiss, suggestionFor, type LibraryMetaRecord, type TitleUnit } from "../library-match.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import type { LibraryOp, LibraryOps } from "../library-ops.js";
import { parseMediaPath } from "../library-parse.js";
import type { LibraryHealth } from "../library-probe.js";
import type { LibraryScan } from "../library-scan.js";
import { isVideo, type FoundFile } from "../library.js";
import { mediaResources, ResourceError, type ResourceOwner } from "../media-resources.js";
import { nextVideoFile } from "../next-file.js";
import type { UserPrefs } from "../store.js";
import { asyncRoute, type RouteContext } from "./context.js";

/** Matching a title, the library operations and the scan. */
export interface CurateDeps extends RouteContext {
  invalidateLibrary(): void;
  libraryAutoScan: LibraryAutoScan;
  libraryFiles(): Promise<FoundFile[]>;
  libraryOps: LibraryOps;
  libraryScan: LibraryScan;
  libraryTarget(value: string, viewer: Viewer | undefined): Promise<string>;
  libraryUnits(): Promise<TitleUnit[]>;
  matchLibraryItem(body: { path?: unknown; key?: unknown; id?: unknown; type?: unknown; scope?: unknown; season?: unknown; episode?: unknown; skipLookup?: unknown; skipMosaic?: unknown }, language?: string): Promise<{ key: string; type?: string; id?: string | null; skipLookup?: boolean; skipMosaic?: boolean }>;
  metaStore: LibraryMetaStore;
  ownRecord(relative: string, records: Record<string, LibraryMetaRecord>): LibraryMetaRecord | undefined;
  ownerOf(req: express.Request): ResourceOwner;
  prefsOf(req?: express.Request): UserPrefs;
  refreshLibraryHealth(): Promise<Map<string, LibraryHealth>>;
  scheduleMetaBackfill(type: string, id: string, language: string): boolean;
  wirePath(key: string): string;
}

export function registerCurateRoutes(app: express.Application, deps: CurateDeps): void {
  const { store, currentUser, invalidateLibrary, libraryAutoScan, libraryFiles, libraryOps, libraryScan, libraryTarget, libraryUnits, matchLibraryItem, metaStore, ownRecord, ownerOf, prefsOf, refreshLibraryHealth, requireAccess, scheduleMetaBackfill, wirePath } = deps;

  app.get("/api/library/identity", asyncRoute(async (req, res) => {
    const relative = String(req.query.path ?? "").trim();
    const resolved = relative ? await resolveLibraryPath(store.libraries(), relative) : undefined;
    if (!resolved) throw new AppError("Invalid path.", "err.invalidPath");
    const files = await libraryFiles();
    const unitKey = matchKeyFor(resolved.key, files);
    const unit = (await libraryUnits()).find((item) => item.key === unitKey);
    const records = metaStore.qualifiedMeta();
    const suggestions = metaStore.qualifiedSuggestions();
    const known = knownTitleOf(resolved.key, records);
    const language = prefsOf(req).uiLanguage;
    const wantedLanguage = store.settings().tmdbApiKey ? language : undefined;
    if (needsBackfill(known, undefined, wantedLanguage)) scheduleMetaBackfill(known!.type, known!.id, language);
    const suggestion = suggestionFor(unitKey, suggestions);
    const isFile = isVideo(posixBase(resolved.key));
    const numbers = episodeNumberOf(resolved.key, ownRecord(resolved.key, records));
    const bound = known ? { type: known.type, id: known.id, name: known.name, season: known.season, episode: known.episode } : undefined;
    res.json({
      path: relative,
      key: wirePath(unitKey),
      // What the user clicked can be one file of a whole bound title, so the dialog
      // has to be able to say which of the two it is about to rewrite.
      file: isFile,
      label: posixBase(relative),
      kind: unit?.kind ?? (isFile && numbers ? "series" : "movie"),
      parsed: { ...parseMediaPath(unitKey), ...(numbers ? { season: numbers.season, episode: numbers.episode } : {}) },
      match: matchStatus(resolved.key, records, suggestions),
      ...(bound?.id ? { bound } : {}),
      ...(suggestion ? { suggestion } : {}),
    });
  }));

  app.post("/api/library/match", asyncRoute(async (req, res) => {
    res.json(await matchLibraryItem(req.body ?? {}, prefsOf(req).uiLanguage));
  }));

  const parseLibraryOp = (value: unknown): LibraryOp => {
    const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const op = String(body.op ?? "");
    const items = Array.isArray(body.items)
      ? [...new Set(body.items.map((item) => String(item).trim()).filter(Boolean))]
      : [];
    if (!items.length) throw new AppError("At least one library item is required.", "err.missingLibraryItems");
    if (items.length > 500) throw new AppError("A library operation may contain at most 500 items.", "err.tooManyItems");
    if (op === "move" || op === "copy") {
      const target = String(body.target ?? "").trim();
      if (!target) throw new AppError("A destination folder is required.", "err.targetMissing");
      return { op, items, target, ...(body.confirmTypeMismatch === true ? { confirmTypeMismatch: true } : {}) };
    }
    if (op === "delete" || op === "unmatch" || op === "artwork" || op === "forget") return { op, items };
    if (op === "favorite") return { op, items, favorite: Boolean(body.favorite) };
    if (op === "skipLookup") return { op, items, skipLookup: Boolean(body.skipLookup) };
    if (op === "mosaic") return { op, items, mosaic: Boolean(body.mosaic) };
    if (op === "match") {
      const id = String(body.id ?? "").trim();
      const type = String(body.type ?? "").trim();
      if (!id || !type) throw new AppError("A catalogue title is required.", "err.missingTitleKey");
      return { op, items, type, id };
    }
    throw new AppError("Unknown library operation.", "err.invalidLibraryOperation");
  };

  app.get("/api/library/ops", (_req, res) => res.json(libraryOps.snapshot()));
  app.post("/api/library/ops", asyncRoute(async (req, res) => {
    // The account that asked, carried on the job: `favorite` and `forget` write to somebody's
    // own rows, and by the time they run the request is long gone.
    const job = await libraryOps.enqueue({ ...parseLibraryOp(req.body), ownerUserId: currentUser(req)?.id });
    res.status(202).json({ id: job.id });
  }));
  app.delete("/api/library/ops/:id", asyncRoute(async (req, res) => {
    if (!await libraryOps.cancel(String(req.params.id))) throw new AppError("Library operation not found.", "err.libraryOperationMissing", 404);
    res.status(204).end();
  }));

  /** What the scan proposed and nobody has confirmed yet. */
  app.get("/api/library/suggestions", asyncRoute(async (_req, res) => {
    const records = metaStore.qualifiedMeta();
    const items = Object.entries(metaStore.qualifiedSuggestions())
      .filter(([key, suggestion]) => suggestion.id && !knownTitleOf(key, records)?.id && !lookupSkipped(key, records))
      .map(([key, suggestion]) => ({ key: wirePath(key), label: posixBase(key), suggestion }))
      .sort((a, b) => b.suggestion.score - a.suggestion.score);
    res.json({ items, total: items.length });
  }));
  app.delete("/api/library/suggestion", asyncRoute(async (req, res) => {
    const requested = String(req.query.key ?? "").trim();
    const resolved = requested ? await resolveLibraryPath(store.libraries(), requested) : undefined;
    if (!resolved) throw new AppError("Invalid path.", "err.invalidPath");
    const key = resolved.key;
    const target = parseLibraryPath(key);
    if (target) await metaStore.update(target.libraryId, (file) => {
      const previous = file.suggestions[target.relative];
      // Kept as the memory of a searched unit, so the next scan walks past it.
      file.suggestions[target.relative] = scanMiss(previous?.type === "series" ? "series" : "movie");
    });
    invalidateLibrary();
    res.status(204).end();
  }));
  app.get("/api/library/scan", (_req, res) => res.json(libraryScan.snapshot()));
  app.post("/api/library/scan", asyncRoute(async (req, res) => {
    const requested = String(req.body?.path ?? "").trim();
    const resolved = requested ? await resolveLibraryPath(store.libraries(), requested) : undefined;
    if (requested && !resolved) throw new AppError("Invalid path.", "err.invalidPath");
    const wanted = String(req.body?.libraryId ?? "").trim();
    const library = wanted ? libraryFor(store.libraries(), wanted) : undefined;
    if (wanted && !library) throw new AppError("Unknown library.", "err.unknownLibrary");
    await refreshLibraryHealth();
    // A run somebody asked for reads the tree as it is now: the walk behind it is held in
    // memory for half a minute, and "scan again" must not answer from a listing taken before
    // the file it is meant to find was copied in.
    invalidateLibrary();
    const state = await libraryScan.start({ force: req.body?.force === true, path: resolved?.key ?? "", libraryId: library?.id });
    // A manual run covers the same ground, so the automatic one starts from here too.
    void libraryAutoScan.remember();
    res.json(state);
  }));
  app.post("/api/library/scan/stop", asyncRoute(async (_req, res) => { await libraryScan.stop(); res.status(204).end(); }));
  app.get(["/api/library/next/:sourceId", "/api/library/previous/:sourceId"], asyncRoute(async (req, res) => {
    const source = mediaResources.get(String(req.params.sourceId), ownerOf(req).sid, "source").stream;
    res.setHeader("cache-control", "private, no-store");
    if (!source.url?.startsWith("file://")) return void res.json(null);
    const relative = source.url.slice(7);
    const target = await libraryTarget(relative, currentUser(req));
    const next = await nextVideoFile(target, req.path.startsWith("/api/library/previous/") ? -1 : 1);
    res.json(next ? { path: path.posix.join(path.posix.dirname(relative), next), title: next } : null);
  }));

  app.post("/api/library/source", asyncRoute(async (req, res) => {
    const requested = String(req.body.path ?? "").trim();
    const resolved = requested ? await resolveLibraryPath(store.libraries(), requested) : undefined;
    const target = resolved && await libraryTarget(requested, currentUser(req)).catch(() => undefined);
    if (!resolved || !target || !(await stat(target).catch(() => undefined))?.isFile()) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    const relative = resolved.relative;
    const key = resolved.key;
    const directory = path.dirname(target);
    const stem = posixBase(relative).replace(/\.[^.]+$/, "");
    const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sidecars = (await readdir(directory, { withFileTypes: true })).flatMap((entry) => {
      if (!entry.isFile()) return [];
      const match = new RegExp(`^${escaped}(?:\\.([a-zA-Z]{2,3}))?\\.(?:srt|vtt)$`, "i").exec(entry.name);
      if (!match) return [];
      return [{ url: `file://${path.posix.join(path.posix.dirname(key), entry.name)}`, lang: normalizeLanguage(match[1]) }];
    });
    // The media resource and its sidecars are minted here, in one step with the check: the
    // library may have been switched off, or its grant withdrawn, while the tree was read.
    requireAccess(req, { libraryId: parseLibraryPath(key)?.libraryId });
    res.setHeader("cache-control", "private, no-store").json(mediaResources.publicStream({ url: `file://${key}`, subtitles: sidecars, behaviorHints: { filename: path.basename(relative) } }, ownerOf(req)));
  }));
}
