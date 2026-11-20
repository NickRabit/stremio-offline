import { lstat, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { ART_VARIANTS, artVariantKey } from "./artwork.js";
import type { ArtworkCache, ArtworkCarry } from "./artwork-cache.js";
import { AppError } from "./errors.js";
import { foldersBetween, holdsLibraryRoot, isPathWithin, isVideo, moveDestination, orphanedCatalogKeys, remapPath, withinLibraryRoot, type FoundFile } from "./library.js";
import { dropKeyed, isAutomaticRecord, knownEntryForUnit, knownTitleEntry, type LibraryMetaRecord, type TitleKind, type TitleUnit } from "./library-match.js";
import type { LibraryMetaStore } from "./library-meta-store.js";
import type { LibraryHealth } from "./library-probe.js";
import { libraryPath, parseLibraryPath, posixBase, posixDir, posixJoin, resolveLibraryPath, toPosix, type LibraryRecord } from "./libraries.js";
import { transferLibraryPath, type TransferProgress } from "./library-transfer.js";
import { log } from "./logger.js";
import { captureTransferIdentity, hasEvidence, reconcileTransfer, recoveryConflict, type RecoveryEvidence } from "./library-recovery.js";
import { isSidecarOf, renamedSidecar, subtitleSidecars } from "./library-sidecars.js";
import type { LibraryOp, OpsJournal } from "./library-ops.js";
import type { LibrarySeenStore } from "./library-seen.js";
import type { Store, StoredProgress, WatchlistEntry } from "./store.js";
import type { UserData } from "./users.js";

/** Every collaborator the library file operations reach for. `index.ts` hands them in so the
 *  operations can be exercised without booting the app; what is a plain helper elsewhere is
 *  imported straight into this module and named here only when it holds state. */
export interface LibraryActionDeps {
  store: Pick<Store, "libraries">;
  metaStore: Pick<LibraryMetaStore, "qualifiedMeta" | "update" | "relocate" | "copy" | "holds" | "flushLibrary">;
  artworks: Pick<ArtworkCache, "moveKey" | "copyKey">;
  libraryFiles(): Promise<FoundFile[]>;
  libraryUnits(): Promise<TitleUnit[]>;
  carveOutsOf(library: LibraryRecord): ReadonlySet<string>;
  healthOf(library: LibraryRecord): LibraryHealth;
  libraryOfKey(key: string): { library: LibraryRecord; relative: string };
  wirePath(key: string): string;
  fileExists(file: string): Promise<boolean>;
  isFileKey(key: string): boolean;
  removeGeneratedArt(key: string): Promise<void>;
  ownRecord(relative: string, records: Record<string, LibraryMetaRecord>): LibraryMetaRecord | undefined;
  progressOf(data: UserData): Record<string, StoredProgress>;
  watchlistOf(data: UserData): Record<string, WatchlistEntry>;
  updateEveryData(mutate: (data: UserData) => void): Promise<void>;
  invalidateLibrary(): void;
  seen: Pick<LibrarySeenStore, "move">;
  /** Keeps the thumbnail sweep off a library while an operation writes to it. */
  setLibraryOpsWriting(writing: boolean): void;
}

export interface LibraryActions {
  forgetLibraryPath(key: string): Promise<Set<string>>;
  clearGeneratedArt(key: string): Promise<void>;
  remapPersonalState(key: string, nextKey: string): Promise<void>;
  relocateLibraryPath(key: string, nextKey: string, pin?: boolean): Promise<void>;
  relocateArtwork(items: string[], relative: string, nextRelative: string): Promise<void>;
  duplicateArtwork(items: string[], relative: string, nextRelative: string): Promise<void>;
  carryCoveringArtwork(cover: string, nextKey: string): Promise<void>;
  pruneEmptiedFolders(key: string): Promise<string[]>;
  deleteLibraryItem(relative: string): Promise<void>;
  assertMoveType(key: string, destination: LibraryRecord, confirmed?: boolean): Promise<void>;
  finishTransfer(step: TransferStep, sourceLeft?: string, replay?: boolean): Promise<string>;
  carryHandMove(fromKey: string, toKey: string, folder: boolean, files?: string[]): Promise<void>;
  resumeTransfer(step: TransferStep, journal?: OpsJournal): Promise<string | undefined>;
  transferLibraryItem(relative: string, folder: string, copy?: boolean, progress?: TransferProgress, confirmTypeMismatch?: boolean, journal?: OpsJournal): Promise<string>;
  rerootItem(operation: Extract<LibraryOp, { op: "reroot" }>, item: string, progress: (bytes: number, total?: number) => void, journal: OpsJournal): Promise<{ to: string }>;
}

/** What a queued move or copy is halfway through, written to the journal before the bytes
 *  move so a crash can be finished from it. */
export type TransferStep = RecoveryEvidence & {
  copy: boolean;
  from: string;
  to: string;
  carried: string[];
  /** The subtitle files that travel with a single video: bare file names, `from` beside the
   *  source and `to` beside the destination. Absent on a record an older build wrote. */
  sidecars: Array<{ from: string; to: string; identity?: string }>;
  cover?: string;
  /** The key of the title a single video belongs to when that title is keyed by a file (a loose
   *  film beside others in a collection folder): its identity is read the way the library view
   *  reads it, so the folder's binding is not pinned onto a film it does not describe. */
  unit?: string;
};

/** What a queued `reroot` is halfway through: the item's bare name joined onto both roots,
 *  so the two ends are absolute paths rather than library keys. */
export type RerootStep = RecoveryEvidence & {
  kind: "reroot";
  from: string;
  to: string;
};

// Deleting, renaming and moving touch real files, hence the path and root checks.
export function createLibraryActions(deps: LibraryActionDeps): LibraryActions {
  const {
    store, metaStore, artworks, libraryFiles, libraryUnits, carveOutsOf, healthOf, libraryOfKey,
    wirePath, fileExists, isFileKey, removeGeneratedArt, ownRecord, progressOf, watchlistOf,
    updateEveryData, invalidateLibrary, seen, setLibraryOpsWriting,
  } = deps;

  /** Everything the store remembers about a path, dropped in one go. Returns the catalogue
   *  titles that nothing points at any more, for the log. */
  const forgetLibraryPath = async (key: string) => {
    // The resume list and the watchlist are keyed by catalogue title, not by path, so a
    // deleted file would leave the title hanging in both, offering to continue something
    // that is no longer on disk. The match history knows the catalogue binding -- it is
    // read before this cleanup deletes it.
    const orphans = orphanedCatalogKeys(metaStore.qualifiedMeta(), key);
    const target = parseLibraryPath(key);
    if (target) await metaStore.update(target.libraryId, (file) => {
      file.meta = dropKeyed(file.meta, target.relative);
      file.suggestions = dropKeyed(file.suggestions, target.relative);
    });
    // Every account: the file is gone for all of them, so each one's stored rows have to lose
    // it. Fixing only the first leaves everybody else with a star and a resume position on a
    // path that no longer exists.
    await updateEveryData((data) => {
      data.favorites = data.favorites.filter((item) => !isPathWithin(item, key));
      data.progress = Object.fromEntries(Object.entries(progressOf(data)).filter(([progressKey, value]) => {
        if (orphans.has(progressKey)) return false;
        const itemPath = progressKey.startsWith("file:") ? progressKey.slice(5) : value.path;
        return !itemPath || !isPathWithin(itemPath, key);
      }));
      data.watchlist = Object.fromEntries(Object.entries(watchlistOf(data)).filter(([watchKey]) => !orphans.has(watchKey)));
    });
    return orphans;
  };

  /** The personal rows a move carries: the star and the resume position of every account. A
   *  deletion reaches them all for the same reason, and a replay of a move is harmless because
   *  the remap is idempotent. */
  const remapPersonalState = async (key: string, nextKey: string) => {
    await updateEveryData((data) => {
      data.favorites = [...new Set(data.favorites.map((item) => remapPath(item, key, nextKey)))];
      const progress = progressOf(data);
      const moved: typeof progress = {};
      for (const [progressKey, value] of Object.entries(progress)) {
        const filePath = progressKey.startsWith("file:") ? progressKey.slice(5) : undefined;
        const nextProgressKey = filePath ? `file:${remapPath(filePath, key, nextKey)}` : progressKey;
        const nextPath = value.path ? remapPath(value.path, key, nextKey) : value.path;
        const candidate = { ...value, path: nextPath };
        const current = moved[nextProgressKey];
        const candidateIsTarget = progress[nextProgressKey] === value;
        if (!current || (candidateIsTarget ? candidate.updatedAt >= current.updatedAt : candidate.updatedAt > current.updatedAt)) {
          moved[nextProgressKey] = candidate;
        }
      }
      data.progress = moved;
    });
  };

  /** Every stored binding uses the relative path, so a move has to keep them all consistent.
   *  `pin` is for a move into another folder: the identity an item inherited from the folder
   *  it is leaving has to become its own, or the destination's title would take over. */
  const relocateLibraryPath = async (key: string, nextKey: string, pin = false) => {
    // The bindings live in one file per library, so a move into another library rewrites two
    // of them and the store is the only place that can do both.
    await metaStore.relocate(key, nextKey, pin);
    await remapPersonalState(key, nextKey);
  };

  const checkArtwork = (result: ArtworkCarry, from: string, to: string) => {
    if (result.carried || result.reason === "absent") return;
    log("WARN", "Artwork transfer stopped", { from, to, reason: result.reason, detail: result.detail });
    if (result.reason === "conflict") throw recoveryConflict();
    throw new AppError("Could not save the library artwork.", "err.libraryArtworkWrite", 503);
  };

  /** Moves the hashed thumbnails of an item and of everything under it to their new keys. The
   *  cache creates the destination library's directory: `data/artwork/<libraryId>/` is made on a
   *  library's first thumbnail, so a move *between* libraries used to fail with `ENOENT` and lose
   *  the picture to the orphan sweep an hour later. */
  const relocateArtwork = async (items: string[], relative: string, nextRelative: string) => {
    for (const item of items) {
      const next = remapPath(item, relative, nextRelative);
      for (const [from, to] of [[item, next], [`dir:${item}`, `dir:${next}`]]) {
        for (const variant of ART_VARIANTS) {
          const moved = artVariantKey(from!, variant), target = artVariantKey(to!, variant);
          const result = await artworks.moveKey(moved, target);
          checkArtwork(result, moved, target);
        }
      }
    }
  };

  /** The same for a copy: the item exists twice now and both halves deserve the picture. */
  const duplicateArtwork = async (items: string[], relative: string, nextRelative: string) => {
    for (const item of items) {
      const next = remapPath(item, relative, nextRelative);
      for (const [from, to] of [[item, next], [`dir:${item}`, `dir:${next}`]]) {
        for (const variant of ART_VARIANTS) {
          const copied = artVariantKey(from!, variant), target = artVariantKey(to!, variant);
          const result = await artworks.copyKey(copied, target);
          checkArtwork(result, copied, target);
        }
      }
    }
  };

  /** A title bound through its folder keeps its picture under that folder's key. Moving the item
   *  out pins the binding on the item, so the picture has to follow it: without this the item
   *  shows up blank and the folder's copy is swept as an orphan an hour later. Copied rather than
   *  moved, because whatever stays in the folder is still that title's. */
  const carryCoveringArtwork = async (cover: string, nextKey: string) => {
    const to = isFileKey(nextKey) ? nextKey : `dir:${nextKey}`;
    for (const variant of ART_VARIANTS) {
      const result = await artworks.copyKey(artVariantKey(`dir:${cover}`, variant), artVariantKey(to, variant));
      checkArtwork(result, cover, nextKey);
    }
  };

  /** The folders the moved or deleted item left behind are removed only while each is truly
   *  empty. A picture, subtitle or any other file keeps its folder and everything above it. */
  const pruneEmptiedFolders = async (key: string) => {
    const { library, relative } = libraryOfKey(key);
    const carveOuts = carveOutsOf(library);
    const caseInsensitive = healthOf(library).caseInsensitive;
    const gone: string[] = [];
    for (let folder = posixDir(relative); folder; folder = posixDir(folder)) {
      if (holdsLibraryRoot(carveOuts, folder, caseInsensitive) || withinLibraryRoot(carveOuts, folder, caseInsensitive)) break;
      const folderKey = libraryPath(library.id, folder);
      const resolved = await resolveLibraryPath([library], folderKey);
      if (!resolved?.relative) break;
      try {
        await rmdir(resolved.absolute);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") {
          log("WARN", "Emptied-folder cleanup stopped", {
            folder: folderKey, reason: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }
      gone.push(folder);
      await removeGeneratedArt(folderKey);
      await forgetLibraryPath(folderKey);
    }
    if (gone.length) log("INFO", "Emptied folders removed", { folders: gone });
    return gone;
  };

  /** Generated thumbnails of a path and everything under it. A changed binding makes them stale:
   *  the poster of the old title, a season folder's picture, or a frame grabbed while unmatched. */
  const clearGeneratedArt = async (key: string) => {
    // One pass over the keys: a season folder sits between every episode in it and the title, and
    // removing it once per file would be thousands of lookups over a whole series.
    const keys = new Set<string>([key]);
    for (const file of await libraryFiles()) {
      if (file.relative === key || !isPathWithin(file.relative, key)) continue;
      keys.add(file.relative);
      // A season folder between the title and its files draws a picture of its own, and the new
      // binding makes that one stale exactly like the files' own.
      for (const folder of foldersBetween(key, file.relative)) keys.add(folder);
    }
    for (const target of keys) await removeGeneratedArt(target);
  };

  const deleteLibraryItem = async (relative: string) => {
    const resolved = relative ? await resolveLibraryPath(store.libraries(), relative) : undefined;
    if (!resolved || !resolved.relative) throw new AppError("Invalid path.", "err.invalidPath");
    const info = await stat(resolved.absolute).catch(() => undefined);
    if (!info) throw new AppError("The file or folder does not exist.", "err.pathMissing");
    // A recursive remove would take the nested library with it. The fold comes from the volume
    // this folder sits on: the carve-outs are compared as spellings inside this library's tree,
    // so this library's probe -- not the process's platform -- decides.
    if (holdsLibraryRoot(carveOutsOf(resolved.library), resolved.relative, healthOf(resolved.library).caseInsensitive)) {
      throw new AppError("This folder holds another library. Move that library out first.", "err.libraryHoldsAnother", 409);
    }
    // Read before the video goes: whether another video of the same name still uses them is a
    // question about the folder as it stands now.
    const sidecars = info.isFile() ? await subtitleSidecars(resolved.absolute) : { stem: "", names: [] };
    await rm(resolved.absolute, { recursive: true, force: true });
    for (const name of sidecars.names) {
      await rm(path.join(path.dirname(resolved.absolute), name), { force: true }).catch((error: unknown) => {
        log("WARN", "A subtitle of a deleted video could not be removed", { file: name, reason: error instanceof Error ? error.message : String(error) });
      });
    }
    await removeGeneratedArt(resolved.key);
    const orphans = await forgetLibraryPath(resolved.key);
    const pruned = await pruneEmptiedFolders(resolved.key);
    invalidateLibrary();
    log("INFO", "Deleted from the library", { path: relative, directory: info.isDirectory(), forgottenTitles: [...orphans], pruned });
  };

  /** The kind of the unit an item belongs to: its own binding first, the structure the source
   *  library gives it otherwise, because an unbound file carries no type of its own. */
  const unitKindOf = async (key: string): Promise<TitleKind | undefined> => {
    const record = ownRecord(key, metaStore.qualifiedMeta());
    if (record?.type === "movie" || record?.type === "series") return record.type;
    const covering = (await libraryUnits()).filter((unit) => isPathWithin(key, unit.key));
    return covering.sort((a, b) => b.key.length - a.key.length)[0]?.kind;
  };

  /** A typed library is a promise about what is inside it, and a move must not break it
   *  without being asked. `mixed` takes anything, and so does a unit whose kind nobody can
   *  name -- refusing that would block a move over a guess. Confirming is the owner's to
   *  do: nothing renders differently afterwards, only a later scan reads the item as the
   *  library's kind. */
  const assertMoveType = async (key: string, destination: LibraryRecord, confirmed = false) => {
    if (destination.type === "mixed") return;
    const kind = await unitKindOf(key);
    if (kind && kind !== destination.type) {
      if (!confirmed) {
        throw new AppError(`A ${destination.type} library does not take ${kind === "movie" ? "films" : "series"}.`,
          "err.libraryTypeMismatch", undefined, { type: destination.type, kind });
      }
      log("INFO", "A move into a library of another type was confirmed", { key, library: destination.id, type: destination.type, kind });
    }
  };

  /** A record the journal kept, read back defensively. A present but malformed record is a
   *  conflict; only an absent record allows a fresh operation. */
  const asTransferStep = (value: unknown): TransferStep | undefined => {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw recoveryConflict();
    const step = value as Partial<TransferStep>;
    if (step.phase !== "moving" && step.phase !== "published") throw recoveryConflict();
    if (typeof step.copy !== "boolean" || typeof step.from !== "string" || typeof step.to !== "string") throw recoveryConflict();
    if (!Array.isArray(step.carried) || !step.carried.every((item) => typeof item === "string")) throw recoveryConflict();
    const from = step.from;
    if (!step.carried.every(key => isPathWithin(key, from) && !key.split("/").some(part => part === "." || part === ".."))) throw recoveryConflict();
    if (step.cover !== undefined && (typeof step.cover !== "string" || !isPathWithin(from, step.cover))) throw recoveryConflict();
    const bareName = (name: unknown): name is string =>
      typeof name === "string" && name.length > 0 && name !== "." && name !== ".." && path.basename(name) === name;
    const sidecar = (item: unknown): item is TransferStep["sidecars"][number] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const pair = item as { from?: unknown; to?: unknown; identity?: unknown };
      return bareName(pair.from) && bareName(pair.to) && (pair.identity === undefined || typeof pair.identity === "string");
    };
    const sidecars = (value as { sidecars?: unknown }).sidecars;
    if (!Array.isArray(sidecars) || !sidecars.every(sidecar)) throw recoveryConflict();
    if (!hasEvidence(step)) throw recoveryConflict();
    const { sourceIdentity, publishedIdentity } = step;
    return {
      phase: step.phase, copy: step.copy, from: step.from, to: step.to, carried: step.carried,
      sourceIdentity, publishedIdentity,
      sidecars,
      ...(step.cover !== undefined ? { cover: step.cover } : {}),
    };
  };

  /** A re-root record the journal kept, read back defensively. */
  const asRerootStep = (value: unknown): RerootStep | undefined => {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw recoveryConflict();
    const step = value as Partial<RerootStep>;
    if (step.kind !== "reroot") throw recoveryConflict();
    if (step.phase !== "moving" && step.phase !== "published") throw recoveryConflict();
    if (typeof step.from !== "string" || typeof step.to !== "string") throw recoveryConflict();
    if (!hasEvidence(step)) throw recoveryConflict();
    const { sourceIdentity, publishedIdentity } = step;
    return {
      kind: "reroot", phase: step.phase, from: step.from, to: step.to, sourceIdentity, publishedIdentity,
    };
  };

  const carrySidecars = async (
    pairs: TransferStep["sidecars"],
    sourceDir: string,
    targetDir: string,
    copy: boolean,
    replay = false,
  ): Promise<void> => {
    for (const pair of pairs) {
      try {
        const from = path.join(sourceDir, pair.from);
        const to = path.join(targetDir, pair.to);
        if (!await fileExists(from)) continue;
        if (await fileExists(to)) {
          log("INFO", "A subtitle stayed behind, the destination already has one of that name", { file: pair.from });
          continue;
        }
        if (!pair.identity || await captureTransferIdentity(from) !== pair.identity) {
          log("WARN", "A subtitle stayed behind because its identity could not be verified", { file: pair.from });
          continue;
        }
        // A replay cannot know whether a subtitle still at the source was already handed to
        // the move. Keep that source and copy it, so no later folder prune can destroy it.
        await transferLibraryPath(from, to, replay ? false : !copy);
      } catch (error) {
        log("WARN", "A subtitle could not follow its video", {
          file: pair.from, reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  /** The metadata half of a transfer, everything after the bytes have landed, and the way a
   *  record a crash left behind is finished. `sourceLeft` is the interrupted transfer's own
   *  report, so a resumed move logs the same warning an in-process one does. */
  const finishTransfer = async (step: TransferStep, sourceLeft?: string, replay = false) => {
    // Verify the destination artwork before changing bindings. Keep the originals until the move commits.
    await duplicateArtwork(step.carried, step.from, step.to);
    if (step.copy) {
      await metaStore.copy(step.from, step.to, step.unit);
    }
    else {
      if (step.cover) await carryCoveringArtwork(step.cover, step.to);
      // A replay must not pin the folder's identity over the rows the first run already
      // carried: once the source holds nothing and the destination does, only the personal
      // rows are remapped. A first run always relocates, over any stale row at the target.
      if (!replay || metaStore.holds(step.from) || !metaStore.holds(step.to)) await metaStore.relocate(step.from, step.to, true, replay ? "replay" : "replace", step.unit);
      await relocateArtwork(step.carried, step.from, step.to);
      await remapPersonalState(step.from, step.to);
    }
    const targetId = libraryOfKey(step.to).library.id;
    const sourceId = libraryOfKey(step.from).library.id;
    await metaStore.flushLibrary(targetId);
    if (!step.copy && sourceId !== targetId) await metaStore.flushLibrary(sourceId);
    // Only the library the item left: the destination gained a folder, it did not lose one.
    const pruned = step.copy ? [] : await pruneEmptiedFolders(step.from);
    if (pruned.length) await metaStore.flushLibrary(sourceId);
    invalidateLibrary();
    const moved = wirePath(step.to);
    log("INFO", step.copy ? "Copied in the library" : "Moved in the library",
      { from: step.from, to: moved, library: parseLibraryPath(step.from)?.libraryId, pruned, ...(sourceLeft ? { sourceLeft } : {}) });
    return moved;
  };

  const carryHandMove = async (fromKey: string, toKey: string, folder: boolean, files?: string[]) => {
    const parsedFrom = parseLibraryPath(fromKey);
    const parsedTo = parseLibraryPath(toKey);
    if (!parsedFrom?.relative || !parsedTo?.relative) return;
    const targetFiles = folder ? files ?? (await libraryFiles()).map((file) => file.relative) : [];
    const carried = folder
      ? [fromKey, ...targetFiles
          .filter((item) => item !== toKey && isPathWithin(item, toKey))
          .map((item) => fromKey + item.slice(toKey.length))]
      : [fromKey];
    const target = metaStore.qualifiedMeta()[toKey];
    const manualTarget = Boolean(target && !isAutomaticRecord(target));
    const acrossLibraries = parsedFrom.libraryId !== parsedTo.libraryId;
    if (metaStore.holds(fromKey) && (acrossLibraries || !manualTarget)) {
      await metaStore.relocate(fromKey, toKey, true, manualTarget ? "keep-target" : "replace");
    }
    if (acrossLibraries) {
      await metaStore.flushLibrary(parsedTo.libraryId);
      await metaStore.flushLibrary(parsedFrom.libraryId);
    }
    await relocateArtwork(carried, fromKey, toKey);
    await remapPersonalState(fromKey, toKey);
    seen.move(parsedFrom.libraryId, parsedFrom.relative, parsedTo.libraryId, parsedTo.relative);
  };

  /** The `published` record is a shortcut for the next start, not a condition for finishing:
   *  the bytes have moved, so a failed write is logged and the metadata half still runs. The
   *  next start would read the `moving` record against the disk and land in the same place. */
  const recordPublished = async (step: TransferStep | RerootStep, journal?: OpsJournal) => {
    await journal?.record({ ...step, phase: "published" }).catch((error: unknown) =>
      log("WARN", "A finished transfer could not be recorded, finishing it anyway", { from: step.from, to: step.to, reason: error instanceof Error ? error.message : String(error) }));
  };

  const runTransfer = async (
    step: TransferStep | RerootStep, source: string, target: string, move: boolean,
    progress: TransferProgress | undefined, journal: OpsJournal | undefined,
  ) => {
    await journal?.record({ ...step });
    const result = await transferLibraryPath(source, target, move, progress, {
      beforePublish: async (staged) => {
        step.publishedIdentity = await captureTransferIdentity(staged);
        await journal?.record({ ...step });
      },
      beforeSourceRemoval: async () => {
        const [original, published] = await Promise.all([captureTransferIdentity(source), captureTransferIdentity(target)])
          .catch(() => { throw recoveryConflict(); });
        if (!original || !published || original !== step.sourceIdentity || published !== step.publishedIdentity) throw recoveryConflict();
      },
    });
    step.publishedIdentity ??= step.sourceIdentity;
    return result;
  };

  /** Finishes an item a crash stopped in the middle of, from the record it left. Returns the
   *  wire path when the record was enough, or undefined when the transfer never landed and the
   *  normal path has to run from the start. */
  const resumeTransfer = async (step: TransferStep, journal?: OpsJournal): Promise<string | undefined> => {
    const parsed = asTransferStep(step);
    if (!parsed) throw recoveryConflict();
    step = parsed;
    const source = await resolveLibraryPath(store.libraries(), step.from);
    const target = await resolveLibraryPath(store.libraries(), step.to);
    if (!source || !target) throw recoveryConflict();
    const decision = await reconcileTransfer(step, source.absolute, target.absolute, source.library.root, target.library.root, step.copy);
    const stemOf = (key: string) => posixBase(key).slice(0, posixBase(key).length - path.extname(key).length);
    const sourceStem = stemOf(source.key);
    const targetStem = stemOf(target.key);
    if (step.sidecars?.some((pair) => !isSidecarOf(pair.from, sourceStem) || !isSidecarOf(pair.to, targetStem))) {
      throw recoveryConflict();
    }
    if (decision === "retry") return undefined;
    await carrySidecars(step.sidecars, path.dirname(source.absolute), path.dirname(target.absolute), step.copy, true);
    await recordPublished({ ...step, publishedIdentity: step.publishedIdentity ?? step.sourceIdentity }, journal);
    return finishTransfer(step, undefined, true);
  };

  const transferLibraryItem = async (relative: string, folder: string, copy = false, progress?: TransferProgress, confirmTypeMismatch = false, journal?: OpsJournal) => {
    const resolved = relative ? await resolveLibraryPath(store.libraries(), relative) : undefined;
    const recorded = asTransferStep(journal?.recorded);
    if (!resolved || !resolved.relative) {
      if (recorded) throw recoveryConflict();
      throw new AppError("Invalid path.", "err.invalidPath");
    }
    // Moving or copying the folder would take the nested library with it, and a copy would
    // leave a second set of its media for the next scan to adopt. The fold comes from the
    // volume the item sits on, which is the tree the carve-outs are compared in.
    if (holdsLibraryRoot(carveOutsOf(resolved.library), resolved.relative, healthOf(resolved.library).caseInsensitive)) {
      throw new AppError("This folder holds another library. Move that library out first.", "err.libraryHoldsAnother", 409);
    }

    const folderResolved = await resolveLibraryPath(store.libraries(), folder);
    if (!folderResolved) {
      if (recorded) throw recoveryConflict();
      throw new AppError("Invalid path.", "err.invalidPath");
    }
    const folderInfo = await stat(folderResolved.absolute).catch(() => undefined);
    if (!folderInfo?.isDirectory()) {
      if (recorded) throw recoveryConflict();
      throw new AppError("The destination folder does not exist.", "err.targetMissing");
    }

    // Into another library the item simply keeps its name: the two folders have nothing to
    // do with one another, so the checks that guard a move inside one do not apply.
    const acrossLibraries = folderResolved.library.id !== resolved.library.id;
    const destination = acrossLibraries
      ? { path: posixJoin(folderResolved.relative, posixBase(resolved.relative)) }
      : moveDestination(resolved.relative, folderResolved.relative);
    if ("error" in destination) {
      throw destination.error === "sameFolder"
        ? new AppError("The item is already in that folder.", "err.sameFolder")
        : new AppError("A folder cannot be moved into itself.", "err.moveIntoItself");
    }
    // Qualified, so a destination in another library resolves under its own root.
    const target = await resolveLibraryPath(store.libraries(), libraryPath(folderResolved.library.id, destination.path));
    if (!target) {
      if (recorded) throw recoveryConflict();
      throw new AppError("Invalid path.", "err.invalidPath");
    }
    // The stored record must describe this same queued operation. A record for another item,
    // destination, or direction is not a safe starting point.
    if (recorded && (recorded.from !== resolved.key || recorded.to !== target.key || recorded.copy !== copy)) {
      throw recoveryConflict();
    }
    if (recorded) {
      const resumed = await resumeTransfer(recorded, journal);
      if (resumed !== undefined) return resumed;
    }
    if (acrossLibraries) await assertMoveType(resolved.key, folderResolved.library, confirmTypeMismatch);
    const info = await lstat(resolved.absolute, { bigint: true }).catch(() => undefined);
    if (!info) throw new AppError("The file or folder does not exist.", "err.pathMissing");
    if (await fileExists(target.absolute)) throw new AppError("A file with that name already exists.", "err.nameTaken");

    // The thumbnails are keyed by path, so they are carried over rather than dropped:
    // the item is the same item and would otherwise lose its poster until a rescan.
    const carried = [resolved.key, ...(await libraryFiles())
      .map((file) => file.relative).filter((item) => item !== resolved.key && isPathWithin(item, resolved.key))];
    // The folder a title is bound through, when the item does not carry the binding itself: its
    // picture is the title's and has to travel with it.
    // A title keyed by a video of its own does not inherit the folder's binding in the library
    // view; the move must not give it one either, nor carry the folder's picture to it.
    const ownTitle = info.isFile()
      ? (await libraryUnits()).find((unit) => unit.key === resolved.key || unit.sampleFiles.includes(resolved.key))
      : undefined;
    const unitKey = ownTitle && isVideo(posixBase(ownTitle.key)) ? ownTitle.key : undefined;
    const cover = unitKey
      ? knownEntryForUnit(unitKey, metaStore.qualifiedMeta(), resolved.key)
      : knownTitleEntry(resolved.key, metaStore.qualifiedMeta());
    // A single video's subtitles sit beside it, not inside it, so a move or copy of the file
    // alone would leave them behind and the player would stop offering them.
    const sidecars = info.isFile() ? await subtitleSidecars(resolved.absolute) : { stem: "", names: [] };
    const targetName = posixBase(target.key);
    const targetStem = targetName.slice(0, targetName.length - path.extname(targetName).length);
    const sidecarPairs = recorded?.sidecars ?? await Promise.all(sidecars.names.map(async (name) => ({
      from: name,
      to: renamedSidecar(name, sidecars.stem, targetStem),
      identity: await captureTransferIdentity(path.join(path.dirname(resolved.absolute), name)),
    })));
    const sourceIdentity = await captureTransferIdentity(resolved.absolute).catch(() => {
      throw recoveryConflict();
    });
    const step: TransferStep = {
      phase: "moving", copy, from: resolved.key, to: target.key, sourceIdentity, publishedIdentity: null,
      carried, sidecars: sidecarPairs,
      ...(cover && cover.key !== resolved.key && isPathWithin(resolved.key, cover.key) ? { cover: cover.key } : {}),
      ...(unitKey ? { unit: unitKey } : {}),
    };
    if (recorded && recorded.sourceIdentity !== sourceIdentity) throw recoveryConflict();
    const transferred = await runTransfer(step, resolved.absolute, target.absolute, !copy, progress, journal);
    await carrySidecars(sidecarPairs, path.dirname(resolved.absolute), path.dirname(target.absolute), copy);
    await recordPublished(step, journal);
    return finishTransfer(step, transferred.sourceLeft, Boolean(recorded));
  };

  /** One item of a `reroot`: a bare name of the old root joined onto both roots. Resolving it
   *  as a library key would throw before it ever moved. Returns the new wire path. */
  const rerootItem = async (operation: Extract<LibraryOp, { op: "reroot" }>, item: string, progress: (bytes: number, total?: number) => void, journal: OpsJournal) => {
    setLibraryOpsWriting(true);
    try {
      if (!item || item === "." || item === ".." || item.includes("/") || item.includes("\\") || item.includes("\0")) throw recoveryConflict();
      const source = path.join(operation.from, item);
      const target = path.join(operation.to, item);
      const recorded = asRerootStep(journal.recorded);
      if (recorded && (recorded.from !== source || recorded.to !== target)) throw recoveryConflict();
      if (recorded) {
        const owner = store.libraries().find(library => library.id === operation.libraryId);
        if (!owner || path.resolve(owner.root) !== path.resolve(operation.from)) throw recoveryConflict();
        const decision = await reconcileTransfer(recorded, source, target, operation.from, operation.to);
        if (decision === "finish") return { to: toPosix(target) };
      }
      const sourceIdentity = await captureTransferIdentity(source).catch(() => {
        throw recoveryConflict();
      });
      const step: RerootStep = {
        kind: "reroot", phase: "moving", from: source, to: target, sourceIdentity, publishedIdentity: null,
      };
      if (recorded && recorded.sourceIdentity !== sourceIdentity) throw recoveryConflict();
      await runTransfer(step, source, target, true, progress, journal);
      await recordPublished(step, journal);
      return { to: toPosix(target) };
    } finally { setLibraryOpsWriting(false); }
  };

  return {
    forgetLibraryPath, clearGeneratedArt, remapPersonalState, relocateLibraryPath, relocateArtwork, duplicateArtwork,
    carryCoveringArtwork, pruneEmptiedFolders, deleteLibraryItem, assertMoveType,
    finishTransfer, carryHandMove, resumeTransfer, transferLibraryItem, rerootItem,
  };
}
