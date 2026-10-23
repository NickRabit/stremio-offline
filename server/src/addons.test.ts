import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addonAllowed, addonMetadataLanguage, allowedAddons, fetchCatalogPage, metadata, orderedForUser, searchAll, searchableCatalogs, streamCandidates, subtitles, supportsSkip } from "./addons.js";
import { flushLog, initLogger } from "./logger.js";
import type { Viewer } from "./libraries.js";
import { defaultDownloadSettings } from "./naming.js";
import { outbound } from "./outbound.js";
import { setFetchTransport } from "./security.js";
import type { AddonRecord, CatalogDefinition } from "./types.js";

process.env.LOG_STDOUT = "0";
await initLogger(await mkdtemp(path.join(os.tmpdir(), "stremio-addons-")));

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

const admin: Viewer = { id: "usr_00000001", role: "admin" };
const ordinary: Viewer = { id: "usr_00000002", role: "user" };

test("addonAllowed lets an administrator use every addon, whatever the list says", () => {
  assert.equal(addonAllowed(addon("alpha"), admin), true, "an absent list still admits an administrator");
  assert.equal(addonAllowed({ ...addon("alpha"), allowedUsers: [] }, admin), true, "an empty list too");
  assert.equal(addonAllowed({ ...addon("alpha"), allowedUsers: [ordinary.id] }, admin), true, "a grant to somebody else does not narrow it");
});

test("addonAllowed refuses a user who is not on the list", () => {
  assert.equal(addonAllowed(addon("alpha"), ordinary), false, "an absent list grants nobody");
  assert.equal(addonAllowed({ ...addon("alpha"), allowedUsers: [] }, ordinary), false);
  assert.equal(addonAllowed({ ...addon("alpha"), allowedUsers: ["usr_ffffffff"] }, ordinary), false);
  assert.equal(addonAllowed({ ...addon("alpha"), allowedUsers: [ordinary.id] }, ordinary), true);
  assert.deepEqual(allowedAddons([addon("alpha"), { ...addon("beta"), allowedUsers: [ordinary.id] }], ordinary).map((item) => item.key), ["beta"]);
});

test("orderedForUser puts the listed addons first in their order and the rest after in the global order", () => {
  const addons = [addon("alpha"), addon("beta"), addon("gamma")];
  assert.deepEqual(orderedForUser(addons, ["gamma", "alpha"]).map((item) => item.key), ["gamma", "alpha", "beta"]);
  assert.deepEqual(orderedForUser(addons, ["gamma"]).map((item) => item.key), ["gamma", "alpha", "beta"], "an addon the list does not name keeps its place after");
});

test("orderedForUser ignores a key that names no addon", () => {
  const addons = [addon("alpha"), addon("beta")];
  assert.deepEqual(orderedForUser(addons, ["missing", "beta"]).map((item) => item.key), ["beta", "alpha"]);
  assert.deepEqual(orderedForUser(addons, ["missing"]).map((item) => item.key), ["alpha", "beta"], "a list of stale keys changes nothing");
});

test("an absent or empty order is exactly the global order", () => {
  const addons = [addon("alpha"), addon("beta")];
  assert.deepEqual(orderedForUser(addons, undefined).map((item) => item.key), ["alpha", "beta"]);
  assert.deepEqual(orderedForUser(addons, []).map((item) => item.key), ["alpha", "beta"]);
});

test("ordering is applied after filtering, so an addon the user cannot see never appears", () => {
  const addons = [addon("alpha"), { ...addon("beta"), allowedUsers: [ordinary.id] }, addon("gamma")];
  const visible = allowedAddons(addons, ordinary);
  assert.deepEqual(orderedForUser(visible, ["alpha", "beta"]).map((item) => item.key), ["beta"], "the order names alpha, but the filter already dropped it");
});

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

