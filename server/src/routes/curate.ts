import type express from "express";
import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { AppError } from "../errors.js";
import { assertStillAdmin } from "../roles.js";
import { normalizeLanguage } from "../language.js";
import { libraryFor, parseLibraryPath, posixBase, resolveLibraryPath, type Viewer } from "../libraries.js";
import type { LibraryAutoScan } from "../library-autoscan.js";
import type { LibraryCandidateSource } from "../library-candidates.js";
import { episodeNumberOf, knownTitleOf, matchStatus, needsBackfill, parseUnit, pendingSuggestionKeys, scanMiss, suggestionFor, unitFor, type LibraryMetaRecord, type TitleUnit } from "../library-match.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import type { LibraryOp, LibraryOps } from "../library-ops.js";
import { parseMediaPath } from "../library-parse.js";
import type { LibraryHealth } from "../library-probe.js";
import type { LibraryScan } from "../library-scan.js";
import { isPathWithin, isVideo } from "../library.js";
import { mediaResources, ResourceError, type ResourceOwner } from "../media-resources.js";
import { nextVideoFile } from "../next-file.js";
import type { UserPrefs } from "../store.js";
import { asyncRoute, type RouteContext } from "./context.js";

/** How many rows the manual identity search offers: enough to pick from, not a catalogue. */
const SEARCH_RESULT_LIMIT = 20;

/** Matching a title, the library operations and the scan. */
export interface CurateDeps extends RouteContext {
  /** The trusted metadata providers behind the manual search and the identity it binds. */
  candidates: LibraryCandidateSource;
  invalidateLibrary(): void;
  libraryAutoScan: LibraryAutoScan;
  libraryOps: LibraryOps;
  libraryPathBusy(keys: string[]): Promise<string | undefined>;
  libraryScan: LibraryScan;
  libraryTarget(value: string, viewer: Viewer | undefined): Promise<string>;
  libraryUnits(): Promise<TitleUnit[]>;
  matchLibraryItem(body: { path?: unknown; key?: unknown; id?: unknown; type?: unknown; scope?: unknown; season?: unknown; episode?: unknown; skipLookup?: unknown; skipMosaic?: unknown }, language?: string): Promise<{ key: string; type?: string; id?: string | null; skipLookup?: boolean; skipMosaic?: boolean }>;
  metaStore: LibraryMetaStore;
  ownRecord(relative: string, records: Record<string, LibraryMetaRecord>): LibraryMetaRecord | undefined;
  ownerOf(req: express.Request): ResourceOwner;
  prefsOf(req?: express.Request): UserPrefs;
  /** Turns an upstream picture address into the opaque link the browser may load. */
  proxyImage(url?: string): string | undefined;
  refreshLibraryHealth(): Promise<Map<string, LibraryHealth>>;
  scheduleMetaBackfill(type: string, id: string, language: string): boolean;
  wirePath(key: string): string;
}

