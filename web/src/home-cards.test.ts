import { describe, expect, it } from "vitest";
import { cardLabel, cardNumbering, cardProgress, relativeAge, showAllTarget } from "./home-cards";
import type { HomeCard } from "../../server/src/home";

const file: HomeCard = { kind: "resume-file", key: "file:a", title: "A", path: "lib_00000000/a.mkv", progress: { position: 1, duration: 4 }, season: 2, episode: 4, updatedAt: "", forgetKeys: ["file:a"] };
const movie: HomeCard = { kind: "resume-catalogue", key: "movie:tt1", title: "M", type: "movie", id: "tt1", name: "M", progress: { position: 1, duration: 4 }, updatedAt: "", forgetKeys: ["movie:tt1"] };
const series: HomeCard = { kind: "resume-catalogue", key: "series:tt2:2:4", title: "S", type: "series", id: "tt2", name: "S", season: 2, episode: 4, progress: { position: 1, duration: 4 }, updatedAt: "", forgetKeys: ["series:tt2:2:4"] };
const pending: HomeCard = { kind: "resume-catalogue", key: "series:tt2:2:5", title: "S", type: "series", id: "tt2", name: "S", season: 2, episode: 5, pending: true, updatedAt: "", forgetKeys: ["series:tt2:2:5"] };
const completed: HomeCard = { kind: "completed", key: "lib_00000000/c.mkv", title: "C", path: "lib_00000000/c.mkv", completedAt: "", season: 1, episode: 3 };
const favorite: HomeCard = { kind: "favorite", key: "lib_00000000/d", path: "lib_00000000/d", itemKind: "folder", label: "D" };
const newEpisode: HomeCard = { kind: "episode", key: "episode:f:1", followId: "f", type: "series", metaId: "tt2", name: "S", season: 2, episode: 4, released: "2026-10-03T00:00:00Z" };
const recent: HomeCard = { kind: "recent", key: "lib_00000000/r.mkv", path: "lib_00000000/r.mkv", label: "R", addedAt: "2026-10-03T00:00:00Z", libraryId: "lib_00000000", season: 2, episode: 4 };
const tonight: HomeCard = { kind: "tonight", key: "lib_00000000/t.mkv", path: "lib_00000000/t.mkv", itemKind: "file", label: "T", year: "2024", libraryId: "lib_00000000" };
const confirm: HomeCard = { kind: "confirm", key: "s1", libraryId: "lib_00000000", library: "Films", label: "guess.mkv", path: "lib_00000000/guess.mkv", candidate: { name: "Real Title", year: "2023" } };

describe("cardLabel", () => {
  it("names the action each kind offers", () => {
    expect(cardLabel(file)).toBe("home.resume");
    expect(cardLabel(movie)).toBe("home.openTitle");
    expect(cardLabel(series)).toBe("home.openEpisode");
    expect(cardLabel(pending)).toBe("home.nextEpisode");
    expect(cardLabel(completed)).toBe("player.play");
    expect(cardLabel(newEpisode)).toBe("home.newEpisode");
    expect(cardLabel(favorite)).toBeUndefined();
  });

  it("leaves a recently added, Tonight or To confirm card unlabelled", () => {
    expect(cardLabel(recent)).toBeUndefined();
    expect(cardLabel(tonight)).toBeUndefined();
    expect(cardLabel(confirm)).toBeUndefined();
  });
});

describe("cardNumbering", () => {
  it("renders the season and episode the card carries", () => {
    expect(cardNumbering(file)).toBe("S02E04");
    expect(cardNumbering(series)).toBe("S02E04");
    expect(cardNumbering(pending)).toBe("S02E05");
    expect(cardNumbering(completed)).toBe("S01E03");
    expect(cardNumbering(newEpisode)).toBe("S02E04");
    expect(cardNumbering(recent)).toBe("S02E04");
  });

  it("is silent when the card carries no numbers", () => {
    expect(cardNumbering(movie)).toBeUndefined();
    expect(cardNumbering(favorite)).toBeUndefined();
    expect(cardNumbering(tonight)).toBeUndefined();
    expect(cardNumbering(confirm)).toBeUndefined();
  });
});

describe("cardProgress", () => {
  it("is the stored position as a whole percent", () => {
    expect(cardProgress({ ...file, progress: { position: 1, duration: 4 } })).toBe(25);
  });

  it("clamps to a whole percent inside the bar", () => {
    expect(cardProgress({ ...file, progress: { position: 9, duration: 4 } })).toBe(100);
    expect(cardProgress({ ...file, progress: { position: -2, duration: 4 } })).toBe(0);
    expect(cardProgress({ ...file, progress: { position: 5, duration: 0 } })).toBe(0);
  });

  it("draws nothing for a pending next episode, a completed file, a favourite or the new kinds", () => {
    expect(cardProgress(pending)).toBeNull();
    expect(cardProgress(completed)).toBeNull();
    expect(cardProgress(favorite)).toBeNull();
    expect(cardProgress(newEpisode)).toBeNull();
    expect(cardProgress(recent)).toBeNull();
    expect(cardProgress(tonight)).toBeNull();
    expect(cardProgress(confirm)).toBeNull();
  });
});

describe("relativeAge", () => {
  const now = Date.parse("2026-06-01T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("rounds to the newest minute, hour or day that fits", () => {
    expect(relativeAge(ago(5 * 60_000), now, "en")).toBe("5 minutes ago");
    expect(relativeAge(ago(2 * 3_600_000), now, "en")).toBe("2 hours ago");
    expect(relativeAge(ago(3 * 86_400_000), now, "en")).toBe("3 days ago");
  });

  it("reads in the asked language and answers the injected now, not the wall clock", () => {
    expect(relativeAge(ago(2 * 3_600_000), now, "cs")).toContain("2");
    expect(relativeAge(ago(2 * 3_600_000), now + 2 * 86_400_000, "en")).toBe("2 days ago");
  });
});

describe("showAllTarget", () => {
  it("offers Continue watching only when there is more, and picks the list by the cards held", () => {
    expect(showAllTarget("resume", [file], false)).toBeUndefined();
    expect(showAllTarget("resume", [file], true)).toBe("library-resume");
    expect(showAllTarget("resume", [series], true)).toBe("catalog-resume");
    expect(showAllTarget("resume", [series, file], true)).toBe("library-resume");
  });

  it("offers Ready to play only when there is more, and points at Downloads", () => {
    expect(showAllTarget("completed", [completed], false)).toBeUndefined();
    expect(showAllTarget("completed", [completed], true)).toBe("downloads");
  });

  it("always offers the library's list for Favourites", () => {
    expect(showAllTarget("favorites", [favorite], false)).toBe("library-favorites");
    expect(showAllTarget("favorites", [], true)).toBe("library-favorites");
  });

  it("always points New episodes at Following and To confirm at the suggestions dialog", () => {
    expect(showAllTarget("episodes", [newEpisode], false)).toBe("following");
    expect(showAllTarget("episodes", [newEpisode], true)).toBe("following");
    expect(showAllTarget("confirm", [confirm], false)).toBe("confirm");
  });

  it("offers Recently added only when there is more, and offers Tonight nothing", () => {
    expect(showAllTarget("recent", [recent], false)).toBeUndefined();
    expect(showAllTarget("recent", [recent], true)).toBe("library");
    expect(showAllTarget("tonight", [tonight], true)).toBeUndefined();
  });
});
