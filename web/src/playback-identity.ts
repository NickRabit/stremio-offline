import type { IdentityPreview } from "./types";

/** The catalogue identity a playing file may report itself as: the film itself, or the exact
 *  episode of its show. Only a binding the matcher really confirmed counts, and an episode needs
 *  both of its numbers: a loose one never stands in for a season. */
export function playbackIdentity(preview: IdentityPreview | null): { type: "movie" | "series"; id: string } | null {
  const bound = preview?.bound;
  if (!preview || preview.match !== "matched" || !bound) return null;
  if (bound.type === "movie") return { type: "movie", id: bound.id };
  if (bound.type !== "series") return null;
  // The file's own numbering wins over the show's: a bound show says which episode it is only
  // when the name or the binding carried a number of its own.
  const season = preview.parsed?.season ?? bound.season;
  const episode = preview.parsed?.episode ?? bound.episode;
  if (typeof season !== "number" || !Number.isInteger(season) || season < 0) return null;
  if (typeof episode !== "number" || !Number.isInteger(episode) || episode < 1) return null;
  return { type: "series", id: `${bound.id}:${season}:${episode}` };
}
