import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FetchLike } from "./debrid.js";
import { renameWithRetry } from "./fs-retry.js";
import { log } from "./logger.js";
import { guardedMetadataBody } from "./outbound.js";
import { readLimitedBody } from "./response-body.js";

/** Ids of the sites a title links to. IMDb is the catalogue id, the other two come
 *  from Wikidata. */
export interface ExternalIds { csfd?: string; tmdbMovie?: string; tmdbTv?: string }
export interface SiteLink { site: "csfd" | "tmdb" | "imdb"; url: string }

const WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql";
/** Wikidata answers 403 without a descriptive agent. */
const USER_AGENT = "StremioOffline (+https://github.com/NickRabit/stremio-offline)";
/** WDQS's own hard query limit is 60 s and a cold query ordinarily takes 15-30 s. */
const TIMEOUT_MS = 45_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
/** An answer that names no ids is the memory of a fruitless search, not a fact. */
const NEGATIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const IMDB_ID = /^tt\d+$/;
const TMDB_ID = /^tmdb:(\d+)$/;

/** The IMDb id an id carries, when it carries one. A catalogue chooses its own ids and an
 *  addon that groups titles by source prefixes them (`mpa:webshare-index:tt2709692`), so the
 *  IMDb id is the last segment rather than the whole id. */
export const imdbOf = (id: string): string | undefined => /(?:^|:)(tt\d+)$/.exec(id)?.[1];

const sparql = (imdbId: string) => `SELECT ?csfd ?tmdbMovie ?tmdbTv WHERE {
  ?item wdt:P345 "${imdbId}".
  OPTIONAL { ?item wdt:P2529 ?csfd }
  OPTIONAL { ?item wdt:P4947 ?tmdbMovie }
  OPTIONAL { ?item wdt:P4983 ?tmdbTv }
} LIMIT 1`;

interface CachedIds extends ExternalIds { at: string }
interface CacheFile { version: number; entries: Record<string, CachedIds> }

const reasonOf = (error: unknown) =>
  error instanceof SyntaxError ? "Response body is not valid JSON." : (error instanceof Error ? error.message : String(error)).slice(0, 120);

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? Object.assign(new Error("The lookup was cancelled."), { name: "AbortError" });

const readWikidataJson = async <T>(response: Response, signal: AbortSignal): Promise<T> =>
  JSON.parse(new TextDecoder().decode(await readLimitedBody(response, MAX_JSON_BYTES, signal))) as T;

type WikidataAnswer =
  | { status: "ok"; body: { results?: { bindings?: Array<Record<string, { value?: string }>> } } }
  | { status: "http"; code: number };

const readWikidataAnswer = async (response: Response, signal: AbortSignal): Promise<WikidataAnswer> => {
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    return { status: "http", code: response.status };
  }
  return { status: "ok", body: await readWikidataJson(response, signal) };
};

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
  await renameWithRetry(temp, file);
}

interface FlightWaiter {
  onAbort(): void;
}

interface IdFlight {
  controller: AbortController;
  waiters: Set<FlightWaiter>;
  done: Promise<ExternalIds | null>;
  settled: boolean;
  abandoned: boolean;
}

/**
 * Wikidata ids of a catalogue title, kept on disk: an id never changes, so a title is
 * asked about once. The store is the only place that talks to Wikidata, and it does so
 * one title at a time -- never in a loop over the library.
 */
