import assert from "node:assert/strict";
import test from "node:test";
import { publicAddon, publicAddonRestricted, redirectedHeaders, safeFetch, upstreamRequestHeaders } from "./security.js";
import { defaultDownloadSettings } from "./naming.js";
import type { AddonRecord } from "./types.js";

const source = new URL("https://provider.test/media");
const credentials = { Authorization: "Bearer secret", Cookie: "session=secret", "X-Api-Key": "secret", Referer: "https://provider.test/secret", Range: "bytes=10-20" };

test("redirects preserve source headers only within the same origin", () => {
  assert.equal(redirectedHeaders(credentials, source, new URL("/next", source)).get("authorization"), "Bearer secret");
  for (const target of ["https://cdn.test/media", "http://provider.test/media", "https://provider.test:444/media"]) {
    assert.deepEqual(Object.fromEntries(redirectedHeaders(credentials, source, new URL(target))), { range: "bytes=10-20" });
  }
});

test("redirect bodies are canceled and credentials cannot return after an origin change", async (t) => {
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  t.after(() => { delete process.env.ALLOW_PRIVATE_ADDONS; });
  let canceled = 0;
  const calls: Headers[] = [];
  t.mock.method(globalThis, "fetch", async (_url: URL, init: RequestInit) => {
    calls.push(new Headers(init.headers));
    if (calls.length === 3) return new Response("media");
    return new Response(new ReadableStream({ cancel() { canceled++; } }), {
      status: 302, headers: { location: calls.length === 1 ? "https://cdn.test/media" : source.href },
    });
  });
  const response = await safeFetch(source.href, { headers: credentials });
  assert.equal(await response.text(), "media");
  assert.equal(canceled, 2);
  assert.equal(upstreamRequestHeaders(response).get("authorization"), null);
  assert.equal(calls[0].get("authorization"), "Bearer secret");
  assert.equal(calls[1].get("authorization"), null);
  assert.equal(calls[2].get("authorization"), null);
  assert.equal(calls[2].get("range"), "bytes=10-20");
});

test("invalid, missing and excessive redirects cancel their bodies before failing", async (t) => {
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  t.after(() => { delete process.env.ALLOW_PRIVATE_ADDONS; });
  for (const location of [undefined, "file:///secret", "https://cdn.test/loop"]) {
    let canceled = 0;
    const mock = t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ cancel() { canceled++; } }), {
      status: 302, headers: location ? { location } : {},
    }));
    await assert.rejects(safeFetch(source.href, {}, 1));
    assert.equal(canceled, location === "https://cdn.test/loop" ? 2 : 1);
    mock.mock.restore();
  }
});

const sampleAddon = (): AddonRecord => ({
  key: "abc",
  manifestUrl: "https://torrentio.strem.fun/secret-token/manifest.json",
  role: "source",
  enabled: true,
  globalSearch: false,
  addedAt: "2026-01-01T00:00:00.000Z",
  downloadSettings: defaultDownloadSettings(),
  manifest: {
    id: "com.torrentio",
    name: "Torrentio",
    version: "1.2.3",
    description: "Streams",
    logo: "https://torrentio.strem.fun/logo.png",
    resources: ["stream", { name: "catalog", types: ["movie"] }],
    types: ["movie"],
    idPrefixes: ["tt"],
    catalogs: [{ type: "movie", id: "top" }],
    behaviorHints: { configurable: true, configurationRequired: true, p2p: true },
  },
});

test("publicAddonRestricted is an allowlist and drops token-adjacent fields", () => {
  const addon = sampleAddon();
  (addon.manifest as { extra?: string }).extra = "should-not-leak";
  const published = publicAddonRestricted(addon);
  assert.deepEqual(Object.keys(published).sort(), ["enabled", "essential", "globalSearch", "key", "manifest", "role", "showInContinueWatching"]);
  assert.deepEqual(Object.keys(published.manifest).sort(), ["behaviorHints", "description", "id", "logo", "name", "resources", "version"]);
  assert.equal("displayUrl" in published, false);
  assert.equal("downloadSettings" in published, false);
  assert.equal("addedAt" in published, false);
  assert.equal("configurable" in published, false);
  assert.equal("extra" in published.manifest, false);
  assert.equal("catalogs" in published.manifest, false);
  assert.deepEqual(published.manifest.resources, ["stream", { name: "catalog" }]);
  assert.deepEqual(published.manifest.behaviorHints, { p2p: true });
  assert.equal(published.manifest.logo, "https://torrentio.strem.fun/logo.png");
  assert.equal(published.globalSearch, false);
  assert.equal(published.showInContinueWatching, true);
});

test("publicAddon still redacts the path but keeps downloadSettings", () => {
  const published = publicAddon(sampleAddon());
  assert.equal(published.displayUrl, "https://torrentio.strem.fun/…/manifest.json");
  assert.ok(published.downloadSettings);
  assert.equal(published.globalSearch, false);
  assert.equal(published.showInContinueWatching, true);
});
