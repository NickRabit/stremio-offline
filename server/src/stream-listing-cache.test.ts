import assert from "node:assert/strict";
import test from "node:test";
import { defaultDownloadSettings } from "./naming.js";
import { StreamListingCache } from "./stream-listing-cache.js";
import type { AddonRecord, StreamItem } from "./types.js";
import type { StreamListing } from "./addons.js";

const provider = (key: string, options: { enabled?: boolean; version?: string; manifestUrl?: string } = {}): AddonRecord => ({
  key,
  manifestUrl: options.manifestUrl ?? `https://${key}.example/manifest.json`,
  role: "source",
  enabled: options.enabled ?? true,
  globalSearch: true,
  addedAt: "2026-01-01T00:00:00.000Z",
  downloadSettings: defaultDownloadSettings(),
  manifest: {
    id: key,
    name: key.toUpperCase(),
    version: options.version ?? "1",
    resources: [{ name: "stream", types: ["movie", "series"] }],
  },
});

const item = (name: string): StreamItem => ({ url: `https://cdn.example/${name}.mp4`, name });

const success = (addon: AddonRecord, items: StreamItem[] = [item(addon.key)]): StreamListing =>
  ({ addonKey: addon.key, status: "success", items });

test("successful empty listings are cached for five minutes while failures are retried", async () => {
  let now = 0;
  const calls = new Map<string, number>();
  const addons = [provider("full"), provider("empty"), provider("broken")];
  const cache = new StreamListingCache({
    now: () => now,
    fetch: async (addon) => {
      calls.set(addon.key, (calls.get(addon.key) ?? 0) + 1);
      if (addon.key === "broken") return { addonKey: addon.key, status: "failure" };
      return addon.key === "empty" ? success(addon, []) : success(addon);
    },
  });

  assert.deepEqual((await cache.list(addons, "movie", "tt1")).map((stream) => stream.name), ["full"]);
  assert.deepEqual((await cache.list(addons, "movie", "tt1")).map((stream) => stream.name), ["full"]);
  assert.deepEqual(Object.fromEntries(calls), { full: 1, empty: 1, broken: 2 });

  now = 5 * 60_000;
  await cache.list(addons, "movie", "tt1");
  assert.deepEqual(Object.fromEntries(calls), { full: 2, empty: 2, broken: 3 });
});

test("mixed cache hits are reassembled in current provider order", async () => {
  const alpha = provider("alpha");
  const beta = provider("beta");
  const gamma = provider("gamma");
  const disabled = provider("disabled", { enabled: false });
  const calls: string[] = [];
  const cache = new StreamListingCache({
    fetch: async (addon) => {
      calls.push(addon.key);
      return success(addon);
    },
  });

  assert.deepEqual((await cache.list([alpha, gamma], "movie", "tt1")).map((stream) => stream.name), ["alpha", "gamma"]);
  calls.length = 0;

  assert.deepEqual(
    (await cache.list([disabled, gamma, beta, alpha], "movie", "tt1")).map((stream) => stream.name),
    ["gamma", "beta", "alpha"],
  );
  assert.deepEqual(calls, ["beta"]);
});

test("invalidate removes only the exact colon-containing title across providers", async () => {
  const alpha = provider("alpha");
  const beta = provider("beta");
  const calls: string[] = [];
  const cache = new StreamListingCache({
    fetch: async (addon, _type, id) => {
      calls.push(`${addon.key}:${id}`);
      return success(addon, [item(`${addon.key}:${id}`)]);
    },
  });
  const first = "tt1:1:1";
  const longer = "tt1:1:10";

  await cache.list([alpha, beta], "series", first);
  await cache.list([alpha, beta], "series", longer);
  calls.length = 0;

  cache.invalidate("series", first);
  assert.deepEqual(
    (await cache.list([alpha, beta], "series", first)).map((stream) => stream.name),
    [`alpha:${first}`, `beta:${first}`],
  );
  await cache.list([alpha, beta], "series", longer);
  assert.deepEqual(calls, [`alpha:${first}`, `beta:${first}`]);
});

test("an in-flight result cannot reenter the cache after title invalidation", async () => {
  const addon = provider("alpha");
  let resolveFirst!: (listing: StreamListing) => void;
  let calls = 0;
  const cache = new StreamListingCache({
    fetch: async (asked) => {
      calls += 1;
      if (calls === 1) return await new Promise((resolve) => { resolveFirst = resolve; });
      return success(asked, [item("fresh")]);
    },
  });

  const stale = cache.list([addon], "movie", "tt1");
  cache.invalidate("movie", "tt1");
  resolveFirst(success(addon, [item("stale")]));
  assert.deepEqual((await stale).map((stream) => stream.name), ["stale"]);
  assert.deepEqual((await cache.list([addon], "movie", "tt1")).map((stream) => stream.name), ["fresh"]);
  assert.equal(calls, 2);
});

test("clear prevents an in-flight result from reentering after an import", async () => {
  const addon = provider("alpha");
  let resolveFirst!: (listing: StreamListing) => void;
  let calls = 0;
  const cache = new StreamListingCache({
    fetch: async (asked) => {
      calls += 1;
      if (calls === 1) return await new Promise((resolve) => { resolveFirst = resolve; });
      return success(asked, [item("fresh")]);
    },
  });

  const stale = cache.list([addon], "movie", "tt1");
  cache.clear();
  resolveFirst(success(addon, [item("stale")]));
  await stale;
  assert.deepEqual((await cache.list([addon], "movie", "tt1")).map((stream) => stream.name), ["fresh"]);
  assert.equal(calls, 2);
});

test("provider manifest revisions do not reuse another definition's listing", async () => {
  const first = provider("alpha");
  let calls = 0;
  const cache = new StreamListingCache({
    fetch: async (addon) => {
      calls += 1;
      return success(addon, [item(`${addon.manifest.version}:${addon.manifestUrl}`)]);
    },
  });

  await cache.list([first], "movie", "tt1");
  const nextVersion = { ...first, manifest: { ...first.manifest, version: "2" } };
  const nextUrl = { ...nextVersion, manifestUrl: "https://alpha.example/new/manifest.json" };
  assert.deepEqual((await cache.list([nextVersion], "movie", "tt1")).map((stream) => stream.name), [`2:${first.manifestUrl}`]);
  assert.deepEqual((await cache.list([nextUrl], "movie", "tt1")).map((stream) => stream.name), [
    `2:https://alpha.example/new/manifest.json`,
  ]);
  assert.equal(calls, 3);
});