test("metadata language is read from configured addons and Cinemeta", () => {
  const configured = addon("tmdb");
  configured.manifestUrl = "https://metadata.example/%7B%22language%22%3A%22cs-CZ%22%7D/manifest.json";
  const cinemeta = addon("cinemeta");
  cinemeta.manifest.id = "com.linvo.cinemeta";
  assert.equal(addonMetadataLanguage(configured), "cs");
  assert.equal(addonMetadataLanguage(cinemeta), "en");
  assert.equal(addonMetadataLanguage(addon("plain")), undefined);
});

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const metaAddon = (key: string): AddonRecord => ({
  key,
  manifestUrl: `https://${key}.example/manifest.json`,
  role: "both",
  enabled: true,
  globalSearch: true,
  addedAt: "2026-01-01T00:00:00.000Z",
  downloadSettings: defaultDownloadSettings(),
  manifest: { id: key, name: key.toUpperCase(), version: "1", resources: ["catalog", "meta"] },
});

/** Serves the addon requests from a stub instead of the network. */
async function withStubbedAddons(handler: (url: string) => Response | Promise<Response>, run: () => Promise<void>) {
  const originalFlag = process.env.ALLOW_PRIVATE_ADDONS;
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  setFetchTransport(async (url) => handler(String(url)));
  try { await run(); }
  finally {
    setFetchTransport();
    if (originalFlag === undefined) delete process.env.ALLOW_PRIVATE_ADDONS;
    else process.env.ALLOW_PRIVATE_ADDONS = originalFlag;
  }
}

test("a provider answer wins and an addon fills the missing poster", async () => {
  const calls: string[] = [];
  await withStubbedAddons((url) => {
    calls.push(url);
    return json({ meta: { id: "tt1", type: "movie", name: "Cinemeta name", description: "Cinemeta description", poster: "https://img.example/poster.jpg" } });
  }, async () => {
    const provider = async (type: string, id: string) => ({ id, type, name: "TMDB name", description: "TMDB description" });
    const result = await metadata([metaAddon("cinemeta")], "movie", "tt1", "cs", provider);
    if (!result) throw new Error("expected metadata");
    assert.equal(result.name, "TMDB name");
    assert.equal(result.description, "TMDB description");
    assert.equal(result.poster, "https://img.example/poster.jpg");
  });
  assert.equal(calls.length, 1);
});

test("a series with a full provider description still waits for the episode list", async () => {
  const videos = [{ id: "tt1:1:1", season: 1, episode: 1, title: "Pilot" }];
  const calls: string[] = [];
  await withStubbedAddons((url) => {
    calls.push(url);
    return json({ meta: { id: "tt1", type: "series", name: "Series name", videos } });
  }, async () => {
    const provider = async (type: string, id: string) => ({ id, type, name: "TMDB series", description: "TMDB description", videos: [] });
    const result = await metadata([metaAddon("cinemeta")], "series", "tt1", "cs", provider);
    if (!result) throw new Error("expected metadata");
    assert.equal(result.name, "TMDB series");
    assert.deepEqual(result.videos, videos);
  });
  assert.equal(calls.length, 1);
});

test("without a provider the first addon with a description ends the loop", async () => {
  const calls: string[] = [];
  await withStubbedAddons((url) => {
    calls.push(url);
    return json({ meta: { id: "tt2", type: "movie", name: "Name", description: "Description" } });
  }, async () => {
    const result = await metadata([metaAddon("cinemeta"), metaAddon("other")], "movie", "tt2", "cs");
    assert.deepEqual(result, { id: "tt2", type: "movie", name: "Name", description: "Description" });
  });
  assert.equal(calls.length, 1);
});

test("a real provider failure still falls through to metadata addons", async () => {
  const calls: string[] = [];
  await withStubbedAddons((url) => {
    calls.push(url);
    return json({ meta: { id: "tt2", type: "movie", name: "Addon answer", description: "Description" } });
  }, async () => {
    const provider = async () => { throw new Error("TMDB is offline"); };
    const result = await metadata([metaAddon("fallback")], "movie", "tt2", "cs", provider);
    assert.equal(result?.name, "Addon answer");
  });
  assert.equal(calls.length, 1);
});

