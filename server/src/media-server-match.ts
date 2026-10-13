import type { ProviderItem } from "./media-server-provider.js";

type ExternalIds = ProviderItem["providerIds"];
export interface RemoteMatchTarget {
  type: "movie" | "episode";
  ids: ExternalIds;
  season?: number;
  episode?: number;
}

export function remoteMatchTarget(type: string, id: string): RemoteMatchTarget | undefined {
  if (id.length > 256) return undefined;
  const match = /^(tt[0-9]+|(?:tmdb|tvdb):[1-9][0-9]*)(?::([0-9]+):([0-9]+))?$/.exec(id);
  if (!match) return undefined;
  const value = match[1]!;
  const ids: ExternalIds = value.startsWith("tt") ? { imdb: value }
    : value.startsWith("tmdb:") ? { tmdb: value.slice(5) } : { tvdb: value.slice(5) };
  if (type === "movie" && match[2] === undefined) return { type, ids };
  if (type !== "series" || match[2] === undefined || match[3] === undefined) return undefined;
  const season = Number(match[2]);
  const episode = Number(match[3]);
  if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode) || season < 0 || episode < 1) return undefined;
  return { type: "episode", ids, season, episode };
}

export function remoteIdsMatch(target: ExternalIds, candidate: ExternalIds): boolean {
  let shared = false;
  for (const key of ["imdb", "tmdb", "tvdb"] as const) {
    const wanted = target[key];
    const actual = candidate[key];
    if (wanted === undefined || actual === undefined) continue;
    if (wanted !== actual) return false;
    shared = true;
  }
  return shared;
}

export function remoteMatchCandidates(items: readonly ProviderItem[], target: RemoteMatchTarget): ProviderItem[] {
  if (target.type === "movie") return items.filter((item) => item.type === "movie" && remoteIdsMatch(target.ids, item.providerIds));
  const series = new Set(items.filter((item) => item.type === "series" && remoteIdsMatch(target.ids, item.providerIds)).map((item) => item.id));
  return items.filter((item) => item.type === "episode" && item.seriesId !== undefined && series.has(item.seriesId)
    && item.season === target.season && item.episode === target.episode
    && (item.episodeEnd === undefined || item.episodeEnd === item.episode));
}
