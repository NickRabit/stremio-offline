import { describe, expect, it } from "vitest";
import { cardLabel, cardNumbering, cardProgress, showAllTarget } from "./home-cards";
import type { HomeCard } from "../../server/src/home";

const file: HomeCard = { kind: "resume-file", key: "file:a", title: "A", path: "lib_00000000/a.mkv", progress: { position: 1, duration: 4 }, season: 2, episode: 4, updatedAt: "", forgetKeys: ["file:a"] };
const movie: HomeCard = { kind: "resume-catalogue", key: "movie:tt1", title: "M", type: "movie", id: "tt1", name: "M", progress: { position: 1, duration: 4 }, updatedAt: "", forgetKeys: ["movie:tt1"] };
const episode: HomeCard = { kind: "resume-catalogue", key: "series:tt2:2:4", title: "S", type: "series", id: "tt2", name: "S", season: 2, episode: 4, progress: { position: 1, duration: 4 }, updatedAt: "", forgetKeys: ["series:tt2:2:4"] };
const pending: HomeCard = { kind: "resume-catalogue", key: "series:tt2:2:5", title: "S", type: "series", id: "tt2", name: "S", season: 2, episode: 5, pending: true, updatedAt: "", forgetKeys: ["series:tt2:2:5"] };
const completed: HomeCard = { kind: "completed", key: "lib_00000000/c.mkv", title: "C", path: "lib_00000000/c.mkv", completedAt: "", season: 1, episode: 3 };
const favorite: HomeCard = { kind: "favorite", key: "lib_00000000/d", path: "lib_00000000/d", itemKind: "folder", label: "D" };

describe("cardLabel", () => {
  it("names the action each kind offers", () => {
    expect(cardLabel(file)).toBe("home.resume");
    expect(cardLabel(movie)).toBe("home.openTitle");
    expect(cardLabel(episode)).toBe("home.openEpisode");
    expect(cardLabel(pending)).toBe("home.nextEpisode");
    expect(cardLabel(completed)).toBe("player.play");
    expect(cardLabel(favorite)).toBeUndefined();
  });
});

describe("cardNumbering", () => {
  it("renders the season and episode the card carries", () => {
    expect(cardNumbering(file)).toBe("S02E04");
    expect(cardNumbering(episode)).toBe("S02E04");
    expect(cardNumbering(pending)).toBe("S02E05");
    expect(cardNumbering(completed)).toBe("S01E03");
  });

  it("is silent when the card carries no numbers", () => {
    expect(cardNumbering(movie)).toBeUndefined();
    expect(cardNumbering(favorite)).toBeUndefined();
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

  it("draws nothing for a pending next episode, a completed file or a favourite", () => {
    expect(cardProgress(pending)).toBeNull();
    expect(cardProgress(completed)).toBeNull();
    expect(cardProgress(favorite)).toBeNull();
  });
});

describe("showAllTarget", () => {
  it("offers Continue watching only when there is more, and picks the list by the cards held", () => {
    expect(showAllTarget("resume", [file], false)).toBeUndefined();
    expect(showAllTarget("resume", [file], true)).toBe("library-resume");
    expect(showAllTarget("resume", [episode], true)).toBe("catalog-resume");
    expect(showAllTarget("resume", [episode, file], true)).toBe("library-resume");
  });

  it("offers Ready to play only when there is more, and points at Downloads", () => {
    expect(showAllTarget("completed", [completed], false)).toBeUndefined();
    expect(showAllTarget("completed", [completed], true)).toBe("downloads");
  });

  it("always offers the library's list for Favourites", () => {
    expect(showAllTarget("favorites", [favorite], false)).toBe("library-favorites");
    expect(showAllTarget("favorites", [], true)).toBe("library-favorites");
  });
});
