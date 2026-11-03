import type { LibraryCandidateSource } from "./library-candidates.js";
import { autoAccept, parsedFromRemoteItem, scoreHit, yearFromMeta, type TitleKind } from "./library-match.js";
import { log } from "./logger.js";
import type { ProviderItem } from "./media-server-provider.js";
import type { PublicRemoteItem } from "./media-server-types.js";

const MATCH_TTL_MS = 24 * 60 * 60 * 1_000;
const MISS_TTL_MS = 6 * 60 * 60 * 1_000;
const FAILURE_TTL_MS = 10 * 60 * 1_000;
const MAX_CACHE_ENTRIES = 2_000;
const MAX_CONCURRENT_SEARCHES = 2;
const DEFAULT_TIMEOUT_MS = 2_000;

interface CachedMatch {
  expiresAt: number;
  providerIds?: { imdb?: string; tmdb?: string };
}

interface MatchOutcome {
  providerIds?: { imdb?: string; tmdb?: string };
  failed?: boolean;
}

type MatchItem = Pick<ProviderItem, "id" | "name" | "type" | "providerIds" | "year"> & {
  originalTitle?: string;
};

interface RemoteItemMatcherOptions {
  timeoutMs?: number;
}

const matchableKind = (type: string): type is TitleKind => type === "movie" || type === "series";

const providerIdsOf = (id: string): MatchOutcome["providerIds"] => {
  const imdb = /^tt\d+$/i.exec(id);
  if (imdb) return { imdb: imdb[0].toLowerCase() };
  const tmdb = /^tmdb:([1-9]\d*)$/.exec(id);
  return tmdb ? { tmdb: tmdb[1] } : undefined;
};

const waitAtMost = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> => {
  let timer: number | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, timeoutMs));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export class RemoteItemMatcher {
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, CachedMatch>();
  private readonly pending = new Map<string, Promise<MatchOutcome>>();
  private readonly waiting: Array<() => void> = [];
  private activeSearches = 0;

  constructor(private readonly candidates: LibraryCandidateSource, options: RemoteItemMatcherOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async enrich(libraryId: string, item: PublicRemoteItem, language: string): Promise<PublicRemoteItem> {
    if (!matchableKind(item.type) || item.providerIds.imdb || item.providerIds.tmdb) return item;
    const key = JSON.stringify([libraryId, item.id, item.name, item.year]);
    const cached = this.cached(key);
    const outcome = cached ? { providerIds: cached.providerIds } : await waitAtMost(this.pendingMatch(key, libraryId, item, language), this.timeoutMs);
    const providerIds = outcome?.providerIds;
    if (!providerIds) return item;
    log("DEBUG", "A media-server item title matched a catalogue identity", {
      libraryId,
      itemId: item.id,
      id: providerIds.imdb ?? (providerIds.tmdb ? `tmdb:${providerIds.tmdb}` : undefined),
    });
    return {
      ...item,
      providerIds: { ...item.providerIds, ...providerIds },
      providerIdsMatched: true,
    };
  }

  private cached(key: string): CachedMatch | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  private pendingMatch(key: string, libraryId: string, item: MatchItem, language: string): Promise<MatchOutcome> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const search = this.bounded(() => this.search(libraryId, item, language))
      .then((outcome) => {
        this.remember(key, outcome);
        return outcome;
      })
      .catch((error: unknown) => {
        log("WARN", "The remote item title match failed", {
          libraryId,
          itemId: item.id,
          reason: error instanceof Error ? error.message : String(error),
        });
        const outcome = { failed: true };
        this.remember(key, outcome);
        return outcome;
      })
      .finally(() => { this.pending.delete(key); });
    this.pending.set(key, search);
    return search;
  }

  private remember(key: string, outcome: MatchOutcome): void {
    const ttl = outcome.failed ? FAILURE_TTL_MS : outcome.providerIds ? MATCH_TTL_MS : MISS_TTL_MS;
    this.cache.delete(key);
    while (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(key, {
      expiresAt: Date.now() + ttl,
      ...(outcome.providerIds ? { providerIds: outcome.providerIds } : {}),
    });
  }

  private async bounded<T>(work: () => Promise<T>): Promise<T> {
    if (this.activeSearches >= MAX_CONCURRENT_SEARCHES) {
      await new Promise<void>((resolve) => { this.waiting.push(resolve); });
    }
    this.activeSearches += 1;
    try {
      return await work();
    } finally {
      this.activeSearches -= 1;
      this.waiting.shift()?.();
    }
  }

  private async search(libraryId: string, item: MatchItem, language: string): Promise<MatchOutcome> {
    if (!matchableKind(item.type)) return {};
    const kind = item.type;
    const parsed = parsedFromRemoteItem(item);
    const title = parsed.title || parsed.query;
    if (!title) return {};
    try {
      const originalTitle = item.originalTitle?.trim();
      const found = await this.candidates.searchLibraryCandidates(
        title,
        kind,
        item.year ?? undefined,
        language,
        originalTitle ? [originalTitle] : [],
      );
      const hits = found.filter((candidate) => candidate.item.name).map((candidate) => scoreHit(parsed, candidate.item, kind));
      const accepted = autoAccept(hits);
      if (!accepted) return {};
      const candidate = found.find((entry) => entry.item.id === accepted.item.id);
      if (!candidate) return {};
      const chosen = await this.candidates.resolveSelected(candidate, kind, language);
      // A provider year must agree exactly. Without one the item is judged like a library file
      // without a year: only autoAccept's strict rules (whole-name similarity, no close namesake).
      if (item.year != null && (yearFromMeta(accepted.item) !== item.year || yearFromMeta(chosen) !== item.year)) return {};
      return { providerIds: providerIdsOf(chosen.id) };
    } catch (error) {
      log("WARN", "The remote item title search failed", {
        libraryId,
        itemId: item.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      return { failed: true };
    }
  }
}