test("the artwork reading reads on past a localized description until a backdrop appears", async () => {
  const czech = { ...metaAddon("czech"), manifestUrl: "https://czech.example/manifest.json?language=cs" };
  const cinemeta = metaAddon("com.linvo.cinemeta");
  const calls: string[] = [];
  await withStubbedAddons((url) => {
    calls.push(String(url));
    // The Czech addon supplies the localized description but no picture; Cinemeta has the backdrop.
    if (String(url).includes("czech.example")) return json({ meta: { id: "tt3", type: "movie", name: "Film", description: "Popis" } });
    return json({ meta: { id: "tt3", type: "movie", name: "Film", background: "https://img.example/backdrop.jpg" } });
  }, async () => {
    const result = await metadata([czech, cinemeta], "movie", "tt3", "cs", undefined, false, true);
    if (!result) throw new Error("expected metadata");
    assert.equal(result.description, "Popis", "the localized description wins");
    assert.equal(result.background, "https://img.example/backdrop.jpg", "and the later addon fills the missing backdrop");
  });
  assert.equal(calls.length, 2, "the loop does not stop on a description without artwork");
});

test("a disabled addon is refused for an administrator too, where enabled is enforced", async () => {
  const disabledMeta = { ...metaAddon("cinemeta"), enabled: false };
  const disabledStream = { ...metaAddon("streamer"), enabled: false, role: "source" as const, manifest: { ...metaAddon("streamer").manifest, resources: ["stream"] } };
  const granted = allowedAddons([disabledMeta, disabledStream], admin);
  assert.equal(addonAllowed(disabledMeta, admin), true, "addonAllowed answers for visibility, not for enabled");

  // `enabled` lives in the searchableCatalogs/streamCandidates/metadata helpers, which drop a
  // disabled addon before an administrator gets anywhere: visibility never widens a disabled one.
  const calls: string[] = [];
  await withStubbedAddons((url) => { calls.push(String(url)); return json({ meta: {} }); }, async () => {
    assert.deepEqual(searchableCatalogs(granted), [], "a disabled addon has no catalogue");
    assert.deepEqual(streamCandidates(granted, "movie", "tt1"), [], "and no source");
    assert.equal(await metadata(granted, "movie", "tt1", "en"), null, "and no metadata");
  });
  assert.equal(calls.length, 0, "a disabled addon is never asked");
});

const searchAddon = (key: string, type = "movie", id = "top"): AddonRecord => ({
  ...addon(key),
  manifest: { id: key, name: key.toUpperCase(), version: "1", catalogs: [{ type, id, extra: [{ name: "search" }] }] },
});

const statusJson = (status: number) =>
  new Response(JSON.stringify({}), { status, headers: { "content-type": "application/json" } });

test("searchAll folds in target order, merges sources and keeps per-catalog offsets", async () => {
  const slow = searchAddon("slow");
  const fast = searchAddon("fast");
  const down = searchAddon("down");
  const requested: string[] = [];
  const cursor = Buffer.from(JSON.stringify({
    "slow:movie:top": 20, "fast:movie:top": 0, "down:movie:top": 0,
  })).toString("base64url");

  await withStubbedAddons(async (url) => {
    requested.push(url);
    const host = new URL(url).hostname;
    if (host === "slow.example") {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return json({ metas: [{ id: "tt1", name: "Slow title" }, { id: "tt2", name: "Second" }] });
    }
    if (host === "fast.example") return json({ metas: [{ id: "tt1", name: "Fast title" }] });
    return statusJson(503);
  }, async () => {
    const result = await searchAll([slow, fast, down], "needle", "movie", cursor);
    assert.deepEqual(result.items, [
      {
        id: "tt1", type: "movie", name: "Slow title", addonName: "SLOW", sources: ["SLOW", "FAST"],
      },
      {
        id: "tt2", type: "movie", name: "Second", addonName: "SLOW", sources: ["SLOW"],
      },
    ]);
    assert.equal(result.sources, 3);
    assert.equal(result.hasMore, true);
    assert.deepEqual(JSON.parse(Buffer.from(result.cursor, "base64url").toString()), {
      "slow:movie:top": 22, "fast:movie:top": 1, "down:movie:top": -1,
    });
  });

  assert.equal(requested.some((url) => url.includes("skip=20")), true);
  assert.equal(requested.filter((url) => url.includes("fast.example")).every((url) => !url.includes("skip=")), true);
});

