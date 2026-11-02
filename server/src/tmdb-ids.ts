import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "./fs-retry.js";
import { log } from "./logger.js";
import type { AppDatabase, Statement } from "./storage/app-database.js";
import { moveToMigrationBackup } from "./storage/hourly-counts.js";
import { TrackedMap } from "./storage/tracked-map.js";

export type TmdbKind = "movie" | "series";

interface ImdbEntry {
  tmdb: number | null;
  at: number;
}

interface TmdbEntry {
  imdb: string | null;
  at: number;
}

interface IdFile {
  version: 1;
  byImdb: Record<string, ImdbEntry>;
  byTmdb: Record<string, TmdbEntry>;
}

const FILE_VERSION = 1;
const NEGATIVE_TTL_MS = 30 * 24 * 60 * 60_000;
const WRITE_INTERVAL_MS = 5_000;
const DEFAULT_LIMIT = 50_000;
const IMDB_ID = /^tt\d{5,}$/;
const DOMAIN = "tmdbIds";
const UPSERT = "INSERT INTO tmdb_ids (direction, key, value, at) VALUES (?, ?, ?, ?) ON CONFLICT (direction, key) DO UPDATE SET value = excluded.value, at = excluded.at";
const DELETE = "DELETE FROM tmdb_ids WHERE direction = ? AND key = ?";

const reasonOf = (error: unknown) =>
  error instanceof SyntaxError ? "Response body is not valid JSON." : error instanceof Error ? error.message : String(error);

const validKind = (kind: string): kind is TmdbKind => kind === "movie" || kind === "series";
const validAt = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const validTmdb = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

export class TmdbIdMap {
  private byImdb = new TrackedMap<string, ImdbEntry>();
  private byTmdb = new TrackedMap<string, TmdbEntry>();
  private file?: string;
  private database?: AppDatabase;
  private timer?: NodeJS.Timeout;
  private dirty = false;
  private saving: Promise<void> = Promise.resolve();
  private queued = false;
  private loaded = false;

  constructor(private readonly limit = DEFAULT_LIMIT) {}

  attachDatabase(database: AppDatabase): void {
    if (this.loaded) throw new Error("The TMDB id database must be attached before load.");
    this.database = database;
  }

  /** Reads the id file. A missing or malformed file leaves the map empty. */
  async load(file: string): Promise<void> {
    this.clear();
    this.file = file;
    this.loaded = true;
    if (this.database) {
      await this.loadDatabase(this.database, file);
      return;
    }
    const raw = await readFile(file, "utf8").catch(() => undefined);
    if (raw === undefined) return;
    try {
      const parsed = JSON.parse(raw) as Partial<IdFile>;
      if (parsed.version !== FILE_VERSION) return;
      this.loadImdb(parsed.byImdb);
      this.loadTmdb(parsed.byTmdb);
      this.orderOldest(this.byImdb);
      this.orderOldest(this.byTmdb);
      this.trim(this.byImdb);
      this.trim(this.byTmdb);
      this.byImdb.forget(this.byImdb.snapshot());
      this.byTmdb.forget(this.byTmdb.snapshot());
    } catch (error) {
      this.byImdb.clear();
      this.byTmdb.clear();
      this.byImdb.forget(this.byImdb.snapshot());
      this.byTmdb.forget(this.byTmdb.snapshot());
      log("WARN", "TMDB ids could not be read", { file: path.basename(file), reason: reasonOf(error) });
    }
  }

  tmdbOf(kind: TmdbKind, imdb: string, now = Date.now()): number | null | undefined {
    const entry = this.byImdb.get(`${kind}:${imdb}`);
    if (!entry) return undefined;
    return entry.tmdb ?? (now - entry.at < NEGATIVE_TTL_MS ? null : undefined);
  }

  imdbOf(kind: TmdbKind, tmdb: number, now = Date.now()): string | null | undefined {
    const entry = this.byTmdb.get(`${kind}:${tmdb}`);
    if (!entry) return undefined;
    return entry.imdb ?? (now - entry.at < NEGATIVE_TTL_MS ? null : undefined);
  }

  rememberPair(kind: TmdbKind, imdb: string, tmdb: number, now = Date.now()): void {
    if (!this.validPair(kind, imdb, tmdb)) return;
    if (this.byImdb.get(`${kind}:${imdb}`)?.tmdb === tmdb
      && this.byTmdb.get(`${kind}:${tmdb}`)?.imdb === imdb) return;
    this.set(this.byImdb, `${kind}:${imdb}`, { tmdb, at: now });
    this.set(this.byTmdb, `${kind}:${tmdb}`, { imdb, at: now });
    this.changed();
  }

  rememberNoTmdb(kind: TmdbKind, imdb: string, now = Date.now()): void {
    if (!validKind(kind) || !IMDB_ID.test(imdb)) return;
    const key = `${kind}:${imdb}`;
    const existing = this.byImdb.get(key);
    if (existing?.tmdb != null) return;
    if (existing?.tmdb === null && now - existing.at < NEGATIVE_TTL_MS) return;
    this.set(this.byImdb, key, { tmdb: null, at: now });
    this.changed();
  }

