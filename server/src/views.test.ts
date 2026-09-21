import assert from "node:assert/strict";
import { test } from "node:test";
import { messageKeyOf } from "./errors.js";
import {
  applyPatch, defaultDownloadsView, defaultLibraryView, defaultResumeView, emptyViews, parseViews, type UserViews,
} from "./views.js";

const LIBRARY = "lib_0000000a";

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
  assert.deepEqual(emptyViews(), { libraries: {}, extras: {}, downloads: defaultDownloadsView() });
});

const alice = (): UserViews => ({
  libraries: { [LIBRARY]: { sort: "size", order: "desc", favoritesOnly: true, view: "list" } },
  extras: {},
  downloads: defaultDownloadsView(),
});

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
