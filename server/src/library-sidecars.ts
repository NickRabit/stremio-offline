import { readdir } from "node:fs/promises";
import path from "node:path";
import { isVideo } from "./library.js";

/** What follows a video's own name in a subtitle beside it: an optional two- or three-letter
 *  language, then `.srt` or `.vtt`. The same reading `POST /api/library/source` offers them by. */
const SUBTITLE_SUFFIX = /^(?:\.[a-zA-Z]{2,3})?\.(?:srt|vtt)$/i;

export interface SubtitleSidecars {
  /** The video's name without its extension, as the subtitles spell it. */
  stem: string;
  /** The subtitle files' names, each the stem followed by its own suffix. */
  names: string[];
}

/** The subtitle files the player would offer beside a video. None for anything that is not a
 *  video, and none while another video of the same name sits in the folder: the subtitles are
 *  that one's as much as this one's, so a rename, move or delete of one leaves them be. */
export async function subtitleSidecars(videoPath: string): Promise<SubtitleSidecars> {
  const extension = path.extname(videoPath);
  const own = path.basename(videoPath);
  const stem = own.slice(0, own.length - extension.length);
  if (!isVideo(own)) return { stem, names: [] };
  const entries = await readdir(path.dirname(videoPath), { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === own) continue;
    if (entry.name.slice(0, stem.length).toLowerCase() !== stem.toLowerCase()) continue;
    const suffix = entry.name.slice(stem.length);
    if (path.extname(entry.name) === suffix && isVideo(entry.name)) return { stem, names: [] };
    if (SUBTITLE_SUFFIX.test(suffix)) names.push(entry.name);
  }
  return { stem, names };
}

/** A subtitle's name under the video's new stem, keeping its language and extension. */
export const renamedSidecar = (name: string, from: string, to: string): string => `${to}${name.slice(from.length)}`;
