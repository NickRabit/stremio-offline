import { randomBytes } from "node:crypto";
import { stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** A library root that cannot be reached is normal operation once external disks are
 *  in play, so the answer is cached: the interface polls, and a sick NFS or SMB mount
 *  must not be stat-ed on every request. */
export interface LibraryHealth { unreachable: boolean; readOnly: boolean }

export interface LibraryProbe {
  /** What the disk says right now, bounded by the timeout. */
  probe(root: string): Promise<LibraryHealth>;
  /** The same, unless an answer younger than the TTL is already in hand. */
  cached(root: string): Promise<LibraryHealth>;
  /** Called when an operation against the root fails on I/O: a failing write is a
   *  better signal than the next scheduled probe. */
  invalidate(root?: string): void;
}

const UNREACHABLE: LibraryHealth = { unreachable: true, readOnly: false };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `stat` on a dead mount can hang for the mount timeout, so every call gets a
 *  deadline of its own and the loser is left to settle unobserved. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  const guarded = work.catch(() => undefined);
  const timer = sleep(ms).then(() => undefined);
  return Promise.race([guarded, timer]);
}

async function writable(root: string): Promise<boolean> {
  // Probing by writing tells apart a read-only mount, a wrong PUID and an ACL,
  // which the mode bits alone do not.
  const file = path.join(root, `.stremio-offline-${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(file, "");
    await unlink(file);
    return true;
  } catch {
    await unlink(file).catch(() => undefined);
    return false;
  }
}

export function createLibraryProbe(opts: { timeoutMs?: number; ttlMs?: number; now?: () => number } = {}): LibraryProbe {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const ttlMs = opts.ttlMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; value: LibraryHealth }>();
  const inflight = new Map<string, Promise<LibraryHealth>>();

  const probe = async (root: string): Promise<LibraryHealth> => {
    const absolute = path.resolve(root);
    const info = await within(stat(absolute), timeoutMs);
    if (!info?.isDirectory()) return UNREACHABLE;
    const ok = await within(writable(absolute), timeoutMs);
    return { unreachable: false, readOnly: ok === false };
  };

  const cached = async (root: string): Promise<LibraryHealth> => {
    const absolute = path.resolve(root);
    const hit = cache.get(absolute);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const running = inflight.get(absolute);
    if (running) return running;
    const pending = probe(absolute)
      .then((value) => { cache.set(absolute, { at: now(), value }); return value; })
      .finally(() => { inflight.delete(absolute); });
    inflight.set(absolute, pending);
    return pending;
  };

  return {
    probe,
    cached,
    invalidate: (root) => {
      if (root === undefined) cache.clear();
      else cache.delete(path.resolve(root));
    },
  };
}
