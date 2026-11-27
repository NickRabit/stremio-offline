import { createHash } from "node:crypto";
import type { AppDatabase } from "./storage/app-database.js";
import type { MetaItem } from "./types.js";

const ROW_LIMIT = 5_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;

const hash = (json: string): string => createHash("sha1").update(json).digest("hex");

export class StaleMetaStore {
  private database: AppDatabase | undefined;
  private hashes = new Map<string, string>();
  private pending = new Map<string, Promise<void>>();
  private lastPrunedAt: number | undefined;

  constructor(private now: () => number = Date.now) {}

  attachDatabase(database: AppDatabase): void {
    this.database = database;
    this.hashes.clear();
    this.lastPrunedAt = undefined;
  }

  async get(key: string): Promise<MetaItem | null> {
    if (!this.database) return null;
    const row = await this.database.get<{ data: string }>("SELECT data FROM meta_stale WHERE key = ?", [key]);
    if (!row) return null;
    this.hashes.set(key, hash(row.data));
    try {
      return JSON.parse(row.data) as MetaItem;
    } catch {
      return null;
    }
  }

  remember(key: string, value: MetaItem): Promise<void> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.rememberChanged(key, value));
    const tail = work.catch(() => undefined).finally(() => {
      if (this.pending.get(key) === tail) this.pending.delete(key);
    });
    this.pending.set(key, tail);
    return work;
  }

  private async rememberChanged(key: string, value: MetaItem): Promise<void> {
    const database = this.database;
    if (!database) return;
    const data = JSON.stringify(value);
    const digest = hash(data);
    const known = this.hashes.get(key);
    if (known === digest) return;

    let isNew = false;
    if (known === undefined) {
      const row = await database.get<{ data: string }>("SELECT data FROM meta_stale WHERE key = ?", [key]);
      if (row?.data === data) {
        this.hashes.set(key, digest);
        return;
      }
      isNew = row === undefined;
    }

    await database.run(
      "INSERT INTO meta_stale (key, data, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, at = excluded.at",
      [key, data, this.now()],
    );
    this.hashes.set(key, digest);

    if (!isNew) return;
    const now = this.now();
    if (this.lastPrunedAt !== undefined && now - this.lastPrunedAt < PRUNE_INTERVAL_MS) return;
    this.lastPrunedAt = now;
    const pruned = await database.run(
      `DELETE FROM meta_stale WHERE key IN (
        SELECT key FROM meta_stale ORDER BY at, key LIMIT max(0, (SELECT count(*) FROM meta_stale) - ${ROW_LIMIT})
      )`,
    );
    // A pruned key must be written again the next time it is remembered.
    if (pruned.changes > 0) this.hashes.clear();
  }
}
