import { createHash } from "node:crypto";
import { lstat, open as openFile } from "node:fs/promises";
import { isPathWithin, resolveInside } from "./library.js";
import type { AppDatabase, Statement } from "./storage/app-database.js";
import { TrackedMap } from "./storage/tracked-map.js";

export const STILL_WRITING_MS = 10 * 60_000;
export const HASH_BUDGET_FILES = 500;
export const HASH_BUDGET_MS = 10 * 60_000;
export const INCOMPLETE_KEEP_PASSES = 4;
const HASH_CHUNK = 1024 * 1024;

export interface FingerprintWalkFile {
  relative: string;
  size: number;
  modified: string;
}

export interface FingerprintPair {
  libraryId: string;
  from: string;
  toLibraryId: string;
  to: string;
  folder: boolean;
}

export interface FingerprintRow {
  libraryId: string;
  relative: string;
  size: number;
  mtimeMs: number;
  hash?: string;
}

export interface FingerprintPairing {
  pairs: FingerprintPair[];
  ambiguous: number;
  vanished: FingerprintRow[];
  fresh: FingerprintRow[];
}

type Walk = { libraryId: string; root: string; files: FingerprintWalkFile[] };
type OpenFile = typeof import("node:fs/promises").open;
type CommitItem = { source: FingerprintRow; target: FingerprintRow };
type HashPass = { started: number; hashed: number; busy: () => boolean };

const pathKey = (libraryId: string, relative: string) => JSON.stringify([libraryId, relative]);
const qualified = (libraryId: string, relative: string) => `${libraryId}/${relative}`;
const mtimeOf = (modified: string) => {
  const parsed = Date.parse(modified);
  return Number.isFinite(parsed) ? parsed : 0;
};
const sameRow = (left: FingerprintRow | undefined, right: FingerprintRow | undefined) =>
  left?.size === right?.size && left?.mtimeMs === right?.mtimeMs && left?.hash === right?.hash;
const isFreshFile = (file: FingerprintWalkFile, now: number) =>
  !file.relative.endsWith(".part") && now - mtimeOf(file.modified) >= STILL_WRITING_MS;

function parentFolders(relative: string): string[] {
  const parts = relative.split("/");
  const folders: string[] = [];
  for (let depth = 1; depth < parts.length; depth += 1) folders.push(parts.slice(0, depth).join("/"));
  return folders;
}

/**
 * Pairs vanished fingerprint rows with eligible new files. `newHashes` is only used when a
 * caller already has the hash of a fresh path; reconciliation itself never hashes files.
 */
