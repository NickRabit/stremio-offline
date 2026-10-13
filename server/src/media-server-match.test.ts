import assert from "node:assert/strict";
import test from "node:test";
import { remoteIdsMatch, remoteMatchCandidates, remoteMatchTarget } from "./media-server-match.js";
import type { ProviderItem } from "./media-server-provider.js";

test("remote catalogue matching requires a typed exact ID and an explicit episode number", () => {
  assert.deepEqual(remoteMatchTarget("movie", "tt123"), { type: "movie", ids: { imdb: "tt123" } });
  assert.deepEqual(remoteMatchTarget("series", "tmdb:12:0:1"), { type: "episode", ids: { tmdb: "12" }, season: 0, episode: 1 });
  for (const [type, id] of [["movie", "tt123:1:2"], ["series", "tt123"], ["series", "tt123:1:0"], ["movie", "Movie"], ["movie", "tmdb:0"], ["movie", "tt123junk"], ["series", "tt1:1:9007199254740992"]]) {
    assert.equal(remoteMatchTarget(type!, id!), undefined);
  }
});

test("missing and conflicting external IDs cannot auto-match", () => {
  assert.equal(remoteIdsMatch({ imdb: "tt1" }, {}), false);
  assert.equal(remoteIdsMatch({ imdb: "tt1" }, { imdb: "tt1" }), true);
  assert.equal(remoteIdsMatch({ imdb: "tt1", tmdb: "2" }, { imdb: "tt1", tmdb: "3" }), false);
  assert.equal(remoteIdsMatch({ tmdb: "2" }, { tvdb: "2" }), false);
});

test("movie copies remain separate and similarly named titles never match", () => {
  const items: ProviderItem[] = [
    { id: "one", name: "A", type: "movie", providerIds: { imdb: "tt1" } },
    { id: "two", name: "A", type: "movie", providerIds: { imdb: "tt1" } },
    { id: "wrong", name: "A", type: "movie", providerIds: { imdb: "tt2" } },
    { id: "show", name: "A", type: "series", providerIds: { imdb: "tt1" } },
  ];
  assert.deepEqual(remoteMatchCandidates(items, remoteMatchTarget("movie", "tt1")!).map((item) => item.id), ["one", "two"]);
});

test("episodes require a matching parent, exact numbering and a single episode file", () => {
  const show: ProviderItem = { id: "show", name: "Show", type: "series", providerIds: { imdb: "tt1" } };
  const episode: ProviderItem = { id: "episode", name: "Episode", type: "episode", seriesId: show.id, season: 1, episode: 2, providerIds: {} };
  const items: ProviderItem[] = [show, episode,
    { ...episode, id: "multi", episodeEnd: 3 },
    { ...episode, id: "wrong-parent", seriesId: "other" },
    { ...episode, id: "wrong-number", episode: 3 },
    { ...episode, id: "missing-parent", seriesId: undefined, providerIds: { imdb: "tt1" } },
  ];
  const target = remoteMatchTarget("series", "tt1:1:2")!;
  assert.deepEqual(remoteMatchCandidates(items, target).map((item) => item.id), ["episode"]);
  assert.deepEqual(remoteMatchCandidates(items.slice(1), target), []);
});
