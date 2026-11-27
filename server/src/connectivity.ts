import { isIP } from "node:net";
import { AppError } from "./errors.js";
import { log } from "./logger.js";

export type InternetState = "online" | "offline";

export interface ConnectivityOptions {
  now?: () => number;
  /** Distinct hosts whose resolver must be unreachable inside `windowMs`, with no answer in
   *  between, before the server declares itself offline. Default 2. */
  hostsToTrip?: number;
  /** Default 60_000. */
  windowMs?: number;
  /** While offline, one request lookup is let through at most this often, and the background
   *  probe runs at most this often on its own clock. Default 15_000. */
  probeIntervalMs?: number;
  /** A lone failure is cross-checked against the last host that resolved at most this often.
   *  Default 30_000. */
  confirmIntervalMs?: number;
}

type Resolver = (host: string) => Promise<unknown>;

/** Codes that say the resolver itself could not be reached. ENOTFOUND and ENODATA are answers:
 *  a dead addon domain says nothing about the internet. */
const RESOLVER_DOWN = new Set(["EAI_AGAIN", "EAI_FAIL", "ETIMEOUT", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "ESERVFAIL"]);

/** Hosts the app talks to by design, asked (DNS only) to cross-check a lone failure when no host
 *  has resolved since the start. */
const REFERENCE_HOSTS = ["api.themoviedb.org", "v3-cinemeta.strem.io", "query.wikidata.org"];

const normalizedHost = (host: string): string =>
  host.trim().toLowerCase().replace(/^\[|\]$/g, "");

const isAddress = (host: string): boolean => isIP(normalizedHost(host)) !== 0;

const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
};

export class OfflineError extends AppError {
  constructor() {
    super("The server has no internet connection right now.", "err.offline", 503);
    this.name = "OfflineError";
  }
}

