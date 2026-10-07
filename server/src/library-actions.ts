import { lstat, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ART_VARIANTS, artVariantKey } from "./artwork.js";
import type { ArtworkCache } from "./artwork-cache.js";
import { AppError } from "./errors.js";
import { emptiedFolders, holdsLibraryRoot, isPathWithin, moveDestination, orphanedCatalogKeys, remapPath, type FoundFile } from "./library.js";
import { dropKeyed, knownTitleEntry, type LibraryMetaRecord, type TitleKind, type TitleUnit } from "./library-match.js";
import type { LibraryMetaStore } from "./library-meta-store.js";
import type { LibraryHealth } from "./library-probe.js";
import { libraryPath, parseLibraryPath, posixBase, posixJoin, resolveLibraryPath, toPosix, type LibraryRecord } from "./libraries.js";
import { placeholderOnly, removePlaceholder, transferLibraryPath, type TransferProgress } from "./library-transfer.js";
import { log } from "./logger.js";
import type { LibraryOp, OpsJournal } from "./library-ops.js";
import type { Store, StoredProgress, WatchlistEntry } from "./store.js";
import type { UserData } from "./users.js";

/** Every collaborator the library file operations reach for. `index.ts` hands them in so the
 *  operations can be exercised without booting the app; what is a plain helper elsewhere is
 *  imported straight into this module and named here only when it holds state. */
export interface LibraryActionDeps {
  store: Pick<Store, "libraries">;
  metaStore: Pick<LibraryMetaStore, "qualifiedMeta" | "update" | "relocate" | "copy" | "holds" | "flush">;
  artworks: Pick<ArtworkCache, "moveKey" | "copyKey">;
  libraryFiles(): Promise<FoundFile[]>;
  libraryUnits(): Promise<TitleUnit[]>;
  carveOutsOf(library: LibraryRecord): ReadonlySet<string>;
  healthOf(library: LibraryRecord): LibraryHealth;
  libraryOfKey(key: string): { library: LibraryRecord; relative: string };
  wirePath(key: string): string;
  mediaPath(key: string, ...rest: string[]): string;
  fileExists(file: string): Promise<boolean>;
  isFileKey(key: string): boolean;
  removeGeneratedArt(key: string): Promise<void>;
  ownRecord(relative: string, records: Record<string, LibraryMetaRecord>): LibraryMetaRecord | undefined;
  progressOf(data: UserData): Record<string, StoredProgress>;
  watchlistOf(data: UserData): Record<string, WatchlistEntry>;
  updateEveryData(mutate: (data: UserData) => void): Promise<void>;
  invalidateLibrary(): void;
  /** Keeps the thumbnail sweep off a library while an operation writes to it. */
  setLibraryOpsWriting(writing: boolean): void;
}

export interface LibraryActions {
  forgetLibraryPath(key: string): Promise<Set<string>>;
  remapPersonalState(key: string, nextKey: string): Promise<void>;
  relocateLibraryPath(key: string, nextKey: string, pin?: boolean): Promise<void>;
  relocateArtwork(items: string[], relative: string, nextRelative: string): Promise<void>;
  duplicateArtwork(items: string[], relative: string, nextRelative: string): Promise<void>;
  carryCoveringArtwork(cover: string, nextKey: string): Promise<void>;
  pruneEmptiedFolders(key: string): Promise<string[]>;
  deleteLibraryItem(relative: string): Promise<void>;
  assertMoveType(key: string, destination: LibraryRecord, confirmed?: boolean): Promise<void>;
  pathPresent(target: string): Promise<boolean>;
  finishTransfer(step: TransferStep, sourceLeft?: string, replay?: boolean): Promise<string>;
  recordPublished(step: { from: string; to: string }, journal?: OpsJournal): Promise<void>;
  resumeTransfer(step: TransferStep, journal?: OpsJournal): Promise<string | undefined>;
  transferLibraryItem(relative: string, folder: string, copy?: boolean, progress?: TransferProgress, confirmTypeMismatch?: boolean, journal?: OpsJournal): Promise<string>;
  rerootItem(operation: Extract<LibraryOp, { op: "reroot" }>, item: string, progress: (bytes: number, total?: number) => void, journal: OpsJournal): Promise<{ to: string }>;
}

/** What a queued move or copy is halfway through, written to the journal before the bytes
 *  move so a crash can be finished from it. */
export type TransferStep = {
  phase: "moving" | "published";
  copy: boolean;
  from: string;
  to: string;
  carried: string[];
  cover?: string;
};

/** What a queued `reroot` is halfway through: the item's bare name joined onto both roots,
 *  so the two ends are absolute paths rather than library keys. */
