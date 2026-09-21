import { randomBytes } from "node:crypto";
import { realpath, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** A library root that cannot be reached is normal operation once external disks are
 *  in play, so the answer is cached: the interface polls, and a sick NFS or SMB mount
 *  must not be stat-ed on every request. */
export interface LibraryHealth {
  unreachable: boolean;
  readOnly: boolean;
  /** The root with symlinks resolved, or the resolved-but-not-real path when
   *  the root cannot be reached. */
  realRoot: string;
  /** Whether *this volume* treats two spellings as one directory. */
  caseInsensitive: boolean;
}

export interface LibraryProbe {
  /** What the disk says right now, bounded by the timeout. */
  probe(root: string): Promise<LibraryHealth>;
  /** The same, unless an answer younger than the TTL is already in hand. */
  cached(root: string): Promise<LibraryHealth>;
  /** Called when an operation against the root fails on I/O: a failing write is a
   *  better signal than the next scheduled probe. */
  invalidate(root?: string): void;
}

/** The answer when the volume could not be asked: the platform's own habit is the only
 *  estimate left, and it is an estimate -- a probe that never reached the disk must not
 *  read as an answer about it. */
const PLATFORM_CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `stat` on a dead mount can hang for the mount timeout, so every call gets a
 *  deadline of its own and the loser is left to settle unobserved. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  const guarded = work.catch(() => undefined);
  const timer = sleep(ms).then(() => undefined);
  return Promise.race([guarded, timer]);
}

/** The same spelling with every ASCII letter's case swapped. The probe file carries a
 *  mixed-case marker, so the flipped spelling is never the spelling that was written. */
const flipCase = (value: string) =>
  value.replace(/[a-zA-Z]/g, (character) => character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase());

/** What the two answers say: one file on one volume is the same inode on the same device.
 *  Pure, so both halves can be driven from a test on a runner whose own volume folds
 *  neither way. */
export const sameVolumeEntry = (
  own: { ino: number; dev: number } | undefined,
  flipped: { ino: number; dev: number } | undefined,
): boolean => Boolean(own && flipped && own.ino === flipped.ino && own.dev === flipped.dev);

/** One write answers both questions the health holds: probing by writing tells apart a
 *  read-only mount, a wrong PUID and an ACL, which the mode bits alone do not, and reading
 *  the file back under the flipped spelling tells whether this volume folds case.
 *  `undefined` is the read-only answer. */
async function probeVolume(root: string): Promise<{ caseInsensitive: boolean } | undefined> {
  const file = path.join(root, `.stremio-offline-${randomBytes(4).toString("hex")}-Probe.tmp`);
  const flipped = path.join(root, flipCase(path.basename(file)));
  try {
    await writeFile(file, "");
    const [own, other] = await Promise.all([stat(file), stat(flipped).catch(() => undefined)]);
    await unlink(file);
    return { caseInsensitive: sameVolumeEntry(own, other) };
  } catch {
    await unlink(file).catch(() => undefined);
    return undefined;
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
    if (!info?.isDirectory()) {
      // Nothing is known but the spelling: `realpath` would hang on the same mount that made
      // this stat fail, and there is no volume to ask about the fold.
      return { unreachable: true, readOnly: false, realRoot: absolute, caseInsensitive: PLATFORM_CASE_INSENSITIVE };
    }
    // Bounded like every other call: a half-dead mount hangs on a resolve as readily as on a stat.
    const real = await within(realpath(absolute), timeoutMs) ?? absolute;
    const volume = await within(probeVolume(real), timeoutMs);
    return {
      unreachable: false,
      readOnly: volume === undefined,
      realRoot: real,
      // A volume that could not be asked -- refused, failed or out of time -- is unknown, and
      // an unknown fold folds. Falling back to the platform here answered a question about the
      // disk with a fact about the process, which is the mistake this probe exists to undo.
      caseInsensitive: volume?.caseInsensitive ?? true,
    };
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