export class ExternalIdStore {
  private entries: Record<string, CachedIds> = {};
  private inFlight = new Map<string, IdFlight>();
  private saving: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(dataDir: string, private readonly fetchImpl?: FetchLike) {
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

  /** Only what is already on disk, never a request: search may read it while it runs. */
  cachedIds(imdbId: string): ExternalIds | undefined {
    const cached = IMDB_ID.test(imdbId) ? this.entries[imdbId] : undefined;
    return cached ? withoutEmpty(cached) : undefined;
  }

  /** Cached, otherwise one Wikidata query. Returns an empty object when Wikidata knows
   *  nothing, null when the lookup itself failed. */
  async ids(imdbId: string, signal?: AbortSignal): Promise<ExternalIds | null> {
    if (!IMDB_ID.test(imdbId)) return null;
    const cached = this.entries[imdbId];
    if (cached) {
      const ids = withoutEmpty(cached);
      if (Object.keys(ids).length > 0 || Date.now() - Date.parse(cached.at) < NEGATIVE_TTL_MS) return ids;
    }
    if (signal?.aborted) throw abortReason(signal);
    const flight = this.inFlight.get(imdbId) ?? this.start(imdbId);
    return this.attach(imdbId, flight, signal);
  }

  private start(imdbId: string): IdFlight {
    const flight: IdFlight = {
      controller: new AbortController(),
      waiters: new Set<FlightWaiter>(),
      done: Promise.resolve<ExternalIds | null>(null),
      settled: false,
      abandoned: false,
    };
    this.inFlight.set(imdbId, flight);
    flight.done = (async () => {
      try {
        const found = await this.lookup(imdbId, flight.controller.signal);
        if (!found || flight.abandoned || flight.controller.signal.aborted) return null;
        this.entries[imdbId] = { ...found, at: new Date().toISOString() };
        await this.save();
        return found;
      } catch (error) {
        if (flight.controller.signal.aborted) return null;
        throw error;
      }
    })().finally(() => {
      flight.settled = true;
      if (this.inFlight.get(imdbId) === flight) this.inFlight.delete(imdbId);
    });
    return flight;
  }

  private attach(imdbId: string, flight: IdFlight, signal?: AbortSignal): Promise<ExternalIds | null> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const waiter: FlightWaiter = {
        onAbort: () => {
          if (settled) return;
          settled = true;
          cleanup();
          flight.waiters.delete(waiter);
          reject(abortReason(signal!));
          this.abandon(imdbId, flight);
        },
      };
      const cleanup = () => signal?.removeEventListener("abort", waiter.onAbort);
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        flight.waiters.delete(waiter);
        settle();
      };
      flight.waiters.add(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      flight.done.then(
        (ids) => finish(() => resolve(ids)),
        (error) => finish(() => reject(error)),
      );
      if (signal?.aborted) waiter.onAbort();
    });
  }

  private abandon(imdbId: string, flight: IdFlight): void {
    if (flight.waiters.size > 0 || flight.settled) return;
    flight.abandoned = true;
    if (this.inFlight.get(imdbId) === flight) this.inFlight.delete(imdbId);
    flight.controller.abort();
  }

  private async lookup(imdbId: string, signal: AbortSignal): Promise<ExternalIds | null> {
    const url = new URL(WIKIDATA_ENDPOINT);
    url.searchParams.set("format", "json");
    url.searchParams.set("query", sparql(imdbId));
    try {
      const answer = await guardedMetadataBody<WikidataAnswer>(
        url.toString(),
        { headers: { accept: "application/sparql-results+json", "user-agent": USER_AGENT } },
        readWikidataAnswer,
        { signal, deadlineMs: TIMEOUT_MS },
        this.fetchImpl,
      );
      if (answer.status === "http") {
        log("WARN", "Wikidata did not answer, the links stay partial", { id: imdbId, status: answer.code });
        return null;
      }
      const body = answer.body;
      const row = body.results?.bindings?.[0];
      const value = (name: string) => row?.[name]?.value || undefined;
      return withoutEmpty({ csfd: value("csfd"), tmdbMovie: value("tmdbMovie"), tmdbTv: value("tmdbTv") });
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      log("WARN", "Wikidata could not be reached, the links stay partial", { id: imdbId, reason: reasonOf(error) });
      return null;
    }
  }

  /** One write at a time: two lookups finishing together would share the temporary file. */
  private save(): Promise<void> {
    this.saving = this.saving.then(async () => {
      try {
        await writeAtomic(this.file, JSON.stringify({ version: 1, entries: this.entries } satisfies CacheFile, null, 2));
      } catch (error) {
        log("WARN", "External ids could not be saved", { file: path.basename(this.file), reason: reasonOf(error) });
      }
    });
    return this.saving;
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
  const imdbId = imdbOf(id);
  const imdb: SiteLink | undefined = imdbId ? { site: "imdb", url: `https://www.imdb.com/title/${imdbId}/` } : undefined;
  const csfd: SiteLink | undefined = czech && ids.csfd ? { site: "csfd", url: `https://www.csfd.cz/film/${ids.csfd}/` } : undefined;
  return (czech ? [csfd, tmdb, imdb] : [imdb, tmdb]).filter((link): link is SiteLink => Boolean(link));
}
