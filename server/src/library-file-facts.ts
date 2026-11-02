import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AudioCodec, AudioFacts } from "./api-types.js";
import { renameWithRetry } from "./fs-retry.js";
import { log } from "./logger.js";
import type { MediaInfo } from "./probe.js";
import type { AppDatabase, Statement } from "./storage/app-database.js";
import { moveToMigrationBackup } from "./storage/hourly-counts.js";
import { TrackedMap } from "./storage/tracked-map.js";

/** A library file as the walk saw it. The size and the modification time are what tell a
 *  remembered reading from one the file has since outgrown. */
export interface LibraryFileStamp { key: string; size: number; modified: string }

interface Entry {
  size: number;
  modified: string;
  /** `null` when ffprobe could not read the file. */
  info: MediaInfo | null;
  at: number;
}

export interface LibraryFileFacts {
  /** What each file holds. Readings already in hand come back at once; the rest are started
   *  and waited for until `waitMs` runs out, then keep going so the next listing has them. */
  read(files: readonly LibraryFileStamp[], opts?: { waitMs?: number }): Promise<Map<string, MediaInfo>>;
  /** Writes whatever is still waiting for the debounce. */
  flush(): Promise<void>;
}

export interface LibraryFileFactsOptions {
  /** The JSON fallback when no database is attached. */
  file?: string;
  database?: AppDatabase;
  probe: (key: string, signal: AbortSignal) => Promise<MediaInfo | undefined>;
  now?: () => number;
  concurrency?: number;
  probeTimeoutMs?: number;
  maxEntries?: number;
  saveDelayMs?: number;
}

/** A file ffprobe could not read is asked again after this long: a sleeping NAS that timed out
 *  once must not lose its facts until the file changes. */
const FAILURE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WAIT_MS = 1500;
const DOMAIN = "fileFacts";
const UPSERT = "INSERT INTO file_facts (key, size, modified, info, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET size = excluded.size, modified = excluded.modified, info = excluded.info, at = excluded.at";

const AUDIO_CODECS = new Set<string>(["aac", "ac3", "eac3", "dts", "truehd", "opus", "flac", "mp3"]);

const languages = (values: readonly (string | undefined)[]) =>
  [...new Set(values.filter((value): value is string => Boolean(value)))];

/** What a source row says about a read file: the languages it really holds and its main
 *  sound track. A track with no language tag adds nothing. */
export function localCopySummary(info: MediaInfo, subtitleSidecars: readonly (string | undefined)[]): {
  audioLanguages: string[];
  subtitleLanguages: string[];
  audioFacts?: AudioFacts;
} {
  const codec = info.audio?.codec && AUDIO_CODECS.has(info.audio.codec) ? info.audio.codec as AudioCodec : undefined;
  const channels = info.audio?.channels && info.audio.channels > 0 ? info.audio.channels : undefined;
  return {
    audioLanguages: languages(info.audioTracks.map((track) => track.language)),
    subtitleLanguages: languages([...info.subtitleTracks.map((track) => track.language), ...subtitleSidecars]),
    ...(codec || channels ? { audioFacts: { ...(codec ? { codec } : {}), ...(channels ? { channels } : {}) } } : {}),
  };
}

/** The variant indexes only matter to a conversion running now; they are not kept. */
const kept = (info: MediaInfo): MediaInfo => {
  const { variant: _variant, ...rest } = info;
  return rest;
};

