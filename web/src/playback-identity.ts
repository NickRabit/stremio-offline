import type { IdentityPreview } from "./types";

/** One row of the library the identity is resolved for: a file may carry the numbering the
 *  listing read from its name, which is the row's own answer about which episode it holds. */
export interface IdentifiedRow {
  kind: string;
  season?: number | null;
  episode?: number | null;
}

/** The episode numbers a row's identity really carries: the file's own first, then the matcher's
 *  reading of the name, then the numbers of the binding itself. */
const episodeNumbers = (preview: IdentityPreview | null, row?: IdentifiedRow) => ({
  season: (row?.kind === "file" ? row.season : undefined) ?? preview?.parsed?.season ?? preview?.bound?.season,
  episode: (row?.kind === "file" ? row.episode : undefined) ?? preview?.parsed?.episode ?? preview?.bound?.episode,
});

/** The catalogue identity a playing file may report itself as: the film itself, or the exact
 *  episode of its show. Only a binding the matcher really confirmed counts, and an episode needs
 *  both of its numbers: a loose one never stands in for a season. */
export function playbackIdentity(preview: IdentityPreview | null, row?: IdentifiedRow): { type: "movie" | "series"; id: string } | null {
  const bound = preview?.bound;
  if (!preview || preview.match !== "matched" || !bound) return null;
  if (bound.type === "movie") return { type: "movie", id: bound.id };
  if (bound.type !== "series") return null;
  const { season, episode } = episodeNumbers(preview, row);
  if (typeof season !== "number" || !Number.isInteger(season) || season < 0) return null;
  if (typeof episode !== "number" || !Number.isInteger(episode) || episode < 1) return null;
  return { type: "series", id: `${bound.id}:${season}:${episode}` };
}
