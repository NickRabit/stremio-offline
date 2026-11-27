import { isIP } from "node:net";
import { AppError } from "./errors.js";
import { log } from "./logger.js";

export type InternetState = "online" | "offline";

export interface ConnectivityOptions {
  now?: () => number;
  /** While offline, one request lookup is let through at most this often, and the background
   *  probe runs at most this often on its own clock. Default 15_000. */
  probeIntervalMs?: number;
  /** Organic failures never take the server offline on their own: a cross-check against a host
   *  that should resolve decides, at most this often. Default 5_000. */
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
  private lastGoodHost: string | undefined;
  private proofHost: string | undefined;
  private confirmInFlight = false;
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
      probeIntervalMs: Math.max(0, options.probeIntervalMs ?? 15_000),
      confirmIntervalMs: Math.max(0, options.confirmIntervalMs ?? 5_000),
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
    this.requestProbeInFlight = false;
    if (this.current === "offline") return;
    this.confirm(normalizedHost(host));
  }

  /** Called by /api/status: while offline, re-resolves the host whose cross-check proved the
   *  outage, on its own clock. Never throws. */
  probeIfDue(): void {
    const resolver = this.resolver;
    const host = this.proofHost;
    if (this.current !== "offline" || !resolver || !host || this.backgroundProbeInFlight) return;
    const now = this.options.now();
    if (now - this.lastBackgroundProbeAt < this.options.probeIntervalMs) return;
    this.lastBackgroundProbeAt = now;
    this.backgroundProbeInFlight = true;
    void this.resolve(resolver, host).then((outcome) => {
      this.backgroundProbeInFlight = false;
      if (outcome === "resolved") this.recordLookupSuccess(host);
      else if (outcome === "answered") this.resolverAnswered();
    });
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
    this.lastGoodHost = undefined;
    this.proofHost = undefined;
    this.confirmInFlight = false;
    this.lastRequestProbeAt = 0;
    this.requestProbeInFlight = false;
    this.lastBackgroundProbeAt = 0;
    this.backgroundProbeInFlight = false;
    this.lastConfirmAt = Number.NEGATIVE_INFINITY;
  }

  /** One domain with broken DNS also fails as "resolver down"; only a host that should resolve
   *  failing too proves the outage. */
  private confirm(failedHost: string): void {
    const resolver = this.resolver;
    if (!resolver || this.confirmInFlight) return;
    const now = this.options.now();
    if (now - this.lastConfirmAt < this.options.confirmIntervalMs) return;
    const target = this.lastGoodHost && this.lastGoodHost !== failedHost
      ? this.lastGoodHost
      : REFERENCE_HOSTS.find((host) => host !== failedHost);
    if (!target) return;
    this.lastConfirmAt = now;
    this.confirmInFlight = true;
    void this.resolve(resolver, target).then((outcome) => {
      this.confirmInFlight = false;
      if (outcome === "down") this.goOffline(target);
      else if (outcome === "resolved") this.recordLookupSuccess(target);
      else this.resolverAnswered();
    });
  }

  private resolve(resolver: Resolver, host: string): Promise<"resolved" | "answered" | "down"> {
    const outcome = (error: unknown) => {
      const code = codeOf(error);
      return code && RESOLVER_DOWN.has(code) ? "down" as const : "answered" as const;
    };
    try {
      return resolver(host).then(() => "resolved" as const, outcome);
    } catch (error) {
      return Promise.resolve(outcome(error));
    }
  }

  private goOffline(proofHost: string): void {
    if (this.current === "offline") return;
    const now = this.options.now();
    this.current = "offline";
    this.beganAt = now;
    this.proofHost = proofHost;
    this.lastRequestProbeAt = now;
    this.lastBackgroundProbeAt = now;
    log("WARN", "The internet connection looks down, outbound requests fail fast", { checked: proofHost });
  }

  private resolverAnswered(): void {
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
