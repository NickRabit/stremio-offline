import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FetchLike } from "./debrid.js";
import { log } from "./logger.js";
import { guardedFetch } from "./outbound.js";

/** Ids of the sites a title links to. IMDb is the catalogue id, the other two come
 *  from Wikidata. */
export interface ExternalIds { csfd?: string; tmdbMovie?: string; tmdbTv?: string }
export interface SiteLink { site: "csfd" | "tmdb" | "imdb"; url: string }

const WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql";
/** Wikidata answers 403 without a descriptive agent. */
const USER_AGENT = "StremioOffline (+https://github.com/NickRabit/stremio-offline)";
const TIMEOUT_MS = 12_000;
/** An answer that names no ids is the memory of a fruitless search, not a fact. */
const NEGATIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const IMDB_ID = /^tt\d+$/;
const TMDB_ID = /^tmdb:(\d+)$/;

const sparql = (imdbId: string) => `SELECT ?csfd ?tmdbMovie ?tmdbTv WHERE {
  ?item wdt:P345 "${imdbId}".
  OPTIONAL { ?item wdt:P2529 ?csfd }
  OPTIONAL { ?item wdt:P4947 ?tmdbMovie }
  OPTIONAL { ?item wdt:P4983 ?tmdbTv }
} LIMIT 1`;

interface CachedIds extends ExternalIds { at: string }
interface CacheFile { version: number; entries: Record<string, CachedIds> }

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 120);

const withoutEmpty = (ids: ExternalIds): ExternalIds => {
  const kept: ExternalIds = {};
  if (ids.csfd) kept.csfd = ids.csfd;
  if (ids.tmdbMovie) kept.tmdbMovie = ids.tmdbMovie;
  if (ids.tmdbTv) kept.tmdbTv = ids.tmdbTv;
  return kept;
};

async function writeAtomic(file: string, data: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, data, { mode: 0o600 });
  await rename(temp, file);
}

/**
 * Wikidata ids of a catalogue title, kept on disk: an id never changes, so a title is
 * asked about once. The store is the only place that talks to Wikidata, and it does so
 * one title at a time -- never in a loop over the library.
 */
export class ExternalIdStore {
  private entries: Record<string, CachedIds> = {};
  private readonly file: string;

  constructor(dataDir: string, private readonly fetchImpl: FetchLike = guardedFetch) {
    this.file = path.join(dataDir, "external-ids.json");
  }

  /** Reads data/external-ids.json. Never throws: a missing or broken file starts empty. */
  async load(): Promise<void> {
    const raw = await readFile(this.file, "utf8").catch(() => undefined);
    if (raw === undefined) return;
    try {
      const parsed = JSON.parse(raw) as Partial<CacheFile>;
      const entries = parsed.entries;
      this.entries = entries && typeof entries === "object" && !Array.isArray(entries) ? entries : {};
    } catch (error) {
      this.entries = {};
      log("WARN", "External ids could not be read", { reason: reasonOf(error) });
    }
  }

  /** Cached, otherwise one Wikidata query. Returns an empty object when Wikidata knows
   *  nothing, null when the lookup itself failed. */
  async ids(imdbId: string): Promise<ExternalIds | null> {
    if (!IMDB_ID.test(imdbId)) return null;
    const cached = this.entries[imdbId];
    if (cached) {
      const ids = withoutEmpty(cached);
      if (Object.keys(ids).length > 0 || Date.now() - Date.parse(cached.at) < NEGATIVE_TTL_MS) return ids;
    }
    const found = await this.lookup(imdbId);
    if (!found) return null;
    this.entries[imdbId] = { ...found, at: new Date().toISOString() };
    await this.save();
    return found;
  }

  private async lookup(imdbId: string): Promise<ExternalIds | null> {
    const url = new URL(WIKIDATA_ENDPOINT);
    url.searchParams.set("format", "json");
    url.searchParams.set("query", sparql(imdbId));
    try {
      const response = await this.fetchImpl(url.toString(), {
        headers: { accept: "application/sparql-results+json", "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        log("WARN", "Wikidata did not answer, the links stay partial", { id: imdbId, status: response.status });
        return null;
      }
      const body = await response.json() as { results?: { bindings?: Array<Record<string, { value?: string }>> } };
      const row = body.results?.bindings?.[0];
      const value = (name: string) => row?.[name]?.value || undefined;
      return withoutEmpty({ csfd: value("csfd"), tmdbMovie: value("tmdbMovie"), tmdbTv: value("tmdbTv") });
    } catch (error) {
      log("WARN", "Wikidata could not be reached, the links stay partial", { id: imdbId, reason: reasonOf(error) });
      return null;
    }
  }

  private async save() {
    try {
      await writeAtomic(this.file, JSON.stringify({ version: 1, entries: this.entries } satisfies CacheFile, null, 2));
    } catch (error) {
      log("WARN", "External ids could not be saved", { file: path.basename(this.file), reason: reasonOf(error) });
    }
  }
}

const tmdbTarget = (type: string, id: string, ids: ExternalIds): { path: "movie" | "tv"; id: string } | undefined => {
  // Which kind the catalogue thinks it is only decides which id to prefer. The path has to
  // follow the property that actually supplied the id, or the link points at another title.
  const ordered = type === "series"
    ? [["tv", ids.tmdbTv], ["movie", ids.tmdbMovie]] as const
    : [["movie", ids.tmdbMovie], ["tv", ids.tmdbTv]] as const;
  for (const [path, value] of ordered) if (value) return { path, id: value };
  const fromId = TMDB_ID.exec(id)?.[1];
  return fromId ? { path: type === "series" ? "tv" : "movie", id: fromId } : undefined;
};

/** Pure. The order and the set depend on the language: ČSFD only has Czech and Slovak
 *  pages, so it is behind the language and never built for anyone else. */
export function siteLinks(type: string, id: string, ids: ExternalIds, language: string): SiteLink[] {
  const czech = language === "cs";
  const target = tmdbTarget(type, id, ids);
  const tmdb: SiteLink | undefined = target
    ? { site: "tmdb", url: `https://www.themoviedb.org/${target.path}/${target.id}${czech ? "?language=cs-CZ" : ""}` }
    : undefined;
  const imdb: SiteLink | undefined = id.startsWith("tt") ? { site: "imdb", url: `https://www.imdb.com/title/${id}/` } : undefined;
  const csfd: SiteLink | undefined = czech && ids.csfd ? { site: "csfd", url: `https://www.csfd.cz/film/${ids.csfd}/` } : undefined;
  return (czech ? [csfd, tmdb, imdb] : [imdb, tmdb]).filter((link): link is SiteLink => Boolean(link));
}
