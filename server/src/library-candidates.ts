import { searchAll } from "./addons.js";
import { parseMediaPath, type ParsedMedia } from "./library-parse.js";
import { scoreHit, SUGGESTION_MIN_SCORE, type TitleKind } from "./library-match.js";
import { log as serverLog } from "./logger.js";
import type { MediaInfo } from "./naming.js";
import { tmdbExternalId, tmdbGallery, tmdbSearch, type TmdbConfig } from "./tmdb.js";
import type { AddonRecord, MetaItem } from "./types.js";

/** One candidate a trusted provider offered for a library title. */
export interface LibraryCandidate {
  item: MetaItem;
  provider: "tmdb" | "cinemeta";
}

/** The seam the scan and the manual search both need: a title search, the identity
 *  resolution of the chosen candidate, and its alternate artwork. */
export interface LibraryCandidateSource {
  searchLibraryCandidates(query: string, kind: TitleKind, year: number | undefined, language: string): Promise<LibraryCandidate[]>;
  resolveSelected(candidate: LibraryCandidate, kind: TitleKind, language: string): Promise<MetaItem>;
  galleryOf(candidate: LibraryCandidate, kind: TitleKind, language: string): Promise<NonNullable<MediaInfo["gallery"]>>;
}

/** The installed addon whose metadata may create a binding on its own. */
export const CINEMETA_ID = "com.linvo.cinemeta";

type Logger = (level: "DEBUG" | "INFO" | "WARN", message: string, fields?: Record<string, unknown>) => void;

export interface LibraryCandidatesDeps {
  /** The key and language TMDB is asked with, or undefined when the install has none. */
  tmdb: () => TmdbConfig | undefined;
  /** Every configured addon; only the Cinemeta one is ever searched. */
  addons: () => AddonRecord[];
  searchTmdb?: (kind: TitleKind, query: string, config: TmdbConfig) => Promise<MetaItem[]>;
  searchCinemeta?: (addons: AddonRecord[], query: string, kind: TitleKind) => Promise<MetaItem[]>;
  externalId?: (kind: TitleKind, tmdbId: number, config: TmdbConfig) => Promise<string | null>;
  gallery?: (kind: TitleKind, id: string, config: TmdbConfig) => Promise<NonNullable<MediaInfo["gallery"]>>;
  log?: Logger;
}

const tmdbIdOf = (id: string): number | undefined => {
  const match = /^tmdb:(\d+)$/.exec(id);
  return match ? Number(match[1]) : undefined;
};

const isCinemeta = (addon: AddonRecord) => addon.manifest.id === CINEMETA_ID;

