import assert from "node:assert/strict";
import { test } from "node:test";
import { compareEpisodes, localSeriesId, markerCovers } from "./local-series.js";

test("episodes compare within a season and across seasons", () => {
  assert.ok(compareEpisodes({ season: 1, episode: 1 }, { season: 1, episode: 2 }) < 0);
  assert.equal(compareEpisodes({ season: 1, episode: 2 }, { season: 1, episode: 2 }), 0);
  assert.ok(compareEpisodes({ season: 1, episode: 9 }, { season: 2, episode: 1 }) < 0);
});

test("specials sort after every regular season", () => {
  assert.ok(compareEpisodes({ season: 0, episode: 1 }, { season: 99, episode: 1 }) > 0);
  assert.ok(compareEpisodes({ season: 1, episode: 1 }, { season: 0, episode: 1 }) < 0);
  assert.ok(compareEpisodes({ season: 0, episode: 1 }, { season: 0, episode: 2 }) < 0);
});

test("a marker covers episodes up to itself", () => {
  const marker = { season: 1, episode: 3 };
  assert.equal(markerCovers(marker, { season: 1, episode: 2 }), true);
  assert.equal(markerCovers(marker, { season: 1, episode: 3 }), true);
  assert.equal(markerCovers(marker, { season: 1, episode: 4 }), false);
});

test("a special is covered only by a special marker", () => {
  const special = { season: 0, episode: 2 };
  assert.equal(markerCovers(special, { season: 0, episode: 1 }), true);
  assert.equal(markerCovers(special, { season: 0, episode: 3 }), false);
  assert.equal(markerCovers(special, { season: 1, episode: 1 }), false);
  assert.equal(markerCovers({ season: 1, episode: 3 }, { season: 0, episode: 1 }), false);
});

test("no marker covers nothing", () => {
  assert.equal(markerCovers(undefined, { season: 1, episode: 1 }), false);
});

test("a series unit names the local series and otherwise its parent folder does", () => {
  const file = "lib_00000001/Shows/Local/Season 01/Local - S01E01.mp4";
  assert.equal(localSeriesId(file, [{
    key: "lib_00000001/Shows/Local",
    kind: "series",
    relative: "Shows/Local",
    sampleFiles: [file],
  }]), "local:lib_00000001/Shows/Local");
  assert.equal(localSeriesId(file, []), "local:lib_00000001/Shows/Local/Season 01");
});
