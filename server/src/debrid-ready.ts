import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "./fs-retry.js";
import { log } from "./logger.js";

const READY_MAX_ENTRIES = 5_000;
const READY_TTL_MS = 60 * 24 * 60 * 60 * 1_000;
const INFO_HASH = /^(?:[a-f0-9]{40}|[a-z2-7]{32})$/i;

interface ReadyFile {
  version: 1;
  entries: Record<string, string>;
}

const reasonOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 120);

const normalizeHash = (value: string): string | undefined => {
  const hash = value.trim().toLowerCase();
  return INFO_HASH.test(hash) ? hash : undefined;
};

const timestamp = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const newest = (
  entries: ReadonlyArray<readonly [string, string]>,
): Array<readonly [string, string]> =>
  [...entries]
    .sort((left, right) => Date.parse(right[1]) - Date.parse(left[1]))
    .slice(0, READY_MAX_ENTRIES);

async function writeAtomic(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, data, { mode: 0o600 });
  await renameWithRetry(temp, file);
}

export class DebridReadyStore {
  private entries: Record<string, string> = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    this.file = path.join(dataDir, "debrid-ready.json");
  }

  /** Never throws: a missing, unreadable or malformed file starts empty. */
  async load(): Promise<void> {
    const raw = await readFile(this.file, "utf8").catch(() => undefined);
    if (raw === undefined) return;
    try {
      const parsed = JSON.parse(raw) as Partial<ReadyFile>;
      if (parsed.entries === null || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) {
        this.entries = {};
        return;
      }
      const valid = Object.entries(parsed.entries).flatMap(([infoHash, lastReadyAt]) => {
        const hash = normalizeHash(infoHash);
        return hash !== undefined && timestamp(lastReadyAt) !== undefined
          ? [[hash, lastReadyAt] as const]
          : [];
      });
      this.entries = Object.fromEntries(newest(valid));
    } catch (error) {
      this.entries = {};
      log("WARN", "Real-Debrid readiness could not be read", { reason: reasonOf(error) });
    }
  }

  has(infoHash: string): boolean {
    const hash = normalizeHash(infoHash);
    if (hash === undefined) return false;
    const at = timestamp(this.entries[hash]);
    return at !== undefined && this.now() - at <= READY_TTL_MS;
  }

  async remember(infoHash: string): Promise<void> {
    const hash = normalizeHash(infoHash);
    if (hash === undefined) return;
    this.entries[hash] = new Date(this.now()).toISOString();
    await this.save();
  }

  private save(): Promise<void> {
    this.saving = this.saving.then(async () => {
      const fresh = Object.entries(this.entries).filter(([, lastReadyAt]) => {
        const at = timestamp(lastReadyAt);
        return at !== undefined && this.now() - at <= READY_TTL_MS;
      });
      this.entries = Object.fromEntries(newest(fresh));
      try {
        await writeAtomic(
          this.file,
          JSON.stringify({ version: 1, entries: this.entries } satisfies ReadyFile, null, 2),
        );
      } catch (error) {
        log("WARN", "Real-Debrid readiness could not be saved", {
          file: path.basename(this.file),
          reason: reasonOf(error),
        });
      }
    });
    return this.saving;
  }
}
