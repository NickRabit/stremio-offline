import assert from "node:assert/strict";
import { test } from "node:test";
import { messageKeyOf } from "./errors.js";
import {
  applyPatch, defaultCatalogView, defaultDownloadsView, defaultLibraryView, defaultResumeView, emptyViews, parseViews, type UserViews,
} from "./views.js";

const LIBRARY = "lib_0000000a";
const REMOTE_LIBRARY = `rlib_${"a".repeat(32)}`;

test("a remote library keeps its own view preferences under the rlib_ handle", () => {
  const parsed = parseViews({ libraries: { [REMOTE_LIBRARY]: { sort: "added", order: "desc", view: "list" } } });
  assert.deepEqual(parsed.libraries[REMOTE_LIBRARY], { sort: "added", order: "desc", favoritesOnly: false, view: "list" });
  const merged = applyPatch(parsed, { libraries: { [REMOTE_LIBRARY]: { sort: "size", order: "asc", favoritesOnly: true, view: "list" } } });
  assert.deepEqual(merged.libraries[REMOTE_LIBRARY], { sort: "size", order: "asc", favoritesOnly: true, view: "list" });
  assert.deepEqual(parseViews(merged).libraries[REMOTE_LIBRARY], merged.libraries[REMOTE_LIBRARY], "the remote prefs survive a round trip");
  assert.deepEqual(applyPatch(emptyViews(), { libraries: { "not-an-id": { sort: "name" } } }).libraries, {}, "a random key is still dropped");
});

test("parseViews reads nothing, or junk, as the empty object", () => {
  assert.deepEqual(parseViews(undefined), emptyViews());
  assert.deepEqual(parseViews({}), emptyViews());
  assert.deepEqual(parseViews({ libraries: { no: 1 } }), emptyViews());
});

test("parseViews keeps what it knows and falls back field by field", () => {
  const stored = parseViews({
    libraries: { [LIBRARY]: { sort: "size", order: "desc", favoritesOnly: true, view: "list" } },
    extras: { ":resume": { sort: "nope" } },
    downloads: { sort: "titleSort", pageSize: 50, status: "gone" },
  });
  assert.deepEqual(stored.libraries[LIBRARY], { sort: "size", order: "desc", favoritesOnly: true, view: "list" });
  assert.deepEqual(stored.extras[":resume"], { sort: "added", order: "desc", favoritesOnly: false, view: "grid" });
  assert.deepEqual(stored.downloads, { ...defaultDownloadsView(), sort: "titleSort", pageSize: 50 });
});

test("the defaults differ per scope", () => {
  assert.deepEqual(defaultLibraryView(), { sort: "name", order: "asc", favoritesOnly: false, view: "grid" });
  assert.deepEqual(defaultResumeView(), { sort: "added", order: "desc", favoritesOnly: false, view: "grid" });
  assert.deepEqual(defaultDownloadsView(), { sort: "order", direction: "asc", status: "", dateField: "createdAt", pageSize: 20 });
  assert.deepEqual(defaultCatalogView(), { recentCount: 3, recent: [], hiddenAddons: [], last: null });
  assert.deepEqual(emptyViews(), { libraries: {}, extras: {}, downloads: defaultDownloadsView(), catalog: defaultCatalogView() });
});

const alice = (): UserViews => ({
  libraries: { [LIBRARY]: { sort: "size", order: "desc", favoritesOnly: true, view: "list" } },
  extras: {},
  downloads: defaultDownloadsView(),
  catalog: defaultCatalogView(),
});

const ref = (id: string, addonKey = "cine", type = "movie") => ({ addonKey, type, id });

test("applyPatch merges one library and leaves another alone", () => {
  const other = "lib_0000000b";
  const before: UserViews = { ...alice(), libraries: { ...alice().libraries, [other]: { sort: "added", order: "desc", favoritesOnly: false, view: "grid" } } };
  const next = applyPatch(before, { libraries: { [LIBRARY]: { sort: "name" } } });
  assert.deepEqual(next.libraries[LIBRARY], { sort: "name", order: "asc", favoritesOnly: false, view: "grid" });
  assert.deepEqual(next.libraries[other], before.libraries[other]);
  assert.deepEqual(next.downloads, before.downloads);
});

test("applyPatch writes downloads without touching the libraries", () => {
  const next = applyPatch(alice(), { downloads: { sort: "duration", pageSize: 100 } });
  assert.deepEqual(next.libraries, alice().libraries);
  assert.deepEqual(next.downloads, { sort: "duration", direction: "asc", status: "", dateField: "createdAt", pageSize: 100 });
});

test("applyPatch refuses a body that is not an object", () => {
  for (const body of [null, "x", 7, []]) {
    const failure = (() => { try { applyPatch(alice(), body); } catch (error) { return error; } return undefined; })();
    assert.equal(messageKeyOf(failure), "err.invalidRequest");
  }
});

