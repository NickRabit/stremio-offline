import { log } from "./logger.js";
import { safeFetch } from "./security.js";
import { AppError } from "./errors.js";

/**
 * Guards outgoing calls to third-party addons. The circuit breaker is the point of
 * this module: a dead addon fails instantly instead of costing a full timeout on
 * every search. The concurrency cap only stops requests from piling up without
 * bound; it sits high enough not to slow down a normal fan-out, because one addon
 * routinely serves a dozen catalogs from a single host. The queue behind it holds a
 * whole search fan-out -- a waiting entry is a closure, so refusing one costs the
 * user a missing catalogue while keeping it costs nothing. Spacing requests apart is
 * off unless a provider actually asks for it.
 *
 * Media transfers deliberately do not go through here -- they are long-lived by
 * design and would both hold a slot and trip the breaker when the user simply
 * stops playback.
 */

export interface GuardConfig {
  enabled: boolean;
  maxConcurrent: number;
  minIntervalMs: number;
  maxQueue: number;
  failureThreshold: number;
  cooldownMs: number;
  maxCooldownMs: number;
  countTimeoutsAsFailure: boolean;
}

const number = (value: string | undefined, fallback: number, min = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GuardConfig {
  return {
    enabled: env.ADDON_GUARD !== "0",
    maxConcurrent: Math.max(1, number(env.ADDON_MAX_CONCURRENT, 8, 1)),
    minIntervalMs: number(env.ADDON_MIN_INTERVAL_MS, 0),
    maxQueue: Math.max(1, number(env.ADDON_MAX_QUEUE, 256, 1)),
    failureThreshold: Math.max(1, number(env.ADDON_BREAKER_FAILURES, 5, 1)),
    cooldownMs: Math.max(1000, number(env.ADDON_BREAKER_COOLDOWN_MS, 30_000, 1000)),
    maxCooldownMs: Math.max(1000, number(env.ADDON_BREAKER_MAX_COOLDOWN_MS, 300_000, 1000)),
    countTimeoutsAsFailure: true,
  };
}

export function metadataConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GuardConfig {
  return {
    enabled: env.WIKIDATA_GUARD !== "0",
    maxConcurrent: Math.max(1, number(env.WIKIDATA_MAX_CONCURRENT, 2, 1)),
    minIntervalMs: number(env.WIKIDATA_MIN_INTERVAL_MS, 1500),
    maxQueue: Math.max(1, number(env.WIKIDATA_MAX_QUEUE, 4, 1)),
    failureThreshold: Math.max(1, number(env.WIKIDATA_BREAKER_FAILURES, 3, 1)),
    cooldownMs: Math.max(1000, number(env.WIKIDATA_BREAKER_COOLDOWN_MS, 30_000, 1000)),
    maxCooldownMs: Math.max(1000, number(env.WIKIDATA_BREAKER_MAX_COOLDOWN_MS, 300_000, 1000)),
    countTimeoutsAsFailure: false,
  };
}

export type BreakerState = "closed" | "open" | "half-open";

interface HostState {
  active: number;
  queue: Array<() => void>;
  lastStartedAt: number;
  touchedAt: number;
  state: BreakerState;
  failures: number;
  openUntil: number;
  cooldownMs: number;
  trialInFlight: boolean;
  rejected: number;
  opened: number;
}

const seconds = (ms: number) => Math.max(1, Math.round(ms / 1000));

/** The refusal belongs to the interface, so it carries the same key and variables an
 *  `AppError` does: the host and the wait reach the body translated and the header raw. */
export class GuardRejection extends AppError {
  constructor(message: string, readonly host: string, readonly retryAfterMs: number) {
    super(message, "err.hostUnavailable", 503, { host, seconds: seconds(retryAfterMs) });
    this.name = "GuardRejection";
  }
}

/** Providers ask for a pause in seconds or as an HTTP date; both forms appear in the wild. */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const asSeconds = Number(header.trim());
  if (Number.isFinite(asSeconds)) return asSeconds > 0 ? asSeconds * 1000 : undefined;
  const asDate = Date.parse(header);
  return Number.isFinite(asDate) && asDate > now ? asDate - now : undefined;
}

const IDLE_MS = 60 * 60_000;

/** `AbortSignal.timeout` rejects with TimeoutError; an explicit abort with AbortError. */
const isOwnTimeout = (error: unknown) =>
  error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

export class OutboundGuard {
  private hosts = new Map<string, HostState>();

  constructor(
    private config: GuardConfig = configFromEnv(),
    private now: () => number = Date.now,
    private delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  ) {}

  private stateOf(host: string): HostState {
    let entry = this.hosts.get(host);
    if (!entry) {
      entry = {
        active: 0, queue: [], lastStartedAt: 0, touchedAt: this.now(),
        state: "closed", failures: 0, openUntil: 0, cooldownMs: this.config.cooldownMs,
        trialInFlight: false, rejected: 0, opened: 0,
      };
      this.hosts.set(host, entry);
    }
    entry.touchedAt = this.now();
    return entry;
  }

  /** Hosts nobody has talked to for an hour only keep the map growing. */
  private prune() {
    if (this.hosts.size < 64) return;
    const cutoff = this.now() - IDLE_MS;
    for (const [host, entry] of this.hosts) {
      if (entry.touchedAt < cutoff && !entry.active && !entry.queue.length && entry.state === "closed") this.hosts.delete(host);
    }
  }

