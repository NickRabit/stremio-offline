import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "./fs-retry.js";
import { log } from "./logger.js";
import type { AppDatabase, Statement } from "./storage/app-database.js";
import { moveToMigrationBackup } from "./storage/hourly-counts.js";

export type ActivityKind = "playback" | "library" | "device";
export interface Activity {
  id: number;
  at: string;
  kind: ActivityKind;
  title: string;
  filename?: string;
  userId?: string;
  username?: string;
  bytes?: number;
  partial?: boolean;
}
export const ACTIVITY_LIMIT = 5000;

const DOMAIN = "activity";
const INSERT = "INSERT INTO activity (id, at, kind, title, filename, user_id, username, bytes, partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING";

interface ActivityRow {
  id: number;
  at: string;
  kind: ActivityKind;
  title: string;
  filename: string | null;
  user_id: string | null;
  username: string | null;
  bytes: number | null;
  partial: number | null;
}

export class ActivityLog {
  private entries: Activity[] = [];
  private unsaved = new Map<number, Activity>();
  private sequence = 0;
  private timer?: NodeJS.Timeout;
  private chain = Promise.resolve();
  private dirty = false;
  private loaded = false;
  private database?: AppDatabase;
  private file: string;

  constructor(dataDir: string) { this.file = path.join(dataDir, "activity.json"); }

  attachDatabase(database: AppDatabase): void {
    if (this.loaded) throw new Error("The activity database must be attached before load.");
    this.database = database;
  }

