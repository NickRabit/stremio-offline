import { describe, expect, it } from "vitest";
import { matchKey, rankByTitle } from "./title-match";

describe("matchKey", () => {
  it("strips accents, punctuation and case", () => {
    expect(matchKey("Příběhy: 2. díl!")).toBe("pribehy 2 dil");
  });

  it("collapses a run of separators to one space and trims", () => {
    expect(matchKey("  ---A   B--  ")).toBe("a b");
  });
});

describe("rankByTitle", () => {
  it("orders exact, prefix, whole-token, substring and the rest", () => {
    const items = [
      { name: "Part Two" },
      { name: "Two" },
      { name: "Zeta" },
      { name: "Two Towers" },
      { name: "Network" },
    ];
    expect(rankByTitle(items, "two").map((item) => item.name))
      .toEqual(["Two", "Two Towers", "Part Two", "Network", "Zeta"]);
  });

  it("keeps the existing order for ties", () => {
    expect(rankByTitle([{ name: "B Star" }, { name: "A Star" }], "star").map((item) => item.name))
      .toEqual(["B Star", "A Star"]);
  });

  it("keeps the order when the query has no letters or digits", () => {
    expect(rankByTitle([{ name: "B" }, { name: "A" }], "!!!").map((item) => item.name))
      .toEqual(["B", "A"]);
  });

  it("matches a Czech name against an unaccented query", () => {
    expect(rankByTitle([{ name: "Jiné" }, { name: "Příběhy" }], "pribehy").map((item) => item.name))
      .toEqual(["Příběhy", "Jiné"]);
  });

  it("ranks an item without a name last", () => {
    const items: Array<{ name?: string }> = [{ name: undefined }, { name: "Star" }];
    expect(rankByTitle(items, "star").map((item) => item.name)).toEqual(["Star", undefined]);
  });
});
