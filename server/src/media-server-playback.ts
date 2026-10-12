import { log } from "./logger.js";
import type { MediaResources, ResourceOwner } from "./media-resources.js";
import { isRemoteMediaStream } from "./media-server-reference.js";
import type { MediaServerSources } from "./media-server-sources.js";
import type { ActiveTransfer } from "./revocation.js";
import type { StreamItem } from "./types.js";

/** How often live remote resources are re-authorized, and how long one cycle may take. */
export interface MediaServerPlaybackConfig {
  intervalMs: number;
  timeoutMs: number;
}

const INTERVAL_DEFAULT = 30_000;
const INTERVAL_MAX = 30_000;
const TIMEOUT_DEFAULT = 5_000;
const TIMEOUT_MAX = 5_000;
const MAX_TRACKED = 128;
const MAX_PARALLEL = 4;

const positiveBound = (value: string | undefined, fallback: number, max: number, name: string): number => {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`${name} must be a positive integer no greater than ${max}.`);
  return parsed;
};

/** Reads the revalidation cadence from the environment. An invalid value fails startup with a
 *  plain sentence; nothing here carries a secret. */
export const readMediaServerPlaybackConfig = (env: NodeJS.ProcessEnv = process.env): MediaServerPlaybackConfig => ({
  intervalMs: positiveBound(env.MEDIA_SERVER_REVALIDATE_MS, INTERVAL_DEFAULT, INTERVAL_MAX, "MEDIA_SERVER_REVALIDATE_MS"),
  timeoutMs: positiveBound(env.MEDIA_SERVER_REVALIDATE_TIMEOUT_MS, TIMEOUT_DEFAULT, TIMEOUT_MAX, "MEDIA_SERVER_REVALIDATE_TIMEOUT_MS"),
});

export interface MediaServerPlaybackGuardDeps {
  sources: MediaServerSources;
  resources: MediaResources;
  playbackOwners: Map<string, { owner: ResourceOwner; resourceId: string }>;
  activeMedia: Set<ActiveTransfer>;
  revocations: { stopResource(resourceId: string): Promise<void> };
  clock?: () => number;
}

interface Candidate { resourceId: string; owner: ResourceOwner; stream: StreamItem }

/** Re-authorizes every live remote resource on a timer, because an upstream server does not
 *  reliably enforce a change to the account's policy: a resource that stops being permitted
 *  is stopped here, within one interval plus the deadline. A failure or a timeout is always
 *  a revocation, never a positive permission. */
export class MediaServerPlaybackGuard {
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly clock: () => number;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private closed = false;
  /** Resources seen to be remote. A later disappearance is a denial for these, and only these. */
  private readonly remote = new Set<string>();
  private readonly controllers = new Set<AbortController>();
  private readonly closedSignal: Promise<void>;
  private markClosed!: () => void;

  constructor(private readonly deps: MediaServerPlaybackGuardDeps, config: MediaServerPlaybackConfig) {
    this.intervalMs = config.intervalMs;
    this.timeoutMs = config.timeoutMs;
    this.clock = deps.clock ?? (() => Date.now());
    this.closedSignal = new Promise<void>((resolve) => { this.markClosed = resolve; });
  }

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.cycle(); }, this.intervalMs);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // In-flight checks are aborted at once; the wait only covers a check whose provider ignores
    // the signal, and the closed signal ends that within the deadline.
    for (const controller of this.controllers) controller.abort();
    this.markClosed();
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  /** Only verified remote resources are candidates. A local or addon resource never consumes a
   *  slot, the deadline or a revocation; a resource this guard has already seen as remote and
   *  that has since disappeared is denied. */
  private candidates(): { remote: Candidate[]; missing: string[] } {
    const seen = new Map<string, ResourceOwner>();
    for (const owned of this.deps.playbackOwners.values()) if (owned.resourceId) seen.set(owned.resourceId, owned.owner);
    for (const active of this.deps.activeMedia) if (active.resourceId) seen.set(active.resourceId, active.owner);
    for (const resourceId of this.remote) if (!seen.has(resourceId)) this.remote.delete(resourceId);
    const remote: Candidate[] = [];
    const missing: string[] = [];
    for (const [resourceId, owner] of seen) {
      let stream: StreamItem;
      try { stream = this.deps.resources.get(resourceId, owner.sid, "media").stream; }
      catch {
        if (this.remote.has(resourceId)) missing.push(resourceId);
        continue;
      }
      if (!isRemoteMediaStream(stream)) continue;
      this.remote.add(resourceId);
      remote.push({ resourceId, owner, stream });
    }
    return { remote, missing };
  }

  /** One sweep. Checks never overlap and never outlive the cycle deadline; too many resources
   *  to track is a failure, not a reason to skip any. */
  async cycle(): Promise<void> {
    if (this.closed || this.running) return;
    this.running = true;
    try {
      const { remote, missing } = this.candidates();
      if (missing.length) await this.revoke(missing);
      if (remote.length === 0) return;
      if (remote.length > MAX_TRACKED) {
        log("WARN", "Too many remote resources to revalidate, stopping them all", { count: remote.length });
        await this.revoke(remote.map((candidate) => candidate.resourceId));
        return;
      }
      const deadline = this.clock() + this.timeoutMs;
      const queue = [...remote];
      const workers = Array.from({ length: Math.min(MAX_PARALLEL, queue.length) }, async () => {
        for (;;) {
          const next = queue.shift();
          if (!next || this.closed) return;
          await this.check(next, deadline);
        }
      });
      await Promise.all(workers);
    } finally {
      this.running = false;
    }
  }

  private async check(candidate: Candidate, deadline: number): Promise<void> {
    const remaining = deadline - this.clock();
    if (remaining <= 0) return this.revoke([candidate.resourceId]);
    const controller = new AbortController();
    this.controllers.add(controller);
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("The media-server revalidation timed out.")); }, remaining);
      });
      let work: Promise<void>;
      try { work = this.deps.sources.authorize(candidate.stream, candidate.owner, controller.signal); }
      catch (error) { work = Promise.reject(error); }
      work.catch(() => undefined);
      try {
        await Promise.race([work, timeout, this.closedSignal]);
      } catch {
        if (!this.closed) await this.revoke([candidate.resourceId]);
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  private async revoke(resourceIds: string[]): Promise<void> {
    for (const resourceId of resourceIds) {
      this.remote.delete(resourceId);
      try { await this.deps.revocations.stopResource(resourceId); }
      catch (error) { log("WARN", "A denied remote resource was not stopped", { reason: error instanceof Error ? error.message : String(error) }); }
    }
  }
}
