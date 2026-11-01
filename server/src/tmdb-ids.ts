import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "./fs-retry.js";
import { log } from "./logger.js";

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

const reasonOf = (error: unknown) =>
  error instanceof SyntaxError ? "Response body is not valid JSON." : error instanceof Error ? error.message : String(error);

const validKind = (kind: string): kind is TmdbKind => kind === "movie" || kind === "series";
const validAt = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const validTmdb = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;
const oldestFirst = <T extends { at: number }>(map: Map<string, T>) =>
  new Map([...map.entries()].sort((left, right) => left[1].at - right[1].at));

export class TmdbIdMap {
  private byImdb = new Map<string, ImdbEntry>();
  private byTmdb = new Map<string, TmdbEntry>();
  private file?: string;
  private timer?: NodeJS.Timeout;
  private dirty = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly limit = DEFAULT_LIMIT) {}

  /** Reads the id file. A missing or malformed file leaves the map empty. */
  async load(file: string): Promise<void> {
    this.clear();
    this.file = file;
    const raw = await readFile(file, "utf8").catch(() => undefined);
    if (raw === undefined) return;
    try {
      const parsed = JSON.parse(raw) as Partial<IdFile>;
      if (parsed.version !== FILE_VERSION) return;
      this.loadImdb(parsed.byImdb);
      this.loadTmdb(parsed.byTmdb);
      this.byImdb = oldestFirst(this.byImdb);
      this.byTmdb = oldestFirst(this.byTmdb);
      this.trim(this.byImdb);
      this.trim(this.byTmdb);
    } catch (error) {
      this.byImdb.clear();
      this.byTmdb.clear();
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
    this.set(this.byImdb, `${kind}:${imdb}`, { tmdb, at: now });
    this.set(this.byTmdb, `${kind}:${tmdb}`, { imdb, at: now });
    this.changed();
  }

  rememberNoTmdb(kind: TmdbKind, imdb: string, now = Date.now()): void {
    if (!validKind(kind) || !IMDB_ID.test(imdb)) return;
    const key = `${kind}:${imdb}`;
    if (this.byImdb.get(key)?.tmdb != null) return;
    this.set(this.byImdb, key, { tmdb: null, at: now });
    this.changed();
  }

  rememberNoImdb(kind: TmdbKind, tmdb: number, now = Date.now()): void {
    if (!validKind(kind) || !validTmdb(tmdb)) return;
    const key = `${kind}:${tmdb}`;
    if (this.byTmdb.get(key)?.imdb != null) return;
    this.set(this.byTmdb, key, { imdb: null, at: now });
    this.changed();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty = false;
    this.byImdb.clear();
    this.byTmdb.clear();
  }

  async flush(): Promise<void> {
    for (;;) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      if (this.dirty) {
        this.dirty = false;
        this.queueSave();
      }
      await this.saving;
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
    if (!this.file) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.dirty) return;
      this.dirty = false;
      this.queueSave();
    }, WRITE_INTERVAL_MS);
    this.timer.unref?.();
  }

  private queueSave(): void {
    const file = this.file;
    if (!file) return;
    const data = JSON.stringify({
      version: FILE_VERSION,
      byImdb: Object.fromEntries(this.byImdb),
      byTmdb: Object.fromEntries(this.byTmdb),
    } satisfies IdFile);
    this.saving = this.saving.then(async () => {
      try {
        await mkdir(path.dirname(file), { recursive: true });
        const temp = `${file}.tmp`;
        await writeFile(temp, data, { mode: 0o600 });
        await renameWithRetry(temp, file);
      } catch (error) {
        log("WARN", "TMDB ids could not be saved", { file: path.basename(file), reason: reasonOf(error) });
      }
    });
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
