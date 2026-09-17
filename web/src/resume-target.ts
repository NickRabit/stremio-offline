import type { Meta, ProgressEntry, Video } from "./types";

export interface ResumeTarget {
  meta: Pick<Meta, "id" | "type" | "name" | "poster">;
  /** Absent for a movie. */
  episode?: { key: string; season: number; number: number };
}

/** `series:<stremio series id>:<season>:<episode>`, the key the player writes an episode
 *  under. The id is greedy so a namespaced one (`kitsu:12345`) survives. */
const EPISODE_KEY = /^series:(.+):(\d+):(\d+)$/;

/** What the client puts between a show and an episode in a title. */
const TITLE_SEPARATOR = " · ";

/** The series a stored row belongs to, from the field first and from the key second — the
 *  same derivation the server uses, so a row stored before the field existed still works. */
function seriesOf(entry: ProgressEntry): ProgressEntry["series"] {
  if (entry.series?.id) return entry.series;
  const match = EPISODE_KEY.exec(entry.key);
  if (!match) return undefined;
  const at = entry.title.indexOf(TITLE_SEPARATOR);
  return {
    id: match[1]!,
    name: at < 0 ? entry.title : entry.title.slice(0, at),
    season: Number(match[2]),
    episode: Number(match[3]),
  };
}

/** What a Continue watching row opens. A series row opens the series and remembers
 *  the episode; anything else opens itself. */
export function resumeTarget(entry: ProgressEntry): ResumeTarget {
  const series = seriesOf(entry);
  if (series) return {
    meta: { id: series.id, type: "series", name: series.name, poster: entry.poster },
    episode: { key: entry.key, season: series.season, number: series.episode },
  };
  const [type, ...rest] = entry.key.split(":");
  return { meta: { id: rest.join(":") || entry.key, type, name: entry.title, poster: entry.poster } };
}

/** The video id a stored key was built from: the player keys an episode as
 *  `series:<video id>`, and a Stremio video id carries the numbers itself. */
function keyVideoId(key: string): string | undefined {
  return key.startsWith("series:") ? key.slice("series:".length) : undefined;
}

/** The video a remembered episode points at, by season and number first and by the
 *  progress key second. Undefined when the metadata no longer has it.
 *  A video with no id is never answered: sources, downloads and the episode list are all
 *  keyed by it, so one without it cannot be opened however well its numbers match. */
export function resumeVideo(videos: Video[] | undefined, episode: ResumeTarget["episode"]): Video | undefined {
  if (!videos?.length || !episode) return undefined;
  // The server writes 0/0 when a report names a show without numbers; a special numbered 0
  // would then be picked by mistake, so the unknown pair only ever matches by id.
  if (episode.season !== 0 || episode.number !== 0) {
    const byNumbers = videos.find((video) => video.id && video.season === episode.season && video.episode === episode.number);
    if (byNumbers) return byNumbers;
  }
  const id = keyVideoId(episode.key);
  return id === undefined ? undefined : videos.find((video) => video.id === id);
}