  async load() {
    this.loaded = true;
    await mkdir(path.dirname(this.file), { recursive: true });
    if (this.database) {
      await this.loadDatabase(this.database);
      return;
    }
    try {
      this.entries = JSON.parse(await readFile(this.file, "utf8")) as Activity[];
      this.entries = this.entries.slice(-ACTIVITY_LIMIT);
      this.sequence = this.entries.reduce((max, entry) => Math.max(max, entry.id), 0);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  record(entry: Omit<Activity, "id" | "at">) {
    const saved: Activity = { ...entry, title: entry.title.slice(0, 500), filename: entry.filename?.slice(0, 500), id: ++this.sequence, at: new Date().toISOString() };
    this.entries.push(saved);
    if (this.database) this.unsaved.set(saved.id, saved);
    if (this.entries.length > ACTIVITY_LIMIT) this.entries.splice(0, this.entries.length - ACTIVITY_LIMIT);
    this.dirty = true;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush().catch((error) => log("WARN", "Saving activity history failed", { error: String(error) }));
      }, 1000);
      this.timer.unref();
    }
  }

  page(hours: number, kind?: string, userId?: string, before?: number) {
    const cutoff = Date.now() - Math.max(1, Math.min(8760, Number.isFinite(hours) ? hours : 720)) * 3600000;
    const users = new Map<string, string>();
    const items: Activity[] = [];
    let total = 0;
    let more = false;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (Date.parse(entry.at) < cutoff) continue;
      if (entry.userId) users.set(entry.userId, users.get(entry.userId) ?? entry.username ?? entry.userId);
      if ((kind && entry.kind !== kind) || (userId && entry.userId !== userId)) continue;
      total++;
      if (before && entry.id >= before) continue;
      if (items.length < 50) items.push(entry); else more = true;
    }
    return { items, total, next: more ? items.at(-1)?.id : undefined, users: [...users].map(([id, username]) => ({ id, username })) };
  }

  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    // Nothing new: wait for the write already under way, and make it again if that one failed --
    // shutdown is the last chance to save what it carried.
    if (!this.dirty) return this.chain.catch(() => undefined).then(() => this.dirty ? this.flush() : undefined);
    this.dirty = false;
    this.chain = this.chain.catch(() => undefined).then(async () => {
      try {
        if (this.database) {
          const snapshot = new Map(this.unsaved);
          const newestId = this.sequence;
          const statements: Statement[] = [...snapshot.values()].map((entry) => ({
            sql: INSERT,
            params: activityParams(entry),
          }));
          const trimThrough = newestId - ACTIVITY_LIMIT;
          if (trimThrough > 0) statements.push({ sql: "DELETE FROM activity WHERE id <= ?", params: [trimThrough] });
          if (statements.length) await this.database.batch(statements);
          for (const id of snapshot.keys()) this.unsaved.delete(id);
          return;
        }
        await writeFile(`${this.file}.tmp`, JSON.stringify(this.entries), { mode: 0o600 });
        await renameWithRetry(`${this.file}.tmp`, this.file);
      } catch (error) { this.dirty = true; throw error; }
    });
    return this.chain;
  }

  private async loadDatabase(database: AppDatabase): Promise<void> {
    const marker = await readMarker(database, DOMAIN);
    if (marker) {
      const rows = await database.all<ActivityRow>(
        "SELECT id, at, kind, title, filename, user_id, username, bytes, partial FROM activity ORDER BY id",
      );
      this.loadRows(rows);
      await moveToMigrationBackup(this.file, path.dirname(this.file), `${this.backupStem()}-${Date.now()}.json`);
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.file, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await writeMarker(database, DOMAIN, { importedAt: Date.now(), source: path.basename(this.file), count: 0 });
        return;
      }
      await this.markUnreadable(database, error);
      return;
    }
    if (!Array.isArray(raw)) {
      await this.markUnreadable(database, new Error("The activity history is not an array."));
      return;
    }

    const rows = raw.slice(-ACTIVITY_LIMIT) as Activity[];
    const importedAt = Date.now();
    const statements: Statement[] = rows.map((entry) => ({ sql: INSERT, params: activityParams(entry) }));
    statements.push(markerStatement(DOMAIN, { importedAt, source: path.basename(this.file), count: rows.length }));
    await database.batch(statements);
    this.entries = rows;
    this.sequence = rows.reduce((max, entry) => Math.max(max, entry.id), 0);
    await moveToMigrationBackup(this.file, path.dirname(this.file), `${this.backupStem()}-${importedAt}.json`);
  }

  private async markUnreadable(database: AppDatabase, error: unknown): Promise<void> {
    const importedAt = Date.now();
    log("ERROR", "The activity history could not be imported", { reason: String(error).slice(0, 200) });
    await moveToMigrationBackup(
      this.file,
      path.dirname(this.file),
      `${this.backupStem()}-unreadable-${importedAt}.json`,
    );
    await writeMarker(database, DOMAIN, { importedAt, source: "unreadable", count: 0 });
    this.entries = [];
    this.sequence = 0;
  }

  private loadRows(rows: ActivityRow[]): void {
    this.entries = rows.slice(-ACTIVITY_LIMIT).map((row) => ({
      id: row.id,
      at: row.at,
      kind: row.kind,
      title: row.title,
      ...(row.filename === null ? {} : { filename: row.filename }),
      ...(row.user_id === null ? {} : { userId: row.user_id }),
      ...(row.username === null ? {} : { username: row.username }),
      ...(row.bytes === null ? {} : { bytes: row.bytes }),
      ...(row.partial === null ? {} : { partial: row.partial !== 0 }),
    }));
    this.sequence = this.entries.reduce((max, entry) => Math.max(max, entry.id), 0);
  }

  private backupStem(): string {
    const name = path.basename(this.file);
    return name.endsWith(".json") ? name.slice(0, -5) : name;
  }
}

function activityParams(entry: Activity) {
  return [
    entry.id,
    entry.at,
    entry.kind,
    entry.title,
    entry.filename ?? null,
    entry.userId ?? null,
    entry.username ?? null,
    entry.bytes ?? null,
    entry.partial === undefined ? null : Number(entry.partial),
  ];
}

export async function readMarker(database: AppDatabase, domain: string): Promise<Record<string, unknown> | undefined> {
  const row = await database.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [`domain.${domain}`]);
  if (!row) return undefined;
  try {
    const value = JSON.parse(row.value) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function markerStatement(domain: string, marker: Record<string, unknown>): Statement {
  return {
    sql: "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    params: [`domain.${domain}`, JSON.stringify(marker)],
  };
}

export async function writeMarker(database: AppDatabase, domain: string, marker: Record<string, unknown>): Promise<void> {
  const statement = markerStatement(domain, marker);
  await database.run(statement.sql, statement.params);
}
