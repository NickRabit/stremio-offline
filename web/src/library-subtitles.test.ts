import { describe, expect, it } from "vitest";
import { librarySubtitleTarget } from "./library-subtitles";
import type { IdentityPreview } from "./types";

const identity = (patch: Partial<IdentityPreview>): IdentityPreview => ({
  path: "Films/Heat.mkv", key: "Films/Heat.mkv", kind: "movie", file: true, label: "Heat.mkv",
  parsed: { title: "Heat", query: "Heat" }, match: "matched", ...patch,
});

describe("librarySubtitleTarget", () => {
  it("asks about a bound film by its own id", () => {
    expect(librarySubtitleTarget(identity({ bound: { type: "movie", id: "tt0113277" } }))).toEqual({ type: "movie", id: "tt0113277" });
  });

  it("asks about an episode of a bound series by its numbers from the file name", () => {
    const episode = identity({ kind: "series", parsed: { title: "Dark", query: "Dark", season: 2, episode: 3 }, bound: { type: "series", id: "tt5753856" } });
    expect(librarySubtitleTarget(episode)).toEqual({ type: "series", id: "tt5753856:2:3" });
  });

  it("prefers the numbers the binding names over the file name", () => {
    const episode = identity({ kind: "series", parsed: { title: "Dark", query: "Dark", season: 1, episode: 1 }, bound: { type: "series", id: "tt5753856", season: 3, episode: 8 } });
    expect(librarySubtitleTarget(episode)).toEqual({ type: "series", id: "tt5753856:3:8" });
  });

  it("asks about nothing for an unbound file or an episode without numbers", () => {
    expect(librarySubtitleTarget(null)).toBeUndefined();
    expect(librarySubtitleTarget(identity({ match: "unmatched" }))).toBeUndefined();
    expect(librarySubtitleTarget(identity({ kind: "series", bound: { type: "series", id: "tt5753856" } }))).toBeUndefined();
  });
});
