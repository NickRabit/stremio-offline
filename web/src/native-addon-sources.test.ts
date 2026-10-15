import { describe, expect, it } from "vitest";
import { addonMediaSubject, genericProgressKey, supplementaryIdentity } from "./native-addon-sources";
import type { RemoteItem } from "./types";

const item = (over: Partial<RemoteItem> & Pick<RemoteItem, "type">): RemoteItem => ({
  id: "i1", name: "One", providerIds: {}, ...over,
});

describe("supplementaryIdentity", () => {
  it("names a movie by its own exact catalogue ids", () => {
    expect(supplementaryIdentity(item({ type: "movie", providerIds: { imdb: "tt123" } }), null)).toEqual({ type: "movie", id: "tt123" });
    expect(supplementaryIdentity(item({ type: "movie", providerIds: { tmdb: "550" } }), null)).toEqual({ type: "movie", id: "tmdb:550" });
  });

  it("asks an episode about its parent series with its own numbering appended", () => {
    const series = item({ id: "s1", type: "series", providerIds: { imdb: "tt7000" } });
    expect(supplementaryIdentity(item({ type: "episode", season: 1, episode: 2, providerIds: {} }), series))
      .toEqual({ type: "series", id: "tt7000:1:2" });
    // Season zero is the specials season and a real season, so it is valid.
    expect(supplementaryIdentity(item({ type: "episode", season: 0, episode: 1, providerIds: {} }), series))
      .toEqual({ type: "series", id: "tt7000:0:1" });
  });

  it("rejects an episode whose numbering is missing or not an integer inside its range", () => {
    const series = item({ id: "s1", type: "series", providerIds: { imdb: "tt7000" } });
    const episode = (season?: number, episode?: number) => item({ type: "episode", ...(season === undefined ? {} : { season }), ...(episode === undefined ? {} : { episode }) });
    expect(supplementaryIdentity(episode(undefined, 1), series)).toBeNull();
    expect(supplementaryIdentity(episode(1, undefined), series)).toBeNull();
    expect(supplementaryIdentity(episode(-1, 1), series)).toBeNull();
    expect(supplementaryIdentity(episode(1, 0), series)).toBeNull();
    expect(supplementaryIdentity(episode(1.5, 1), series)).toBeNull();
    expect(supplementaryIdentity(episode(1, 2.5), series)).toBeNull();
    expect(supplementaryIdentity(episode(Number.NaN, 1), series)).toBeNull();
    expect(supplementaryIdentity(episode(1, Number.POSITIVE_INFINITY), series)).toBeNull();
  });

  it("never uses an episode's own ids, a tvdb-only series or a title guess", () => {
    const episode = item({ type: "episode", season: 1, episode: 1, providerIds: { imdb: "tt9999", tmdb: "42" } });
    expect(supplementaryIdentity(episode, null)).toBeNull();
    expect(supplementaryIdentity(episode, item({ id: "s1", type: "series", providerIds: { tvdb: "81189" } }))).toBeNull();
  });

  it("names nothing that is not a playable movie or episode", () => {
    for (const type of ["folder", "series", "season"] as const) {
      expect(supplementaryIdentity(item({ type, providerIds: { imdb: "tt123" } }), null)).toBeNull();
    }
    expect(supplementaryIdentity(null, item({ type: "series", providerIds: { imdb: "tt123" } }))).toBeNull();
    // An unmatched mixed video carries no usable id at all.
    expect(supplementaryIdentity(item({ type: "movie", providerIds: { tvdb: "81189" } }), null)).toBeNull();
  });
});

describe("generic playback subject", () => {
  it("keys progress by the catalogue identity, episode suffix included", () => {
    expect(genericProgressKey({ type: "movie", id: "tt5000" })).toBe("movie:tt5000");
    expect(genericProgressKey({ type: "series", id: "tt7000:1:2" })).toBe("series:tt7000:1:2");
  });

  it("builds an exact movie or episode subject without any native reference", () => {
    const movie = addonMediaSubject(item({ type: "movie", name: "Film", year: 2021, providerIds: { imdb: "tt5000" } }), null, { poster: "/p.jpg" });
    expect(movie).toEqual({ kind: "movie", title: "Film", year: 2021, id: "tt5000", metaType: "movie", poster: "/p.jpg" });
    const series = item({ id: "s1", type: "series", name: "Show", providerIds: { imdb: "tt7000" } });
    const episode = addonMediaSubject(item({ type: "episode", name: "Pilot", season: 1, episode: 2, providerIds: { imdb: "tt9999" } }), series);
    expect(episode).toEqual({ kind: "episode", title: "Show", season: 1, episode: 2, episodeTitle: "Pilot", id: "tt7000", metaType: "series" });
  });
});
