import { createHash } from "node:crypto";
import { lstat, open as openFile } from "node:fs/promises";
import { resolveInside } from "./library.js";
import type { AppDatabase, Statement } from "./storage/app-database.js";
import { TrackedMap } from "./storage/tracked-map.js";

export const STILL_WRITING_MS = 10 * 60_000;
export const HASH_BUDGET_FILES = 500;
export const HASH_BUDGET_MS = 10 * 60_000;
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
    for (const to of freshByTime.get(`${from.size}\0${from.mtimeMs}`) ?? []) {
      candidates.set(pathKey(to.libraryId, to.relative), to);
    }
    if (from.hash) {
      for (const to of freshByHash.get(`${from.size}\0${from.hash}`) ?? []) {
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
    const targetKey = pathKey(sourcePairs[0]!.toLibraryId, to);
    if (usedTargets.has(targetKey)) continue;
    if (sourcePairs.some((pair) => pair.toLibraryId !== sourcePairs[0]!.toLibraryId)) continue;

    usedTargets.add(targetKey);
    for (const pair of sourcePairs) consumed.add(pathKey(pair.libraryId, pair.from));
    folders.push({
      libraryId: candidate.libraryId,
      from: candidate.from,
      toLibraryId: sourcePairs[0]!.toLibraryId,
      to,
      folder: true,
    });
  }

  const files = pairs.filter((pair) => !consumed.has(pathKey(pair.libraryId, pair.from)));
  return [...folders, ...files];
}

export class LibraryFingerprints {
  private readonly now: () => number;
  private readonly open: OpenFile;
  private database?: AppDatabase;
  private loaded = false;
  private rows = new Map<string, FingerprintRow>();
  private readonly dirty = new TrackedMap<string, FingerprintRow | undefined>();
  private chain: Promise<void> = Promise.resolve();
  private ambiguous = 0;

  constructor(options: { now?: () => number; open?: OpenFile } = {}) {
    this.now = options.now ?? Date.now;
    this.open = options.open ?? openFile;
  }

  get lastAmbiguous(): number { return this.ambiguous; }

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

  async reconcile(walks: Array<{ libraryId: string; root: string; files: FingerprintWalkFile[] }>): Promise<FingerprintPair[]> {
    this.ambiguous = 0;
    if (!this.database || !this.loaded) return [];
    const now = this.now();
    const newHashes = await this.hashMoveCandidates(walks, now);
    const pairing = pairMoves([...this.rows.values()], walks, { now, newHashes });
    this.ambiguous = pairing.ambiguous;
    const pairedByTarget = new Map<string, FingerprintPair>();
    for (const pair of pairing.pairs) pairedByTarget.set(pathKey(pair.toLibraryId, pair.to), pair);
    const freshByKey = new Map(pairing.fresh.map((file) => [pathKey(file.libraryId, file.relative), file]));
    const next = new Map(this.rows);
    const walkedIds = new Set(walks.map((walk) => walk.libraryId));
    for (const [key, row] of this.rows) if (walkedIds.has(row.libraryId)) next.delete(key);

    for (const walk of walks) {
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
        const paired = pairedByTarget.get(key);
        if (paired) {
          const source = this.rows.get(pathKey(paired.libraryId, paired.from));
          if (source) {
            next.set(key, {
              libraryId: walk.libraryId,
              relative: file.relative,
              size: file.size,
              mtimeMs: mtimeOf(file.modified),
              ...(source.hash ? { hash: source.hash } : {}),
            });
          }
          continue;
        }
        const fresh = freshByKey.get(key);
        if (fresh) {
          next.set(key, {
            libraryId: fresh.libraryId,
            relative: fresh.relative,
            size: fresh.size,
            mtimeMs: fresh.mtimeMs,
          });
        }
      }
    }

    const keys = new Set([...this.rows.keys(), ...next.keys()]);
    for (const key of keys) {
      const before = this.rows.get(key);
      const after = next.get(key);
      if (!sameRow(before, after)) this.dirty.set(key, after);
    }
    this.rows = next;
    await this.flush();

