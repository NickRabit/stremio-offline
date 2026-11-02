import { t } from "./i18n";
import type { PlaybackChapter } from "./types";

/** Index of the chapter `position` falls in, or -1. Chapters are sorted by start. */
export function chapterAt(chapters: PlaybackChapter[] | undefined, position: number): number {
  if (!chapters) return -1;
  for (let index = chapters.length - 1; index >= 0; index -= 1) {
    const chapter = chapters[index];
    if (position >= chapter.start && position < chapter.end) return index;
  }
  return -1;
}

/** The chapter's own title, else "Chapter N" (1-based) through t("player.chapterNumber"). */
export function chapterLabel(chapters: PlaybackChapter[], index: number): string {
  return chapters[index]?.title || t("player.chapterNumber", { number: index + 1 });
}
