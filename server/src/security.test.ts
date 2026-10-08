import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { privateAddressRefusal, publicAddon, publicAddonRestricted, redirectedHeaders, safeFetch, setDnsLookup, setFetchTransport, upstreamRequestHeaders, validateRemoteUrl } from "./security.js";
import { defaultDownloadSettings } from "./naming.js";
import type { AddonRecord } from "./types.js";

const source = new URL("https://provider.test/media");
const credentials = { Authorization: "Bearer secret", Cookie: "session=secret", "X-Api-Key": "secret", Referer: "https://provider.test/secret", Range: "bytes=10-20" };

type Lookup = NonNullable<Parameters<typeof setDnsLookup>[0]>;

/** A loopback server for the test's own traffic, counting the paths it was asked for. */
async function loopbackServer(handler: (path: string, response: ServerResponse) => void) {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? "");
    handler(request.url ?? "", response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    hits,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Test seam: answers each host from its list, repeating the last answer for later questions. */
function useLookup(t: TestContext, answers: Record<string, string[]>): void {
  const asked = new Map<string, number>();
  const lookup: Lookup = (hostname, options, callback) => {
    const list = answers[hostname] ?? ["127.0.0.1"];
    const index = Math.min(asked.get(hostname) ?? 0, list.length - 1);
    asked.set(hostname, (asked.get(hostname) ?? 0) + 1);
    const address = list[index]!;
    if (options.all) callback(null, [{ address, family: 4 }]);
    else callback(null, address, 4);
  };
  setDnsLookup(lookup);
  t.after(() => setDnsLookup());
}

const withEnv = (t: TestContext, name: string, value: string) => {
  process.env[name] = value;
  t.after(() => { delete process.env[name]; });
};

test("a name that rebinds between the check and the connection is refused without a request", async (t) => {
  const server = await loopbackServer((_path, response) => { response.writeHead(200); response.end("ok"); });
  t.after(server.close);
  useLookup(t, { "nas.example": ["93.184.216.34", "127.0.0.1"] });

  await assert.rejects(safeFetch(`http://nas.example:${server.port}/admin`), (error: { messageKey?: string }) => {
    assert.equal(error.messageKey, "err.privateAddon");
    return true;
  });
  assert.deepEqual(server.hits, [], "the connection must not be opened at all");
});

test("an address the allow list covers still reaches the local server", async (t) => {
  const server = await loopbackServer((_path, response) => { response.writeHead(200, { "content-type": "text/plain" }); response.end("ok"); });
  t.after(server.close);
  withEnv(t, "ALLOW_ADDON_HOSTS", "lan.example");
  useLookup(t, { "lan.example": ["127.0.0.1"] });

  const response = await safeFetch(`http://lan.example:${server.port}/manifest.json`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.deepEqual(server.hits, ["/manifest.json"]);
});

test("ALLOW_PRIVATE_ADDONS reaches a local server", async (t) => {
  const server = await loopbackServer((_path, response) => { response.writeHead(200); response.end("ok"); });
  t.after(server.close);
  withEnv(t, "ALLOW_PRIVATE_ADDONS", "1");
  useLookup(t, { "local.example": ["127.0.0.1"] });

  assert.equal((await safeFetch(`http://local.example:${server.port}/manifest.json`)).status, 200);
  assert.deepEqual(server.hits, ["/manifest.json"]);
});

test("a redirect to a name that rebinds is refused the same way", async (t) => {
  let port = 0;
  const server = await loopbackServer((path, response) => {
    if (path === "/start") {
      response.writeHead(302, { location: `http://nas.example:${port}/admin` });
      response.end();
      return;
    }
    response.writeHead(200);
    response.end("ok");
  });
  port = server.port;
  t.after(server.close);
  withEnv(t, "ALLOW_ADDON_HOSTS", "start.example");
  useLookup(t, { "start.example": ["127.0.0.1"], "nas.example": ["93.184.216.34", "127.0.0.1"] });

  await assert.rejects(safeFetch(`http://start.example:${port}/start`), (error: { messageKey?: string }) => {
    assert.equal(error.messageKey, "err.privateAddon");
    return true;
  });
  assert.deepEqual(server.hits, ["/start"]);
});

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
  setFetchTransport(async (_url, init) => {
    calls.push(new Headers(init.headers));
    if (calls.length === 3) return new Response("media");
    return new Response(new ReadableStream({ cancel() { canceled++; } }), {
      status: 302, headers: { location: calls.length === 1 ? "https://cdn.test/media" : source.href },
    });
  });
  t.after(() => setFetchTransport());
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
  t.after(() => setFetchTransport());
  for (const location of [undefined, "file:///secret", "https://cdn.test/loop"]) {
    let canceled = 0;
    setFetchTransport(async () => new Response(new ReadableStream({ cancel() { canceled++; } }), {
      status: 302, headers: location ? { location } : {},
    }));
    await assert.rejects(safeFetch(source.href, {}, 1));
    assert.equal(canceled, location === "https://cdn.test/loop" ? 2 : 1);
    setFetchTransport();
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
  assert.deepEqual(Object.keys(published).sort(), ["allowedUsers", "enabled", "essential", "globalSearch", "key", "manifest", "role", "showInContinueWatching", "showOnHome"]);
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
  assert.equal(published.showOnHome, true);
  assert.deepEqual(published.allowedUsers, [], "the grants are shown, as the library view shows visibleTo");
});

test("publicAddon still redacts the path but keeps downloadSettings", () => {
  const published = publicAddon(sampleAddon());
  assert.equal(published.displayUrl, "https://torrentio.strem.fun/…/manifest.json");
  assert.ok(published.downloadSettings);
  assert.equal(published.globalSearch, false);
  assert.equal(published.showInContinueWatching, true);
  assert.equal(published.showOnHome, true);
});

test("a private address is refused with a translatable message that names the way out", async () => {
  await assert.rejects(validateRemoteUrl("http://127.0.0.1:7000/manifest.json"), (error: { messageKey?: string; vars?: Record<string, string> }) => {
    assert.equal(error.messageKey, "err.privateAddon");
    assert.deepEqual(error.vars, { host: "127.0.0.1", address: "127.0.0.1" });
    return true;
  });
  const server = privateAddressRefusal("nas.local", "192.168.1.20", {});
  assert.match(server.message, /ALLOW_ADDON_HOSTS=nas\.local/);
});

test("the desktop app's own backend points at its switch, not at an environment it cannot edit", () => {
  const desktop = privateAddressRefusal("nas.local", "192.168.1.20", { DESKTOP_LOCAL_BACKEND: "1" });
  assert.equal(desktop.messageKey, "err.privateAddonDesktop");
  assert.deepEqual(desktop.vars, { host: "nas.local", address: "192.168.1.20" });
  assert.doesNotMatch(desktop.message, /ALLOW_/);
  assert.match(desktop.message, /Allow addons on my home network/);
});
