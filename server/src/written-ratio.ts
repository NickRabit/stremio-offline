/** "16x9" written into a name is the shape of the picture, not season 16, episode 9. Only the
 *  widescreen forms are taken for one: "4x3" or "3x2" are as likely an unpadded episode, and a
 *  padded "16x09" always is one. Kept apart from the readers so each can share it without an
 *  import cycle between `library` and `library-parse`. */
const RATIOS = new Set(["16x9", "16x10", "21x9", "9x16"]);
export const WRITTEN_RATIO = /\b(?:16x9|16x10|21x9|9x16)\b/gi;

export interface CrossEpisode { season: number; episode: number; index: number; end: number }

/** The first "1x03" in a name that is not a written ratio; one in front of it does not hide it. */
export function crossEpisode(text: string, episodeDigits = 4): CrossEpisode | undefined {
  for (const match of text.matchAll(new RegExp(`\\b(\\d{1,2})x(\\d{1,${episodeDigits}})\\b`, "gi"))) {
    if (RATIOS.has(match[0].toLowerCase())) continue;
    return { season: Number(match[1]), episode: Number(match[2]), index: match.index!, end: match.index! + match[0].length };
  }
  return undefined;
}
