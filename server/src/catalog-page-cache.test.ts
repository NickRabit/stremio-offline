import assert from "node:assert/strict";
import test from "node:test";
import { CatalogPageCache } from "./catalog-page-cache.js";
import type { MetaItem } from "./types.js";

const page = (bytes: number): MetaItem[] => [{ id: "tt1", type: "movie", name: "x".repeat(bytes) }];

test("kept pages stay within the byte budget, oldest dropped first", () => {
  const cache = new CatalogPageCache(60_000, 200, Date.now, 10_000, 4_000);
  for (let index = 0; index < 5; index += 1) cache.set(`p${index}`, page(3_000));
  assert.ok(cache.bytes <= 10_000, `held ${cache.bytes} bytes`);
  assert.equal(cache.size, 3);
  assert.equal(cache.get("p0"), undefined);
  assert.ok(cache.get("p4"));
});

test("a page larger than the per-page limit is not kept", () => {
  const cache = new CatalogPageCache(60_000, 200, Date.now, 10_000, 4_000);
  cache.set("small", page(100));
  cache.set("huge", page(5_000));
  assert.equal(cache.get("huge"), undefined);
  assert.ok(cache.get("small"), "a large page does not push the others out");
});

test("expired pages give their memory back when the next page is kept", () => {
  let now = 0;
  const cache = new CatalogPageCache(1_000, 200, () => now);
  cache.set("old", page(1_000));
  now = 2_000;
  cache.set("new", page(10));
  assert.equal(cache.size, 1);
  assert.ok(cache.bytes < 1_000);
});

test("replacing a page counts its bytes once", () => {
  const cache = new CatalogPageCache();
  cache.set("same", page(1_000));
  const once = cache.bytes;
  cache.set("same", page(1_000));
  assert.equal(cache.bytes, once);
  cache.clear();
  assert.equal(cache.bytes, 0);
});
