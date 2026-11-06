import { unitFor, type TitleUnit } from "./library-match.js";

/** `local:<series folder key>` for an unbound library episode file. */
export function localSeriesId(qualifiedFile: string, units: TitleUnit[]): string {
  const unit = unitFor(qualifiedFile, units);
  const seriesKey = unit?.kind === "series" ? unit.key : qualifiedFile.slice(0, qualifiedFile.lastIndexOf("/"));
  return `local:${seriesKey}`;
}

/** Negative when a is earlier. Season 0 (specials) sorts after every other season. */
export function compareEpisodes(a: { season: number; episode: number }, b: { season: number; episode: number }): number {
  if (a.season === b.season) return a.episode - b.episode;
  if (a.season === 0) return 1;
  if (b.season === 0) return -1;
  return a.season - b.season;
}

/** Whether the marker's "watched through" covers the episode. A season 0 episode is covered
 *  only by a season 0 marker. */
export function markerCovers(
  marker: { season: number; episode: number } | undefined,
  ep: { season?: number | null; episode?: number | null },
): boolean {
  if (!marker || typeof ep.season !== "number" || typeof ep.episode !== "number") return false;
  const season = ep.season, episode = ep.episode;
  if (season === 0 || marker.season === 0) {
    return season === 0 && marker.season === 0 && compareEpisodes({ season, episode }, marker) <= 0;
  }
  return compareEpisodes({ season, episode }, marker) <= 0;
}
