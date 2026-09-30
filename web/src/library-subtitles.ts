import type { IdentityPreview } from "./types";

/** The catalogue title a subtitle addon is asked about for a library file: the bound title,
 *  and for a series the episode as `id:season:episode`. An unbound file, or an episode whose
 *  numbers are known neither from its binding nor from its name, has nothing to ask about. */
export function librarySubtitleTarget(identity: IdentityPreview | null | undefined): { type: string; id: string } | undefined {
  const bound = identity?.bound;
  if (!identity || !bound?.id) return undefined;
  if (bound.type !== "series") return { type: bound.type, id: bound.id };
  const season = bound.season ?? identity.parsed.season;
  const episode = bound.episode ?? identity.parsed.episode;
  if (season == null || episode == null) return undefined;
  return { type: bound.type, id: `${bound.id}:${season}:${episode}` };
}