test("an aborted search resolves with every catalog exhausted and does not touch the breaker", async () => {
  const addons = [searchAddon("abort-one"), searchAddon("abort-two"), searchAddon("abort-three")];
  const hosts = ["abort-one.example", "abort-two.example", "abort-three.example"];
  const controller = new AbortController();
  controller.abort();
  let calls = 0;

  await withStubbedAddons(() => { calls += 1; return json({ metas: [] }); }, async () => {
    const result = await searchAll(addons, "needle", "movie", undefined, undefined, false, { signal: controller.signal });
    assert.deepEqual(result.items, []);
    assert.equal(result.sources, 3);
    assert.equal(result.hasMore, false);
    assert.deepEqual(JSON.parse(Buffer.from(result.cursor, "base64url").toString()), {
      "abort-one:movie:top": -1, "abort-two:movie:top": -1, "abort-three:movie:top": -1,
    });
  });

  assert.equal(calls, 0);
  assert.deepEqual(outbound.diagnostics().filter((entry) => hosts.includes(entry.host)), []);
});

test("a failing search never writes the query to the log", async () => {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "stremio-addons-log-"));
  await initLogger(logDir);
  const network = searchAddon("log-network");
  const malformed = searchAddon("log-malformed");
  const unavailable = searchAddon("log-unavailable");

  await withStubbedAddons((url) => {
    const host = new URL(url).hostname;
    if (host === "log-network.example") {
      throw new Error("fetch failed https://log-network.example/catalog/movie/top/search=zz-sentinel-query.json");
    }
    if (host === "log-malformed.example") {
      return new Response("{not json", { headers: { "content-type": "application/json" } });
    }
    return statusJson(503);
  }, async () => {
    await searchAll([network, malformed, unavailable], "zz-sentinel-query", "movie");
  });
  await flushLog();

  const lines = await readFile(path.join(logDir, "app.log"), "utf8");
  assert.equal(lines.includes("zz-sentinel-query"), false);
  assert.match(lines, /"reason":"network"/);
  assert.match(lines, /"reason":"invalid-json"/);
  assert.match(lines, /"reason":"http-503"/);
});

test("fetchCatalogPage sends skip only when needed and fills the catalog type", async () => {
  const definition: CatalogDefinition = { type: "series", id: "top", extra: [{ name: "search" }] };
  const target = { addon: searchAddon("catalog", "series", "top"), definition };
  const requested: string[] = [];

  await withStubbedAddons((url) => {
    requested.push(url);
    return json({ metas: [{ id: "tt1", name: "One" }, { id: "tt2", type: "movie", name: "Two" }] });
  }, async () => {
    assert.deepEqual(await fetchCatalogPage(target, "needle", 0), [
      { id: "tt1", type: "series", name: "One" },
      { id: "tt2", type: "movie", name: "Two" },
    ]);
    assert.deepEqual(await fetchCatalogPage(target, "needle", 40), [
      { id: "tt1", type: "series", name: "One" },
      { id: "tt2", type: "movie", name: "Two" },
    ]);
  });

  assert.equal(requested[0]?.includes("search=needle"), true);
  assert.equal(requested[0]?.includes("skip="), false);
  assert.equal(requested[1]?.includes("skip=40"), true);
});

test("supportsSkip reads both spellings of catalog extras", () => {
  assert.equal(supportsSkip({ type: "movie", id: "top", extra: [{ name: "skip" }] }), true);
  assert.equal(supportsSkip({ type: "movie", id: "top", extraSupported: ["skip"] }), true);
  assert.equal(supportsSkip({ type: "movie", id: "top" }), false);
});

const subtitleAddon = (): AddonRecord => ({
  ...metaAddon("subs"),
  manifest: { id: "subs", name: "Subs", version: "1", resources: ["subtitles"], types: ["movie", "series"], idPrefixes: ["tt"] },
});