  rememberNoImdb(kind: TmdbKind, tmdb: number, now = Date.now()): void {
    if (!validKind(kind) || !validTmdb(tmdb)) return;
    const key = `${kind}:${tmdb}`;
    const existing = this.byTmdb.get(key);
    if (existing?.imdb != null) return;
    if (existing?.imdb === null && now - existing.at < NEGATIVE_TTL_MS) return;
    this.set(this.byTmdb, key, { imdb: null, at: now });
    this.changed();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty = false;
    this.byImdb.clear();
    this.byTmdb.clear();
    this.byImdb.forget(this.byImdb.snapshot());
    this.byTmdb.forget(this.byTmdb.snapshot());
  }

  async flush(): Promise<void> {
    for (;;) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      if (this.dirty) {
        this.dirty = false;
        try {
          await this.writeOnce();
        } catch (error) {
          this.dirty = true;
          throw error;
        }
      } else {
        await this.saving.catch(() => undefined);
      }
      if (!this.dirty) return;
    }
  }

  private validPair(kind: TmdbKind, imdb: string, tmdb: number): boolean {
    return validKind(kind) && IMDB_ID.test(imdb) && validTmdb(tmdb);
  }

  private set<T extends { at: number }>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key);
    map.set(key, value);
    this.trim(map);
  }

  /** The maps are kept in insertion order, oldest first, so the cap drops from the front
   *  instead of sorting every entry on each write. */
  private trim<T extends { at: number }>(map: Map<string, T>): void {
    for (const key of map.keys()) {
      if (map.size <= this.limit) return;
      map.delete(key);
    }
  }

  private changed(): void {
    if (!this.file && !this.database) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.dirty) return;
      this.dirty = false;
      void this.queueSave();
    }, WRITE_INTERVAL_MS);
    this.timer.unref?.();
  }

  private async queueSave(): Promise<void> {
    try {
      await this.writeOnce();
    } catch (error) {
      this.dirty = true;
      log("WARN", "TMDB ids could not be saved", { reason: reasonOf(error) });
    }
  }

  private writeOnce(): Promise<void> {
    // `queued` means a write is waiting for its turn, not that one is running: a change made while
    // a write is under way is not in that write's snapshot, so it needs a run of its own.
    if (this.queued) return this.saving;
    this.queued = true;
    const run = this.saving.catch(() => undefined).then(async () => {
      this.queued = false;
      if (this.database) {
        await this.writeDatabase(this.database);
        return;
      }
      const file = this.file;
      if (!file) return;
      const imdbSnapshot = this.byImdb.snapshot();
      const tmdbSnapshot = this.byTmdb.snapshot();
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      await writeFile(temp, JSON.stringify({
        version: FILE_VERSION,
        byImdb: Object.fromEntries(this.byImdb),
        byTmdb: Object.fromEntries(this.byTmdb),
      } satisfies IdFile), { mode: 0o600 });
      await renameWithRetry(temp, file);
      this.byImdb.forget(imdbSnapshot);
      this.byTmdb.forget(tmdbSnapshot);
    });
    this.saving = run;
    return this.saving;
  }

  private async writeDatabase(database: AppDatabase): Promise<void> {
    const imdbSnapshot = this.byImdb.snapshot();
    const tmdbSnapshot = this.byTmdb.snapshot();
    const statements: Statement[] = [];
    for (const key of imdbSnapshot.keys()) {
      const entry = this.byImdb.get(key);
      statements.push(entry
        ? { sql: UPSERT, params: ["imdb", key, entry.tmdb === null ? null : String(entry.tmdb), entry.at] }
        : { sql: DELETE, params: ["imdb", key] });
    }
    for (const key of tmdbSnapshot.keys()) {
      const entry = this.byTmdb.get(key);
      statements.push(entry
        ? { sql: UPSERT, params: ["tmdb", key, entry.imdb, entry.at] }
        : { sql: DELETE, params: ["tmdb", key] });
    }
    if (statements.length) {
      await database.batch(statements);
      this.byImdb.forget(imdbSnapshot);
      this.byTmdb.forget(tmdbSnapshot);
    }
  }

  private async loadDatabase(database: AppDatabase, file: string): Promise<void> {
    const marker = await database.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [`domain.${DOMAIN}`]);
    if (marker) {
      this.loadRows(await database.all("SELECT direction, key, value, at FROM tmdb_ids ORDER BY at, direction, key"));
      if (this.byImdb.hasDirty() || this.byTmdb.hasDirty()) this.changed();
      await this.moveJsonAside(database, String(Date.now()));
      return;
    }

    let raw: string | undefined;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const markerStatement = this.markerStatement({ importedAt: Date.now(), source: path.basename(file), count: 0 });
        await database.run(markerStatement.sql, markerStatement.params);
        return;
      }
      await this.markUnreadable(database, error);
      return;
    }

    let parsed: Partial<IdFile>;
    try {
      parsed = JSON.parse(raw) as Partial<IdFile>;
      if (!parsed || parsed.version !== FILE_VERSION) throw new SyntaxError("The TMDB id file has an unknown version.");
    } catch (error) {
      await this.markUnreadable(database, error);
      return;
    }

    this.loadImdb(parsed.byImdb);
    this.loadTmdb(parsed.byTmdb);
    this.orderOldest(this.byImdb);
    this.orderOldest(this.byTmdb);
    this.trim(this.byImdb);
    this.trim(this.byTmdb);
    const statements: Statement[] = [];
    for (const [key, entry] of this.byImdb) {
      statements.push({
        sql: UPSERT,
        params: ["imdb", key, entry.tmdb === null ? null : String(entry.tmdb), entry.at],
      });
    }
    for (const [key, entry] of this.byTmdb) {
      statements.push({ sql: UPSERT, params: ["tmdb", key, entry.imdb, entry.at] });
    }
    const importedAt = Date.now();
    statements.push(this.markerStatement({
      importedAt,
      source: path.basename(file),
      count: statements.length,
    }));
    await database.batch(statements);
    this.byImdb.forget(this.byImdb.snapshot());
    this.byTmdb.forget(this.byTmdb.snapshot());
    await this.moveJsonAside(database, String(importedAt));
  }

  private loadRows(rows: readonly {
    direction: string; key: string; value: string | null; at: number;
  }[]): void {
    for (const row of rows) {
      if (!validAt(row.at)) continue;
      if (row.direction === "imdb") {
        const match = /^(movie|series):(tt\d{5,})$/.exec(row.key);
        if (!match) continue;
        if (row.value === null) this.byImdb.set(row.key, { tmdb: null, at: row.at });
        else if (validTmdb(Number(row.value))) this.byImdb.set(row.key, { tmdb: Number(row.value), at: row.at });
      } else if (row.direction === "tmdb") {
        const match = /^(movie|series):(\d+)$/.exec(row.key);
        if (!match || !validTmdb(Number(match[2]))) continue;
        if (row.value === null) this.byTmdb.set(row.key, { imdb: null, at: row.at });
        else if (IMDB_ID.test(row.value)) this.byTmdb.set(row.key, { imdb: row.value, at: row.at });
      }
    }
    this.orderOldest(this.byImdb);
    this.orderOldest(this.byTmdb);
    this.byImdb.forget(this.byImdb.snapshot());
    this.byTmdb.forget(this.byTmdb.snapshot());
    this.trim(this.byImdb);
    this.trim(this.byTmdb);
  }

  private markerStatement(marker: Record<string, unknown>): Statement {
    return {
      sql: "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      params: [`domain.${DOMAIN}`, JSON.stringify(marker)],
    };
  }

  private async markUnreadable(database: AppDatabase, error: unknown): Promise<void> {
    const importedAt = Date.now();
    log("ERROR", "TMDB ids could not be imported", { reason: reasonOf(error) });
    await this.moveJsonAside(database, `unreadable-${importedAt}`);
    const marker = this.markerStatement({ importedAt, source: "unreadable", count: 0 });
    await database.run(marker.sql, marker.params);
    this.byImdb.clear();
    this.byTmdb.clear();
    this.byImdb.forget(this.byImdb.snapshot());
    this.byTmdb.forget(this.byTmdb.snapshot());
  }

  private async moveJsonAside(database: AppDatabase, suffix: string): Promise<void> {
    if (!this.file) return;
    const name = path.basename(this.file);
    const stem = name.endsWith(".json") ? name.slice(0, -5) : name;
    await moveToMigrationBackup(
      this.file,
      path.dirname(database.info.file),
      `${stem}-${suffix}.json`,
    );
  }

  private orderOldest<T extends { at: number }>(map: TrackedMap<string, T>): void {
    const ordered = [...map.entries()].sort((left, right) => left[1].at - right[1].at);
    map.clear();
    for (const [key, entry] of ordered) map.set(key, entry);
  }

  private loadImdb(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      const match = /^(movie|series):(tt\d{5,})$/.exec(key);
      if (!match || !entry || typeof entry !== "object") continue;
      const row = entry as Partial<ImdbEntry>;
      if (!validAt(row.at)) continue;
      if (row.tmdb === null) {
        this.byImdb.set(key, { tmdb: null, at: row.at });
      } else if (validTmdb(row.tmdb)) {
        this.byImdb.set(key, { tmdb: row.tmdb, at: row.at });
      }
    }
  }

  private loadTmdb(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      const match = /^(movie|series):(\d+)$/.exec(key);
      if (!match || !validTmdb(Number(match[2])) || !entry || typeof entry !== "object") continue;
      const row = entry as Partial<TmdbEntry>;
      if (!validAt(row.at)) continue;
      if (row.imdb === null) {
        this.byTmdb.set(key, { imdb: null, at: row.at });
      } else if (typeof row.imdb === "string" && IMDB_ID.test(row.imdb)) {
        this.byTmdb.set(key, { imdb: row.imdb, at: row.at });
      }
    }
  }
}

export const tmdbIds = new TmdbIdMap();
