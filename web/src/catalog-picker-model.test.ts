import { describe, expect, it } from "vitest";
import {
  bucketsPresent,
  catalogGroups,
  effectiveGenre,
  fallbackForBucket,
  foldText,
  genrePaused,
  isBrowsable,
  matchesQuery,
  needsSearch,
  recentCatalogs,
  refOf,
  requiredExtras,
  scopeGroups,
  typeBucket,
} from "./catalog-picker-model";
import type { Catalog, SearchableCatalog } from "./types";

const catalog = (
  addonKey: string,
  addonName: string,
  type: string,
  id: string,
  name?: string,
  extra?: Catalog["extra"],
  extraRequired?: unknown,
): Catalog => ({
  addonKey, addonName, type, id, name,
  ...(extra ? { extra } : {}),
  ...(extraRequired === undefined ? {} : { extraRequired }),
}) as Catalog;

const searchable = (addonKey: string, addonName: string, globalSearch: boolean, type: string, id: string, name: string): SearchableCatalog =>
  ({ addonKey, addonName, globalSearch, type, id, name });

describe("catalog picker model text", () => {
  it("folds diacritics and matches every query word", () => {
    expect(foldText("ČSFD")).toBe("csfd");
    expect(matchesQuery("ČSFD: Startuje na VOD", "csfd vod")).toBe(true);
    expect(matchesQuery("CZ Dabing · Netflix", "netf")).toBe(true);
    expect(matchesQuery("anything", "  ")).toBe(true);
  });
});

describe("catalogGroups", () => {
  const catalogs = [
    catalog("cinemeta", "Cinemeta", "movie", "top", "Top"),
    catalog("cinemeta", "Cinemeta", "series", "top", "Top"),
    catalog("cinemeta", "Cinemeta", "series", "last-videos", "Last videos", [{ name: "lastVideosIds", isRequired: true }]),
    catalog("cinemeta", "Cinemeta", "series", "fresh", "Fresh"),
    catalog("archive", "Archive", "movie", "classics", "Classics"),
    catalog("hidden", "Hidden addon", "movie", "secret", "Secret"),
  ];

  it("merges shared ids, omits unbrowsable catalogs and orders other types last", () => {
    const groups = catalogGroups(catalogs, { bucket: "movie", query: "", hiddenAddons: [], includeHidden: false });
    const cinemeta = groups.find((group) => group.addonKey === "cinemeta")!;
    expect(cinemeta.rows.map((row) => [row.name, row.ref.type, row.otherType])).toEqual([
      ["Top", "movie", false],
      ["Fresh", "series", true],
    ]);
    expect(cinemeta.notBrowsable).toBe(1);
    expect(cinemeta.countInBucket).toBe(1);
  });

  it("keeps distinct custom types sharing a catalog id selectable", () => {
    const catalogs = ["channel", "tv"].map((type) => catalog("live", "Live", type, "popular", "Popular"));
    const groups = catalogGroups(catalogs, { bucket: "other", query: "", hiddenAddons: [], includeHidden: false });
    expect(groups[0]?.rows.map((row) => row.ref.type)).toEqual(["channel", "tv"]);
  });

  it("shows hidden addons for a query or when included, and preserves addon order", () => {
    const withoutHidden = catalogGroups(catalogs, { bucket: "movie", query: "", hiddenAddons: ["hidden"], includeHidden: false });
    expect(withoutHidden.map((group) => group.addonKey)).toEqual(["cinemeta", "archive"]);

    const withHidden = catalogGroups(catalogs, { bucket: "movie", query: "", hiddenAddons: ["hidden"], includeHidden: true });
    expect(withHidden.map((group) => group.addonKey)).toEqual(["cinemeta", "archive", "hidden"]);
    expect(withHidden.at(-1)?.hidden).toBe(true);

    const found = catalogGroups(catalogs, { bucket: "movie", query: "secret", hiddenAddons: ["hidden"], includeHidden: false });
    expect(found).toHaveLength(1);
    expect(found[0]?.hidden).toBe(true);
  });
});

