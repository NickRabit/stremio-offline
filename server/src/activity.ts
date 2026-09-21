import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";

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

export class ActivityLog {
  private entries: Activity[] = [];
  private sequence = 0;
  private timer?: NodeJS.Timeout;
  private chain = Promise.resolve();
  private dirty = false;
  private file: string;

  constructor(dataDir: string) { this.file = path.join(dataDir, "activity.json"); }

  async load() {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      this.entries = JSON.parse(await readFile(this.file, "utf8")) as Activity[];
      this.entries = this.entries.slice(-ACTIVITY_LIMIT);
      this.sequence = this.entries.reduce((max, entry) => Math.max(max, entry.id), 0);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  record(entry: Omit<Activity, "id" | "at">) {
    this.entries.push({ ...entry, title: entry.title.slice(0, 500), filename: entry.filename?.slice(0, 500), id: ++this.sequence, at: new Date().toISOString() });
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

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.dirty) return this.chain;
    this.dirty = false;
    this.chain = this.chain.catch(() => undefined).then(async () => {
      try {
        await writeFile(`${this.file}.tmp`, JSON.stringify(this.entries), { mode: 0o600 });
        await rename(`${this.file}.tmp`, this.file);
      } catch (error) { this.dirty = true; throw error; }
    });
    return this.chain;
  }
}
