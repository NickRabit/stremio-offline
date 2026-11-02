import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "./i18n";
import { chapterAt, chapterLabel } from "./player-chapters";
import type { PlaybackChapter } from "./types";

const chapters: PlaybackChapter[] = [
  { start: 0, end: 600, title: "Opening" },
  { start: 600, end: 1800 },
  { start: 1800, end: 3600, title: "Finale" },
];

afterEach(() => setLocale("en"));

describe("chapters", () => {
  it("finds the chapter around a position", () => {
    expect(chapterAt(chapters, -1)).toBe(-1);
    expect(chapterAt(chapters, 300)).toBe(0);
    expect(chapterAt(chapters, 600)).toBe(1);
    expect(chapterAt(chapters, 3600)).toBe(-1);
  });

  it("numbers an untitled chapter", () => {
    setLocale("en");
    expect(chapterLabel(chapters, 1)).toBe("Chapter 2");
  });
});
