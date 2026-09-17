export interface ProgressSeries { id: string; name: string; season: number; episode: number }

/** `series:<stremio series id>:<season>:<episode>`, the key the player reports episodes
 *  under. The id is greedy so a namespaced one (`kitsu:12345`) survives. */
const EPISODE_KEY = /^series:(.+):(\d+):(\d+)$/;

/** What the client puts between a show and an episode in a title. */
const TITLE_SEPARATOR = " · ";

function nameFromTitle(title: string): string {
  const at = title.indexOf(TITLE_SEPARATOR);
  return at < 0 ? title : title.slice(0, at);
}

/** The series an entry belongs to, from the stored field first and from a Stremio
 *  video id second. Anything else — a movie, a local file — answers undefined. */
export function seriesOf(
  key: string,
  record: { title: string; series?: ProgressSeries },
): ProgressSeries | undefined {
  if (record.series && typeof record.series.id === "string" && record.series.id) return record.series;
  const match = EPISODE_KEY.exec(key);
  if (!match) return undefined;
  return { id: match[1]!, name: nameFromTitle(record.title), season: Number(match[2]), episode: Number(match[3]) };
}

/** Newest first, one row per series. Entries with no series pass through untouched,
 *  and the input order is not relied on. */
export function groupSeriesProgress<T extends { key: string; title: string; updatedAt: string; series?: ProgressSeries }>(
  entries: T[],
): Array<T & { series?: ProgressSeries }> {
  const resolved = entries.map((entry) => ({ entry, series: seriesOf(entry.key, entry) }));
  resolved.sort((a, b) => b.entry.updatedAt.localeCompare(a.entry.updatedAt));
  const seen = new Set<string>();
  const rows: Array<T & { series?: ProgressSeries }> = [];
  for (const { entry, series } of resolved) {
    if (!series) { rows.push(entry); continue; }
    if (seen.has(series.id)) continue;
    seen.add(series.id);
    rows.push({ ...entry, series });
  }
  return rows;
}
