import assert from "node:assert/strict";
import test from "node:test";
import { searchableCatalogs } from "./addons.js";
import { defaultDownloadSettings } from "./naming.js";
import type { AddonRecord } from "./types.js";

const addon = (key: string, globalSearch = true): AddonRecord => ({
  key,
  manifestUrl: `https://${key}.example/manifest.json`,
  role: "both",
  enabled: true,
  globalSearch,
  addedAt: "2026-01-01T00:00:00.000Z",
  downloadSettings: defaultDownloadSettings(),
  manifest: {
    id: key,
    name: key.toUpperCase(),
    version: "1",
    catalogs: [
      { type: "movie", id: "movies", extra: [{ name: "search" }] },
      { type: "series", id: "series", extra: [{ name: "search" }] },
      { type: "movie", id: "browse-only" },
    ],
  },
});

const keys = (addons: AddonRecord[], scope?: Parameters<typeof searchableCatalogs>[2]) =>
  searchableCatalogs(addons, undefined, scope).map(({ addon: item, definition }) => `${item.key}:${definition.type}:${definition.id}`);

test("search scope can select an addon or one of its catalogues", () => {
  const addons = [addon("alpha"), addon("beta")];
  assert.deepEqual(keys(addons, { addonKey: "alpha" }), ["alpha:movie:movies", "alpha:series:series"]);
  assert.deepEqual(keys(addons, { addonKey: "alpha", catalogType: "series", catalogId: "series" }), ["alpha:series:series"]);
  assert.deepEqual(keys(addons, { addonKey: "alpha", catalogType: "movie", catalogId: "unknown" }), []);
});

test("global-search opt-out affects only an unscoped user search", () => {
  const addons = [addon("alpha"), addon("private", false)];
  assert.deepEqual(keys(addons, { respectGlobalSearch: true }), ["alpha:movie:movies", "alpha:series:series"]);
  assert.deepEqual(keys(addons, { addonKey: "private", respectGlobalSearch: true }), ["private:movie:movies", "private:series:series"]);
  assert.deepEqual(keys(addons, { addonKey: "private", catalogType: "movie", catalogId: "movies", respectGlobalSearch: true }), ["private:movie:movies"]);
  assert.deepEqual(keys(addons), ["alpha:movie:movies", "alpha:series:series", "private:movie:movies", "private:series:series"]);
});
