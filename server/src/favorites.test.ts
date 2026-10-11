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

test("parseFavoriteFilter accepts the three names and falls back to all", () => {
  assert.equal(parseFavoriteFilter("library"), "library");
  assert.equal(parseFavoriteFilter("catalog"), "catalog");
  assert.equal(parseFavoriteFilter("all"), "all");
  assert.equal(parseFavoriteFilter("nonsense"), "all");
  assert.equal(parseFavoriteFilter(undefined), "all");
});