    const absent = await this.absentSourceFolders(pairing.vanished, walks);
    return liftFolders(pairing.pairs, pairing.vanished, absent);
  }

  async hashPending(roots: Map<string, string>, busy: () => boolean): Promise<number> {
    if (!this.database || !this.loaded) return 0;
    const started = this.now();
    let hashed = 0;
    const pending = [...this.rows.values()]
      .filter((row) => !row.hash && roots.has(row.libraryId))
      .sort((left, right) =>
        left.libraryId.localeCompare(right.libraryId) || left.relative.localeCompare(right.relative));
    for (const row of pending) {
      if (hashed >= HASH_BUDGET_FILES || this.now() - started >= HASH_BUDGET_MS || busy()) break;
      const root = roots.get(row.libraryId);
      if (!root) continue;
      const file = resolveInside(root, row.relative);
      if (!file) continue;
      let handle: Awaited<ReturnType<OpenFile>> | undefined;
      try {
        handle = await this.open(file, "r");
        const info = await handle.stat();
        const hash = await contentHash(handle, info.size);
        this.rows.set(pathKey(row.libraryId, row.relative), {
          libraryId: row.libraryId,
          relative: row.relative,
          size: info.size,
          mtimeMs: info.mtimeMs,
          hash,
        });
        this.dirty.set(pathKey(row.libraryId, row.relative), this.rows.get(pathKey(row.libraryId, row.relative)));
        hashed += 1;
      } catch {
        // A file that vanished or became unreadable waits for the next complete walk.
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
    await this.flush();
    return hashed;
  }

  async forget(libraryId: string): Promise<void> {
    if (!this.database || !this.loaded) return;
    for (const [key, row] of this.rows) {
      if (row.libraryId !== libraryId) continue;
      this.rows.delete(key);
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

  private async hashMoveCandidates(walks: readonly Walk[], now: number): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    const roots = new Map(walks.map((walk) => [walk.libraryId, walk.root]));
    const walkedIds = new Set(walks.map((walk) => walk.libraryId));
    const present = new Set(walks.flatMap((walk) =>
      walk.files.map((file) => pathKey(walk.libraryId, file.relative))));
    const vanished = [...this.rows.values()].filter((row) =>
      walkedIds.has(row.libraryId) && !present.has(pathKey(row.libraryId, row.relative)));
    const vanishedBySize = new Map<number, FingerprintRow[]>();
    const hashedBySize = new Map<number, FingerprintRow[]>();
    for (const row of vanished) {
      const all = vanishedBySize.get(row.size);
      if (all) all.push(row); else vanishedBySize.set(row.size, [row]);
      if (!row.hash) continue;
      const hashed = hashedBySize.get(row.size);
      if (hashed) hashed.push(row); else hashedBySize.set(row.size, [row]);
    }

    for (const walk of walks) {
      const root = roots.get(walk.libraryId);
      if (!root) continue;
      for (const file of walk.files) {
        if (this.rows.has(pathKey(walk.libraryId, file.relative)) || !isFreshFile(file, now)) continue;
        const mtimeMs = mtimeOf(file.modified);
        if (!hashedBySize.has(file.size)) continue;
        if ((vanishedBySize.get(file.size) ?? []).some((row) => row.mtimeMs === mtimeMs)) continue;
        const absolute = resolveInside(root, file.relative);
        if (!absolute) continue;
        let handle: Awaited<ReturnType<OpenFile>> | undefined;
        try {
          handle = await this.open(absolute, "r");
          const info = await handle.stat();
          if (info.size !== file.size) continue;
          hashes.set(qualified(walk.libraryId, file.relative), await contentHash(handle, info.size));
        } catch {
          // An unreadable candidate waits for a later pass.
        } finally {
          await handle?.close().catch(() => undefined);
        }
      }
    }
    return hashes;
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
