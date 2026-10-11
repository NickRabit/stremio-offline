import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** One line a client sends back: when it happened, how bad it was and what it said. */
export interface ClientLogLine {
  t: string;
  level: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface ClientLogBundle {
  id: string;
  /** The account that uploaded it. */
  user: string;
  client: "web" | "tv";
  app: string;
  device: string;
  note?: string;
  time: string;
  lines: ClientLogLine[];
}

/** A bundle as the listing needs it: the lines are a count, not the payload. */
export interface ClientLogSummary extends Omit<ClientLogBundle, "lines"> { lines: number }

export const CLIENT_LOG_MAX_LINES = 1000;
export const CLIENT_LOG_MAX_BYTES = 512 * 1024;
/** Newest this many bundles are kept; the rest are dropped on the next upload. */
export const CLIENT_LOG_KEEP = 50;

const summaryOf = (bundle: ClientLogBundle): ClientLogSummary => ({ ...bundle, lines: bundle.lines.length });

/** One JSON file per bundle under `<data dir>/client-logs`, newest first by the time it was
 *  uploaded. A bundle that cannot be read back is skipped rather than failing the whole list. */
export class ClientLogStore {
  private readonly dir: string;
  private readonly now: () => number;

  constructor(dataDir: string, now: () => number = Date.now) {
    this.dir = path.join(dataDir, "client-logs");
    this.now = now;
  }

  private fileOf(id: string) { return path.join(this.dir, `${id}.json`); }

  async save(input: Omit<ClientLogBundle, "id" | "time">): Promise<ClientLogSummary> {
    const bundle: ClientLogBundle = { id: randomUUID(), time: new Date(this.now()).toISOString(), ...input };
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.fileOf(bundle.id), JSON.stringify(bundle), { mode: 0o600 });
    await this.prune();
    return summaryOf(bundle);
  }

  async list(): Promise<ClientLogSummary[]> {
    return (await this.readAll())
      .map(summaryOf)
      .sort((a, b) => b.time.localeCompare(a.time) || b.id.localeCompare(a.id));
  }

  async get(id: string): Promise<ClientLogBundle | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    try {
      const parsed = JSON.parse(await readFile(this.fileOf(id), "utf8")) as ClientLogBundle;
      return parsed.id === id ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async remove(id: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    try {
      await unlink(this.fileOf(id));
      return true;
    } catch {
      return false;
    }
  }

  private async readAll(): Promise<ClientLogBundle[]> {
    const names = await readdir(this.dir).catch(() => []);
    const bundles: ClientLogBundle[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try { bundles.push(JSON.parse(await readFile(path.join(this.dir, name), "utf8")) as ClientLogBundle); }
      catch { /* a half-written or foreign file is skipped, not fatal */ }
    }
    return bundles;
  }

  private async prune(): Promise<void> {
    const bundles = (await this.readAll()).sort((a, b) => b.time.localeCompare(a.time) || b.id.localeCompare(a.id));
    for (const stale of bundles.slice(CLIENT_LOG_KEEP)) await unlink(this.fileOf(stale.id)).catch(() => undefined);
  }
}
