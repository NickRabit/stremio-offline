export interface EpisodeRef { season: number; episode: number }
export interface ShowVideo { id?: string; name?: string; title?: string; season?: unknown; episode?: unknown; number?: unknown }

/** Read the numbers the way `episodesFromMeta` does: an episode number is `episode`
 *  first, its older spelling `number` second, and anything else is skipped. */
const number = (value: unknown): number | undefined => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** Specials (season 0) are never what a regular episode leads into, so they sort after
 *  every other season instead of before season 1. */
const seasonOrder = (season: number) => (season === 0 ? Number.POSITIVE_INFINITY : season);

interface NumberedEpisode extends EpisodeRef { video: ShowVideo }

/** The videos that carry both numbers, in watching order. */
function orderedEpisodes(videos: ShowVideo[] | undefined): NumberedEpisode[] {
  const out: NumberedEpisode[] = [];
  for (const video of videos ?? []) {
    const season = number(video.season);
    const episode = number(video.episode ?? video.number);
    if (season == null || episode == null) continue;
    out.push({ season, episode, video });
  }
  return out.sort((a, b) => {
    const orderA = seasonOrder(a.season), orderB = seasonOrder(b.season);
    return orderA === orderB ? a.episode - b.episode : orderA < orderB ? -1 : 1;
  });
}

/** The episode after `after`, in season and episode order. A special (season 0) is
 *  only ever answered when `after` is itself a special. Undefined at the end of the
 *  show, and for videos that carry no numbers. */
export function nextEpisodeOf(
  videos: ShowVideo[] | undefined,
  after: EpisodeRef,
): { season: number; episode: number; id?: string; name?: string } | undefined {
  const afterOrder = seasonOrder(after.season);
  // A regular episode never steps into the specials; finishing the last special ends the show.
  const episodes = orderedEpisodes(videos).filter((entry) => afterOrder === Number.POSITIVE_INFINITY || entry.season !== 0);
  const next = episodes.find((entry) => {
    const order = seasonOrder(entry.season);
    return order === afterOrder ? entry.season === after.season && entry.episode > after.episode : order > afterOrder;
  });
  if (!next) return undefined;
  const id = text(next.video.id);
  const name = text(next.video.name ?? next.video.title);
  return { season: next.season, episode: next.episode, ...(id ? { id } : {}), ...(name ? { name } : {}) };
}

/** The markers that may still owe a Continue watching row: those whose series has no
 *  row of its own yet. */
export function markersOwingRow<T>(
  markers: Record<string, T>,
  seriesWithRow: Iterable<string>,
): Array<[string, T]> {
  const shown = new Set(seriesWithRow);
  return Object.entries(markers).filter(([id]) => !shown.has(id));
}
