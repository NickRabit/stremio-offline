import { constants, type BigIntStats } from "node:fs";
import {
  access, copyFile, lstat, mkdir, open, readFile, readdir, unlink,
} from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ART_VARIANTS, artVariantKey, type ArtVariant } from "./artwork.js";
import type { ArtworkCache } from "./artwork-cache.js";
import { AppError } from "./errors.js";
import { renameWithRetry, syncDirectory } from "./fs-retry.js";
import type { LibraryActions } from "./library-actions.js";
import { holdsLibraryRoot, withinLibraryRoot, isPathWithin } from "./library.js";
import type { LibraryHealth } from "./library-probe.js";
import { renameAcross } from "./library-transfer.js";
import {
  libraryPath, parseLibraryPath, placed, posixBase, posixDir, resolveLibraryPath, sameFile,
  type LibraryRecord, type ResolvedPath,
} from "./libraries.js";
import { captureTransferIdentity, hasEvidence, reconcileTransfer, recoveryConflict, type RecoveryEvidence } from "./library-recovery.js";
import { isSidecarOf, renamedSidecar, subtitleSidecars } from "./library-sidecars.js";
import { log } from "./logger.js";
import { heldOverlap, type HeldPlace } from "./path-reservations.js";
import { assertStillAdmin } from "./roles.js";
import type { UserRecord } from "./users.js";

const JOURNAL_VERSION = 1;
const JOURNAL_FILE = /\.json$/;
const validIdentity = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

export interface RenameSidecar {
  from: string;
  to: string;
  sourceIdentity: string;
  targetIdentity: string | null;
}

export interface RenameArtwork {
  relative?: string;
  place: "file" | "folder";
  variant: ArtVariant;
  sha256: string;
}

export interface RenameIntent extends RecoveryEvidence {
  version: 1;
  kind: "rename";
  operationId: string;
  actorUserId: string;
  itemKind: "file" | "directory";
  caseOnly: boolean;
  from: string;
  to: string;
  sidecars: RenameSidecar[];
  artwork: RenameArtwork[];
}

export interface RenameRequest {
  actor: { id: string; secret: string } | undefined;
  source: ResolvedPath;
  target: ResolvedPath;
}

interface RenameRecoveryDeps {
  dataDir: string;
  libraries(): LibraryRecord[];
  users(): UserRecord[];
  carveOutsOf(library: LibraryRecord): ReadonlySet<string>;
  healthOf(library: LibraryRecord): LibraryHealth;
  refreshHealth(): Promise<unknown>;
  actions: Pick<LibraryActions, "relocateLibraryPath">;
  metaStore: { flushLibrary(id: string): Promise<void> };
  artworks: Pick<ArtworkCache, "dirOf" | "file" | "written" | "flush">;
  store: { flush(): Promise<void> };
  invalidateLibrary(): void;
}

interface StoredIntent {
  intent: RenameIntent;
  files: string[];
}

const failure = (error: unknown): string => error instanceof Error ? error.message : String(error);
const bareName = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value !== "." && value !== ".." && path.basename(value) === value;

async function optionalIdentity(target: string): Promise<string | undefined> {
  try {
    return await captureTransferIdentity(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw recoveryConflict();
  }
}

async function optionalInfo(target: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw recoveryConflict();
  }
}

