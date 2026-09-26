import { searchAll } from "./addons.js";
import { parseMediaName, titleVariants, type ParsedMedia } from "./library-parse.js";
import { AUTO_ACCEPT_MIN_SCORE, normalizeTitle, scoreHit, SUGGESTION_MIN_SCORE, type TitleKind } from "./library-match.js";
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
  searchLibraryCandidates(
    query: string, kind: TitleKind, year: number | undefined, language: string, extraQueries?: string[],
  ): Promise<LibraryCandidate[]>;
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
  searchTmdb?: (kind: TitleKind, query: string, config: TmdbConfig, year?: number) => Promise<MetaItem[]>;
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

  private searchTmdbOf(kind: TitleKind, query: string, config: TmdbConfig, year?: number): Promise<MetaItem[]> {
    const search = this.deps.searchTmdb ?? ((type, text, cfg, when) => tmdbSearch(type, text, cfg, undefined, when != null ? { year: when } : {}));
    return search(kind, query, config, year);
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

  /** TMDB first, Cinemeta when TMDB has nothing plausible or is not configured. A title is
   *  asked about in every form worth searching, but a provider that already named it well
   *  enough is not asked again. A year the file states narrows the first question, and one
   *  that comes back with nothing plausible is asked again without it. Names the caller kept
   *  beside the title, such as the one file of a folder, are searched after the title's own. */
  async searchLibraryCandidates(
    query: string, kind: TitleKind, year: number | undefined, language: string, extraQueries: string[] = [],
  ): Promise<LibraryCandidate[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const extras = extraQueries.map((extra) => extra.trim()).filter(Boolean);
    // The query is a typed title, not a path: a " / " in it is a separator, not a folder.
    const parsed: ParsedMedia = {
      ...parseMediaName(trimmed),
      ...(year != null ? { year } : {}),
      // One name kept beside the title is the file the folder holds; scoring reads it as a
      // half of the name, so it may propose a candidate but never bind one on its own.
      ...(extras.length === 1 ? { fileTitle: extras[0]! } : {}),
    };
    const queries = titleVariants(parsed).map((variant) => variant.text);
    const searchQueries = queries.length ? [...queries] : [trimmed];
    const seen = new Set(searchQueries.map((text) => normalizeTitle(text)));
    for (const extra of extras) {
      const key = normalizeTitle(extra);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      searchQueries.push(extra);
    }

    const scoreOf = (candidates: LibraryCandidate[]) =>
      candidates.reduce((top, candidate) => Math.max(top, scoreHit(parsed, candidate.item, kind).score), 0);
    const ranked = (candidates: LibraryCandidate[]) =>
      [...candidates].sort((a, b) => scoreHit(parsed, b.item, kind).score - scoreHit(parsed, a.item, kind).score);

    const config = this.tmdbConfig(language);
    if (config) {
      const ask = async (text: string, when?: number): Promise<LibraryCandidate[]> => {
        try {
          const items = await this.searchTmdbOf(kind, text, config, when);
          return items.map((item) => ({ item, provider: "tmdb" as const }));
        } catch (error) {
          this.log("WARN", "The TMDB search failed", { provider: "tmdb", kind, reason: error instanceof Error ? error.message : String(error) });
          return [];
        }
      };
      let merged: LibraryCandidate[] = [];
      let best = 0;
      for (const text of searchQueries) {
        let found = year != null ? await ask(text, year) : await ask(text);
        if (year != null && !found.some((candidate) => scoreHit(parsed, candidate.item, kind).score >= SUGGESTION_MIN_SCORE)) {
          // The year may be wrong, or belong to a different release of the same name.
          found = dedupe([...found, ...await ask(text)]);
        }
        merged = dedupe([...merged, ...found]);
        best = scoreOf(merged);
        if (best >= AUTO_ACCEPT_MIN_SCORE) break;
      }
      if (best >= SUGGESTION_MIN_SCORE) return ranked(merged);
      this.log("DEBUG", "TMDB offered no plausible candidate, trying Cinemeta", { provider: "tmdb", kind, query: trimmed, best });
    }

    let merged: LibraryCandidate[] = [];
    let best = 0;
    for (const text of searchQueries) {
      merged = dedupe([...merged, ...await this.searchCinemetaOf(text, kind)]);
      best = scoreOf(merged);
      if (best >= AUTO_ACCEPT_MIN_SCORE) break;
    }
    return ranked(merged);
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
