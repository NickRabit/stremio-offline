import { expect, it } from "vitest";
import { resumeTarget, resumeVideo } from "./resume-target";
import type { ProgressEntry, Video } from "./types";

const entry = (over: Partial<ProgressEntry> & { key: string }): ProgressEntry => ({
  position: 120, duration: 2400, title: "Title", updatedAt: "2026-09-01T00:00:00.000Z", ...over,
});

it("opens a grouped series row as the series and remembers its episode", () => {
  const row = entry({
    key: "series:tt0944947:1:5", title: "Městečko South Park · Volcano", poster: "tt0944947.jpg",
    series: { id: "tt0944947", name: "Městečko South Park", season: 1, episode: 5 },
  });
  expect(resumeTarget(row)).toEqual({
    meta: { id: "tt0944947", type: "series", name: "Městečko South Park", poster: "tt0944947.jpg" },
    episode: { key: "series:tt0944947:1:5", season: 1, number: 5 },
  });
});

it("derives the series of a row stored before the field existed", () => {
  const row = entry({ key: "series:tt0944947:1:5", title: "Show · S01E05" });
  expect(resumeTarget(row)).toEqual({
    meta: { id: "tt0944947", type: "series", name: "Show", poster: undefined },
    episode: { key: "series:tt0944947:1:5", season: 1, number: 5 },
  });
});

it("opens a movie row as itself", () => {
  const row = entry({ key: "movie:tt1", title: "Zkušební film", poster: "tt1.jpg" });
  expect(resumeTarget(row)).toEqual({ meta: { id: "tt1", type: "movie", name: "Zkušební film", poster: "tt1.jpg" } });
});

it("opens a local file as itself instead of inventing a series", () => {
  const row = entry({ key: "file:lib_ab12cd34/Show/01.mkv", title: "Show · S01E05" });
  expect(resumeTarget(row).episode).toBeUndefined();
  expect(resumeTarget(row).meta).toEqual({ id: "lib_ab12cd34/Show/01.mkv", type: "file", name: "Show · S01E05", poster: undefined });
});

it("finds the episode the season and number point at", () => {
  const videos: Video[] = [{ id: "tt0944947:1:4", season: 1, episode: 4 }, { id: "tt0944947:1:5", season: 1, episode: 5 }];
  expect(resumeVideo(videos, { key: "series:tt0944947:1:5", season: 1, number: 5 })).toEqual(videos[1]);
});

it("falls back to the id in the key when the metadata carries no numbers", () => {
  const videos: Video[] = [{ id: "tt0944947:1:5", title: "Volcano" }];
  expect(resumeVideo(videos, { key: "series:tt0944947:1:5", season: 1, number: 5 })).toEqual(videos[0]);
});

it("does not take a special numbered 0 for an episode whose numbers are unknown", () => {
  const specials: Video[] = [{ id: "tt0944947:0:0", season: 0, episode: 0 }, { id: "tt0944947:1:5", season: 1, episode: 5 }];
  expect(resumeVideo(specials, { key: "series:tt0944947:1:5", season: 0, number: 0 })).toEqual(specials[1]);
});

it("answers nothing when the metadata no longer lists the episode", () => {
  const videos: Video[] = [{ id: "tt0944947:1:4", season: 1, episode: 4 }];
  expect(resumeVideo(videos, { key: "series:tt0944947:1:5", season: 1, number: 5 })).toBeUndefined();
});

it("resumeVideo never answers a video that carries no id", () => {
  const videos: Video[] = [{ season: 1, episode: 3, name: "Spoonful" }];
  expect(resumeVideo(videos, { key: "series:tt9288030:1:3", season: 1, number: 3 })).toBeUndefined();
});
