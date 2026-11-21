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
  /** What the disk says right now for reachability; volume facts may be up to
   *  `volumeTtlMs` old. */
  probe(root: string): Promise<LibraryHealth>;
  /** The same, unless an answer younger than the TTL is already in hand. `stale` takes an
   *  older answer at once and asks the disk again behind it: a view must not wait for a
   *  sleeping NAS to spin up just to draw what it drew a minute ago. */
  cached(root: string, read?: { stale?: boolean }): Promise<LibraryHealth>;
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
  own: { ino: number | bigint; dev: number | bigint } | undefined,
  flipped: { ino: number | bigint; dev: number | bigint } | undefined,
): boolean => Boolean(own && flipped && own.ino === flipped.ino && own.dev === flipped.dev);

/** One write answers both volume questions: probing by writing tells apart a read-only
 *  mount, a wrong PUID and an ACL, which the mode bits alone do not, and reading the file
 *  back under the flipped spelling tells whether this volume folds case. A successful
 *  answer is reused for `volumeTtlMs`; a failure is retried on the next reachability
 *  refresh. `undefined` is the read-only answer. */
async function probeVolume(root: string): Promise<{ caseInsensitive: boolean } | undefined> {
  const file = path.join(root, `.stremio-offline-${randomBytes(4).toString("hex")}-Probe.tmp`);
  const flipped = path.join(root, flipCase(path.basename(file)));
  try {
    await writeFile(file, "");
    // bigint: a Windows file id passes 2^53, and as numbers two files could compare equal.
    const [own, other] = await Promise.all([stat(file, { bigint: true }), stat(flipped, { bigint: true }).catch(() => undefined)]);
    await unlink(file);
    return { caseInsensitive: sameVolumeEntry(own, other) };
  } catch {
    await unlink(file).catch(() => undefined);
    return undefined;
  }
}

export function createLibraryProbe(opts: {
  timeoutMs?: number;
  ttlMs?: number;
  volumeTtlMs?: number;
  now?: () => number;
} = {}): LibraryProbe {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const ttlMs = opts.ttlMs ?? 30_000;
  const volumeTtlMs = opts.volumeTtlMs ?? 60 * 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; value: LibraryHealth }>();
  const volumeCache = new Map<string, { at: number; value: Pick<LibraryHealth, "readOnly" | "caseInsensitive"> }>();
  const realRoots = new Map<string, string>();
  const previouslyUnreachable = new Set<string>();
  const inflight = new Map<string, { generation: string; promise: Promise<LibraryHealth> }>();
  // Per root, so invalidating one library does not discard the probes of the others.
  let everyRoot = 0;
  const rootGenerations = new Map<string, number>();
  const generationOf = (absolute: string) => `${everyRoot}:${rootGenerations.get(absolute) ?? 0}`;

  const probe = async (root: string): Promise<LibraryHealth> => {
    const absolute = path.resolve(root);
    const generationAtStart = generationOf(absolute);
    const info = await within(stat(absolute), timeoutMs);
    if (!info?.isDirectory()) {
      if (generationAtStart === generationOf(absolute)) previouslyUnreachable.add(absolute);
      // Nothing is known but the spelling: `realpath` would hang on the same mount that made
      // this stat fail, and there is no volume to ask about the fold.
      // Unreachable is unanswered too, and an unanswered fold folds -- the same rule the
      // write probe below uses. The platform constant is a fact about the process, not about
      // a disk nobody could reach.
      return { unreachable: true, readOnly: false, realRoot: absolute, caseInsensitive: true };
    }
    // Bounded like every other call: a half-dead mount hangs on a resolve as readily as on a stat.
    const real = await within(realpath(absolute), timeoutMs) ?? absolute;
    const held = volumeCache.get(real);
    const cacheIsCurrent = generationAtStart === generationOf(absolute);
    const recovered = cacheIsCurrent && previouslyUnreachable.delete(absolute);
    let volume = cacheIsCurrent && !recovered && held && now() - held.at < volumeTtlMs
      ? held.value
      : undefined;
    if (!volume) {
      if (cacheIsCurrent) volumeCache.delete(real);
      const probed = await within(probeVolume(real), timeoutMs);
      if (probed) {
        volume = { readOnly: false, caseInsensitive: probed.caseInsensitive };
        if (generationAtStart === generationOf(absolute)) volumeCache.set(real, { at: now(), value: volume });
      }
    }
    if (generationAtStart === generationOf(absolute)) realRoots.set(absolute, real);
    return {
      unreachable: false,
      readOnly: volume?.readOnly ?? true,
      realRoot: real,
      // A volume that could not be asked -- refused, failed or out of time -- is unknown, and
      // an unknown fold folds. Falling back to the platform here answered a question about the
      // disk with a fact about the process, which is the mistake this probe exists to undo.
      caseInsensitive: volume?.caseInsensitive ?? true,
    };
  };

  const cached = async (root: string, read: { stale?: boolean } = {}): Promise<LibraryHealth> => {
    const absolute = path.resolve(root);
    const hit = cache.get(absolute);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const generationAtStart = generationOf(absolute);
    let running = inflight.get(absolute);
    if (running?.generation !== generationAtStart) running = undefined;
    if (!running) {
      const promise = probe(absolute)
        .then((value) => {
          if (generationAtStart === generationOf(absolute)) cache.set(absolute, { at: now(), value });
          return value;
        })
        .finally(() => {
          if (inflight.get(absolute)?.promise === promise) inflight.delete(absolute);
        });
      running = { generation: generationAtStart, promise };
      inflight.set(absolute, running);
    }
    if (hit && read.stale) {
      running.promise.catch(() => undefined);
      return hit.value;
    }
    return running.promise;
  };

  return {
    probe,
    cached,
    invalidate: (root) => {
      if (root === undefined) {
        everyRoot += 1;
        cache.clear();
        volumeCache.clear();
        realRoots.clear();
        previouslyUnreachable.clear();
        inflight.clear();
        return;
      }
      const absolute = path.resolve(root);
      rootGenerations.set(absolute, (rootGenerations.get(absolute) ?? 0) + 1);
      cache.delete(absolute);
      const real = realRoots.get(absolute);
      if (real) volumeCache.delete(real);
      realRoots.delete(absolute);
      previouslyUnreachable.delete(absolute);
      inflight.delete(absolute);
    },
  };
}