export function createLibraryFileFacts(opts: LibraryFileFactsOptions): LibraryFileFacts {
  const now = opts.now ?? Date.now;
  const concurrency = opts.concurrency ?? 2;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 60_000;
  const maxEntries = opts.maxEntries ?? 20_000;
  const saveDelayMs = opts.saveDelayMs ?? 2000;
  const entries = new TrackedMap<string, Entry>();
  const running = new Map<string, Promise<void>>();
  const waiting: Array<() => void> = [];
  let active = 0;
  let saveTimer: NodeJS.Timeout | undefined;
  let saving: Promise<void> = Promise.resolve();
  let queued = false;

  const target = () => Boolean(opts.file || opts.database);

  const schedule = () => {
    if (!target() || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      if (!entries.hasDirty()) return;
      void writeOnce().catch((error: unknown) => {
        log("WARN", "Library file facts could not be saved", { reason: String(error).slice(0, 200) });
      });
    }, saveDelayMs);
    saveTimer.unref?.();
  };

  const writeJson = async (snapshot: ReadonlyMap<string, number>) => {
    const file = opts.file!;
    const payload = JSON.stringify({ version: 1, entries: Object.fromEntries(entries) });
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    await writeFile(temp, payload, { mode: 0o600 });
    await renameWithRetry(temp, file);
    entries.forget(snapshot);
  };

  const writeDatabase = async (database: AppDatabase, snapshot: ReadonlyMap<string, number>) => {
    const statements: Statement[] = [];
    for (const key of snapshot.keys()) {
      const entry = entries.get(key);
      if (entry) {
        statements.push({
          sql: UPSERT,
          params: [key, entry.size, entry.modified, entry.info === null ? null : JSON.stringify(entry.info), entry.at],
        });
      } else {
        statements.push({ sql: "DELETE FROM file_facts WHERE key = ?", params: [key] });
      }
    }
    if (statements.length) {
      await database.batch(statements);
      entries.forget(snapshot);
    }
  };

  const persist = async () => {
    const snapshot = entries.snapshot();
    if (snapshot.size === 0) return;
    if (opts.database) await writeDatabase(opts.database, snapshot);
    else await writeJson(snapshot);
  };

  function writeOnce(): Promise<void> {
    if (queued) return saving;
    queued = true;
    const run = saving.catch(() => undefined).then(persist);
    saving = run.finally(() => { queued = false; });
    return saving;
  }

  const backupName = () => {
    const name = path.basename(opts.file ?? "file-facts.json");
    return name.endsWith(".json") ? name.slice(0, -5) : name;
  };

  const markerStatement = (marker: Record<string, unknown>): Statement => ({
    sql: "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    params: [`domain.${DOMAIN}`, JSON.stringify(marker)],
  });

  const writeMarker = async (database: AppDatabase, marker: Record<string, unknown>) => {
    const statement = markerStatement(marker);
    await database.run(statement.sql, statement.params);
  };

  const moveJsonAside = async (database: AppDatabase, suffix: string) => {
    if (!opts.file) return;
    await moveToMigrationBackup(
      opts.file,
      path.dirname(database.info.file),
      `${backupName()}-${suffix}.json`,
    );
  };

  const loadRows = async (database: AppDatabase) => {
    const rows = await database.all<{
      key: string; size: number; modified: string; info: string | null; at: number;
    }>("SELECT key, size, modified, info, at FROM file_facts ORDER BY at, key");
    for (const row of rows) {
      if (typeof row.size !== "number" || typeof row.modified !== "string" || !Number.isFinite(row.at)) continue;
      let info: MediaInfo | null;
      if (row.info === null) {
        info = null;
      } else {
        try {
          info = JSON.parse(row.info) as MediaInfo;
        } catch {
          continue;
        }
      }
      entries.set(row.key, { size: row.size, modified: row.modified, info, at: row.at });
    }
    entries.forget(entries.snapshot());
  };

  const markJsonUnreadable = async (database: AppDatabase, error: unknown) => {
    const importedAt = now();
    log("ERROR", "Remembered library file facts could not be imported", { reason: String(error).slice(0, 200) });
    await moveJsonAside(database, `unreadable-${importedAt}`);
    await writeMarker(database, { importedAt, source: "unreadable", count: 0 });
    entries.clear();
    entries.forget(entries.snapshot());
  };

  const loadDatabase = async (database: AppDatabase) => {
    const marker = await database.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [`domain.${DOMAIN}`]);
    if (marker) {
      await loadRows(database);
      await moveJsonAside(database, String(now()));
      return;
    }

    let parsed: unknown;
    const file = opts.file;
    try {
      if (!file) {
        await writeMarker(database, { importedAt: now(), source: "none", count: 0 });
        return;
      }
      parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await writeMarker(database, { importedAt: now(), source: path.basename(file!), count: 0 });
        return;
      }
      await markJsonUnreadable(database, error);
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || !(parsed as { entries?: unknown }).entries
      || typeof (parsed as { entries: unknown }).entries !== "object"
      || Array.isArray((parsed as { entries: unknown }).entries)) {
      await markJsonUnreadable(database, new Error("The remembered library file facts are not an entries object."));
      return;
    }

    const statements: Statement[] = [];
    let count = 0;
    for (const [key, value] of Object.entries((parsed as { entries: Record<string, Entry> }).entries)) {
      const entry = value;
      if (!entry || typeof entry.size !== "number" || typeof entry.modified !== "string" || !Number.isFinite(entry.at)) continue;
      const info = entry.info === null ? null : JSON.stringify(entry.info);
      if (info === undefined) continue;
      statements.push({ sql: UPSERT, params: [key, entry.size, entry.modified, info, entry.at] });
      count += 1;
    }
    const importedAt = now();
    statements.push(markerStatement({
      importedAt,
      source: path.basename(file),
      count,
    }));
    await database.batch(statements);
    await loadRows(database);
    await moveJsonAside(database, String(importedAt));
  };

  const loaded = (async () => {
    if (opts.database) {
      await loadDatabase(opts.database);
      return;
    }
    if (!opts.file) return;
    try {
      const parsed = JSON.parse(await readFile(opts.file, "utf8")) as { entries?: Record<string, Entry> };
      for (const [key, entry] of Object.entries(parsed.entries ?? {})) {
        if (entry && typeof entry.size === "number" && typeof entry.modified === "string") entries.set(key, entry);
      }
      entries.forget(entries.snapshot());
    } catch (error) {
      // Only a cache: a missing or damaged file means every file is read again.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log("WARN", "Remembered library file facts could not be read, they will be read again", { reason: String(error).slice(0, 200) });
      }
    }
  })();

  const remember = (key: string, entry: Entry) => {
    const stored = entries.get(key);
    if (stored
      && stored.size === entry.size
      && stored.modified === entry.modified
      && JSON.stringify(stored.info) === JSON.stringify(entry.info)
      && (stored.info !== null || entry.at <= stored.at)) return;
    entries.delete(key);
    entries.set(key, entry);
    // The oldest readings go first; Map keeps insertion order.
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    schedule();
  };

  const current = (file: LibraryFileStamp): Entry | undefined => {
    const entry = entries.get(file.key);
    if (!entry || entry.size !== file.size || entry.modified !== file.modified) return undefined;
    if (entry.info === null && now() - entry.at > FAILURE_TTL_MS) return undefined;
    return entry;
  };

  const slot = async () => {
    if (active < concurrency) { active += 1; return; }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  const inspect = (file: LibraryFileStamp): Promise<void> => {
    const pending = running.get(file.key);
    if (pending) return pending;
    const work = (async () => {
      await slot();
      try {
        if (current(file)) return;
        const info = await opts.probe(file.key, AbortSignal.timeout(probeTimeoutMs));
        remember(file.key, { size: file.size, modified: file.modified, info: info ? kept(info) : null, at: now() });
      } catch {
        // A library that went away or a probe cut off by its deadline says nothing about the
        // file itself; it is simply asked again next time.
      } finally {
        release();
        running.delete(file.key);
      }
    })();
    running.set(file.key, work);
    return work;
  };

  return {
    async read(files, readOpts) {
      await loaded;
      const pending = files.filter((file) => !current(file)).map(inspect);
      if (pending.length) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.allSettled(pending),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, readOpts?.waitMs ?? DEFAULT_WAIT_MS); }),
        ]);
        clearTimeout(timer);
      }
      const found = new Map<string, MediaInfo>();
      for (const file of files) {
        const info = current(file)?.info;
        if (info) found.set(file.key, info);
      }
      return found;
    },
    async flush() {
      await loaded;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
      }
      if (!target()) return;
      for (;;) {
        await saving.catch(() => undefined);
        if (!entries.hasDirty()) return;
        await writeOnce();
      }
    },
  };
}