describe("catalog capabilities", () => {
  it("recognises required search and genre extras", () => {
    expect(isBrowsable(catalog("a", "A", "movie", "search", "Search", [{ name: "search", isRequired: true }]))).toBe(true);
    expect(isBrowsable(catalog("a", "A", "movie", "genre", "Genre", [{ name: "genre", isRequired: true, options: ["Drama"] }]))).toBe(true);
    expect(isBrowsable(catalog("a", "A", "movie", "genre", "Genre", [{ name: "genre", isRequired: true }]))).toBe(false);
    expect(isBrowsable(catalog("a", "A", "series", "videos", "Videos", undefined, ["lastVideosIds"]))).toBe(false);
    expect(needsSearch(catalog("a", "A", "movie", "search", "Search", [{ name: "search", isRequired: true }]))).toBe(true);
  });

  it("identifies movie, series and other buckets and bucket presence", () => {
    expect(typeBucket("movie")).toBe("movie");
    expect(typeBucket("series")).toBe("series");
    expect(typeBucket("channel")).toBe("other");
    expect(bucketsPresent([
      catalog("a", "A", "series", "s"),
      catalog("a", "A", "movie", "m"),
      catalog("a", "A", "channel", "c"),
    ])).toEqual(["movie", "series", "other"]);
  });

  it("keeps a chosen genre when offered, falls back for required genre and pauses stale values", () => {
    const optional = catalog("a", "A", "movie", "id", "Name", [{ name: "genre", options: ["Action", "Drama"] }]);
    const required = catalog("a", "A", "movie", "id", "Name", [{ name: "genre", isRequired: true, options: ["Comedy", "Drama"] }]);
    expect(effectiveGenre(optional, "Drama")).toBe("Drama");
    expect(effectiveGenre(required, "Action")).toBe("Comedy");
    expect(effectiveGenre(optional, "Missing")).toBe("");
    expect(genrePaused(optional, "Missing")).toBe(true);
    expect(genrePaused(required, "Missing")).toBe(false);
    expect(genrePaused(optional, "Action")).toBe(false);
  });

  it("collects required extras once", () => {
    const value = catalog("a", "A", "movie", "id", "Name",
      [{ name: "genre", isRequired: true }, { name: "search", isRequired: true }], ["search", "skip"]);
    expect(requiredExtras(value)).toEqual(["genre", "search", "skip"]);
  });
});

describe("catalog choices", () => {
  const current = { addonKey: "cinemeta", type: "movie", id: "top" };

  it("prefers the same id in another bucket before an ordinary fallback", () => {
    const catalogs = [
      catalog("cinemeta", "Cinemeta", "movie", "top", "Top"),
      catalog("cinemeta", "Cinemeta", "series", "top", "Top"),
    ];
    expect(fallbackForBucket(catalogs, current, "series", [])).toEqual({
      ref: { addonKey: "cinemeta", type: "series", id: "top" },
      sameId: true,
    });
  });

  it("walks the current addon and then other non-hidden addons without choosing search", () => {
    const catalogs = [
      catalog("other", "Other", "movie", "other", "Other"),
      catalog("cinemeta", "Cinemeta", "series", "search", "Search", [{ name: "search", isRequired: true }]),
      catalog("cinemeta", "Cinemeta", "series", "first", "First"),
      catalog("hidden", "Hidden", "series", "hidden", "Hidden"),
      catalog("later", "Later", "series", "later", "Later"),
    ];
    expect(fallbackForBucket(catalogs, current, "series", ["hidden"])?.ref).toEqual({
      addonKey: "cinemeta", type: "series", id: "first",
    });
    expect(fallbackForBucket(catalogs.filter((item) => item.id !== "first"), current, "series", ["hidden"])?.ref).toEqual({
      addonKey: "later", type: "series", id: "later",
    });
    expect(fallbackForBucket(catalogs.filter((item) => item.id === "search"), current, "series", [])).toBeNull();
  });

  it("drops missing and unbrowsable recent catalogs and respects the limit", () => {
    const catalogs = [
      catalog("a", "A", "movie", "one", "One"),
      catalog("a", "A", "movie", "two", "Two", [{ name: "channelIds", isRequired: true }]),
      catalog("a", "A", "movie", "three", "Three"),
    ];
    expect(recentCatalogs(catalogs, [
      refOf(catalogs[0]!),
      refOf(catalogs[1]!),
      { addonKey: "a", type: "movie", id: "missing" },
      refOf(catalogs[2]!),
    ], 2).map((item) => item.name)).toEqual(["One", "Three"]);
  });
});

describe("scopeGroups", () => {
  const rows = [
    searchable("cinemeta", "Cinemeta", true, "movie", "top", "Top movies"),
    searchable("cinemeta", "Cinemeta", true, "series", "top", "Top series"),
    searchable("manual", "Manual", false, "movie", "films", "Films"),
  ];

  it("groups by addon in order and filters by type and query", () => {
    const all = scopeGroups(rows, { query: "", type: "" });
    expect(all.map((group) => group.addonKey)).toEqual(["cinemeta", "manual"]);
    expect(all[0]?.addonValue).toBe("addon:cinemeta");
    expect(all[0]?.rows.map((row) => row.value)).toEqual([
      "catalog:cinemeta:movie:top",
      "catalog:cinemeta:series:top",
    ]);
    expect(scopeGroups(rows, { query: "", type: "series" }).map((group) => group.addonKey)).toEqual(["cinemeta"]);
    expect(scopeGroups(rows, { query: "manual films", type: "" }).map((group) => group.addonKey)).toEqual(["manual"]);
  });
});
