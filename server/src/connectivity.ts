import { isIP } from "node:net";
import { AppError } from "./errors.js";
import { log } from "./logger.js";

export type InternetState = "online" | "offline";

export interface ConnectivityOptions {
  now?: () => number;
  /** Distinct hosts whose lookup must fail inside `windowMs`, with no successful lookup in
   *  between, before the server declares itself offline. Default 3. */
  hostsToTrip?: number;
  /** Default 60_000. */
  windowMs?: number;
  /** While offline, one real lookup is let through at most this often. Default 15_000. */
  probeIntervalMs?: number;
}

const normalizedHost = (host: string): string =>
  host.trim().toLowerCase().replace(/^\[|\]$/g, "");

const isAddress = (host: string): boolean => isIP(normalizedHost(host)) !== 0;

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
  private lastFailedHost: string | undefined;
  private lastProbeAt = 0;
  private probeInFlight = false;
  private probeReservedFor: string | undefined;
  private listeners = new Set<() => void>();

  constructor(options: ConnectivityOptions = {}) {
    this.options = this.settings(options);
  }

  private settings(options: ConnectivityOptions): Required<ConnectivityOptions> {
    return {
      now: options.now ?? Date.now,
      hostsToTrip: Math.max(1, Math.trunc(options.hostsToTrip ?? 3)),
      windowMs: Math.max(0, options.windowMs ?? 60_000),
      probeIntervalMs: Math.max(0, options.probeIntervalMs ?? 15_000),
    };
  }

  get state(): InternetState {
    return this.current;
  }

  get offlineSince(): string | undefined {
    return this.beganAt === undefined ? undefined : new Date(this.beganAt).toISOString();
  }

  admitLookup(host: string): boolean {
    if (isAddress(host)) return true;
    if (this.current === "online") return true;
    if (this.probeReservedFor === normalizedHost(host)) {
      this.probeReservedFor = undefined;
      return true;
    }
    const now = this.options.now();
    if (this.probeInFlight || now - this.lastProbeAt < this.options.probeIntervalMs) return false;
    this.lastProbeAt = now;
    this.probeInFlight = true;
    return true;
  }

  recordLookupSuccess(host: string): void {
    if (isAddress(host)) return;
    this.failures.clear();
    this.lastFailedHost = undefined;
    this.probeInFlight = false;
    this.probeReservedFor = undefined;
    if (this.current === "online") return;
    const now = this.options.now();
    const offlineSeconds = this.beganAt === undefined ? 0 : Math.max(0, Math.round((now - this.beganAt) / 1000));
    this.current = "online";
    this.beganAt = undefined;
    log("INFO", "The internet connection is back", { offlineSeconds });
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A listener must not prevent the state transition or other listeners from running.
      }
    }
  }

  recordLookupFailure(host: string, _code: string | undefined): void {
    if (isAddress(host)) return;
    const now = this.options.now();
    const key = normalizedHost(host);
    this.lastFailedHost = key;
    this.probeInFlight = false;
    this.probeReservedFor = undefined;
    if (this.current === "offline") return;
    for (const [failedHost, at] of this.failures) {
      if (now - at >= this.options.windowMs) this.failures.delete(failedHost);
    }
    this.failures.set(key, now);
    if (this.failures.size < this.options.hostsToTrip) return;
    this.current = "offline";
    this.beganAt = now;
    this.lastProbeAt = now;
    log("WARN", "The internet connection looks down, outbound requests fail fast", {
      hosts: [...this.failures.keys()],
    });
  }

  probeIfDue(lookup: (host: string) => Promise<unknown>): void {
    if (this.current !== "offline" || !this.lastFailedHost || this.probeInFlight) return;
    const now = this.options.now();
    if (now - this.lastProbeAt < this.options.probeIntervalMs) return;
    const host = this.lastFailedHost;
    this.lastProbeAt = now;
    this.probeInFlight = true;
    this.probeReservedFor = host;
    let probe: Promise<unknown>;
    try {
      probe = lookup(host);
    } catch (error) {
      this.probeReservedFor = undefined;
      const code = (error as { code?: unknown } | null)?.code;
      this.recordLookupFailure(host, typeof code === "string" ? code : undefined);
      return;
    }
    void probe.then(
      () => {
        if (this.probeReservedFor === host) this.recordLookupSuccess(host);
      },
      (error: unknown) => {
        if (this.probeReservedFor !== host) return;
        const code = (error as { code?: unknown } | null)?.code;
        this.recordLookupFailure(host, typeof code === "string" ? code : undefined);
      },
    );
  }

  onOnline(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Test seam: production keeps one instance for the process lifetime. */
  reset(options: ConnectivityOptions = {}): void {
    this.options = this.settings(options);
    this.current = "online";
    this.beganAt = undefined;
    this.failures.clear();
    this.lastFailedHost = undefined;
    this.lastProbeAt = 0;
    this.probeInFlight = false;
    this.probeReservedFor = undefined;
  }
}

export const connectivity = new Connectivity();

export function resetConnectivityForTests(options?: ConnectivityOptions): void {
  connectivity.reset(options);
}