  private admit(host: string, entry: HostState, interactive: boolean) {
    if (entry.state === "open") {
      // A person waiting at the screen takes the single trial slot even before the cooldown
      // ends. The sweep that opened the breaker keeps failing fast and leaves the slot alone.
      if (this.now() < entry.openUntil && !interactive) {
        entry.rejected += 1;
        throw new GuardRejection(
          `${host} keeps not answering, the next attempt is in ${seconds(entry.openUntil - this.now())} s.`,
          host, entry.openUntil - this.now(),
        );
      }
      entry.state = "half-open";
      entry.trialInFlight = false;
      log("INFO", "Circuit breaker is testing the host again", { host });
    }
    // Half-open lets exactly one request through; everything else keeps failing fast
    // so a burst of searches cannot hammer a host that has not proven itself yet.
    if (entry.state === "half-open") {
      if (entry.trialInFlight) {
        entry.rejected += 1;
        throw new GuardRejection(`${host} is being retried after an outage, try again in a moment.`, host, entry.cooldownMs);
      }
      entry.trialInFlight = true;
    }
  }

  private async acquire(entry: HostState) {
    if (entry.active >= this.config.maxConcurrent) {
      if (entry.queue.length >= this.config.maxQueue) throw new Error("The request queue for this addon is full.");
      await new Promise<void>((resolve) => entry.queue.push(resolve));
    }
    entry.active += 1;
    if (!this.config.minIntervalMs) return;
    // The slot in time is claimed before the wait, otherwise everything released
    // together would compute the same delay and start as one burst anyway.
    const start = Math.max(this.now(), entry.lastStartedAt + this.config.minIntervalMs);
    entry.lastStartedAt = start;
    const wait = start - this.now();
    if (wait > 0) await this.delay(wait);
  }

  private release(entry: HostState) {
    entry.active -= 1;
    entry.queue.shift()?.();
  }

  private succeed(host: string, entry: HostState) {
    entry.trialInFlight = false;
    if (entry.state !== "closed") log("INFO", "The host answers again, circuit breaker closed", { host });
    entry.state = "closed";
    entry.failures = 0;
    entry.cooldownMs = this.config.cooldownMs;
  }

  private fail(host: string, entry: HostState, reason: string, pauseMs?: number) {
    entry.failures += 1;
    const trial = entry.state === "half-open";
    entry.trialInFlight = false;
    if (!trial && entry.failures < this.config.failureThreshold && pauseMs === undefined) return;
    // A failed trial means the previous cooldown was too short; each further outage waits longer.
    if (trial) entry.cooldownMs = Math.min(this.config.maxCooldownMs, entry.cooldownMs * 2);
    const pause = Math.min(this.config.maxCooldownMs, Math.max(pauseMs ?? 0, entry.cooldownMs));
    entry.state = "open";
    entry.openUntil = this.now() + pause;
    entry.opened += 1;
    log("WARN", "Circuit breaker opened for the host", { host, failures: entry.failures, pauseSeconds: seconds(pause), reason });
  }

  async run(host: string, task: () => Promise<Response>, interactive = false): Promise<Response> {
    if (!this.config.enabled) return task();
    this.prune();
    const entry = this.stateOf(host);
    this.admit(host, entry, interactive);
    try {
      await this.acquire(entry);
    } catch (error) {
      entry.trialInFlight = false;
      throw error;
    }
    try {
      const response = await task();
      // Only the provider's own trouble counts. A 404 on metadata is a plain answer,
      // not an outage, and must never take the addon out of service.
      if (response.status === 429 || response.status >= 500) {
        this.fail(host, entry, `HTTP ${response.status}`, retryAfterMs(response.headers.get("retry-after"), this.now()));
      } else {
        this.succeed(host, entry);
      }
      return response;
    } catch (error) {
      // A deadline we set ourselves says nothing about the provider. The call still fails
      // and the caller still copes; it just must not count towards opening the breaker.
      if (this.config.countTimeoutsAsFailure || !isOwnTimeout(error)) {
        this.fail(host, entry, error instanceof Error ? error.message : String(error));
      } else {
        entry.trialInFlight = false;
      }
      throw error;
    } finally {
      this.release(entry);
    }
  }

  diagnostics() {
    const now = this.now();
    return [...this.hosts.entries()]
      .filter(([, entry]) => entry.state !== "closed" || entry.failures || entry.rejected || entry.active)
      .map(([host, entry]) => ({
        host,
        state: entry.state,
        active: entry.active,
        queued: entry.queue.length,
        failures: entry.failures,
        rejected: entry.rejected,
        opened: entry.opened,
        opensInSeconds: entry.state === "open" ? seconds(entry.openUntil - now) : undefined,
      }));
  }
}

export const outbound = new OutboundGuard();

export const metadataOutbound = new OutboundGuard(metadataConfigFromEnv());

const hostOf = (raw: string): string | undefined => {
  try { return new URL(raw.replace(/^stremio:\/\//i, "https://")).hostname.toLowerCase(); }
  catch { return undefined; }
};

/**
 * safeFetch plus the guard above. Only for short third-party calls -- addon JSON,
 * subtitles, artwork. Media transfers keep using safeFetch directly.
 */
export async function guardedFetch(raw: string, init: RequestInit = {}, interactive = false): Promise<Response> {
  const host = hostOf(raw);
  if (!host) return safeFetch(raw, init);
  return outbound.run(host, () => safeFetch(raw, init), interactive);
}

/** Metadata providers that are legitimately slow. A cold Wikidata SPARQL query runs
 *  longer than any deadline worth setting, so our own abort says nothing about the host. */
export async function guardedMetadataFetch(raw: string, init: RequestInit = {}): Promise<Response> {
  const host = hostOf(raw);
  if (!host) return safeFetch(raw, init);
  return metadataOutbound.run(host, () => safeFetch(raw, init));
}
