import { describe, expect, it } from "vitest";
import { catalogueSaveNamesTitle } from "./catalogue-save";

describe("catalogueSaveNamesTitle", () => {
  it("names a film and a fully numbered episode", () => {
    expect(catalogueSaveNamesTitle({ type: "movie", id: "tt1", name: "Heat" })).toBe(true);
    expect(catalogueSaveNamesTitle({ type: "series", id: "tt9", name: "Show", videoId: "tt9:1:2", season: 1, episode: 2 })).toBe(true);
    expect(catalogueSaveNamesTitle({ type: "series", id: "tt9", name: "Show", videoId: "tt9:0:1", season: 0, episode: 1 })).toBe(true);
  });

  it("does not name an episode played by its id alone", () => {
    expect(catalogueSaveNamesTitle({ type: "series", id: "tt9", name: "Show", videoId: "special-1" })).toBe(false);
    expect(catalogueSaveNamesTitle({ type: "series", id: "tt9", name: "Show", videoId: "tt9:1:2", season: 1 })).toBe(false);
    expect(catalogueSaveNamesTitle({ type: "series", id: "tt9", name: "Show", season: 1, episode: 2 })).toBe(false);
  });
});