export const isOfflineError = (error: unknown): boolean => {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    if (current instanceof OfflineError) return true;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

export class Connectivity {
  private options: Required<ConnectivityOptions>;
  private current: InternetState = "online";
  private beganAt: number | undefined;
  private failures = new Map<string, number>();
  private lastGoodHost: string | undefined;
  private lastFailedHost: string | undefined;
  private lastRequestProbeAt = 0;
  private requestProbeInFlight = false;
  private lastBackgroundProbeAt = 0;
  private backgroundProbeInFlight = false;
  private lastConfirmAt = Number.NEGATIVE_INFINITY;
  private resolver: Resolver | undefined;
  private listeners = new Set<(offlineSince: number) => void>();

  constructor(options: ConnectivityOptions = {}) {
    this.options = this.settings(options);
  }

  private settings(options: ConnectivityOptions): Required<ConnectivityOptions> {
    return {
      now: options.now ?? Date.now,
      hostsToTrip: Math.max(1, Math.trunc(options.hostsToTrip ?? 2)),
      windowMs: Math.max(0, options.windowMs ?? 60_000),
      probeIntervalMs: Math.max(0, options.probeIntervalMs ?? 15_000),
      confirmIntervalMs: Math.max(0, options.confirmIntervalMs ?? 30_000),
    };
  }

  get state(): InternetState {
    return this.current;
  }

  get offlineSince(): string | undefined {
    return this.beganAt === undefined ? undefined : new Date(this.beganAt).toISOString();
  }

  /** The raw resolver used for the background probe and the cross-check; it must not pass
   *  through `admitLookup`. */
  useResolver(resolver: Resolver | undefined): void {
    this.resolver = resolver;
  }

  /** True when a lookup for this host may go to the resolver now: always while online; while
   *  offline only for one request every `probeIntervalMs` (the slot is taken by this call). */
  admitLookup(host: string): boolean {
    if (isAddress(host) || this.current === "online") return true;
    const now = this.options.now();
    if (this.requestProbeInFlight || now - this.lastRequestProbeAt < this.options.probeIntervalMs) return false;
    this.lastRequestProbeAt = now;
    this.requestProbeInFlight = true;
    return true;
  }

  recordLookupSuccess(host: string): void {
    if (isAddress(host)) return;
    this.lastGoodHost = normalizedHost(host);
    this.resolverAnswered();
  }

  recordLookupFailure(host: string, code: string | undefined): void {
    if (isAddress(host)) return;
    if (!code || !RESOLVER_DOWN.has(code)) {
      this.resolverAnswered();
      return;
    }
    const now = this.options.now();
    const key = normalizedHost(host);
    this.lastFailedHost = key;
    this.requestProbeInFlight = false;
    if (this.current === "offline") return;
    for (const [failedHost, at] of this.failures) {
      if (now - at >= this.options.windowMs) this.failures.delete(failedHost);
    }
    this.failures.set(key, now);
    if (this.failures.size >= this.options.hostsToTrip) {
      this.goOffline(now);
      return;
    }
    this.confirm(key, now);
  }

  /** Called by /api/status: while offline, re-resolves the last host that ever resolved (the
   *  last failed one when none did) on its own clock. Never throws. */
  probeIfDue(): void {
    const resolver = this.resolver;
    const host = this.lastGoodHost ?? this.lastFailedHost;
    if (this.current !== "offline" || !resolver || !host || this.backgroundProbeInFlight) return;
    const now = this.options.now();
    if (now - this.lastBackgroundProbeAt < this.options.probeIntervalMs) return;
    this.lastBackgroundProbeAt = now;
    this.backgroundProbeInFlight = true;
    this.resolveAndRecord(resolver, host).finally(() => { this.backgroundProbeInFlight = false; });
  }

  onOnline(listener: (offlineSince: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Test seam: production keeps one instance for the process lifetime. */
  reset(options: ConnectivityOptions = {}): void {
    this.options = this.settings(options);
    this.current = "online";
    this.beganAt = undefined;
    this.failures.clear();
    this.lastGoodHost = undefined;
    this.lastFailedHost = undefined;
    this.lastRequestProbeAt = 0;
    this.requestProbeInFlight = false;
    this.lastBackgroundProbeAt = 0;
    this.backgroundProbeInFlight = false;
    this.lastConfirmAt = Number.NEGATIVE_INFINITY;
  }

  /** A single failing host may be one broken domain; another host the resolver should know tells. */
  private confirm(failedHost: string, now: number): void {
    const resolver = this.resolver;
    const good = this.lastGoodHost && this.lastGoodHost !== failedHost
      ? this.lastGoodHost
      : REFERENCE_HOSTS.find((host) => host !== failedHost);
    if (!resolver || !good || this.failures.has(good)) return;
    if (now - this.lastConfirmAt < this.options.confirmIntervalMs) return;
    this.lastConfirmAt = now;
    void this.resolveAndRecord(resolver, good);
  }

  private resolveAndRecord(resolver: Resolver, host: string): Promise<void> {
    let lookup: Promise<unknown>;
    try {
      lookup = resolver(host);
    } catch (error) {
      this.recordLookupFailure(host, codeOf(error));
      return Promise.resolve();
    }
    return lookup.then(
      () => { this.recordLookupSuccess(host); },
      (error: unknown) => { this.recordLookupFailure(host, codeOf(error)); },
    );
  }

  private goOffline(now: number): void {
    this.current = "offline";
    this.beganAt = now;
    this.lastRequestProbeAt = now;
    this.lastBackgroundProbeAt = now;
    log("WARN", "The internet connection looks down, outbound requests fail fast", {
      hosts: [...this.failures.keys()],
    });
  }

  private resolverAnswered(): void {
    this.failures.clear();
    this.requestProbeInFlight = false;
    if (this.current === "online") return;
    const now = this.options.now();
    const began = this.beganAt ?? now;
    this.current = "online";
    this.beganAt = undefined;
    log("INFO", "The internet connection is back", { offlineSeconds: Math.max(0, Math.round((now - began) / 1000)) });
    for (const listener of [...this.listeners]) {
      try {
        listener(began);
      } catch {
        // One listener must not keep the others from running.
      }
    }
  }
}

export const connectivity = new Connectivity();

export function resetConnectivityForTests(options?: ConnectivityOptions): void {
  connectivity.reset(options);
}