test("applyPatch refuses an illegal enum on a named scope", () => {
  assert.throws(() => applyPatch(alice(), { libraries: { [LIBRARY]: { sort: "nope" } } }),
    (error: unknown) => messageKeyOf(error) === "err.invalidRequest");
  assert.throws(() => applyPatch(alice(), { downloads: { status: "gone" } }),
    (error: unknown) => messageKeyOf(error) === "err.invalidRequest");
  assert.throws(() => applyPatch(alice(), { libraries: { [LIBRARY]: { favoritesOnly: "yes" } } }),
    (error: unknown) => messageKeyOf(error) === "err.invalidRequest");
});

test("applyPatch drops a key that is not a library id", () => {
  const next = applyPatch(alice(), { libraries: { "not-an-id": { sort: "name" } } });
  assert.deepEqual(next.libraries, alice().libraries);
});

test("applyPatch ignores unknown top-level keys", () => {
  const next = applyPatch(alice(), { query: "foo", from: "2026-01-01" });
  assert.deepEqual(next, alice());
});

test("applyPatch folds an extra onto its own default", () => {
  const next = applyPatch(emptyViews(), { extras: { ":resume": { view: "list" } } });
  assert.deepEqual(next.extras[":resume"], { sort: "added", order: "desc", favoritesOnly: false, view: "list" });
  assert.deepEqual(next.extras[":favorites"], undefined);
});

test("parseViews defaults a missing or junk catalog", () => {
  assert.deepEqual(parseViews(undefined).catalog, defaultCatalogView());
  assert.deepEqual(parseViews({}).catalog, defaultCatalogView());
  for (const catalog of [1, "x", [], null, { recentCount: 4, recent: "no", hiddenAddons: 7, last: 0 }]) {
    assert.deepEqual(parseViews({ catalog }).catalog, defaultCatalogView());
  }
});

test("parseViews drops invalid refs and duplicates and cuts to recentCount", () => {
  const stored = parseViews({
    catalog: {
      recentCount: 3,
      recent: [
        ref("tt1"),
        { addonKey: "cine", type: "movie", id: "" },
        ref("tt1"),
        ref("tt2"),
        { addonKey: "", type: "movie", id: "tt3" },
        ref("tt4"),
        ref("tt5"),
      ],
      hiddenAddons: ["cine", "", "cine", "x".repeat(201), "other", 7, "third"],
      last: { addonKey: "cine", type: "movie", id: "tt9" },
    },
  });
  assert.deepEqual(stored.catalog.recent, [ref("tt1"), ref("tt2"), ref("tt4")]);
  assert.deepEqual(stored.catalog.hiddenAddons, ["cine", "other", "third"]);
  assert.equal(stored.catalog.last, null);
});

test("parseViews keeps a valid last and a zero recentCount empties recent", () => {
  const stored = parseViews({
    catalog: {
      recentCount: 0,
      recent: [ref("tt1"), ref("tt2")],
      hiddenAddons: ["cine"],
      last: { ...ref("tt1"), genre: "" },
    },
  });
  assert.deepEqual(stored.catalog, {
    recentCount: 0,
    recent: [],
    hiddenAddons: ["cine"],
    last: { ...ref("tt1"), genre: "" },
  });
});

test("applyPatch replaces only the catalog fields given", () => {
  const before = applyPatch(alice(), {
    catalog: { recentCount: 5, recent: [ref("tt1")], hiddenAddons: ["cine"], last: { ...ref("tt1"), genre: "Action" } },
  });
  const next = applyPatch(before, { catalog: { hiddenAddons: ["other"] } });
  assert.equal(next.catalog.recentCount, 5);
  assert.deepEqual(next.catalog.recent, [ref("tt1")]);
  assert.deepEqual(next.catalog.hiddenAddons, ["other"]);
  assert.deepEqual(next.catalog.last, { ...ref("tt1"), genre: "Action" });
});

test("applyPatch refuses a bad catalog field and stores nothing", () => {
  const before = alice();
  const refusals = [
    { recentCount: 4 },
    { recent: [{ addonKey: "cine", type: "movie", id: "" }] },
    { recent: Array.from({ length: 9 }, (_, i) => ref(`tt${i}`)) },
    { hiddenAddons: "cine" },
  ];
  for (const catalog of refusals) {
    assert.throws(() => applyPatch(before, { catalog }),
      (error: unknown) => messageKeyOf(error) === "err.invalidRequest");
  }
  assert.deepEqual(before, alice());
});

test("applyPatch empties recent when recentCount is 0", () => {
  const before = applyPatch(alice(), { catalog: { recentCount: 5, recent: [ref("tt1"), ref("tt2")] } });
  const next = applyPatch(before, { catalog: { recentCount: 0 } });
  assert.deepEqual(next.catalog.recent, []);
  assert.equal(next.catalog.recentCount, 0);
});

test("a catalog-only patch leaves libraries alone", () => {
  const next = applyPatch(alice(), { catalog: { hiddenAddons: ["cine"] } });
  assert.deepEqual(next.libraries, alice().libraries);
  assert.deepEqual(next.downloads, alice().downloads);
  assert.deepEqual(next.catalog.hiddenAddons, ["cine"]);
  assert.equal(next.catalog.recentCount, 3);
});