/** Keeps one entry per identity, in the order the provider ranked them. */
function dedupe(candidates: LibraryCandidate[]): LibraryCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.item.type}:${candidate.item.id}`;
    if (!candidate.item.id || !candidate.item.name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** What one provider answered, scored against the title the file names. */
function scored(parsed: ParsedMedia, candidates: LibraryCandidate[], kind: TitleKind) {
  return candidates.map((candidate) => ({ candidate, hit: scoreHit(parsed, candidate.item, kind) }));
}

/** The one search and resolution service behind both the scan and the manual library
 *  search: TMDB first when it is configured, Cinemeta as the fallback, and nothing else. */
export class LibraryCandidates implements LibraryCandidateSource {
  private readonly log: Logger;

  constructor(private readonly deps: LibraryCandidatesDeps) {
    this.log = deps.log ?? ((level, message, fields) => serverLog(level, message, fields ?? {}));
  }

  private tmdbConfig(language: string): TmdbConfig | undefined {
    const configured = this.deps.tmdb();
    return configured?.apiKey ? { ...configured, language } : undefined;
  }

  private searchTmdbOf(kind: TitleKind, query: string, config: TmdbConfig): Promise<MetaItem[]> {
    return (this.deps.searchTmdb ?? ((type, text, cfg) => tmdbSearch(type, text, cfg)))(kind, query, config);
  }

  private async searchCinemetaOf(query: string, kind: TitleKind): Promise<LibraryCandidate[]> {
    const addon = this.deps.addons().find((item) => item.enabled && item.role !== "source" && isCinemeta(item));
    if (!addon) {
      this.log("DEBUG", "No Cinemeta addon to search for a library title", { query, kind });
      return [];
    }
    const search = this.deps.searchCinemeta
      ?? (async (addons, text, type) => (await searchAll(addons, text, type, undefined, { respectGlobalSearch: false })).items);
    try {
      const items = await search([addon], query, kind);
      return items.map((item) => ({ item: { ...item, type: item.type || kind }, provider: "cinemeta" as const }));
    } catch (error) {
      this.log("WARN", "The Cinemeta search failed", { provider: "cinemeta", kind, reason: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  /** TMDB first, Cinemeta when TMDB has nothing plausible or is not configured. */
  async searchLibraryCandidates(query: string, kind: TitleKind, year: number | undefined, language: string): Promise<LibraryCandidate[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const parsed: ParsedMedia = { ...parseMediaPath(trimmed), ...(year != null ? { year } : {}) };

    const config = this.tmdbConfig(language);
    if (config) {
      let items: MetaItem[] = [];
      try {
        items = await this.searchTmdbOf(kind, trimmed, config);
      } catch (error) {
        this.log("WARN", "The TMDB search failed", { provider: "tmdb", kind, reason: error instanceof Error ? error.message : String(error) });
      }
      const candidates = dedupe(items.map((item) => ({ item, provider: "tmdb" as const })));
      const best = scored(parsed, candidates, kind).reduce((top, entry) => Math.max(top, entry.hit.score), 0);
      if (best >= SUGGESTION_MIN_SCORE) return candidates;
      this.log("DEBUG", "TMDB offered no plausible candidate, trying Cinemeta", { provider: "tmdb", kind, query: trimmed, best });
    }
    return dedupe(await this.searchCinemetaOf(trimmed, kind));
  }

  /** The identity to bind for the chosen candidate: an IMDb id when TMDB has one, the
   *  TMDB id itself otherwise. A Cinemeta candidate is already bindable. */
  async resolveSelected(candidate: LibraryCandidate, kind: TitleKind, language: string): Promise<MetaItem> {
    if (candidate.provider !== "tmdb") return candidate.item;
    const tmdbId = tmdbIdOf(candidate.item.id);
    const config = this.tmdbConfig(language);
    if (tmdbId == null || !config) return candidate.item;
    const external = this.deps.externalId ?? ((type, id, cfg) => tmdbExternalId(type, id, cfg));
    let imdb: string | null = null;
    try { imdb = await external(kind, tmdbId, config); }
    catch (error) {
      this.log("WARN", "The TMDB identity lookup failed", { provider: "tmdb", kind, reason: error instanceof Error ? error.message : String(error) });
    }
    if (!imdb) return candidate.item;
    return { ...candidate.item, id: imdb, tmdbId: candidate.item.id };
  }

  /** Alternate artwork of a chosen title, through the same provider that named it. */
  async galleryOf(candidate: LibraryCandidate, kind: TitleKind, language: string): Promise<NonNullable<MediaInfo["gallery"]>> {
    if (candidate.provider !== "tmdb") return [];
    const config = this.tmdbConfig(language);
    if (!config) return [];
    const gallery = this.deps.gallery ?? ((type, id, cfg) => tmdbGallery(type, id, cfg));
    // A gallery nobody could fetch is a title without a gallery, never a failed match.
    let pictures: NonNullable<MediaInfo["gallery"]> = [];
    try { pictures = await gallery(kind, candidate.item.id, config); }
    catch (error) {
      this.log("WARN", "The TMDB gallery lookup failed", { provider: "tmdb", kind, reason: error instanceof Error ? error.message : String(error) });
    }
    return pictures.filter((picture) => Boolean(picture.url)).map((picture) => ({ url: picture.url, kind: picture.kind }));
  }
}

export const createLibraryCandidates = (deps: LibraryCandidatesDeps): LibraryCandidates => new LibraryCandidates(deps);
