import assert from "node:assert/strict";
import { test } from "node:test";
import { filterFavorites, mergeFavorites, parseFavoriteFilter, type FavoriteEntryCatalog, type FavoriteEntryLibrary } from "./favorites.js";

const library = (key: string, catalogId?: string): FavoriteEntryLibrary => ({ kind: "library", key, ...(catalogId ? { catalogId } : {}) });
const catalog = (id: string): FavoriteEntryCatalog => ({ kind: "catalog", type: "movie", id, name: id });

test("mergeFavorites keeps the library stars first, each source in its own newest-first order", () => {
  const merged = mergeFavorites([library("lib_a/New"), library("lib_a/Old")], [catalog("tt2"), catalog("tt1")]);
  assert.deepEqual(merged.map((entry) => entry.kind === "library" ? entry.key : entry.id), ["lib_a/New", "lib_a/Old", "tt2", "tt1"]);
});

test("filterFavorites keeps one source or both", () => {
  const entries = [...mergeFavorites([library("lib_a/One")], [catalog("tt1")])];
  assert.deepEqual(filterFavorites(entries, "all").map((entry) => entry.kind), ["library", "catalog"]);
  assert.deepEqual(filterFavorites(entries, "library").map((entry) => entry.kind), ["library"]);
  assert.deepEqual(filterFavorites(entries, "catalog").map((entry) => entry.kind), ["catalog"]);
});

test("filterFavorites keeps a folded catalogue star under both of its filters", () => {
  const entries = mergeFavorites([library("lib_a/Heat", "tt1"), library("lib_a/Solo")], [catalog("tt2")]);
  const names = (kept: typeof entries) => kept.map((entry) => entry.kind === "library" ? entry.key : entry.id);
  assert.deepEqual(names(filterFavorites(entries, "library")), ["lib_a/Heat", "lib_a/Solo"]);
  assert.deepEqual(names(filterFavorites(entries, "catalog")), ["lib_a/Heat", "tt2"],
    "the fold is the catalogue's own star, the identified library star without one is not");
});

test("parseFavoriteFilter accepts the three names and falls back to all", () => {
  assert.equal(parseFavoriteFilter("library"), "library");
  assert.equal(parseFavoriteFilter("catalog"), "catalog");
  assert.equal(parseFavoriteFilter("all"), "all");
  assert.equal(parseFavoriteFilter("nonsense"), "all");
  assert.equal(parseFavoriteFilter(undefined), "all");
});
