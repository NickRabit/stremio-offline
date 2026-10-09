import assert from "node:assert/strict";
import test from "node:test";
import { HomeCatalogCache, homeCatalogExtras, homeCatalogTargets, type HomeCatalogTarget } from "./home-catalogs.js";
import type { AddonRecord, MetaItem } from "./types.js";

const addon = (key: string, catalogs: Array<{ type: string; id: string }>, patch: Partial<AddonRecord> = {}) => ({
  key, manifestUrl: `https://${key}/manifest.json`, role: "catalog", enabled: true, globalSearch: true, showOnHome: true, addedAt: "",
  manifest: { id: key, name: key, version: "1", catalogs }, ...patch,
}) as AddonRecord;

const target = (record: AddonRecord, index = 0): HomeCatalogTarget => ({ addon: record, definition: record.manifest.catalogs![index]! });

const deferred = () => {
  let resolve!: (items: MetaItem[]) => void;
  const promise = new Promise<MetaItem[]>((done) => { resolve = done; });
  return { promise, resolve };
};

test("requests that want one shelf at the same moment share a single lookup", async () => {
  const answer = deferred();
  let calls = 0;
  const cache = new HomeCatalogCache(() => { calls += 1; return answer.promise; });
  const shelf = target(addon("a", [{ type: "movie", id: "top" }]));
  const both = Promise.all([cache.load(shelf), cache.load(shelf)]);
  answer.resolve([{ id: "tt1", type: "movie", name: "One" }]);
  const [first, second] = await both;
  assert.equal(calls, 1);
  assert.equal(first, second);
});

test("one addon is asked a bounded number of catalogues at a time", async () => {
  let running = 0;
  let peak = 0;
  const cache = new HomeCatalogCache(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return [];
  }, { perAddon: 2 });
  const record = addon("a", Array.from({ length: 7 }, (_, index) => ({ type: "movie", id: `c${index}` })));
  await Promise.all(record.manifest.catalogs!.map((_, index) => cache.load(target(record, index))));
  assert.equal(peak, 2);
});

test("a remembered answer is fresh, then stale, then forgotten; warming refreshes only what is not fresh", async () => {
  let clock = 0;
  let calls = 0;
  const cache = new HomeCatalogCache(async () => { calls += 1; return [{ id: `tt${calls}`, type: "movie", name: "x" }]; },
    { freshMs: 100, keepMs: 1000, now: () => clock });
  const shelf = target(addon("a", [{ type: "movie", id: "top" }]));
  assert.equal(cache.peek(shelf), undefined);
  await cache.load(shelf);
  assert.equal(cache.peek(shelf)?.fresh, true);
  cache.warm([shelf]);
  assert.equal(calls, 1);
  clock = 500;
  assert.equal(cache.peek(shelf)?.fresh, false);
  cache.warm([shelf]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(cache.peek(shelf)?.items[0]?.id, "tt2");
  clock = 2000;
  assert.equal(cache.peek(shelf), undefined);
});

test("a failed refresh keeps the older answer", async () => {
  let clock = 0;
  let fail = false;
  const cache = new HomeCatalogCache(async () => {
    if (fail) throw new Error("down");
    return [{ id: "tt1", type: "movie", name: "x" }];
  }, { freshMs: 10, now: () => clock });
  const shelf = target(addon("a", [{ type: "movie", id: "top" }]));
  await cache.load(shelf);
  fail = true;
  clock = 50;
  cache.refresh(shelf);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cache.peek(shelf)?.items[0]?.id, "tt1");
});

test("the periodic warm-up stops once nobody has opened Home for a while", () => {
  let clock = 0;
  const cache = new HomeCatalogCache(async () => [], { keepMs: 100, now: () => clock });
  assert.equal(cache.idle, false);
  clock = 500;
  assert.equal(cache.idle, true, "an instance whose Home is never opened goes quiet too");
  clock = 0;
  cache.visited([]);
  clock = 50;
  assert.equal(cache.idle, false);
  clock = 500;
  assert.equal(cache.idle, true);
});

test("Home's targets follow the addon switches and the chosen feeds", () => {
  const targets = homeCatalogTargets([
    addon("on", [{ type: "movie", id: "top" }, { type: "series", id: "top" }], { homeCatalogs: ["series:top"] }),
    addon("off", [{ type: "movie", id: "top" }], { enabled: false }),
    addon("hidden", [{ type: "movie", id: "top" }], { showOnHome: false }),
    addon("source", [{ type: "movie", id: "top" }], { role: "source" }),
  ]);
  assert.deepEqual(targets.map(({ addon, definition }) => `${addon.key}/${definition.type}`), ["on/series"]);
});

test("required extras take skip zero and the first declared option", () => {
  assert.deepEqual(homeCatalogExtras({ type: "movie", id: "x", extraRequired: ["skip"],
    extra: [{ name: "genre", isRequired: true, options: ["Drama", "Comedy"] }, { name: "search" }] }), { skip: 0, genre: "Drama" });
});

test("a manifest whose extras are not a list declares none, rather than failing the warm-up", () => {
  const broken = { type: "movie", id: "x", extra: "search" } as unknown as HomeCatalogTarget["definition"];
  assert.deepEqual(homeCatalogExtras(broken), {});
  const cache = new HomeCatalogCache(async () => []);
  assert.doesNotThrow(() => cache.warm([{ addon: addon("a", []), definition: broken }]));
});