export function pairMoves(
  rows: readonly FingerprintRow[],
  walks: readonly Walk[],
  options: { now?: number; newHashes?: ReadonlyMap<string, string | null> } = {},
): FingerprintPairing {
  const now = options.now ?? Date.now();
  const present = new Map<string, FingerprintWalkFile>();
  const walkIds = new Set<string>();
  for (const walk of walks) {
    walkIds.add(walk.libraryId);
    for (const file of walk.files) present.set(pathKey(walk.libraryId, file.relative), file);
  }
  const vanished = rows
    .filter((row) => walkIds.has(row.libraryId) && !present.has(pathKey(row.libraryId, row.relative)))
    .map((row) => ({ ...row }))
    .sort((left, right) =>
      left.libraryId.localeCompare(right.libraryId) || left.relative.localeCompare(right.relative));
  const known = new Set(rows.map((row) => pathKey(row.libraryId, row.relative)));
  const fresh: FingerprintRow[] = [];
  for (const walk of walks) {
    for (const file of walk.files) {
      if (known.has(pathKey(walk.libraryId, file.relative))) continue;
      if (!isFreshFile(file, now)) continue;
      const hash = options.newHashes?.get(qualified(walk.libraryId, file.relative));
      fresh.push({
        libraryId: walk.libraryId,
        relative: file.relative,
        size: file.size,
        mtimeMs: mtimeOf(file.modified),
        ...(hash ? { hash } : {}),
      });
    }
  }
  fresh.sort((left, right) =>
    left.libraryId.localeCompare(right.libraryId) || left.relative.localeCompare(right.relative));

  const vanishedMatches = new Map<string, FingerprintRow[]>();
  const freshMatches = new Map<string, FingerprintRow[]>();
  const freshByTime = new Map<string, FingerprintRow[]>();
  const freshByHash = new Map<string, FingerprintRow[]>();
  const addTo = (index: Map<string, FingerprintRow[]>, key: string, row: FingerprintRow) => {
    const bucket = index.get(key);
    if (bucket) bucket.push(row); else index.set(key, [row]);
  };
  for (const row of fresh) {
    addTo(freshByTime, `${row.size}\0${row.mtimeMs}`, row);
    if (row.hash) addTo(freshByHash, `${row.size}\0${row.hash}`, row);
  }
  for (const from of vanished) {
    const candidates = new Map<string, FingerprintRow>();
    if (from.hash) {
      for (const to of freshByHash.get(`${from.size}\0${from.hash}`) ?? []) {
        candidates.set(pathKey(to.libraryId, to.relative), to);
      }
    } else {
      for (const to of freshByTime.get(`${from.size}\0${from.mtimeMs}`) ?? []) {
        candidates.set(pathKey(to.libraryId, to.relative), to);
      }
    }
    for (const to of candidates.values()) {
      const fromKey = pathKey(from.libraryId, from.relative);
      const toKey = pathKey(to.libraryId, to.relative);
      addTo(freshMatches, toKey, from);
      addTo(vanishedMatches, fromKey, to);
    }
  }

  const pairs: FingerprintPair[] = [];
  const matchedFrom = new Set<string>();
  const matchedTo = new Set<string>();
  for (const from of vanished) {
    const fromKey = pathKey(from.libraryId, from.relative);
    const targets = vanishedMatches.get(fromKey) ?? [];
    if (targets.length !== 1) continue;
    const to = targets[0]!;
    const toKey = pathKey(to.libraryId, to.relative);
    if ((freshMatches.get(toKey) ?? []).length !== 1) continue;
    matchedFrom.add(fromKey);
    matchedTo.add(toKey);
    pairs.push({
      libraryId: from.libraryId,
      from: from.relative,
      toLibraryId: to.libraryId,
      to: to.relative,
      folder: false,
    });
  }
  const ambiguousFrom = [...vanishedMatches.keys()].filter((key) => !matchedFrom.has(key)).length;
  // Only files that had a candidate and still were not paired are ambiguous; a plain new file
  // with no candidate at all is not.
  const ambiguousTo = [...freshMatches.keys()].filter((key) => !matchedTo.has(key)).length;
  return { pairs, ambiguous: ambiguousFrom + ambiguousTo, vanished, fresh };
}

/**
 * Replaces file pairs with the highest folder pairs that preserve every vanished suffix.
 * `absentFolders` contains qualified source folders known not to exist on disk.
 */