async function artworkDigest(file: string): Promise<string | undefined> {
  const info = await optionalInfo(file);
  if (!info) return undefined;
  if (!info.isFile()) throw recoveryConflict();
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function syncFile(file: string): Promise<void> {
  const handle = await open(file, process.platform === "win32" ? "r+" : "r").catch(async (error: NodeJS.ErrnoException) => {
    if (process.platform === "win32" && (error.code === "EACCES" || error.code === "EPERM")) return open(file, "r");
    throw error;
  });
  try { await handle.sync(); } finally { await handle.close(); }
}

const artKey = (key: string, place: RenameArtwork["place"], variant: ArtVariant) =>
  artVariantKey(place === "folder" ? `dir:${key}` : key, variant);

const recordShape = (value: unknown): RenameIntent => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw recoveryConflict();
  const record = value as Partial<RenameIntent>;
  if (record.version !== JOURNAL_VERSION || record.kind !== "rename") throw recoveryConflict();
  if (typeof record.operationId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(record.operationId)) throw recoveryConflict();
  if (typeof record.actorUserId !== "string" || !record.actorUserId) throw recoveryConflict();
  if (record.itemKind !== "file" && record.itemKind !== "directory") throw recoveryConflict();
  if (typeof record.caseOnly !== "boolean" || typeof record.from !== "string" || typeof record.to !== "string") throw recoveryConflict();
  if ((record.phase !== "moving" && record.phase !== "published") || !hasEvidence(record)) throw recoveryConflict();
  const source = parseLibraryPath(record.from);
  const target = parseLibraryPath(record.to);
  if (!source?.relative || !target?.relative || source.libraryId !== target.libraryId) throw recoveryConflict();
  if (source.relative.split("/").some((part) => part === "." || part === "..")) throw recoveryConflict();
  if (target.relative.split("/").some((part) => part === "." || part === "..")) throw recoveryConflict();
  if (record.from !== libraryPath(source.libraryId, source.relative)
    || record.to !== libraryPath(target.libraryId, target.relative)) throw recoveryConflict();
  if (record.from === record.to
    || (record.phase === "moving" && record.publishedIdentity !== null)
    || (record.phase === "published" && record.publishedIdentity !== record.sourceIdentity)) throw recoveryConflict();
  if (posixDir(source.relative) !== posixDir(target.relative)) throw recoveryConflict();
  if (record.itemKind === "file" && path.extname(source.relative) !== path.extname(target.relative)) throw recoveryConflict();

  const sourceStem = posixBase(source.relative).slice(0, posixBase(source.relative).length - path.extname(source.relative).length);
  const targetStem = posixBase(target.relative).slice(0, posixBase(target.relative).length - path.extname(target.relative).length);
  if (!Array.isArray(record.sidecars) || !record.sidecars.every((sidecar) =>
    sidecar && typeof sidecar === "object"
    && bareName(sidecar.from) && bareName(sidecar.to)
    && validIdentity(sidecar.sourceIdentity)
    && (sidecar.targetIdentity === null || validIdentity(sidecar.targetIdentity))
    && isSidecarOf(sidecar.from, sourceStem) && sidecar.to === renamedSidecar(sidecar.from, sourceStem, targetStem))) {
    throw recoveryConflict();
  }
  if (record.itemKind === "directory" && record.sidecars.length) throw recoveryConflict();

  if (!Array.isArray(record.artwork)) throw recoveryConflict();
  const seen = new Set<string>();
  for (const art of record.artwork) {
    if (!art || typeof art !== "object") throw recoveryConflict();
    if (art.place !== "file" && art.place !== "folder") throw recoveryConflict();
    if (!ART_VARIANTS.includes(art.variant)) throw recoveryConflict();
    if (!validIdentity(art.sha256)) throw recoveryConflict();
    if (art.relative !== undefined && (record.itemKind !== "directory" || typeof art.relative !== "string"
      || art.relative.split("/").some(part => !bareName(part)))) throw recoveryConflict();
    const slot = `${art.relative ?? ""}\0${art.place}\0${art.variant}`;
    if (seen.has(slot)) throw recoveryConflict();
    seen.add(slot);
  }
  return record as RenameIntent;
};

