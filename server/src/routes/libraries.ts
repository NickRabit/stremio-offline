import type express from "express";
import path from "node:path";
import { constants } from "node:fs";
import { access, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { artworks } from "../artwork-cache.js";
import { AppError } from "../errors.js";
import { activeDeparted, carveOuts, DEPARTED_MAX, departedIdFor, isInside, libraryPath, newLibraryId, parseLibraryPath, posixBase, toPosix, visibleLibraries, type LibraryRecord, type RootGrant } from "../libraries.js";
import { asLibraryType, checkLibraryRemoval, checkLibraryRoot, checkRerootItems, checkRerootPaths, libraryFlag } from "../library-admin.js";
import { grantingRoot, insideGrant } from "../library-grants.js";
import { listVideos, type WalkBudget } from "../library.js";
import { knownTitleOf, titleUnits } from "../library-match.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import type { LibraryOps } from "../library-ops.js";
import type { LibraryHealth, LibraryProbe } from "../library-probe.js";
import { log } from "../logger.js";
import type { State } from "../store.js";
import { bumpPermissions, findUserById, usersToBump, type UserData } from "../users.js";
import { asyncRoute, viewerOf, type RouteContext } from "./context.js";

export interface LibrariesDeps extends RouteContext {
  accountIdOf(req?: express.Request): string | undefined;
  grantRows(): Promise<Array<{ path: string; source: RootGrant["source"]; grantedAt: string; writable: boolean }>>;
  healthOf(library: LibraryRecord): LibraryHealth;
  invalidateLibrary(): void;
  libraryGrants(): RootGrant[];
  libraryStats(): Promise<Map<string, { titles: number; files: number; bytes: number }>>;
  libraryView(library: LibraryRecord, health: LibraryHealth, stats: { titles: number; files: number; bytes: number }): Record<string, unknown>;
  mutateData(state: State, id: string, mutate: (data: UserData) => void): void;
  progressOf(data: UserData): Record<string, { path?: string }>;
  refreshLibraryHealth(): Promise<Map<string, LibraryHealth>>;
  libraryProbe: LibraryProbe;
  metaStore: LibraryMetaStore;
  libraryOps: LibraryOps;
}

export function registerLibrariesRoutes(app: express.Application, deps: LibrariesDeps): void {
  const { store, currentUser, accountIdOf, grantRows, healthOf, invalidateLibrary, libraryGrants, libraryStats, libraryView, mutateData, progressOf, refreshLibraryHealth, libraryProbe, metaStore, libraryOps, stopContentAccess } = deps;

  /** The same check the module makes, raised as the failure the interface renders. */
  async function requireLibraryRoot(value: unknown, opts: { create?: boolean; exceptId?: string } = {}): Promise<string> {
    const checked = await checkLibraryRoot({ grants: libraryGrants(), libraries: store.libraries(), root: value, ...opts });
    if (!checked.ok) throw new AppError(checked.message, checked.messageKey, checked.status);
    return checked.root;
  }

  /** A grant edit and a global switch each reach only their own cause: the accounts that
   *  just lost sight of this library, or everybody it was switched off for. Called after
   *  the write, never before -- a request that slips between the two fails its own check. */
  async function sweepLibraryLoss(before: LibraryRecord, after: LibraryRecord): Promise<void> {
    if (before.enabled && !after.enabled) {
      await stopContentAccess({ libraryId: after.id });
      return;
    }
    const removed = (before.visibleTo ?? []).filter((id) => !(after.visibleTo ?? []).includes(id));
    for (const userId of removed) await stopContentAccess({ userId, libraryId: after.id });
  }

  app.get("/api/libraries", asyncRoute(async (req, res) => {
    await refreshLibraryHealth();
    const stats = await libraryStats();
    const libraries = [...visibleLibraries(store.libraries(), viewerOf(currentUser(req)))].sort((a, b) => a.order - b.order);
    res.json(libraries.map((library) => libraryView(library, healthOf(library), stats.get(library.id) ?? { titles: 0, files: 0, bytes: 0 })));
  }));

  app.post("/api/libraries", asyncRoute(async (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    if (!name) throw new AppError("Give the library a name.", "err.libraryNameRequired");
    const type = asLibraryType(req.body?.type);
    if (!type) throw new AppError("Unknown library type.", "err.libraryTypeUnknown");
    const root = await requireLibraryRoot(req.body?.root, { create: req.body?.create === true });
    // A fresh answer for the root as it is now: a deleted library's cached verdict must not
    // decide whether the new one is writable.
    libraryProbe.invalidate(root);
    const health = await libraryProbe.cached(root);
    // A folder that was a library before and was removed without forgetting takes its identity
    // back, so its match history, artwork and favourite rows are its own again.
    const departed = store.departed();
    const resumedId = await departedIdFor(departed, root);
    const library: LibraryRecord = {
      id: resumedId ?? newLibraryId(), name, type, root, enabled: true,
      order: store.libraries().reduce((next, item) => Math.max(next, item.order + 1), 0),
      addedAt: new Date().toISOString(),
      ...(health.unreachable ? { unreachable: true } : {}),
      ...(health.readOnly ? { readOnly: true } : {}),
      // Off unless asked for: a new library points at somebody's existing tree as often as
      // not, and writing poster.jpg into it is the one thing that cannot be taken back.
      writeArtwork: req.body?.writeArtwork === true && !health.readOnly,
    };
    await store.update((state) => {
      state.libraries = [...(state.libraries ?? []), library];
      if (resumedId) state.departed = (state.departed ?? []).filter((entry) => entry.id !== resumedId);
    });
    // The library's directory for generated thumbnails is created with the library, not left to
    // whichever writer happens to come first.
    await mkdir(artworks.dirOf(library.id), { recursive: true }).catch(() => undefined);
    invalidateLibrary();
    await refreshLibraryHealth();
    if (resumedId) log("INFO", "Library added again, it keeps what it remembered", { library: library.id, root: library.root, type });
    else log("INFO", "Library created", { library: library.id, root: library.root, type });
    res.status(201).json(libraryView(library, health, { titles: 0, files: 0, bytes: 0 }));
  }));

  app.get("/api/libraries/browse", asyncRoute(async (req, res) => {
    const requested = String(req.query.path ?? "").trim();
    const grants = libraryGrants();
    if (!requested) {
      const rows = (await grantRows()).map((grant) => ({
        name: posixBase(grant.path) || grant.path, path: grant.path, source: grant.source,
        writable: grant.writable, ...libraryFlag(store.libraries(), grant.path),
      }));
      res.json({ path: "", parent: null, entries: rows });
      return;
    }
    const inside = await grantingRoot(grants, requested);
    if (!inside) throw new AppError("That folder is outside every granted root.", "err.libraryRootNotGranted", 403);
    const dir = path.resolve(requested);
    if (!(await stat(dir).catch(() => undefined))?.isDirectory()) throw new AppError("The folder does not exist.", "err.pathMissing");
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const rows = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      // A symlink out of the grant is not listed at all, rather than listed and then refused.
      if (!await insideGrant(grants, full)) continue;
      rows.push({
        name: entry.name, path: toPosix(full),
        writable: await access(full, constants.W_OK).then(() => true, () => false),
        ...libraryFlag(store.libraries(), full),
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name, "cs"));
    const up = path.dirname(dir);
    res.json({ path: toPosix(dir), parent: up !== dir && await insideGrant(grants, up) ? toPosix(up) : null, entries: rows });
  }));

  app.get("/api/libraries/grants", asyncRoute(async (_req, res) => { res.json(await grantRows()); }));

  app.post("/api/libraries/grants", asyncRoute(async (req, res) => {
    const raw = String(req.body?.path ?? "").trim();
    if (!raw) throw new AppError("Missing folder.", "err.missingFolder");
    if (!path.isAbsolute(raw)) throw new AppError("The path has to be absolute.", "err.libraryRootAbsolute");
    const root = path.resolve(raw);
    if (!(await stat(root).catch(() => undefined))?.isDirectory()) throw new AppError("The folder does not exist.", "err.pathMissing");
    // A grant is recorded, never inferred: the request names a folder that is already there.
    if (!store.grants().some((grant) => path.resolve(grant.path) === root)) {
      await store.update((state) => {
        state.grants = [...(state.grants ?? []), { path: root, source: "user", grantedAt: new Date().toISOString() }];
      });
      log("INFO", "Library root granted", { root });
    }
    res.status(201).json(await grantRows());
  }));

  app.delete("/api/libraries/grants", asyncRoute(async (req, res) => {
    const raw = String(req.body?.path ?? req.query.path ?? "").trim();
    if (!raw) throw new AppError("Missing folder.", "err.missingFolder");
    const root = path.resolve(raw);
    // An operator grant is rebuilt from the environment on the next boot, so only a grant
    // somebody made at the keyboard can be revoked.
    if (!store.grants().some((grant) => path.resolve(grant.path) === root)) {
      throw new AppError("That root was not granted here.", "err.grantNotFound", 404);
    }
    // Revoking disables the libraries under it. Nothing is deleted -- the media, the metadata
    // file and the artwork directory all stay, so granting the root again brings them back.
    const affected = store.libraries().filter((library) => isInside(path.resolve(library.root), root));
    await store.update((state) => {
      state.grants = (state.grants ?? []).filter((grant) => path.resolve(grant.path) !== root);
      state.libraries = (state.libraries ?? []).map((library) =>
        affected.some((item) => item.id === library.id) ? { ...library, enabled: false } : library);
    });
    // A revoked root disables the libraries under it: their content is withdrawn from
    // everybody at once, so everybody's hold on it goes with the switch.
    for (const library of affected) await stopContentAccess({ libraryId: library.id });
    invalidateLibrary();
    await refreshLibraryHealth();
    for (const library of affected) log("INFO", "Library disabled with its revoked grant", { library: library.id, root: library.root });
    res.json(await grantRows());
  }));

  /** How much of a candidate tree the estimate may touch. The walk is capped at depth 8
   *  already, but a folder with a hundred thousand files must not become a way to tie the
   *  server up with one request. */
  const PREVIEW_MAX_FILES = 20_000;
  const PREVIEW_DEADLINE_MS = 5_000;

  app.post("/api/libraries/preview", asyncRoute(async (req, res) => {
    const raw = String(req.body?.root ?? "").trim();
    if (!path.isAbsolute(raw)) throw new AppError("The root has to be an absolute path.", "err.libraryRootAbsolute");
    const root = path.resolve(raw);
    if (!await insideGrant(libraryGrants(), root)) {
      throw new AppError("That folder is outside every granted root.", "err.libraryRootNotGranted", 403);
    }
    if (!(await stat(root).catch(() => undefined))?.isDirectory()) throw new AppError("The folder does not exist.", "err.pathMissing");
    const budget: WalkBudget = { files: PREVIEW_MAX_FILES, until: Date.now() + PREVIEW_DEADLINE_MS };
    const files = await listVideos(root, "", 0, undefined, budget);
    const type = asLibraryType(req.body?.type) ?? "mixed";
    const units = titleUnits(files, type);
    // No addon is asked anything: the estimate is the walk plus what the state already knows.
    const library = store.libraries().find((item) => path.resolve(item.root) === root);
    const records = metaStore.qualifiedMeta();
    const identified = library
      ? units.filter((unit) => Boolean(knownTitleOf(libraryPath(library.id, unit.relative), records)?.id)).length
      : 0;
    res.json({
      root: toPosix(root), type, titles: units.length, identified, files: files.length,
      truncated: budget.files <= 0 || Date.now() > budget.until,
    });
  }));

  // The item routes come after every literal `/api/libraries/...` route: Express matches in
  // registration order, so a `:id` route above them would swallow `/libraries/grants`.
  app.patch("/api/libraries/:id", asyncRoute(async (req, res) => {
    const target = store.libraries().find((library) => library.id === req.params.id);
    if (!target) throw new AppError("The library was not found.", "err.libraryNotFound", 404);
    const patch: Partial<LibraryRecord> = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body?.name).trim();
      if (!name) throw new AppError("Give the library a name.", "err.libraryNameRequired");
      patch.name = name;
    }
    if (req.body?.type !== undefined) {
      const type = asLibraryType(req.body?.type);
      if (!type) throw new AppError("Unknown library type.", "err.libraryTypeUnknown");
      patch.type = type;
    }
    if (req.body?.enabled !== undefined) patch.enabled = req.body.enabled === true;
    if (req.body?.mosaic !== undefined) patch.mosaic = req.body.mosaic !== false;
    if (req.body?.showInContinueWatching !== undefined) patch.showInContinueWatching = req.body.showInContinueWatching !== false;
    if (req.body?.order !== undefined && Number.isFinite(Number(req.body.order))) patch.order = Number(req.body.order);
    if (req.body?.writeArtwork !== undefined) patch.writeArtwork = req.body.writeArtwork === true;
    if (req.body?.visibleTo !== undefined) {
      if (!Array.isArray(req.body.visibleTo)) throw new AppError("The list of accounts has to be an array.", "err.invalidRequest", 400);
      const wanted = new Set<string>();
      for (const value of req.body.visibleTo) {
        const id = String(value);
        const user = findUserById(store.users(), id);
        if (!user) throw new AppError("That account does not exist.", "err.unknownUser");
        // An administrator sees every library by role, so their id in the list would read as
        // though removing it took the library away.
        if (user.role === "admin") throw new AppError("An administrator already sees every library.", "err.adminAlwaysSees");
        wanted.add(id);
      }
      patch.visibleTo = [...wanted];
    }
    if (req.body?.root !== undefined) patch.root = await requireLibraryRoot(req.body.root, { exceptId: target.id, create: req.body?.create === true });
    // The default lives in the settings -- one id per kind, so claiming it takes it from
    // whoever held it -- but it reads as a property of the library, and that is where the
    // form sets it. `undefined` leaves the current choice alone.
    const claimsDefault = (kind: "movie" | "series") => {
      const value = req.body?.[kind === "movie" ? "defaultMovie" : "defaultSeries"];
      return value === undefined ? undefined : value === true;
    };

    const next = { ...target, ...patch };
    if (patch.root !== undefined) libraryProbe.invalidate(next.root);
    await refreshLibraryHealth();
    const health = await libraryProbe.cached(next.root);
    const record: LibraryRecord = { ...next, writeArtwork: next.writeArtwork && !health.readOnly };
    // The probe answers for the root as it is now; a stale `unreachable` on a disk that came
    // back would keep the library out of every walk.
    if (health.unreachable) record.unreachable = true; else delete record.unreachable;
    if (health.readOnly) record.readOnly = true; else delete record.readOnly;
    for (const kind of ["movie", "series"] as const) {
      if (claimsDefault(kind) !== true) continue;
      // Judged on the type the library ends the request with, so widening it and claiming the
      // default in one call is allowed, and narrowing it out of the kind is not.
      if (record.type !== kind && record.type !== "mixed") {
        throw new AppError(`A ${record.type} library cannot be the default for ${kind === "movie" ? "movies" : "series"}.`, "err.libraryDefaultType");
      }
    }
    // A visibleTo edit is a permission change for everybody it named, on both sides: the
    // accounts just removed are the ones whose in-flight requests most need to fail their
    // re-check, and a naive "everyone now listed" would miss exactly them.
    const bumped = patch.visibleTo === undefined ? [] : usersToBump(target.visibleTo, patch.visibleTo);
    await store.update((state) => {
      state.libraries = (state.libraries ?? []).map((library) => library.id === record.id ? record : library);
      if (bumped.length) state.users = bumpPermissions(state.users ?? [], bumped);
      // The default pickers resolve at use, so a type change only strands the kinds the new
      // type no longer serves.
      if (state.settings) {
        const serves = (kind: "movie" | "series") => record.type === kind || record.type === "mixed";
        if (!serves("movie") && state.settings.defaultMovieLibrary === record.id) state.settings.defaultMovieLibrary = "";
        if (!serves("series") && state.settings.defaultSeriesLibrary === record.id) state.settings.defaultSeriesLibrary = "";
        for (const kind of ["movie", "series"] as const) {
          const field = kind === "movie" ? "defaultMovieLibrary" : "defaultSeriesLibrary";
          const wanted = claimsDefault(kind);
          if (wanted === true) state.settings[field] = record.id;
          else if (wanted === false && state.settings[field] === record.id) state.settings[field] = "";
        }
      }
    });
    await sweepLibraryLoss(target, record);
    invalidateLibrary();
    await refreshLibraryHealth();
    const stats = await libraryStats();
    log("INFO", "Library updated", { library: record.id, root: record.root, type: record.type, enabled: record.enabled });
    res.json(libraryView(record, health, stats.get(record.id) ?? { titles: 0, files: 0, bytes: 0 }));
  }));

  app.delete("/api/libraries/:id", asyncRoute(async (req, res) => {
    const check = checkLibraryRemoval(store.libraries(), String(req.params.id));
    if (!check.ok) throw new AppError(check.message, check.messageKey, check.status);
    const target = check.library;
    // Only an explicit forget drops remembered data. The media is never touched either way.
    const forget = req.query.forget === "1";
    // Removing without forgetting leaves a note behind: the folder's identity, so that adding it
    // again is not a new library that has to be matched all over. The note is what makes the
    // dialog's promise true, and it is dropped with the rest when the user asks to forget.
    const realRoot = await realpath(path.resolve(target.root)).catch(() => path.resolve(target.root));
    const ownerId = accountIdOf(req);
    await store.update((state) => {
      state.libraries = (state.libraries ?? []).filter((library) => library.id !== target.id);
      const kept = activeDeparted(state.departed ?? []).filter((entry) => entry.id !== target.id);
      state.departed = forget ? kept : [...kept, { id: target.id, root: realRoot, removedAt: new Date().toISOString() }].slice(-DEPARTED_MAX);
      if (state.settings) {
        if (state.settings.defaultMovieLibrary === target.id) state.settings.defaultMovieLibrary = "";
        if (state.settings.defaultSeriesLibrary === target.id) state.settings.defaultSeriesLibrary = "";
      }
      if (!forget || !ownerId) return;
      mutateData(state, ownerId, (data) => {
        data.favorites = data.favorites.filter((key) => parseLibraryPath(key)?.libraryId !== target.id);
        data.progress = Object.fromEntries(Object.entries(progressOf(data)).filter(([key, value]) => {
          const owner = key.startsWith("file:") ? key.slice(5) : value.path ?? "";
          return parseLibraryPath(owner)?.libraryId !== target.id;
        }));
      });
    });
    await stopContentAccess({ libraryId: target.id });
    if (forget) {
      await metaStore.forget(target.id);
      await rm(artworks.dirOf(target.id), { recursive: true, force: true });
      await artworks.removedTree(artworks.dirOf(target.id));
    }
    invalidateLibrary();
    await refreshLibraryHealth();
    log("INFO", "Library removed", { library: target.id, root: target.root, forget });
    res.status(204).end();
  }));

  /** Re-rooting that carries the content over: the tree moves into the new folder first and the
   *  library only points at it once every item is across. Pointing without moving stays on
   *  `PATCH`, which is what `moveContent` keeps apart. */
  app.post("/api/libraries/:id/reroot", asyncRoute(async (req, res) => {
    const target = store.libraries().find((library) => library.id === req.params.id);
    if (!target) throw new AppError("The library was not found.", "err.libraryNotFound", 404);
    if (req.body?.moveContent !== true) throw new AppError("This route moves the content; set moveContent to true.", "err.invalidRequest", 400);
    const from = path.resolve(target.root);
    // The path-only refusals come first, over the input as it was given: `create` below can
    // make a folder, and a refused request must leave nothing behind.
    const paths = await checkRerootPaths({ from, to: path.resolve(String(req.body?.root ?? "").trim()), carveOuts: carveOuts(store.libraries(), target) });
    if (!paths.ok) throw new AppError(paths.message, paths.messageKey, paths.status);
    const root = await requireLibraryRoot(req.body?.root, { exceptId: target.id, create: req.body?.create === true });
    const items = await checkRerootItems({ from, to: root });
    if (!items.ok) throw new AppError(items.message, items.messageKey, items.status);
    const job = await libraryOps.enqueue({ op: "reroot", items: items.items, libraryId: target.id, from, to: root });
    res.status(202).json({ id: job.id });
  }));
}