export function liftFolders(
  pairs: readonly FingerprintPair[],
  vanished: readonly FingerprintRow[],
  absentFolders?: ReadonlySet<string>,
  occupied?: (libraryId: string, folder: string) => boolean,
): FingerprintPair[] {
  const accepted = new Map(pairs.map((pair) => [
    pathKey(pair.libraryId, pair.from),
    pair,
  ]));
  const candidates = new Map<string, { libraryId: string; from: string }>();
  const pairsBelow = new Map<string, FingerprintPair[]>();
  const vanishedBelow = new Map<string, FingerprintRow[]>();
  for (const pair of pairs) {
    for (const from of parentFolders(pair.from)) {
      const key = pathKey(pair.libraryId, from);
      candidates.set(key, { libraryId: pair.libraryId, from });
      const found = pairsBelow.get(key);
      if (found) found.push(pair); else pairsBelow.set(key, [pair]);
    }
  }
  for (const row of vanished) {
    for (const from of parentFolders(row.relative)) {
      const key = pathKey(row.libraryId, from);
      const found = vanishedBelow.get(key);
      if (found) found.push(row); else vanishedBelow.set(key, [row]);
    }
  }
  const ordered = [...candidates.values()].sort((left, right) =>
    left.from.split("/").length - right.from.split("/").length
    || left.from.length - right.from.length
    || left.libraryId.localeCompare(right.libraryId)
    || left.from.localeCompare(right.from));

  const consumed = new Set<string>();
  const usedTargets = new Set<string>();
  const folders: FingerprintPair[] = [];
  for (const candidate of ordered) {
    const candidateKey = pathKey(candidate.libraryId, candidate.from);
    if (absentFolders && !absentFolders.has(candidateKey)) continue;
    const below = vanishedBelow.get(candidateKey) ?? [];
    if (!below.length || below.some((row) => !accepted.has(pathKey(row.libraryId, row.relative)))) continue;

    const sourcePairs = pairsBelow.get(candidateKey) ?? [];
    if (sourcePairs.every((pair) => consumed.has(pathKey(pair.libraryId, pair.from)))) continue;
    let to: string | undefined;
    let valid = true;
    for (const pair of sourcePairs) {
      const suffix = pair.from.slice(candidate.from.length + 1);
      if (!suffix || pair.to !== suffix && !pair.to.endsWith(`/${suffix}`)) {
        valid = false;
        break;
      }
      const destination = pair.to.slice(0, Math.max(0, pair.to.length - suffix.length - 1));
      if (!destination || (to !== undefined && to !== destination)) {
        valid = false;
        break;
      }
      to = destination;
    }
    if (!valid || to === undefined) continue;
    const toLibraryId = sourcePairs[0]!.toLibraryId;
    if (occupied?.(toLibraryId, to)) continue;
    const targetKey = pathKey(toLibraryId, to);
    if (usedTargets.has(targetKey)) continue;
    if (sourcePairs.some((pair) => pair.toLibraryId !== toLibraryId)) continue;

    usedTargets.add(targetKey);
    for (const pair of sourcePairs) consumed.add(pathKey(pair.libraryId, pair.from));
    folders.push({
      libraryId: candidate.libraryId,
      from: candidate.from,
      toLibraryId,
      to,
      folder: true,
    });
  }

  const files = pairs.filter((pair) => !consumed.has(pathKey(pair.libraryId, pair.from)));
  return [...folders, ...files];
}

/** Carries each pair and commits its fingerprint rows only after the carry succeeded, so a
 *  failed pair is found again by the next pass. `afterCarries` runs once every pair has been
 *  tried, failed ones included: first-seen stamping pairs a move by size and time on its own,
 *  and one pair that keeps failing must not stop new files being stamped for good. */
export async function carryMovePairs(
  pairs: readonly FingerprintPair[],
  carry: (pair: FingerprintPair) => Promise<void>,
  commit: (pair: FingerprintPair) => Promise<void>,
  afterCarries: () => void | Promise<void>,
): Promise<{ carried: number; failed: number }> {
  let carried = 0;
  let failed = 0;
  for (const pair of pairs) {
    try {
      await carry(pair);
      await commit(pair);
      carried += 1;
    } catch {
      failed += 1;
    }
  }
  await afterCarries();
  return { carried, failed };
}

export class LibraryFingerprints {
  private readonly now: () => number;
  private readonly open: OpenFile;
  private database?: AppDatabase;
  private loaded = false;
  private rows = new Map<string, FingerprintRow>();
  private readonly dirty = new TrackedMap<string, FingerprintRow | undefined>();
  private pending = new Map<string, CommitItem[]>();
  private chain: Promise<void> = Promise.resolve();
  private ambiguous = 0;
  private deferred = false;
  private hashPass?: HashPass;
  private readonly emptyWalkLibraries = new Set<string>();
  private readonly skippedWalks = new Set<string>();
  private readonly incompleteKeeps = new Map<string, number>();

  constructor(options: { now?: () => number; open?: OpenFile } = {}) {
    this.now = options.now ?? Date.now;
    this.open = options.open ?? openFile;
  }

