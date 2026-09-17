import assert from "node:assert/strict";
import { test } from "node:test";
import { groupSeriesProgress, seriesOf } from "./progress-series.js";

test("seriesOf reads the series out of a Stremio episode key", () => {
  assert.deepEqual(seriesOf("series:tt0944947:1:5", { title: "Game of Thrones · S01E05" }), {
    id: "tt0944947", name: "Game of Thrones", season: 1, episode: 5,
  });
});

test("seriesOf keeps a namespaced series id whole", () => {
  assert.deepEqual(seriesOf("series:kitsu:12345:2:7", { title: "Show · S02E07" }), {
    id: "kitsu:12345", name: "Show", season: 2, episode: 7,
  });
});

test("seriesOf prefers the stored series over the key", () => {
  const stored = { id: "tt0944947", name: "Game of Thrones", season: 1, episode: 5 };
  assert.deepEqual(seriesOf("series:tt0944947:9:9", { title: "Game of Thrones · S09E09", series: stored }), stored);
  assert.deepEqual(seriesOf("movie:tt0111161", { title: "Anything", series: stored }), stored);
});

test("seriesOf answers nothing for a movie or a local file", () => {
  assert.equal(seriesOf("movie:tt0111161", { title: "The Shawshank Redemption" }), undefined);
  assert.equal(seriesOf("file:lib_0a1b2c3d/Show/S01E05.mkv", { title: "Show · S01E05" }), undefined);
});

test("seriesOf cuts the name at the episode separator", () => {
  assert.equal(seriesOf("series:tt0944947:1:5", { title: "Game of Thrones · S01E05" })?.name, "Game of Thrones");
  assert.equal(seriesOf("series:tt0944947:1:5", { title: "Game of Thrones" })?.name, "Game of Thrones");
  assert.equal(seriesOf("series:tt0944947:1:5", { title: "A · B · C · S01E05" })?.name, "A");
});

test("groupSeriesProgress keeps the newest episode of each series", () => {
  const rows = groupSeriesProgress([
    { key: "series:tt0944947:1:5", title: "Game of Thrones · S01E05", updatedAt: "2026-01-01T10:00:00.000Z" },
    { key: "series:tt0944947:1:6", title: "Game of Thrones · S01E06", updatedAt: "2026-01-02T10:00:00.000Z" },
    { key: "series:tt0903747:2:3", title: "Breaking Bad · S02E03", updatedAt: "2026-01-01T12:00:00.000Z" },
  ]);
  assert.deepEqual(rows.map((row) => row.key), ["series:tt0944947:1:6", "series:tt0903747:2:3"]);
  assert.deepEqual(rows[0]?.series, { id: "tt0944947", name: "Game of Thrones", season: 1, episode: 6 });
});

test("groupSeriesProgress groups by the stored series and never trusts the input order", () => {
  const stored = { id: "tt0944947", name: "Game of Thrones", season: 1, episode: 6 };
  const rows = groupSeriesProgress([
    { key: "series:tt1111111:1:1", title: "Old Show · S01E01", updatedAt: "2026-01-01T10:00:00.000Z" },
    { key: "series:tt0944947:1:6", title: "Game of Thrones · S01E06", updatedAt: "2026-01-03T10:00:00.000Z", series: stored },
    { key: "series:tt0944947:1:5", title: "Game of Thrones · S01E05", updatedAt: "2026-01-02T10:00:00.000Z", series: { ...stored, episode: 5 } },
  ]);
  assert.deepEqual(rows.map((row) => row.key), ["series:tt0944947:1:6", "series:tt1111111:1:1"]);
});

test("groupSeriesProgress leaves movies and local files alone", () => {
  const movie = { key: "movie:tt0111161", title: "The Shawshank Redemption", updatedAt: "2026-01-02T10:00:00.000Z" };
  const file = { key: "file:lib_0a1b2c3d/Show/S01E05.mkv", title: "Show · S01E05", updatedAt: "2026-01-01T10:00:00.000Z" };
  const rows = groupSeriesProgress([
    { key: "series:tt0944947:1:5", title: "Game of Thrones · S01E05", updatedAt: "2026-01-01T12:00:00.000Z" },
    file,
    movie,
  ]);
  assert.deepEqual(rows.map((row) => row.key), [movie.key, "series:tt0944947:1:5", file.key]);
  assert.deepEqual(rows[0], movie);
  assert.deepEqual(rows[2], file);
});
