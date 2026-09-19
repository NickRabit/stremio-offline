import assert from "node:assert/strict";
import test from "node:test";
import { addonAllowed, addonMetadataLanguage, allowedAddons, metadata, searchableCatalogs, streamCandidates } from "./addons.js";
import type { Viewer } from "./libraries.js";
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
async function withStubbedAddons(handler: (url: string) => Response, run: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const originalFlag = process.env.ALLOW_PRIVATE_ADDONS;
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  globalThis.fetch = (async (url: string | URL | Request) => handler(String(url))) as typeof fetch;
  try { await run(); }
  finally {
    globalThis.fetch = originalFetch;
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
