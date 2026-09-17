import assert from "node:assert/strict";
import { test } from "node:test";
import { markersOwingRow, nextEpisodeOf, type ShowVideo } from "./next-episode.js";

const video = (season: number, episode: number, extra: Partial<ShowVideo> = {}): ShowVideo => ({ season, episode, ...extra });

test("nextEpisodeOf answers the next episode of the same season", () => {
  const videos = [video(1, 1), video(1, 2), video(1, 3)];
  assert.deepEqual(nextEpisodeOf(videos, { season: 1, episode: 1 }), { season: 1, episode: 2 });
});

test("nextEpisodeOf rolls a season finale over to the next season", () => {
  const videos = [video(1, 1), video(1, 2), video(2, 1), video(2, 2)];
  assert.deepEqual(nextEpisodeOf(videos, { season: 1, episode: 2 }), { season: 2, episode: 1 });
});

test("nextEpisodeOf answers nothing at the end of the last season", () => {
  const videos = [video(1, 1), video(2, 1), video(2, 2)];
  assert.equal(nextEpisodeOf(videos, { season: 2, episode: 2 }), undefined);
});

test("nextEpisodeOf skips the specials for a regular episode", () => {
  const videos = [video(0, 1), video(0, 2), video(1, 1), video(1, 2)];
  assert.deepEqual(nextEpisodeOf(videos, { season: 1, episode: 1 }), { season: 1, episode: 2 });
  assert.equal(nextEpisodeOf(videos, { season: 1, episode: 2 }), undefined);
});

test("nextEpisodeOf offers the next special after a special", () => {
  const videos = [video(0, 1), video(0, 2), video(1, 1), video(1, 2)];
  assert.deepEqual(nextEpisodeOf(videos, { season: 0, episode: 1 }), { season: 0, episode: 2 });
  assert.equal(nextEpisodeOf(videos, { season: 0, episode: 2 }), undefined);
});

test("nextEpisodeOf holds the videos in season and episode order itself", () => {
  const videos = [video(2, 1), video(1, 3), video(0, 1), video(1, 1), video(1, 2)];
  assert.deepEqual(nextEpisodeOf(videos, { season: 1, episode: 1 }), { season: 1, episode: 2 });
  assert.deepEqual(nextEpisodeOf(videos, { season: 1, episode: 3 }), { season: 2, episode: 1 });
});

test("nextEpisodeOf ignores a video without numbers and reads the older number field", () => {
  const videos: ShowVideo[] = [
    { id: "unplaced", name: "No numbers" },
    { id: "no-season", episode: 2 },
    { id: "no-episode", season: 1 },
    video(1, 1),
    { id: "legacy:1:2", season: 1, number: 2, name: "Legacy" },
  ];
  assert.deepEqual(nextEpisodeOf(videos, { season: 1, episode: 1 }), { season: 1, episode: 2, id: "legacy:1:2", name: "Legacy" });
});

test("nextEpisodeOf reads numbers written as strings", () => {
  const videos: ShowVideo[] = [{ season: "1", episode: "1" }, { season: "1", episode: "2" }];
  assert.deepEqual(nextEpisodeOf(videos, { season: 1, episode: 1 }), { season: 1, episode: 2 });
});

test("nextEpisodeOf answers nothing without videos", () => {
  assert.equal(nextEpisodeOf(undefined, { season: 1, episode: 1 }), undefined);
  assert.equal(nextEpisodeOf([], { season: 1, episode: 1 }), undefined);
});

test("nextEpisodeOf answers nothing for an episode the show does not have", () => {
  const videos = [video(1, 1), video(1, 2)];
  assert.deepEqual(nextEpisodeOf(videos, { season: 1, episode: 0 }), { season: 1, episode: 1 });
  assert.equal(nextEpisodeOf(videos, { season: 9, episode: 9 }), undefined);
});

test("markersOwingRow keeps the markers whose series has no row yet", () => {
  const markers = {
    tt0944947: { updatedAt: "2026-01-02T10:00:00.000Z" },
    tt0903747: { updatedAt: "2026-01-01T10:00:00.000Z" },
  };
  assert.deepEqual(markersOwingRow(markers, ["tt0944947"]).map(([id]) => id), ["tt0903747"]);
  assert.deepEqual(markersOwingRow(markers, []).map(([id]) => id), ["tt0944947", "tt0903747"]);
});