const prefixedMetaAddon = (): AddonRecord => ({
  ...metaAddon("sosac"),
  manifest: { id: "sosac", name: "Sosac", version: "1", resources: ["catalog", { name: "meta", types: ["movie", "series"], idPrefixes: ["mpa:"] }], idPrefixes: ["mpa:"] },
});

/** The subtitle addon answers for the id it was asked, so the test reads which one reached it. */
const subtitleStub = (calls: string[], imdb: Record<string, string>) => (url: string) => {
  calls.push(url);
  const meta = /\/meta\/(movie|series)\/(.+)\.json$/.exec(url);
  if (meta) {
    const id = decodeURIComponent(meta[2]!);
    return json({ meta: { id, type: meta[1], name: id, ...(imdb[id] ? { imdb_id: imdb[id] } : {}) } });
  }
  const asked = /\/subtitles\/(?:movie|series)\/(.+)\.json$/.exec(url);
  return json({ subtitles: asked ? [{ id: "s1", url: "https://subs.example/1.srt", lang: decodeURIComponent(asked[1]!) }] : [] });
};

test("a title of an addon with its own ids asks the subtitle addons under its IMDb id", async () => {
  const calls: string[] = [];
  await withStubbedAddons(subtitleStub(calls, { "mpa:sosac:abc": "tt0241527" }), async () => {
    const found = await subtitles([prefixedMetaAddon(), subtitleAddon()], "movie", "mpa:sosac:abc");
    assert.deepEqual(found.map((item) => item.lang), ["tt0241527"]);
  });
});

test("an episode of such an addon keeps its season and episode on the show's IMDb id", async () => {
  const calls: string[] = [];
  await withStubbedAddons(subtitleStub(calls, { "mpa:sosac-series:141": "tt0096697" }), async () => {
    const found = await subtitles([prefixedMetaAddon(), subtitleAddon()], "series", "mpa:sosac-series:141:3:7");
    assert.deepEqual(found.map((item) => item.lang), ["tt0096697:3:7"]);
  });
});

test("an IMDb id carried in the id itself needs no metadata request", async () => {
  const calls: string[] = [];
  await withStubbedAddons(subtitleStub(calls, {}), async () => {
    const found = await subtitles([prefixedMetaAddon(), subtitleAddon()], "series", "mpa:webshare-index:tt2709692:1:2");
    assert.deepEqual(found.map((item) => item.lang), ["tt2709692:1:2"]);
  });
  assert.ok(calls.every((url) => !url.includes("/meta/")), "no metadata request");
});

test("an id the subtitle addons already accept is asked as it is", async () => {
  const calls: string[] = [];
  await withStubbedAddons(subtitleStub(calls, {}), async () => {
    const found = await subtitles([prefixedMetaAddon(), subtitleAddon()], "series", "tt0096697:1:1");
    assert.deepEqual(found.map((item) => item.lang), ["tt0096697:1:1"]);
  });
  assert.equal(calls.length, 1);
});

test("a title whose metadata names no IMDb id asks no subtitle addon", async () => {
  const calls: string[] = [];
  await withStubbedAddons(subtitleStub(calls, {}), async () => {
    assert.deepEqual(await subtitles([prefixedMetaAddon(), subtitleAddon()], "movie", "mpa:sosac:none"), []);
  });
  assert.ok(calls.every((url) => !url.includes("/subtitles/")));
});

test("an addon answer past the size limit is cut off rather than read whole", async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  const total = 40 * chunk.byteLength;
  let pulled = 0;
  await withStubbedAddons(() => new Response(new ReadableStream({
    pull(controller) {
      if (pulled === 0) { controller.enqueue(new TextEncoder().encode('{"subtitles":[')); }
      if (pulled >= total) { controller.enqueue(new TextEncoder().encode("]}")); controller.close(); return; }
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }), { headers: { "content-type": "application/json" } }), async () => {
    assert.deepEqual(await subtitles([subtitleAddon()], "movie", "tt0241527"), []);
  });
  assert.ok(pulled < total / 2, `read ${pulled} bytes of ${total}`);
});