  get lastAmbiguous(): number { return this.ambiguous; }
  get lastDeferred(): boolean { return this.deferred; }
  get lastSkippedWalks(): ReadonlySet<string> { return this.skippedWalks; }

  attachDatabase(database: AppDatabase): void {
    if (this.loaded) throw new Error("The library fingerprints database must be attached before load.");
    this.database = database;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.database) {
      const stored = await this.database.all<{ library_id: string; path: string; size: number; mtime_ms: number; hash: string | null }>(
        "SELECT library_id, path, size, mtime_ms, hash FROM file_fingerprints",
      );
      for (const row of stored) {
        this.rows.set(pathKey(row.library_id, row.path), {
          libraryId: row.library_id,
          relative: row.path,
          size: row.size,
          mtimeMs: row.mtime_ms,
          ...(row.hash ? { hash: row.hash } : {}),
        });
      }
    }
    this.loaded = true;
  }

  async reconcile(
    walks: Array<{ libraryId: string; root: string; files: FingerprintWalkFile[] }>,
    options: { busy?: () => boolean; complete?: boolean } = {},
  ): Promise<FingerprintPair[]> {
    this.ambiguous = 0;
    this.deferred = false;
    this.skippedWalks.clear();
    this.pending = new Map();
    if (!this.database || !this.loaded) return [];
    const rowsAtStart = [...this.rows.values()];
    const effectiveWalks: Walk[] = [];
    let emptyWalkDeferred = false;
    for (const walk of walks) {
      if (walk.files.length > 0) {
        this.emptyWalkLibraries.delete(walk.libraryId);
        effectiveWalks.push(walk);
        continue;
      }
      const hadRows = rowsAtStart.some((row) => row.libraryId === walk.libraryId);
      if (hadRows && !this.emptyWalkLibraries.has(walk.libraryId)) {
        this.emptyWalkLibraries.add(walk.libraryId);
        emptyWalkDeferred = true;
        this.skippedWalks.add(walk.libraryId);
        continue;
      }
      this.emptyWalkLibraries.add(walk.libraryId);
      effectiveWalks.push(walk);
    }
    const complete = (options.complete ?? true) && !emptyWalkDeferred;
    const now = this.now();
    this.beginHashPass(options.busy ?? (() => false));
    const candidates = await this.hashMoveCandidates(effectiveWalks, now);
    const pairing = pairMoves([...this.rows.values()], effectiveWalks, { now, newHashes: candidates.hashes });
    this.ambiguous = pairing.ambiguous;
    const walkedIds = new Set(effectiveWalks.map((walk) => walk.libraryId));
    // Only a pass that missed a library has to wait for it: on a complete pass the rows of a
    // library outside it (a disabled one keeps its rows) cannot be where a new file came from.
    const unseenSizes = new Set(complete ? [] : rowsAtStart
      .filter((row) => !walkedIds.has(row.libraryId))
      .map((row) => row.size));
    const freshKeys = new Set(pairing.fresh.map((file) => pathKey(file.libraryId, file.relative)));
    const skippedSizes = new Set<number>();
    for (const walk of effectiveWalks) {
      for (const file of walk.files) {
        if (this.rows.has(pathKey(walk.libraryId, file.relative)) || freshKeys.has(pathKey(walk.libraryId, file.relative))) continue;
        skippedSizes.add(file.size);
      }
    }

    const absent = await this.absentSourceFolders(pairing.vanished, effectiveWalks);
    const occupied = (libraryId: string, folder: string) =>
      [...this.rows.values()].some((row) =>
        row.libraryId === libraryId && isPathWithin(row.relative, folder));
    const pairs = liftFolders(pairing.pairs, pairing.vanished, absent, occupied);
    const walkFiles = new Map(effectiveWalks.flatMap((walk) =>
      walk.files.map((file) => [pathKey(walk.libraryId, file.relative), file] as const)));
    for (const pair of pairs) {
      const sources = [...this.rows.values()].filter((row) =>
        row.libraryId === pair.libraryId
        && (pair.folder ? isPathWithin(row.relative, pair.from) : row.relative === pair.from));
      const items: CommitItem[] = [];
      for (const source of sources) {
        const relative = pair.folder ? pair.to + source.relative.slice(pair.from.length) : pair.to;
        const file = walkFiles.get(pathKey(pair.toLibraryId, relative));
        if (!file) continue;
        const hash = candidates.hashes.get(qualified(pair.toLibraryId, relative));
        items.push({
          source,
          target: {
            libraryId: pair.toLibraryId,
            relative,
            size: file.size,
            mtimeMs: mtimeOf(file.modified),
            ...(hash ? { hash } : {}),
          },
        });
      }
      this.pending.set(this.pairKey(pair), items);
    }
    const pairedSources = new Set([...this.pending.values()].flatMap((items) =>
      items.map((item) => pathKey(item.source.libraryId, item.source.relative))));
    const pairedTargets = new Set([...this.pending.values()].flatMap((items) =>
      items.map((item) => pathKey(item.target.libraryId, item.target.relative))));
    const freshByKey = new Map(pairing.fresh.map((file) => [pathKey(file.libraryId, file.relative), file]));
    const next = new Map(this.rows);
    for (const [key, row] of this.rows) if (walkedIds.has(row.libraryId)) next.delete(key);

    for (const walk of effectiveWalks) {
      for (const file of walk.files) {
        const key = pathKey(walk.libraryId, file.relative);
        const existing = this.rows.get(key);
        if (existing) {
          const changed = existing.size !== file.size || existing.mtimeMs !== mtimeOf(file.modified);
          next.set(key, {
            libraryId: walk.libraryId,
            relative: file.relative,
            size: file.size,
            mtimeMs: mtimeOf(file.modified),
            ...(changed || !existing.hash ? {} : { hash: existing.hash }),
          });
          continue;
        }
        if (pairedTargets.has(key)) continue;
        const fresh = freshByKey.get(key);
        if (fresh
          && !candidates.deferredSizes.has(fresh.size)
          && !skippedSizes.has(fresh.size)
          && !unseenSizes.has(fresh.size)) {
          next.set(key, {
            libraryId: fresh.libraryId,
            relative: fresh.relative,
            size: fresh.size,
            mtimeMs: fresh.mtimeMs,
            ...(fresh.hash ? { hash: fresh.hash } : {}),
          });
        }
      }
    }
    for (const items of this.pending.values()) {
      for (const item of items) next.set(pathKey(item.source.libraryId, item.source.relative), item.source);
    }
    for (const row of pairing.vanished) {
      const key = pathKey(row.libraryId, row.relative);
      if (pairedSources.has(key)) continue;
      if (candidates.deferredSizes.has(row.size) || skippedSizes.has(row.size)) {
        next.set(key, row);
        this.deferred = true;
      } else if (!complete) {
        // A library missing from this pass may be where the file went, so the row waits for a
        // pass that saw them all. It does not hold back first-seen stamping: a share that stays
        // off for days must not stop new files being stamped in every other library.
        const kept = (this.incompleteKeeps.get(key) ?? 0) + 1;
        if (kept > INCOMPLETE_KEEP_PASSES) this.incompleteKeeps.delete(key);
        else {
          next.set(key, row);
          this.incompleteKeeps.set(key, kept);
        }
      }
    }
    const presentKeys = new Set(effectiveWalks.flatMap((walk) =>
      walk.files.map((file) => pathKey(walk.libraryId, file.relative))));
    for (const key of this.incompleteKeeps.keys()) {
      if (!next.has(key) || presentKeys.has(key) || pairedSources.has(key)) this.incompleteKeeps.delete(key);
    }

    const keys = new Set([...this.rows.keys(), ...next.keys()]);
    for (const key of keys) {
      const before = this.rows.get(key);
      const after = next.get(key);
      if (!sameRow(before, after)) this.dirty.set(key, after);
    }
    this.rows = next;
    await this.flush();
    return pairs;
  }

  async commitPair(pair: FingerprintPair): Promise<void> {
    if (!this.database || !this.loaded) return;
    const items = this.pending.get(this.pairKey(pair));
    if (!items) return;
    for (const item of items) {
      this.rows.delete(pathKey(item.source.libraryId, item.source.relative));
      this.rows.set(pathKey(item.target.libraryId, item.target.relative), item.target);
      this.dirty.set(pathKey(item.source.libraryId, item.source.relative), undefined);
      this.dirty.set(pathKey(item.target.libraryId, item.target.relative), item.target);
    }
    await this.flush();
    this.pending.delete(this.pairKey(pair));
  }

  async hashPending(roots: Map<string, string>, busy: () => boolean): Promise<number> {
    if (!this.database || !this.loaded) return 0;
    if (!this.hashPass) this.beginHashPass(busy);
    const pending = [...this.rows.values()]
      .filter((row) => !row.hash && roots.has(row.libraryId))
      .sort((left, right) =>
        left.libraryId.localeCompare(right.libraryId) || left.relative.localeCompare(right.relative));
    for (const row of pending) {
      if (!this.canHash()) break;
      const root = roots.get(row.libraryId);
      if (!root) continue;
      const file = resolveInside(root, row.relative);
      if (!file) continue;
      let handle: Awaited<ReturnType<OpenFile>> | undefined;
      try {
        handle = await this.open(file, "r");
        const info = await handle.stat();
        // The same reading of the time as the walk's (`mtime.toISOString()`), which rounds to the
        // millisecond: a truncated `mtimeMs` differs for about half the files on ext4 or btrfs.
        if (info.size !== row.size || mtimeOf(info.mtime.toISOString()) !== row.mtimeMs) continue;
        const hash = await contentHash(handle, row.size);
        this.rows.set(pathKey(row.libraryId, row.relative), {
          ...row,
          hash,
        });
        this.dirty.set(pathKey(row.libraryId, row.relative), this.rows.get(pathKey(row.libraryId, row.relative)));
        this.hashPass!.hashed += 1;
      } catch {
        // A file that vanished or became unreadable waits for the next complete walk.
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
    await this.flush();
    const hashed = this.hashPass?.hashed ?? 0;
    this.hashPass = undefined;
    return hashed;
  }

  trackedKeys(libraryId: string): string[] {
    return [...this.rows.values()]
      .filter((row) => row.libraryId === libraryId)
      .map((row) => row.relative)
      .sort();
  }

  has(libraryId: string, relative: string): boolean {
    return this.rows.has(pathKey(libraryId, relative));
  }

  async forget(libraryId: string): Promise<void> {
    if (!this.database || !this.loaded) return;
    this.emptyWalkLibraries.delete(libraryId);
    for (const [key, row] of this.rows) {
      if (row.libraryId !== libraryId) continue;
      this.rows.delete(key);
      this.incompleteKeeps.delete(key);
      this.dirty.set(key, undefined);
    }
    await this.flush();
  }

  async flush(): Promise<void> {
    if (!this.database || !this.dirty.hasDirty()) return;
    const next = this.chain.then(() => this.write());
    this.chain = next.catch(() => undefined);
    await next;
  }

  private async write(): Promise<void> {
    if (!this.database) return;
    const snapshot = this.dirty.snapshot();
    if (!snapshot.size) return;
    const statements: Statement[] = [];
    for (const key of snapshot.keys()) {
      const row = this.rows.get(key);
      statements.push(row
        ? {
            sql: "INSERT INTO file_fingerprints (library_id, path, size, mtime_ms, hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT (library_id, path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, hash = excluded.hash",
            params: [row.libraryId, row.relative, row.size, row.mtimeMs, row.hash ?? null],
          }
        : {
            sql: "DELETE FROM file_fingerprints WHERE library_id = ? AND path = ?",
            params: [JSON.parse(key)[0] as string, JSON.parse(key)[1] as string],
          });
    }
    await this.database.batch(statements);
    this.dirty.release(snapshot);
  }

  private beginHashPass(busy: () => boolean): void {
    this.hashPass = { started: this.now(), hashed: 0, busy };
  }

  private canHash(): boolean {
    const pass = this.hashPass;
    return Boolean(pass)
      && pass!.hashed < HASH_BUDGET_FILES
      && this.now() - pass!.started < HASH_BUDGET_MS
      && !pass!.busy();
  }

  private pairKey(pair: FingerprintPair): string {
    return JSON.stringify([pair.libraryId, pair.from, pair.toLibraryId, pair.to, pair.folder]);
  }

  private async hashMoveCandidates(
    walks: readonly Walk[],
    now: number,
  ): Promise<{ hashes: Map<string, string>; deferredSizes: Set<number> }> {
    const hashes = new Map<string, string>();
    const deferredSizes = new Set<number>();
    const roots = new Map(walks.map((walk) => [walk.libraryId, walk.root]));
    const walkedIds = new Set(walks.map((walk) => walk.libraryId));
    const present = new Set(walks.flatMap((walk) =>
      walk.files.map((file) => pathKey(walk.libraryId, file.relative))));
    const vanished = [...this.rows.values()].filter((row) =>
      walkedIds.has(row.libraryId) && !present.has(pathKey(row.libraryId, row.relative)));
    const hashedBySize = new Map<number, FingerprintRow[]>();
    for (const row of vanished) {
      if (!row.hash) continue;
      const hashed = hashedBySize.get(row.size);
      if (hashed) hashed.push(row); else hashedBySize.set(row.size, [row]);
    }

    for (const walk of walks) {
      const root = roots.get(walk.libraryId);
      if (!root) continue;
      for (const file of walk.files) {
        if (this.rows.has(pathKey(walk.libraryId, file.relative)) || !isFreshFile(file, now)) continue;
        if (!hashedBySize.has(file.size)) continue;
        if (!this.canHash()) {
          deferredSizes.add(file.size);
          continue;
        }
        const absolute = resolveInside(root, file.relative);
        if (!absolute) continue;
        let handle: Awaited<ReturnType<OpenFile>> | undefined;
        try {
          handle = await this.open(absolute, "r");
          const info = await handle.stat();
          if (info.size !== file.size) {
            deferredSizes.add(file.size);
            continue;
          }
          hashes.set(qualified(walk.libraryId, file.relative), await contentHash(handle, info.size));
          this.hashPass!.hashed += 1;
        } catch {
          // An unreadable candidate is not evidence of a move in this pass.
        } finally {
          await handle?.close().catch(() => undefined);
        }
      }
    }
    return { hashes, deferredSizes };
  }

  private async absentSourceFolders(vanished: readonly FingerprintRow[], walks: readonly Walk[]): Promise<Set<string>> {
    const roots = new Map(walks.map((walk) => [walk.libraryId, walk.root]));
    const folders = new Set<string>();
    for (const row of vanished) {
      const root = roots.get(row.libraryId);
      if (!root) continue;
      for (const relative of parentFolders(row.relative)) {
        const key = pathKey(row.libraryId, relative);
        if (folders.has(key)) continue;
        const absolute = resolveInside(root, relative);
        if (!absolute) continue;
        try {
          await lstat(absolute);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
            folders.add(key);
          }
        }
      }
    }
    return folders;
  }
}

async function contentHash(file: Awaited<ReturnType<OpenFile>>, size: number): Promise<string> {
  const digest = createHash("sha256");
  if (size === 0) return digest.digest("hex");
  const first = Buffer.allocUnsafe(HASH_CHUNK);
  const firstLength = Math.min(size, HASH_CHUNK);
  const firstRead = await file.read(first, 0, firstLength, 0);
  digest.update(first.subarray(0, firstRead.bytesRead));
  if (size <= HASH_CHUNK) return digest.digest("hex");

  const second = Buffer.allocUnsafe(HASH_CHUNK);
  const secondPosition = size <= 2 * HASH_CHUNK ? HASH_CHUNK : size - HASH_CHUNK;
  const secondLength = Math.min(HASH_CHUNK, size - secondPosition);
  const secondRead = await file.read(second, 0, secondLength, secondPosition);
  digest.update(second.subarray(0, secondRead.bytesRead));
  return digest.digest("hex");
}
