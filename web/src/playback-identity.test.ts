import { describe, expect, it } from "vitest";
import { playbackIdentity } from "./playback-identity";
import type { IdentityPreview } from "./types";

const preview = (over: Partial<IdentityPreview> = {}): IdentityPreview => ({
  path: "Films/Heat.mkv", key: "Films/Heat.mkv", kind: "movie", file: true, label: "Heat.mkv",
  parsed: { title: "Heat", query: "Heat" }, match: "unmatched", ...over,
});

describe("playbackIdentity", () => {
  it("names a matched film by its own id", () => {
    const found = playbackIdentity(preview({ match: "matched", bound: { type: "movie", id: "tt0113277", name: "Heat" } }));
    expect(found).toEqual({ type: "movie", id: "tt0113277" });
  });

  it("names a matched episode by the numbers its own name carried", () => {
    const found = playbackIdentity(preview({
      kind: "series", match: "matched", bound: { type: "series", id: "tt0108778", name: "Friends" },
      parsed: { title: "Friends", query: "Friends", season: 3, episode: 7 },
    }));
    expect(found).toEqual({ type: "series", id: "tt0108778:3:7" });
  });

  it("falls back to the numbers the binding itself carries", () => {
    const found = playbackIdentity(preview({
      kind: "series", match: "matched",
      bound: { type: "series", id: "tt0108778", name: "Friends", season: 5, episode: 2 },
    }));
    expect(found).toEqual({ type: "series", id: "tt0108778:5:2" });
  });

  it("has no identity for a file the matcher only suggested or could not match", () => {
    expect(playbackIdentity(preview({ match: "suggested", bound: { type: "movie", id: "tt0113277" } }))).toBeNull();
    expect(playbackIdentity(preview({ match: "unmatched", bound: { type: "movie", id: "tt0113277" } }))).toBeNull();
  });

  it("has no identity for an episode missing one of its numbers", () => {
    const bound = { type: "series", id: "tt0108778", name: "Friends" };
    expect(playbackIdentity(preview({ kind: "series", match: "matched", bound, parsed: { title: "Friends", query: "Friends", season: 3 } }))).toBeNull();
    expect(playbackIdentity(preview({ kind: "series", match: "matched", bound, parsed: { title: "Friends", query: "Friends", episode: 7 } }))).toBeNull();
    expect(playbackIdentity(preview({ kind: "series", match: "matched", bound }))).toBeNull();
  });

  it("has no identity without a preview", () => {
    expect(playbackIdentity(null)).toBeNull();
  });
});
