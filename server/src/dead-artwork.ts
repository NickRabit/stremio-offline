import { cancelResponseBody } from "./response-body.js";
import { safeFetch } from "./security.js";

type Probe = (url: string, signal?: AbortSignal) => Promise<number | undefined>;

const METAHUB_HOSTS = new Set(["images.metahub.space", "live.metahub.space"]);
const FIELDS = ["poster", "background", "logo"] as const;
const ALIVE_TTL_MS = 6 * 60 * 60_000;
const DEAD_TTL_MS = 60 * 60_000;
const PROBE_TIMEOUT_MS = 4_000;
const CACHE_LIMIT = 2000;

const probeStatus: Probe = async (url, signal) => {
  try {
    const response = await safeFetch(url, {
      method: "HEAD",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]) : AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    cancelResponseBody(response);
    return response.status;
  } catch {
    return undefined;
  }
};

/**
 * Metahub advertises a poster, a backdrop and a logo for every IMDb id and answers 404 for the
 * ones it never drew. A page that holds such a link shows a black slot, and it ranks ahead of the
 * picture the catalogue listing carried. Only a definite 404 or 410 removes a link; a timeout or
 * any other answer keeps it, so a provider hiccup never strips a title of its artwork.
 */
export class DeadArtwork {
  private known = new Map<string, { dead: boolean; at: number }>();

  constructor(
    private readonly probe: Probe = probeStatus,
    private readonly now: () => number = Date.now,
  ) {}

  private async isDead(url: string, signal?: AbortSignal): Promise<boolean> {
    const cached = this.known.get(url);
    if (cached && this.now() - cached.at < (cached.dead ? DEAD_TTL_MS : ALIVE_TTL_MS)) return cached.dead;
    const status = await this.probe(url, signal);
    if (status === undefined) return false;
    const dead = status === 404 || status === 410;
    if (this.known.size >= CACHE_LIMIT) this.known.clear();
    this.known.set(url, { dead, at: this.now() });
    return dead;
  }

  async prune<T extends Record<string, unknown>>(meta: T, signal?: AbortSignal): Promise<T> {
    const candidates = FIELDS.flatMap((field) => {
      const value = meta[field];
      if (typeof value !== "string") return [];
      try {
        return METAHUB_HOSTS.has(new URL(value).host) ? [{ field, value }] : [];
      } catch {
        return [];
      }
    });
    if (!candidates.length) return meta;
    const verdicts = await Promise.all(candidates.map(async (candidate) => ({ ...candidate, dead: await this.isDead(candidate.value, signal) })));
    const dead = verdicts.filter((verdict) => verdict.dead);
    if (!dead.length) return meta;
    const next: Record<string, unknown> = { ...meta };
    for (const verdict of dead) delete next[verdict.field];
    return next as T;
  }
}

export const deadArtwork = new DeadArtwork();
