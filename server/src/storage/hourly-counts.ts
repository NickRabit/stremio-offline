import { chmod, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "../fs-retry.js";
import type { AppDatabase, Statement } from "./app-database.js";

export interface HourlyRow {
  hour: string;
  key: string;
  count: number;
}

const UPSERT = "INSERT INTO hourly_counts (domain, hour, key, count) VALUES (?, ?, ?, ?) ON CONFLICT (domain, hour, key) DO UPDATE SET count = excluded.count";
const PRUNE = "DELETE FROM hourly_counts WHERE domain = ? AND hour < ?";

export class HourlyCounts {
  constructor(
    private readonly db: AppDatabase,
    private readonly domain: string,
  ) {}

  async load(): Promise<HourlyRow[]> {
    return await this.db.all<HourlyRow>(
      "SELECT hour, key, count FROM hourly_counts WHERE domain = ? ORDER BY hour, key",
      [this.domain],
    );
  }

  async import(rows: HourlyRow[], marker: Record<string, unknown>): Promise<void> {
    const statements: Statement[] = rows.map((row) => ({
      sql: UPSERT,
      params: [this.domain, row.hour, row.key, row.count],
    }));
    statements.push({
      sql: "INSERT INTO meta (key, value) VALUES (?, ?)",
      params: [`domain.${this.domain}`, JSON.stringify(marker)],
    });
    await this.db.batch(statements);
  }

  async marker(): Promise<Record<string, unknown> | undefined> {
    const row = await this.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [`domain.${this.domain}`]);
    if (!row) return undefined;
    try {
      const value = JSON.parse(row.value) as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  async writeMarker(marker: Record<string, unknown>): Promise<void> {
    await this.db.run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [`domain.${this.domain}`, JSON.stringify(marker)],
    );
  }

  async write(rows: HourlyRow[], pruneBefore: string): Promise<void> {
    const statements: Statement[] = rows.map((row) => ({
      sql: UPSERT,
      params: [this.domain, row.hour, row.key, row.count],
    }));
    statements.push({ sql: PRUNE, params: [this.domain, pruneBefore] });
    await this.db.batch(statements);
  }
}

export async function moveToMigrationBackup(file: string, dataDir: string, name: string): Promise<string | undefined> {
  try {
    await stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const backupDir = path.join(dataDir, "migration-backup");
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(backupDir, 0o700);
  const target = path.join(backupDir, name);
  await renameWithRetry(file, target);
  return target;
}