export type RerootStep = {
  kind: "reroot";
  phase: "moving" | "published";
  from: string;
  to: string;
};

// Deleting, renaming and moving touch real files, hence the path and root checks.
export function createLibraryActions(deps: LibraryActionDeps): LibraryActions {
  const {
    store, metaStore, artworks, libraryFiles, libraryUnits, carveOutsOf, healthOf, libraryOfKey,
    wirePath, mediaPath, fileExists, isFileKey, removeGeneratedArt, ownRecord, progressOf, watchlistOf,
    updateEveryData, invalidateLibrary, setLibraryOpsWriting,
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
      data.favorites = data.favorites.map((item) => remapPath(item, key, nextKey));
      data.progress = Object.fromEntries(Object.entries(progressOf(data)).map(([progressKey, value]) => {
        const filePath = progressKey.startsWith("file:") ? progressKey.slice(5) : undefined;
        const nextProgressKey = filePath ? `file:${remapPath(filePath, key, nextKey)}` : progressKey;
        const nextPath = value.path ? remapPath(value.path, key, nextKey) : value.path;
        return [nextProgressKey, { ...value, path: nextPath }];
      }));
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
          if (!result.carried && result.reason === "failed") {
            log("WARN", "A thumbnail could not follow its item", { from: moved, to: target, detail: result.detail });
          }
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
          if (!result.carried && result.reason === "failed") {
            log("WARN", "A thumbnail could not be copied to the item's new key", { from: copied, to: target, detail: result.detail });
          }
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
      if (!result.carried && result.reason === "failed") {
        log("WARN", "The picture of the folder a title is bound through could not travel with it", { cover, next: nextKey, variant, detail: result.detail });
      }
    }
  };

  /** The folder the last video just left is litter, so it goes too -- up the tree for as long
   *  as the parent holds nothing to watch either. */
  const pruneEmptiedFolders = async (key: string) => {
    const { library, relative } = libraryOfKey(key);
    const gone = await emptiedFolders(library.root, relative, carveOutsOf(library), healthOf(library).caseInsensitive);
    for (const folder of gone) {
      const folderKey = libraryPath(library.id, folder);
      await rm(mediaPath(folderKey), { recursive: true, force: true });
      await removeGeneratedArt(folderKey);
      await forgetLibraryPath(folderKey);
    }
    if (gone.length) log("INFO", "Emptied folders removed", { folders: gone });
    return gone;
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
    await rm(resolved.absolute, { recursive: true, force: true });
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

  /** A record the journal kept, read back defensively: anything that does not match is a
   *  record this build does not understand and is treated as no record at all. */
  const asTransferStep = (value: unknown): TransferStep | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const step = value as Partial<TransferStep>;
    if (step.phase !== "moving" && step.phase !== "published") return undefined;
    if (typeof step.copy !== "boolean" || typeof step.from !== "string" || typeof step.to !== "string") return undefined;
    if (!Array.isArray(step.carried) || !step.carried.every((item) => typeof item === "string")) return undefined;
    if (step.cover !== undefined && typeof step.cover !== "string") return undefined;
    return {
      phase: step.phase, copy: step.copy, from: step.from, to: step.to, carried: step.carried,
      ...(step.cover !== undefined ? { cover: step.cover } : {}),
    };
  };

  /** A re-root record the journal kept, read back defensively: anything else is a record this
   *  build does not understand and is treated as no record at all. */
  const asRerootStep = (value: unknown): RerootStep | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const step = value as Partial<RerootStep>;
    if (step.kind !== "reroot") return undefined;
    if (step.phase !== "moving" && step.phase !== "published") return undefined;
    if (typeof step.from !== "string" || typeof step.to !== "string") return undefined;
    return { kind: "reroot", phase: step.phase, from: step.from, to: step.to };
  };

  /** Plain existence, for the two absolute ends of a re-root: unlike `fileExists` a broken
   *  symlink still counts, which is what the recovery has to see. */
  const pathPresent = async (target: string) => { try { await lstat(target); return true; } catch { return false; } };

  /** The metadata half of a transfer, everything after the bytes have landed, and the way a
   *  record a crash left behind is finished. `sourceLeft` is the interrupted transfer's own
   *  report, so a resumed move logs the same warning an in-process one does. */
  const finishTransfer = async (step: TransferStep, sourceLeft?: string, replay = false) => {
    if (step.copy) {
      await metaStore.copy(step.from, step.to);
      // Both halves of a copy keep the picture: the item exists twice now.
      await duplicateArtwork(step.carried, step.from, step.to);
    }
    else {
      await relocateArtwork(step.carried, step.from, step.to);
      if (step.cover) await carryCoveringArtwork(step.cover, step.to);
      // A replay must not pin the folder's identity over the rows the first run already
      // carried: once the source holds nothing and the destination does, only the personal
      // rows are remapped. A first run always relocates, over any stale row at the target.
      if (!replay || metaStore.holds(step.from) || !metaStore.holds(step.to)) await metaStore.relocate(step.from, step.to, true);
      await remapPersonalState(step.from, step.to);
    }
    // Only the library the item left: the destination gained a folder, it did not lose one.
    const pruned = step.copy ? [] : await pruneEmptiedFolders(step.from);
    invalidateLibrary();
    const moved = wirePath(step.to);
    log("INFO", step.copy ? "Copied in the library" : "Moved in the library",
      { from: step.from, to: moved, library: parseLibraryPath(step.from)?.libraryId, pruned, ...(sourceLeft ? { sourceLeft } : {}) });
    // The item is not done while its metadata is still in the debounce.
    await metaStore.flush();
    return moved;
  };

  /** The `published` record is a shortcut for the next start, not a condition for finishing:
   *  the bytes have moved, so a failed write is logged and the metadata half still runs. The
   *  next start would read the `moving` record against the disk and land in the same place. */
  const recordPublished = async (step: { from: string; to: string }, journal?: OpsJournal) => {
    await journal?.record({ ...step, phase: "published" }).catch((error: unknown) =>
      log("WARN", "A finished transfer could not be recorded, finishing it anyway", { from: step.from, to: step.to, reason: error instanceof Error ? error.message : String(error) }));
  };

  /** Finishes an item a crash stopped in the middle of, from the record it left. Returns the
   *  wire path when the record was enough, or undefined when the transfer never landed and the
   *  normal path has to run from the start. */
  const resumeTransfer = async (step: TransferStep, journal?: OpsJournal): Promise<string | undefined> => {
    const source = await resolveLibraryPath(store.libraries(), step.from);
    const target = await resolveLibraryPath(store.libraries(), step.to);
    const sourceExists = source ? await fileExists(source.absolute) : false;
    const targetExists = target ? await fileExists(target.absolute) : false;
    if (step.phase === "published") return finishTransfer(step, undefined, true);
    // Neither end holds the bytes: nothing is guessed and nothing is deleted.
    if (!sourceExists && !targetExists) throw new AppError("The file or folder does not exist.", "err.pathMissing");
    // The transfer never landed: run the normal path from the start.
    if (sourceExists && !targetExists) return undefined;
    // Both ends hold something, but a target that is only the destination's reservation is not
    // a landed copy: the placeholder goes and the transfer runs from the start.
    if (sourceExists && source && target && await placeholderOnly(source.absolute, target.absolute)) {
      log("INFO", "A reserved destination held nothing, running the transfer again", { from: step.from, to: step.to });
      await removePlaceholder(source.absolute, target.absolute);
      return undefined;
    }
    // The copy landed but the source was not removed: nothing is deleted, and the outcome is
    // the one an interrupted transfer already reports.
    const interrupted = sourceExists && !step.copy;
    if (interrupted) log("WARN", "An interrupted move left its source behind", { from: step.from, to: step.to });
    await recordPublished(step, journal);
    return finishTransfer(step, interrupted ? "interrupted" : undefined, true);
  };

  const transferLibraryItem = async (relative: string, folder: string, copy = false, progress?: TransferProgress, confirmTypeMismatch = false, journal?: OpsJournal) => {
    const resolved = relative ? await resolveLibraryPath(store.libraries(), relative) : undefined;
    if (!resolved || !resolved.relative) throw new AppError("Invalid path.", "err.invalidPath");
    // A record a crash left for this item is finished from what it says, before the source's
    // absence is read as a missing item: a finished move leaves the source gone, which is
    // exactly the state that resumes here.
    const recorded = asTransferStep(journal?.recorded);
    if (recorded && recorded.from === resolved.key) {
      const resumed = await resumeTransfer(recorded, journal);
      if (resumed !== undefined) return resumed;
    }
    const info = await stat(resolved.absolute).catch(() => undefined);
    if (!info) throw new AppError("The file or folder does not exist.", "err.pathMissing");
    // Moving or copying the folder would take the nested library with it, and a copy would
    // leave a second set of its media for the next scan to adopt. The fold comes from the
    // volume the item sits on, which is the tree the carve-outs are compared in.
    if (holdsLibraryRoot(carveOutsOf(resolved.library), resolved.relative, healthOf(resolved.library).caseInsensitive)) {
      throw new AppError("This folder holds another library. Move that library out first.", "err.libraryHoldsAnother", 409);
    }

    const folderResolved = await resolveLibraryPath(store.libraries(), folder);
    if (!folderResolved) throw new AppError("Invalid path.", "err.invalidPath");
    const folderInfo = await stat(folderResolved.absolute).catch(() => undefined);
    if (!folderInfo?.isDirectory()) throw new AppError("The destination folder does not exist.", "err.targetMissing");

    // Into another library the item simply keeps its name: the two folders have nothing to
    // do with one another, so the checks that guard a move inside one do not apply.
    const acrossLibraries = folderResolved.library.id !== resolved.library.id;
    if (acrossLibraries) await assertMoveType(resolved.key, folderResolved.library, confirmTypeMismatch);
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
    if (!target) throw new AppError("Invalid path.", "err.invalidPath");
    if (await fileExists(target.absolute)) throw new AppError("A file with that name already exists.", "err.nameTaken");

    // The thumbnails are keyed by path, so they are carried over rather than dropped:
    // the item is the same item and would otherwise lose its poster until a rescan.
    const carried = [resolved.key, ...(await libraryFiles())
      .map((file) => file.relative).filter((item) => item !== resolved.key && isPathWithin(item, resolved.key))];
    // The folder a title is bound through, when the item does not carry the binding itself: its
    // picture is the title's and has to travel with it.
    const cover = knownTitleEntry(resolved.key, metaStore.qualifiedMeta());
    const step: TransferStep = {
      phase: "moving", copy, from: resolved.key, to: target.key, carried,
      ...(cover && cover.key !== resolved.key && isPathWithin(resolved.key, cover.key) ? { cover: cover.key } : {}),
    };
    // What is about to happen is on disk before the disk is touched.
    await journal?.record(step);
    const transferred = await transferLibraryPath(resolved.absolute, target.absolute, !copy, progress);
    await recordPublished(step, journal);
    return finishTransfer(step, transferred.sourceLeft);
  };

  /** One item of a `reroot`: a bare name of the old root joined onto both roots. Resolving it
   *  as a library key would throw before it ever moved. Returns the new wire path. */
  const rerootItem = async (operation: Extract<LibraryOp, { op: "reroot" }>, item: string, progress: (bytes: number, total?: number) => void, journal: OpsJournal) => {
    setLibraryOpsWriting(true);
    try {
      const source = path.join(operation.from, item);
      const target = path.join(operation.to, item);
      // A record a crash left for this same item is finished from what it says, before the
      // source's absence is read as a missing item: a finished re-root leaves the source
      // gone, which is exactly the state that resumes here.
      const recorded = asRerootStep(journal.recorded);
      if (recorded && recorded.from === source && recorded.to === target) {
        const sourceExists = await pathPresent(source);
        const targetExists = await pathPresent(target);
        if (recorded.phase === "published") return { to: toPosix(target) };
        // The move landed: the source is gone and the target holds it.
        if (!sourceExists && targetExists) return { to: toPosix(target) };
        // Both ends hold it: nothing is deleted, and the outcome is the one an interrupted
        // move already reports.
        if (sourceExists && targetExists) {
          // A target that is only the destination's reservation is not a landed copy: the
          // placeholder goes and the move runs from the start, below.
          if (await placeholderOnly(source, target)) {
            log("INFO", "A reserved re-root destination held nothing, running the move again", { from: source, to: target });
            await removePlaceholder(source, target);
          } else {
            log("WARN", "An interrupted re-root left its source behind", { from: source, to: target });
            return { to: toPosix(target) };
          }
        }
        // Neither end holds it: nothing is guessed and nothing is deleted.
        if (!sourceExists && !targetExists) throw new AppError("The file or folder does not exist.", "err.pathMissing");
        // The move never landed: run it from the start, below.
      }
      const step: RerootStep = { kind: "reroot", phase: "moving", from: source, to: target };
      // What is about to happen is on disk before the disk is touched.
      await journal.record(step);
      await transferLibraryPath(source, target, true, progress);
      await recordPublished(step, journal);
      return { to: toPosix(target) };
    } finally { setLibraryOpsWriting(false); }
  };

  return {
    forgetLibraryPath, remapPersonalState, relocateLibraryPath, relocateArtwork, duplicateArtwork,
    carryCoveringArtwork, pruneEmptiedFolders, deleteLibraryItem, assertMoveType, pathPresent,
    finishTransfer, recordPublished, resumeTransfer, transferLibraryItem, rerootItem,
  };
}
