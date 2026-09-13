import { describe, expect, it } from "vitest";
import { parseSearchScope } from "./search-scope";

describe("search scope", () => {
  it("parses all-addons and whole-addon scopes", () => {
    expect(parseSearchScope("")).toEqual({});
    expect(parseSearchScope("addon:alpha")).toEqual({ addonKey: "alpha" });
  });

  it("parses a catalogue scope without truncating its id", () => {
    expect(parseSearchScope("catalog:alpha:series:popular:2026")).toEqual({
      addonKey: "alpha", catalogType: "series", catalogId: "popular:2026",
    });
  });

  it("ignores malformed values", () => {
    expect(parseSearchScope("catalog:alpha:movie:")).toEqual({});
    expect(parseSearchScope("unknown:alpha")).toEqual({});
  });
});
