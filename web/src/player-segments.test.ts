import { describe, expect, it } from "vitest";
import { activeSegment, fitSegments, introQueryOf, upNextPoint } from "./player-segments";
import type { UpNextAt } from "./types";

describe("introQueryOf", () => {
  it("reads movie and series IMDb keys", () => {
    expect(introQueryOf("movie:tt12345")).toEqual({ imdb: "tt12345" });
    expect(introQueryOf("series:tt0903747:1:2")).toEqual({ imdb: "tt0903747", season: 1, episode: 2 });
  });

  it("rejects other keys and malformed ids", () => {
    expect(introQueryOf("kitsu:123")).toBeUndefined();
    expect(introQueryOf("file:Films/a.mkv")).toBeUndefined();
    expect(introQueryOf()).toBeUndefined();
    expect(introQueryOf("series:tt0903747:-1:2")).toBeUndefined();
  });
});

describe("activeSegment", () => {
  it("uses an inclusive start and hides in the final second", () => {
    const segments = { intro: { start: 5, end: 60 } };
    expect(activeSegment(segments, 4.99)).toBeUndefined();
    expect(activeSegment(segments, 5)).toEqual({ kind: "intro", range: segments.intro });
    expect(activeSegment(segments, 58.99)).toEqual({ kind: "intro", range: segments.intro });
    expect(activeSegment(segments, 59)).toBeUndefined();
  });

  it("prefers intro, then recap, then outro", () => {
    const segments = {
      intro: { start: 10, end: 30 },
      recap: { start: 20, end: 40 },
      outro: { start: 25, end: 50 },
    };
    expect(activeSegment(segments, 25)?.kind).toBe("intro");
    expect(activeSegment({ recap: segments.recap, outro: segments.outro }, 25)?.kind).toBe("recap");
    expect(activeSegment({ outro: segments.outro }, 25)?.kind).toBe("outro");
  });
});

describe("upNextPoint", () => {
  it("maps every non-end choice", () => {
    const expected: Array<[UpNextAt, number | undefined]> = [
      ["end", undefined],
      ["pct97", 3492],
      ["pct98", 3528],
      ["pct99", 3564],
      ["sec30", 3570],
      ["sec60", 3540],
      ["sec120", 3480],
      ["sec180", 3420],
    ];
    for (const [value, point] of expected) expect(upNextPoint(value, 3600)).toBe(point);
  });

  it("moves an earlier point to the start of known credits", () => {
    expect(upNextPoint("sec60", 3600, { start: 3500, end: 3600 })).toBe(3500);
    expect(upNextPoint("sec60", 3600, { start: 3550, end: 3600 })).toBe(3540);
  });

  it("ignores end and unknown or non-positive points", () => {
    expect(upNextPoint("end", 3600, { start: 3500, end: 3600 })).toBeUndefined();
    expect(upNextPoint("sec60", 0)).toBeUndefined();
    expect(upNextPoint("sec180", 100)).toBeUndefined();
  });
});

describe("fitSegments", () => {
  const credits = { intro: { start: 0, end: 60 }, outro: { start: 8903, end: 9299 } };

  it("keeps credits that run to the end of the file", () => {
    expect(fitSegments(credits, 9330)).toEqual(credits);
  });

  it("drops credits timed on a shorter cut, keeping the intro", () => {
    expect(fitSegments(credits, 10258)).toEqual({ intro: { start: 0, end: 60 } });
  });

  it("drops credits that start after the file ends", () => {
    expect(fitSegments(credits, 8000)).toEqual({ intro: { start: 0, end: 60 } });
  });

  it("drops an intro that starts deep into the file", () => {
    expect(fitSegments({ intro: { start: 1500, end: 1560 } }, 2600)).toEqual({});
  });

  it("keeps a cold-open intro a few minutes in", () => {
    expect(fitSegments({ intro: { start: 437, end: 531 } }, 3700)).toEqual({ intro: { start: 437, end: 531 } });
  });

  it("keeps everything while the duration is unknown", () => {
    expect(fitSegments(credits, 0)).toEqual(credits);
  });
});