export function registerCurateRoutes(app: express.Application, deps: CurateDeps): void {
  const { candidates, store, currentUser, invalidateLibrary, libraryAutoScan, libraryOps, libraryPathBusy, libraryScan, libraryTarget, libraryUnits, matchLibraryItem, metaStore, ownRecord, ownerOf, prefsOf, proxyImage, refreshLibraryHealth, requireAccess, scheduleMetaBackfill, wirePath } = deps;
  const suggestionView = (suggestion: NonNullable<ReturnType<typeof suggestionFor>>) => ({
    ...suggestion,
    ...(suggestion.poster ? { poster: proxyImage(suggestion.poster) } : {}),
  });

  app.get("/api/library/identity", asyncRoute(async (req, res) => {
    const relative = String(req.query.path ?? "").trim();
    const resolved = relative ? await resolveLibraryPath(store.libraries(), relative) : undefined;
    if (!resolved) throw new AppError("Invalid path.", "err.invalidPath");
    // The unit the clicked row belongs to, and the title that unit is read as: a folder named
    // for a film keeps the folder title, a loose film in a collection keeps its own name.
    const unit = unitFor(resolved.key, await libraryUnits());
    const unitKey = unit?.key ?? resolved.key;
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
      // No unit covers a path nothing matched (a folder holding only extras, say): the file
      // stands for itself and is read from its own name, never from the folder above it.
      parsed: { ...(unit ? parseUnit(unit) : parseMediaPath(posixBase(unitKey))), ...(numbers ? { season: numbers.season, episode: numbers.episode } : {}) },
      match: matchStatus(resolved.key, records, suggestions),
      ...(bound?.id ? { bound } : {}),
      ...(suggestion ? { suggestion: suggestionView(suggestion) } : {}),
    });
  }));

  app.post("/api/library/match", asyncRoute(async (req, res) => {
    assertStillAdmin(store.users(), currentUser(req));
    const body = req.body ?? {};
    // A dialog left open while the file behind it was moved away would otherwise write a
    // binding for a path nothing holds. Only a confirmation is checked this way: an empty
    // id is an unmatch, which has to stay possible for a path that is already gone.
    const wanted = String(body.path ?? body.key ?? "").trim();
    const id = String(body.id ?? "");
    if (id && wanted) {
      const resolved = await resolveLibraryPath(store.libraries(), wanted);
      // The tree may have changed since its listing cache was filled: a new file must be
      // confirmable immediately, and a removed title must not pass on an old unit entry.
      if (resolved) invalidateLibrary();
      const units = resolved ? await libraryUnits() : [];
      if (resolved && !units.some((unit) => isPathWithin(resolved.key, unit.key))) {
        throw new AppError("That title is no longer in the library.", "err.titleGone", 409);
      }
      const replacesId = String(body.replacesId ?? "");
      if (replacesId) {
        const current = resolved && knownTitleOf(resolved.key, metaStore.qualifiedMeta());
        const proposal = resolved && suggestionFor(resolved.key, metaStore.qualifiedSuggestions());
        if (!current || current.id !== replacesId || current.source !== "scan" || current.locked !== false
          || proposal?.id !== id || proposal.replacesId !== replacesId) {
          throw new AppError("The suggested correction is out of date.", "err.suggestionStale", 409);
        }
      }
    }
    res.json(await matchLibraryItem(body, prefsOf(req).uiLanguage));
  }));

  /** The manual search behind "Identify…": the same trusted providers the scan uses, so
   *  the row somebody picks by hand is the row the scan would have picked on its own. */
  app.get("/api/library/search", asyncRoute(async (req, res) => {
    const requested = String(req.query.path ?? "").trim();
    const resolved = requested ? await resolveLibraryPath(store.libraries(), requested) : undefined;
    if (requested && !resolved) throw new AppError("Invalid path.", "err.invalidPath");
    if (resolved) requireAccess(req, { libraryId: resolved.library.id });
    const query = String(req.query.query ?? "").trim();
    const kind = String(req.query.type ?? "") === "series" ? "series" : "movie";
    const year = Number.parseInt(String(req.query.year ?? ""), 10);
    const found = query
      ? await candidates.searchLibraryCandidates(query, kind, Number.isFinite(year) ? year : undefined, prefsOf(req).uiLanguage)
      : [];
    const items = found.slice(0, SEARCH_RESULT_LIMIT).map((candidate) => ({
      // The id stays the provider's own until the binding is saved: resolving an IMDb id
      // for every row would be a request per row for an answer only one of them needs.
      id: candidate.item.id,
      type: candidate.item.type || kind,
      name: candidate.item.name,
      source: candidate.provider,
      ...(candidate.item.releaseInfo ? { releaseInfo: String(candidate.item.releaseInfo) } : {}),
      ...(candidate.item.poster ? { poster: proxyImage(candidate.item.poster) } : {}),
    }));
    res.json({ items, total: items.length });
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
    const actor = currentUser(req);
    assertStillAdmin(store.users(), actor);
    const operation = parseLibraryOp(req.body);
    if (await libraryPathBusy(operation.items)) throw new AppError("The item is busy with another library operation.", "err.pathBusy", 409);
    const job = await libraryOps.enqueue({ ...operation, ownerUserId: actor?.id });
    res.status(202).json({ id: job.id });
  }));
  app.delete("/api/library/ops/:id", asyncRoute(async (req, res) => {
    assertStillAdmin(store.users(), currentUser(req));
    if (!await libraryOps.cancel(String(req.params.id))) throw new AppError("Library operation not found.", "err.libraryOperationMissing", 404);
    res.status(204).end();
  }));

  /** What the scan proposed and nobody has confirmed yet. A row only counts while the
   *  library it belongs to is reachable and the file behind it is still in the tree: a
   *  proposal for something that is gone is not a proposal, it is a stale count. */
  app.get("/api/library/suggestions", asyncRoute(async (req, res) => {
    const wanted = String(req.query.libraryId ?? "").trim();
    const records = metaStore.qualifiedMeta();
    const suggestions = metaStore.qualifiedSuggestions();
    const libraries = store.libraries();
    const units = await libraryUnits();
    const items = pendingSuggestionKeys(records, suggestions)
      .flatMap((key) => {
        const target = parseLibraryPath(key);
        if (!target || (wanted && target.libraryId !== wanted)) return [];
        const library = libraryFor(libraries, target.libraryId);
        // A library that is away keeps its rows on disk; it just stops asking for them.
        if (!library || !library.enabled || library.unreachable) return [];
        if (!units.some((unit) => isPathWithin(key, unit.key))) return [];
        const suggestion = suggestions[key]!;
        return [{
          key: wirePath(key),
          label: posixBase(key),
          libraryId: library.id,
          library: library.name,
          path: target.relative,
          suggestion: suggestionView(suggestion),
        }];
      })
      .sort((a, b) => b.suggestion.score - a.suggestion.score);
    res.json({ items, total: items.length });
  }));
  app.delete("/api/library/suggestion", asyncRoute(async (req, res) => {
    const actor = currentUser(req);
    const requested = String(req.query.key ?? "").trim();
    const resolved = requested ? await resolveLibraryPath(store.libraries(), requested) : undefined;
    if (!resolved) throw new AppError("Invalid path.", "err.invalidPath");
    const key = resolved.key;
    const target = parseLibraryPath(key);
    assertStillAdmin(store.users(), actor);
    if (target) await metaStore.update(target.libraryId, (file) => {
      const previous = file.suggestions[target.relative];
      // Kept as the memory of a searched unit, so the next scan walks past it -- and marked
      // as a person's decision, so a later rule change does not undo it.
      file.suggestions[target.relative] = scanMiss(previous?.type === "series" ? "series" : "movie", undefined, true);
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
    // Rechecking automatic matches rewrites what the scan once decided, so it names one
    // library and nothing else; "recheck everything" is not an action anybody asked for.
    const recheckScanBindings = req.body?.recheckScanBindings === true;
    if (recheckScanBindings && !library) throw new AppError("Rechecking automatic matches needs one library.", "err.recheckNeedsLibrary");
    await refreshLibraryHealth();
    // A run somebody asked for reads the tree as it is now: the walk behind it is held in
    // memory for half a minute, and "scan again" must not answer from a listing taken before
    // the file it is meant to find was copied in.
    invalidateLibrary();
    // The scan writes metadata for as long as it runs, so the question is asked before it
    // starts rather than at any of the writes behind it.
    assertStillAdmin(store.users(), currentUser(req));
    const state = await libraryScan.start({ force: req.body?.force === true, path: resolved?.key ?? "", libraryId: library?.id, recheckScanBindings });
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
