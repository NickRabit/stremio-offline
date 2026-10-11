import type { Meta, Video } from "./types";

export interface ResumeTarget {
  meta: Pick<Meta, "id" | "type" | "name" | "poster">;
  /** Absent for a movie. */
  episode?: { key: string; season: number; number: number };
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
