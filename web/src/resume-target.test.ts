import { expect, it } from "vitest";
import { resumeVideo } from "./resume-target";
import type { Video } from "./types";

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
