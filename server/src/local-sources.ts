import type { FetchLike } from "./debrid.js";
import { FreshValueCache } from "./value-cache.js";
import { imdbOf } from "./external-ids.js";
import { tmdbIds } from "./tmdb-ids.js";
import { tmdbExternalIdResult, tmdbIdOf, type TmdbConfig } from "./tmdb.js";
import { isPathWithin, type FoundFile } from "./library.js";
import { episodeNumberOf, knownTitleForUnit, unitFor, type LibraryMetaRecord, type TitleUnit } from "./library-match.js";
import { parseLibraryPath, type LibraryRecord } from "./libraries.js";

export const LOCAL_COPY_LIMIT = 20;

export interface LocalRequest { type: "movie" | "series"; titleId: string; season?: number; episode?: number }

/** The title and episode numbers behind the catalogue id the clients pass to `GET /api/streams`. */
export function parseLocalRequest(type: string, id: string): LocalRequest | undefined {
  if (type === "movie") return { type: "movie", titleId: id };
  if (type !== "series") return undefined;
  const parts = id.split(":");
  if (parts.length < 3) return undefined;
  const episode = parts[parts.length - 1]!;
  const season = parts[parts.length - 2]!;
  if (!/^\d+$/.test(season) || !/^\d+$/.test(episode)) return undefined;
  return { type: "series", titleId: parts.slice(0, -2).join(":"), season: Number(season), episode: Number(episode) };
}

const aliasLookups = new FreshValueCache<string | null>(30_000, { maxEntries: 256 });

/** Resolve only the alternate id scheme present in the library, using verified TMDB pairs. */
export async function localTitleIds(type: string, id: string, records: Record<string, LibraryMetaRecord>,
  config?: TmdbConfig, fetchImpl?: FetchLike): Promise<string[]> {
  const request = parseLocalRequest(type, id);
  if (!request) return [];
  const ids = [request.titleId];
  const bindings = Object.values(records).filter((record) => record.type === request.type && record.id);
  const imdbId = imdbOf(request.titleId);
  if (imdbId && imdbId !== request.titleId) ids.push(imdbId);
  const tmdb = /^tmdb:(\d+)$/.exec(request.titleId);
  if (tmdb && bindings.some((record) => /^tt\d+$/.test(record.id!))) {
    const cached = tmdbIds.imdbOf(request.type, Number(tmdb[1]));
    const imdb = cached === undefined && config
      ? await aliasLookups.get(`${request.type}:${request.titleId}`, async () => {
        const result = await tmdbExternalIdResult(request.type, Number(tmdb[1]), config, fetchImpl, AbortSignal.timeout(2_000)).catch(() => null);
        return result?.status === "found" ? result.imdb : null;
      }) : cached;
    if (imdb) ids.push(imdb);
  } else if (imdbId && bindings.some((record) => /^tmdb:\d+$/.test(record.id!))) {
    const cached = tmdbIds.tmdbOf(request.type, imdbId);
    const resolved = cached === undefined && config
      ? await aliasLookups.get(`${request.type}:${imdbId}`, async () => {
        const result = await tmdbIdOf(request.type, imdbId, config, fetchImpl, AbortSignal.timeout(2_000)).catch(() => null);
        return result ? String(result) : null;
      }) : cached;
    if (resolved) ids.push(`tmdb:${resolved}`);
  }
  return ids;
}

export interface LocalCopy { key: string; libraryId: string; size: number; modified: string }

/** The library files that are a copy of one catalogue title or episode, in answer order. */
export function localCopies(input: {
  type: string; id: string;
  titleIds?: readonly string[];
  files: FoundFile[];
  units: TitleUnit[];
  records: Record<string, LibraryMetaRecord>;
  libraries: LibraryRecord[];
}): LocalCopy[] {
  const request = parseLocalRequest(input.type, input.id);
  if (!request) return [];

  const titleIds = new Set([request.titleId, ...(input.titleIds ?? [])]);
  const bindingKeys = Object.keys(input.records)
    .filter((key) => titleIds.has(input.records[key]!.id ?? "") && input.records[key]!.type === request.type);
  if (!bindingKeys.length) return [];

  const covered = (key: string) => bindingKeys.some((binding) => isPathWithin(key, binding));
  const byKey = new Map(input.files.map((file) => [file.relative, file]));
  const candidates = new Set<string>();
  for (const file of input.files) if (covered(file.relative)) candidates.add(file.relative);
  // A folder unit may be keyed by one representative video, so an alternate encode is only
  // reached through the unit's sample files, not through path containment.
  for (const unit of input.units) {
    if (!covered(unit.key)) continue;
    for (const sample of unit.sampleFiles) if (byKey.has(sample)) candidates.add(sample);
  }

  const orders = new Map(input.libraries.map((library) => [library.id, library.order]));
  const kept: Array<{ copy: LocalCopy; order: number }> = [];
  for (const key of candidates) {
    const libraryId = parseLibraryPath(key)?.libraryId;
    const order = libraryId ? orders.get(libraryId) : undefined;
    if (libraryId === undefined || order === undefined) continue;
    const record = knownTitleForUnit(unitFor(key, input.units), input.records, key);
    if (!record || record.type !== request.type || !titleIds.has(record.id ?? "")) continue;
    const file = byKey.get(key);
    if (!file) continue;
    if (request.type === "series") {
      const own = input.records[key]?.id ? input.records[key] : undefined;
      const numbers = episodeNumberOf(key, own, { loose: true });
      if (!numbers || numbers.season !== request.season || numbers.episode !== request.episode) continue;
    }
    kept.push({ copy: { key, libraryId, size: file.size, modified: file.modified }, order });
  }
  kept.sort((left, right) => left.order - right.order
    || right.copy.size - left.copy.size
    || (left.copy.key < right.copy.key ? -1 : left.copy.key > right.copy.key ? 1 : 0));
  return kept.slice(0, LOCAL_COPY_LIMIT).map((entry) => entry.copy);
}