export class LibraryRenameRecovery {
  private readonly dir: string;
  private records = new Map<string, StoredIntent>();
  private damaged = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: RenameRecoveryDeps) {
    this.dir = path.join(deps.dataDir, "library-rename-intents");
  }

  hasUnresolved(): boolean { return this.damaged > 0 || this.records.size > 0; }

  hasUnreadableRecord(): boolean { return this.damaged > 0; }

  busyKeys(): string[] {
    return [...this.records.values()].flatMap(({ intent }) => [intent.from, intent.to]);
  }

  conflicts(keys: readonly string[]): boolean {
    if (this.damaged) return true;
    return [...this.records.values()].some(({ intent }) => keys.some(key => this.overlaps(intent, key)));
  }

  /** Whether a rename in flight holds any of these places on disk. `conflicts` compares keys,
   *  which misses the same file reached through a nested library or a root typed through a
   *  link; this resolves the journaled names and compares where they are. */
  async holdsPlaces(places: readonly HeldPlace[]): Promise<boolean> {
    if (this.damaged) return true;
    const keys = this.busyKeys();
    if (!keys.length || !places.length) return false;
    const libraries = this.deps.libraries();
    const held = await Promise.all(keys.map(async (key) => {
      const resolved = await resolveLibraryPath(libraries, key).catch(() => undefined);
      return resolved && placed(resolved);
    }));
    return held.some((at) => at !== undefined && places.some((place) => heldOverlap(at, place, true)));
  }

  async load(): Promise<void> {
    await this.exclusive(async () => {
      await this.ensureDirectory();
      const entries = await readdir(this.dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const names: string[] = [];
      for (const entry of entries) {
        if (!JOURNAL_FILE.test(entry.name)) continue;
        if (!entry.isFile()) {
          this.damaged += 1;
          log("ERROR", "A rename intent is not a regular private file and is left for inspection", { file: entry.name });
          continue;
        }
        names.push(entry.name);
      }
      names.sort();
      const opened = new Map<string, { intent: RenameIntent; files: string[] }>();
      for (const name of names) {
        const file = path.join(this.dir, name);
        try {
          const intent = recordShape(JSON.parse(await readFile(file, "utf8")));
          const existing = opened.get(intent.operationId);
          if (!existing) {
            opened.set(intent.operationId, { intent, files: [file] });
          } else if (isDeepStrictEqual(existing.intent, intent)) {
            existing.files.push(file);
          } else {
            this.damaged += 1;
            log("ERROR", "Two different rename intents share an id, both are left for inspection", {
              operationId: intent.operationId, files: [existing.files[0], file],
            });
          }
        } catch (error) {
          this.damaged += 1;
          log("ERROR", "A rename intent could not be read and is left for inspection", { file: name, reason: failure(error) });
        }
      }

      if (this.damaged) return;
      for (const { intent, files } of opened.values()) {
        // Duplicate injections of one intent are the same operation. Keep one canonical copy before
        // publishing any proof updates, so a replay cannot make the copies disagree.
        const kept = [files[0]!];
        for (const duplicate of files.slice(1)) {
          await unlink(duplicate).then(() => undefined, () => { kept.push(duplicate); });
        }
        if (files.length > 1) await syncDirectory(this.dir);
        this.records.set(intent.operationId, { intent, files: kept });
      }

      const ordered = [...this.records.values()].sort((left, right) =>
        left.intent.from.localeCompare(right.intent.from)
        || left.intent.to.localeCompare(right.intent.to)
        || left.intent.operationId.localeCompare(right.intent.operationId));
      for (const record of ordered) {
        const conflict = ordered.some((other) => other !== record && (
          this.overlaps(record.intent, other.intent.from) || this.overlaps(record.intent, other.intent.to)));
        if (conflict) {
          log("ERROR", "Overlapping rename intents are left unresolved for inspection", {
            operationId: record.intent.operationId, from: record.intent.from, to: record.intent.to,
          });
          continue;
        }
        try {
          await this.recover(record);
          await this.remove(record.intent.operationId);
        } catch (error) {
          log("ERROR", "A rename intent is left unresolved for inspection", {
            operationId: record.intent.operationId,
            from: record.intent.from,
            to: record.intent.to,
            reason: failure(error),
          });
        }
      }
    });
  }

  async rename(request: RenameRequest): Promise<void> {
    await this.exclusive(async () => {
      await this.deps.refreshHealth();
      const source = await resolveLibraryPath(this.deps.libraries(), request.source.key);
      const target = await resolveLibraryPath(this.deps.libraries(), request.target.key);
      if (!source || !target || source.library.id !== target.library.id) throw recoveryConflict();
      if (this.conflicts([source.key, target.key])) {
        throw new AppError("The item is busy with another library operation.", "err.pathBusy", 409);
      }
      this.assertAvailable(source.library);
      assertStillAdmin(this.deps.users(), request.actor);
      if (!request.actor) throw recoveryConflict();
      await this.assertParent(source, target, source.library);

      const info = await optionalInfo(source.absolute);
      if (!info) throw new AppError("The file or folder does not exist.", "err.pathMissing");
      const caseOnly = this.isCaseOnly(source, target, source.library);
      if (source.key === target.key) return;
      if (!caseOnly) {
        const occupied = await optionalInfo(target.absolute);
        if (occupied) throw new AppError("A file with that name already exists.", "err.nameTaken");
      }
      const sourceIdentity = await optionalIdentity(source.absolute);
      if (!sourceIdentity) throw recoveryConflict();
      const sidecars = info.isFile() ? await this.prepareSidecars(source, target, info, source.library) : [];
      const artwork = await this.prepareArtwork(source, target, info.isDirectory());
      const intent: RenameIntent = {
        version: JOURNAL_VERSION,
        kind: "rename",
        operationId: randomUUID(),
        actorUserId: request.actor.id,
        itemKind: info.isDirectory() ? "directory" : "file",
        caseOnly,
        phase: "moving",
        from: source.key,
        to: target.key,
        sourceIdentity,
        publishedIdentity: null,
        sidecars,
        artwork,
      };
      assertStillAdmin(this.deps.users(), request.actor);
      await this.persist(intent, [this.fileFor(intent.operationId)]);
      this.records.set(intent.operationId, { intent, files: [this.fileFor(intent.operationId)] });
      await this.recover(this.records.get(intent.operationId)!);
      await this.remove(intent.operationId);
    });
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private overlaps(intent: RenameIntent, key: string): boolean {
    const wanted = key.toLowerCase();
    return [intent.from, intent.to].map(held => held.toLowerCase()).some(held => isPathWithin(held, wanted) || isPathWithin(wanted, held));
  }

  private fileFor(operationId: string): string {
    return path.join(this.dir, `rename-${operationId}.json`);
  }

  private async ensureDirectory(): Promise<void> {
    const created = await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (created) await syncDirectory(path.dirname(this.dir));
  }

  private async persist(intent: RenameIntent, files: string[]): Promise<void> {
    const shaped = recordShape(intent);
    await this.ensureDirectory();
    const targets = files.length ? files : [this.fileFor(shaped.operationId)];
    for (const target of targets) {
      const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(shaped, null, 2));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameWithRetry(temporary, target);
    }
    await syncDirectory(this.dir);
  }

  private async remove(operationId: string): Promise<void> {
    const stored = this.records.get(operationId);
    if (!stored) return;
    for (const file of stored.files) await unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await syncDirectory(this.dir);
    this.records.delete(operationId);
  }

  private assertAvailable(library: LibraryRecord): void {
    const health = this.deps.healthOf(library);
    if (!library.enabled || library.readOnly || health.unreachable || health.readOnly) throw recoveryConflict();
  }

  private async assertParent(source: ResolvedPath, target: ResolvedPath, library: LibraryRecord): Promise<void> {
    const exclusions = this.deps.carveOutsOf(library);
    const folded = this.deps.healthOf(library).caseInsensitive;
    for (const key of [source, target]) {
      if (holdsLibraryRoot(exclusions, key.relative, folded) || withinLibraryRoot(exclusions, key.relative, folded)) throw recoveryConflict();
    }
    const sourceParent = path.dirname(source.absolute);
    if (!sameFile(sourceParent, path.dirname(target.absolute), this.deps.healthOf(library).caseInsensitive)) {
      throw recoveryConflict();
    }
    const parent = await optionalInfo(sourceParent);
    if (!parent?.isDirectory()) throw recoveryConflict();
    await access(sourceParent, constants.W_OK).catch(() => { throw recoveryConflict(); });
  }

  private isCaseOnly(source: ResolvedPath, target: ResolvedPath, library: LibraryRecord): boolean {
    const from = posixBase(source.key);
    const to = posixBase(target.key);
    return from !== to && sameFile(from, to, this.deps.healthOf(library).caseInsensitive);
  }

  private async prepareSidecars(
    source: ResolvedPath,
    target: ResolvedPath,
    info: BigIntStats,
    library: LibraryRecord,
  ): Promise<RenameSidecar[]> {
    if (!info.isFile()) return [];
    const sidecars = await subtitleSidecars(source.absolute);
    const targetName = posixBase(target.key);
    const targetStem = targetName.slice(0, targetName.length - path.extname(targetName).length);
    const result: RenameSidecar[] = [];
    for (const name of sidecars.names) {
      const from = path.join(path.dirname(source.absolute), name);
      const to = path.join(path.dirname(target.absolute), renamedSidecar(name, sidecars.stem, targetStem));
      const sourceIdentity = await optionalIdentity(from);
      if (!sourceIdentity) throw recoveryConflict();
      const targetIdentity = await optionalIdentity(to);
      if (targetIdentity && !sameFile(from, to, this.deps.healthOf(library).caseInsensitive)) {
        log("INFO", "A subtitle stays behind because its new name is already occupied", { file: name });
      }
      result.push({ from: name, to: path.basename(to), sourceIdentity, targetIdentity: targetIdentity ?? null });
    }
    return result;
  }

  private async prepareArtwork(source: ResolvedPath, target: ResolvedPath, directory: boolean): Promise<RenameArtwork[]> {
    const result: RenameArtwork[] = [];
    const names = directory ? new Set(await readdir(this.deps.artworks.dirOf(source.library.id))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })) : undefined;
    if (names?.size === 0) return result;
    const inspect = async (relative: string, descend: boolean): Promise<void> => {
      const suffix = relative ? `/${relative}` : "";
      for (const place of ["file", "folder"] as const) {
        for (const variant of ART_VARIANTS) {
          const from = this.deps.artworks.file(artKey(source.key + suffix, place, variant));
          const to = this.deps.artworks.file(artKey(target.key + suffix, place, variant));
          if (names && !names.has(path.basename(from)) && !names.has(path.basename(to))) continue;
          const [digest, existing] = await Promise.all([artworkDigest(from), artworkDigest(to)]);
          if (existing !== undefined && existing !== digest) throw recoveryConflict();
          if (digest === undefined) continue;
          result.push({ ...(relative ? { relative } : {}), place, variant, sha256: digest });
        }
      }
      if (!descend) return;
      for (const entry of await readdir(path.join(source.absolute, relative), { withFileTypes: true })) {
        await inspect(path.posix.join(relative, entry.name), entry.isDirectory());
      }
    };
    await inspect("", directory);
    return result;
  }

  private async recover(record: StoredIntent): Promise<void> {
    let intent = recordShape(record.intent);
    await this.deps.refreshHealth();
    const libraries = this.deps.libraries();
    const source = await resolveLibraryPath(libraries, intent.from);
    const target = await resolveLibraryPath(libraries, intent.to);
    if (!source || !target || source.library.id !== target.library.id) throw recoveryConflict();
    const owner = this.deps.users().find((user) => user.id === intent.actorUserId);
    if (!owner || owner.role !== "admin" || owner.disabled) throw recoveryConflict();
    this.assertAvailable(source.library);
    await this.assertParent(source, target, source.library);

    const caseOnly = this.isCaseOnly(source, target, source.library);
    if (caseOnly !== intent.caseOnly) throw recoveryConflict();
    await this.checkArtwork(intent, false);
    await this.ensureVideo(intent, source, target, source.library, record);
    intent = record.intent;
    await syncDirectory(path.dirname(source.absolute));
    await this.carrySidecars(intent, source.library);
    await this.checkArtwork(intent, true);

    await this.deps.actions.relocateLibraryPath(intent.from, intent.to, false);
    await Promise.all([
      this.deps.metaStore.flushLibrary(source.library.id),
      this.deps.artworks.flush(),
      this.deps.store.flush(),
    ]);

    if (intent.caseOnly) {
      if (await this.caseOnlyEntry(source.absolute, target.absolute, intent.sourceIdentity, source.library, true) !== "finish") {
        throw recoveryConflict();
      }
    } else {
      await reconcileTransfer({ ...intent, phase: "published", publishedIdentity: intent.sourceIdentity },
        source.absolute, target.absolute, source.library.root, target.library.root);
    }
    this.deps.invalidateLibrary();
    log("INFO", "Renamed in the library", { from: intent.from, to: intent.to, operationId: intent.operationId });
  }

  private async ensureVideo(
    intent: RenameIntent,
    source: ResolvedPath,
    target: ResolvedPath,
    library: LibraryRecord,
    record: StoredIntent,
  ): Promise<void> {
    if (intent.caseOnly) {
      const result = await this.caseOnlyEntry(source.absolute, target.absolute, intent.sourceIdentity, library);
      if (result === "retry") {
        if (intent.phase === "published") throw recoveryConflict();
        await renameWithRetry(source.absolute, target.absolute);
        await syncDirectory(path.dirname(source.absolute));
        if (await this.caseOnlyEntry(source.absolute, target.absolute, intent.sourceIdentity, library, true) !== "finish") {
          throw recoveryConflict();
        }
      }
    } else {
      const decision = await reconcileTransfer(intent, source.absolute, target.absolute, source.library.root, target.library.root);
      if (decision === "retry") {
        const occupied = await optionalInfo(target.absolute);
        if (occupied) throw new AppError("A file with that name already exists.", "err.nameTaken");
        const info = await optionalInfo(source.absolute);
        const moved = info ? await renameAcross(source.absolute, target.absolute) : false;
        if (!moved) throw recoveryConflict();
        await syncDirectory(path.dirname(source.absolute));
        const [original, published] = await Promise.all([
          optionalIdentity(source.absolute), optionalIdentity(target.absolute),
        ]);
        if (original !== undefined || published !== intent.sourceIdentity) throw recoveryConflict();
      }
    }
    const publishedIdentity = await optionalIdentity(target.absolute);
    if (publishedIdentity !== intent.sourceIdentity) throw recoveryConflict();
    if (intent.phase !== "published" || intent.publishedIdentity !== intent.sourceIdentity) {
      const next = { ...intent, phase: "published" as const, publishedIdentity: intent.sourceIdentity };
      await this.replace(record, next);
    }
  }

  private async caseOnlyEntry(
    from: string,
    to: string,
    identity: string,
    library: LibraryRecord,
    requireTarget = false,
  ): Promise<"finish" | "retry"> {
    const parent = path.dirname(from);
    if (!sameFile(parent, path.dirname(to), this.deps.healthOf(library).caseInsensitive)) throw recoveryConflict();
    const sourceName = path.basename(from);
    const targetName = path.basename(to);
    const names = await readdir(parent).catch(() => { throw recoveryConflict(); });
    const sourceExact = names.includes(sourceName);
    const targetExact = names.includes(targetName);
    if (!sourceExact && !targetExact) throw recoveryConflict();
    if (targetExact) {
      const targetIdentity = await optionalIdentity(to);
      if (targetIdentity !== identity) throw recoveryConflict();
    }
    if (sourceExact) {
      const sourceIdentity = await optionalIdentity(from);
      if (sourceIdentity !== identity) throw recoveryConflict();
      if (sourceName !== targetName && targetExact) throw recoveryConflict();
      if (sourceName !== targetName) return "retry";
    }
    return requireTarget && !targetExact ? "retry" : "finish";
  }

  private async carrySidecars(intent: RenameIntent, library: LibraryRecord): Promise<void> {
    const sourceDir = path.dirname((await resolveLibraryPath(this.deps.libraries(), intent.from))!.absolute);
    const targetDir = path.dirname((await resolveLibraryPath(this.deps.libraries(), intent.to))!.absolute);
    for (const sidecar of intent.sidecars) {
      const from = path.join(sourceDir, sidecar.from);
      const to = path.join(targetDir, sidecar.to);
      const caseOnly = sameFile(from, to, this.deps.healthOf(library).caseInsensitive) && path.basename(from) !== path.basename(to);
      if (caseOnly) {
        // On a volume that folds case either spelling finds the file; nothing under any spelling
        // means it was removed while the rename ran, as below. A different file is still a conflict.
        if (await optionalIdentity(from) === undefined) {
          log("WARN", "A subtitle disappeared before the rename could carry it", { file: sidecar.from });
          continue;
        }
        const result = await this.caseOnlyEntry(from, to, sidecar.sourceIdentity, library);
        if (result === "retry") {
          await renameWithRetry(from, to);
          await syncDirectory(targetDir);
          if (await this.caseOnlyEntry(from, to, sidecar.sourceIdentity, library, true) === "retry") {
            throw recoveryConflict();
          }
        }
        continue;
      }

      if (sidecar.targetIdentity) continue;
      const sourceIdentity = await optionalIdentity(from);
      const targetIdentity = await optionalIdentity(to);
      if (sourceIdentity !== undefined && sourceIdentity !== sidecar.sourceIdentity) throw recoveryConflict();
      if (targetIdentity !== undefined) {
        if (targetIdentity === sidecar.sourceIdentity && sourceIdentity === undefined) continue;
        if (sourceIdentity !== undefined) {
          log("WARN", "A subtitle kept its old name because a different file already has the new one", { file: sidecar.from });
          continue;
        }
        throw recoveryConflict();
      }
      if (sourceIdentity === undefined) {
        // Gone under both names: removed outside the server while the rename ran. There is
        // nothing left to carry, and refusing would hold the journal -- and every scan behind
        // it -- for good, with the video and its bindings apart.
        log("WARN", "A subtitle disappeared before the rename could carry it", { file: sidecar.from });
        continue;
      }
      const moved = await renameAcross(from, to);
      if (!moved) throw recoveryConflict();
      await syncDirectory(targetDir);
      if (await optionalIdentity(to) !== sidecar.sourceIdentity) throw recoveryConflict();
    }
  }

  private artworkPaths(intent: RenameIntent, art: RenameArtwork): { source: string; target: string } {
    return {
      source: this.deps.artworks.file(artKey(intent.from + (art.relative ? `/${art.relative}` : ""), art.place, art.variant)),
      target: this.deps.artworks.file(artKey(intent.to + (art.relative ? `/${art.relative}` : ""), art.place, art.variant)),
    };
  }

  private async checkArtwork(intent: RenameIntent, publish: boolean): Promise<void> {
    for (const art of intent.artwork) {
      const { source, target } = this.artworkPaths(intent, art);
      const destination = await artworkDigest(target);
      if (destination !== undefined && destination !== art.sha256) throw recoveryConflict();
      if (destination === undefined) {
        if (await artworkDigest(source) !== art.sha256) throw recoveryConflict();
        if (!publish) continue;
        await copyFile(source, target, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        if (await artworkDigest(target) !== art.sha256) throw recoveryConflict();
      }
      if (publish) {
        await syncFile(target);
        await syncDirectory(path.dirname(target));
        await this.deps.artworks.written(target);
      }
    }
  }

  private async replace(record: StoredIntent, intent: RenameIntent): Promise<void> {
    await this.persist(intent, record.files);
    record.intent = intent;
  }
}
