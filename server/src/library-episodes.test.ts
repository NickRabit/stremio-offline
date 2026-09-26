import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmedByEpisodes, diskEpisodes, episodeEvidence } from "./library-episodes.js";

test("a file's number and the name after it are the episode the disk states", () => {
  assert.deepEqual(diskEpisodes(["Peppa Pig/01 serie/01 - Muddy Puddles.mkv"]), [
    { season: 1, episode: 1, title: "Muddy Puddles" },
  ]);
  assert.deepEqual(diskEpisodes(["Show/Season 1/Show.S01E02.The.Blind.Banker.mkv"]), [
    { season: 1, episode: 2, title: "The Blind Banker" },
  ]);
  assert.deepEqual(diskEpisodes(["Show/Show.1x03.mkv"]), [{ season: 1, episode: 3 }],
    "an episode without a name is still numbered");
  assert.deepEqual(diskEpisodes(["Peppa Pig/09 serie/27 - Episode 27.mp4"]), [{ season: 9, episode: 27 }],
    "a placeholder is not a title");
});

test("at most limit files are read, spread evenly across the list", () => {
  const files = Array.from({ length: 10 }, (_value, index) => `Show/Season 1/Show.S01E${String(index + 1).padStart(2, "0")}.mkv`);
  assert.deepEqual(diskEpisodes(files, 3).map((episode) => episode.episode), [1, 6, 10]);
});

test("episode evidence counts presence, titles and names that agree", () => {
  const disk = [
    { season: 1, episode: 1, title: "Muddy Puddles" },
    { season: 1, episode: 2, title: "Hospital" },
    { season: 1, episode: 3, title: "The Best Friend" },
  ];
  const catalogue = [
    { season: 1, episode: 1, name: "Muddy Puddles" },
    { season: 1, episode: 2, name: "Hospital" },
    { season: 1, episode: 3, name: "A Different Story" },
  ];
  assert.deepEqual(episodeEvidence(disk, catalogue), { numbered: 3, present: 3, titled: 3, named: 2 });
});

test("an episode list confirms a candidate only when its names are clearly the best", () => {
  const winner = { numbered: 4, present: 4, titled: 4, named: 3 };
  const loser = { numbered: 4, present: 2, titled: 4, named: 1 };
  assert.equal(confirmedByEpisodes([winner, loser]), 0);
  assert.equal(confirmedByEpisodes([{ ...winner, named: 2 }, { ...loser, named: 2 }]), undefined, "a tie confirms nobody");
  assert.equal(confirmedByEpisodes([{ numbered: 1, present: 1, titled: 1, named: 1 }]), undefined, "one title proves nothing");
});
