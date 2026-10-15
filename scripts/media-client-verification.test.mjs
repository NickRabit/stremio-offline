/**
 * Unit tests for the media-client verification harness. They exercise the
 * exported behaviour of the fixtures -- validation, the observed proxy, the
 * generated provider -- against real loopback HTTP servers, never against the
 * application itself, so they need neither a build nor a provider.
 *
 * Run with: node --test scripts/media-client-verification.test.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FIXTURE_LANE,
  FixtureError,
  classifyUpstreamRequest,
  createAppClient,
  createObservedProxy,
  createSyntheticProvider,
  disposableAppEnv,
  isLoopbackHost,
  labelHash,
  mutationKind,
  parseRunnerArgs,
  parseUpstreamUrl,
  readBounded,
  startDisposableApp,
  validateFixtureConfig,
} from "./media-client-verification-fixtures.mjs";
import { assertReportSafe, BROWSE_LIMIT, RUNNER_FACTS, createFixtureClient, verifySidecar, classifyContentProbe, playlistChildren, rangeProbe } from "./media-client-verification.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** Start a loopback origin with the given handler and stop it afterwards. */
async function withUpstream(handler, run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      handler(req, res, Buffer.concat(chunks));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    return await run({ baseUrl: `http://127.0.0.1:${port}`, requests });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

const fixture = (body) => new TextEncoder().encode(body);

const mediaBuffer = Buffer.alloc(4096, 7);

/** A provider shape for the proxy tests: metadata, a range-capable file, redirects
 *  and two fault statuses. */
const providerHandler = (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/System/Info/Public") return json(res, 200, { Id: "srv", Version: "12.2.0" });
  if (url.pathname === "/Users/AuthenticateByName") return json(res, 200, { User: { Id: "u1" }, AccessToken: "fixture-token" });
  if (url.pathname === "/Users/u1/Items") return json(res, 200, { Items: [], TotalRecordCount: 0 });
  if (url.pathname === "/Videos/i1/stream") {
    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      const from = Number(match[1]);
      const until = match[2] ? Number(match[2]) : mediaBuffer.length - 1;
      const slice = mediaBuffer.subarray(from, until + 1);
      res.statusCode = 206;
      res.setHeader("content-type", "video/mp4");
      res.setHeader("content-range", `bytes ${from}-${from + slice.length - 1}/${mediaBuffer.length}`);
      res.setHeader("content-length", String(slice.length));
      res.setHeader("accept-ranges", "bytes");
      return res.end(slice);
    }
    res.statusCode = 200;
    res.setHeader("content-type", "video/mp4");
    res.setHeader("content-length", String(mediaBuffer.length));
    return res.end(mediaBuffer);
  }
  if (url.pathname === "/redirect") {
    res.statusCode = 302;
    res.setHeader("location", "http://127.0.0.1/nowhere");
    return res.end();
  }
  return json(res, 404, { error: "no such route" });
};

const waitFor = async (predicate, { timeoutMs = 2_000, intervalMs = 5 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

test("the command line rejects anything it cannot run", () => {
  assert.equal(parseRunnerArgs(["--help"]).mode, "help");
  assert.equal(parseRunnerArgs(["--synthetic", "--output", "/tmp/r.json"]).mode, "synthetic");
  const fixtureArgs = parseRunnerArgs(["--fixture", "/tmp/f.json", "--output", "/tmp/r.json"]);
  assert.equal(fixtureArgs.fixturePath, "/tmp/f.json");

  assert.throws(() => parseRunnerArgs(["--output", "/tmp/r.json"]), FixtureError);
  assert.throws(() => parseRunnerArgs(["--synthetic"]), /--output/);
  assert.throws(() => parseRunnerArgs(["--fixture", "/tmp/f.json", "--synthetic", "--output", "/tmp/r.json"]), /unexpected|--fixture|unknown/);
  assert.throws(() => parseRunnerArgs(["--synthetic", "--output", "/tmp/r.json", "--items", "0"]), /--items/);
  assert.throws(() => parseRunnerArgs(["--synthetic", "--output", "/tmp/r.json", "--items", "100001"]), /--items/);
  assert.throws(() => parseRunnerArgs(["--synthetic", "--output", "/tmp/r.json", "--pages", "9999"]), /--pages/);
  assert.throws(() => parseRunnerArgs(["--synthetic", "--output", "/tmp/r.json", "--delay-ms", "9999999"]), /--delay-ms/);
  assert.throws(() => parseRunnerArgs(["--live", "--output", "/tmp/r.json"]), /unknown flag/);
  assert.throws(() => parseRunnerArgs(["--synthetic", "--output"]), /--output needs a value/);
});

test("only a loopback origin without credentials is accepted", () => {
  assert.equal(parseUpstreamUrl("http://127.0.0.1:8096", "url"), "http://127.0.0.1:8096");
  assert.equal(parseUpstreamUrl("https://localhost:8920/jellyfin/", "url"), "https://localhost:8920/jellyfin");
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("10.0.0.5"), false);

  assert.throws(() => parseUpstreamUrl("http://192.168.1.4:8096", "url"), /loopback/);
  assert.throws(() => parseUpstreamUrl("http://user:secret@127.0.0.1:8096", "url"), /credentials/);
  assert.throws(() => parseUpstreamUrl("ftp://127.0.0.1", "url"), /http/);
  assert.throws(() => parseUpstreamUrl("http://127.0.0.1:8096?a=1", "url"), /query/);
  assert.throws(() => parseUpstreamUrl("", "url"), /required/);
});

test("a private fixture file is validated before anything is contacted", () => {
  const good = validateFixtureConfig({
    providers: [{ provider: "jellyfin", baseUrl: "http://127.0.0.1:8096", username: "u", password: "p", itemIds: ["a", "b"] }],
  });
  assert.equal(good.providers.length, 1);
  assert.deepEqual(good.providers[0].itemIds, ["a", "b"]);

  assert.throws(() => validateFixtureConfig({ providers: [] }), /at least one provider/);
  assert.throws(() => validateFixtureConfig({ providers: [{ provider: "plex", baseUrl: "http://127.0.0.1:1", username: "u", password: "p", itemIds: ["a"] }] }), /jellyfin or emby/);
  assert.throws(() => validateFixtureConfig({ providers: [{ provider: "emby", baseUrl: "http://10.1.1.1:8096", username: "u", password: "p", itemIds: ["a"] }] }), /loopback/);
  assert.throws(() => validateFixtureConfig({ providers: [{ provider: "emby", baseUrl: "http://127.0.0.1:1", username: "u", password: "p", itemIds: [] }] }), /item ids/);
  assert.throws(() => validateFixtureConfig({ providers: [{ provider: "emby", baseUrl: "http://127.0.0.1:1", username: "u", password: "p" }] }), /item ids/);
  assert.throws(() => validateFixtureConfig("not json"), SyntaxError);
});

test("the observer classifies the provider wire and refuses mutations", () => {
  assert.deepEqual(classifyUpstreamRequest({ method: "GET", path: "/System/Info/Public" }), { category: "info", allowed: true });
  assert.deepEqual(classifyUpstreamRequest({ method: "GET", path: "/Users/u1/Views" }), { category: "views", allowed: true });
  assert.deepEqual(classifyUpstreamRequest({ method: "GET", path: "/Users/u1/Items" }), { category: "listing", allowed: true });
  assert.deepEqual(classifyUpstreamRequest({ method: "GET", path: "/Users/u1/Items", search: "AnyProviderIdEquals=imdb.tt1" }), { category: "match", allowed: true });
  assert.deepEqual(classifyUpstreamRequest({ method: "GET", path: "/Users/u1/Items/i1" }), { category: "detail", allowed: true });
  assert.deepEqual(classifyUpstreamRequest({ method: "GET", path: "/Items/i1/Ancestors" }), { category: "ancestors", allowed: true });
  assert.deepEqual(classifyUpstreamRequest({ method: "GET", path: "/Items/i1/PlaybackInfo" }), { category: "versions", allowed: true });
  assert.deepEqual(classifyUpstreamRequest({ method: "GET", path: "/Videos/i1/stream" }), { category: "original", allowed: true });
  assert.deepEqual(classifyUpstreamRequest({ method: "GET", path: "/Videos/i1/s1/Subtitles/2/Stream.srt" }), { category: "subtitle", allowed: true });
  assert.deepEqual(classifyUpstreamRequest({ method: "HEAD", path: "/Videos/i1/stream" }), { category: "original", allowed: true });
  assert.equal(classifyUpstreamRequest({ method: "POST", path: "/Users/AuthenticateByName" }).allowed, true);

  const playing = classifyUpstreamRequest({ method: "POST", path: "/Sessions/Playing/Progress" });
  assert.equal(playing.allowed, false);
  assert.equal(playing.mutation, "sessions");
  assert.equal(classifyUpstreamRequest({ method: "POST", path: "/Users/u1/PlayedItems/i1" }).mutation, "userdata");
  assert.equal(classifyUpstreamRequest({ method: "POST", path: "/Users/u1/FavoriteItems/i1" }).mutation, "userdata");
  assert.equal(classifyUpstreamRequest({ method: "DELETE", path: "/Users/u1/Items/i1/UserData" }).mutation, "userdata");
  assert.equal(classifyUpstreamRequest({ method: "POST", path: "/Library/Refresh" }).mutation, "refresh");
  assert.equal(mutationKind("/System/Configuration"), "system");
  assert.equal(mutationKind("/Users/New"), "users");
});

test("the observer relays a mutation as a refusal and never dials upstream", async () => {
  await withUpstream(providerHandler, async ({ baseUrl, requests }) => {
    const observer = await createObservedProxy({ upstream: baseUrl });
    try {
      const response = await fetch(`${observer.baseUrl}/Sessions/Playing`, { method: "POST", body: "{}" });
      assert.equal(response.status, 405);
      await response.arrayBuffer();
      assert.equal(requests.length, 0, "the refusal must not reach the provider");
      const stats = observer.stats();
      assert.equal(stats.app.prohibited.refused, 1);
      assert.equal(stats.refused.sessions, 1);
      assert.equal(observer.counters("prohibited").starts, 1);
      assert.equal(observer.counters("prohibited").inFlight, 0, "no listener may be left behind");
    } finally {
      await observer.close();
    }
  });
});

test("the observer relays metadata and preserves a ranged body byte for byte", async () => {
  await withUpstream(providerHandler, async ({ baseUrl, requests }) => {
    const observer = await createObservedProxy({ upstream: baseUrl });
    try {
      const info = await fetch(`${observer.baseUrl}/System/Info/Public`);
      assert.equal(info.status, 200);
      assert.equal((await info.json()).Id, "srv");

      const ranged = await fetch(`${observer.baseUrl}/Videos/i1/stream`, { headers: { range: "bytes=100-299" } });
      assert.equal(ranged.status, 206);
      assert.equal(ranged.headers.get("content-range"), "bytes 100-299/4096");
      assert.equal(ranged.headers.get("content-length"), "200");
      const bytes = Buffer.from(await ranged.arrayBuffer());
      assert.equal(bytes.length, 200);
      assert.equal(sha256(bytes), sha256(mediaBuffer.subarray(100, 300)));

      const stats = observer.stats();
      assert.equal(stats.app.info.starts, 1);
      assert.equal(stats.app.original.completions, 1);
      assert.equal(stats.app.original.bytes, 200);
      assert.equal(stats.app.original.inFlight, 0);
      assert.equal(stats.app.original.inFlightPeak, 1);
      assert.equal(requests.length, 2);
    } finally {
      await observer.close();
    }
  });
});

test("the observer never follows a redirect and keeps its status", async () => {
  await withUpstream(providerHandler, async ({ baseUrl, requests }) => {
    const observer = await createObservedProxy({ upstream: baseUrl });
    try {
      const response = await fetch(`${observer.baseUrl}/redirect`, { redirect: "manual" });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "http://127.0.0.1/nowhere");
      assert.equal(requests.length, 1);
      assert.equal(observer.counters("other").redirects, 1);
    } finally {
      await observer.close();
    }
  });
});

test("an aborted delayed request never starts its upstream", async () => {
  await withUpstream(providerHandler, async ({ baseUrl, requests }) => {
    const observer = await createObservedProxy({ upstream: baseUrl });
    try {
      observer.setLatency("original", 5_000);
      const controller = new AbortController();
      const pending = fetch(`${observer.baseUrl}/Videos/i1/stream`, { signal: controller.signal }).catch(() => undefined);
      assert.equal(await waitFor(() => observer.counters("original").delayed > 0), true);
      controller.abort(new Error("client left"));
      await pending;
      assert.equal(await waitFor(() => observer.counters("original").inFlight === 0), true);
      const counters = observer.counters("original");
      assert.equal(counters.aborts, 1);
      assert.equal(counters.delayedAborted, 1);
      assert.equal(observer.stats().upstreamDials.original ?? 0, 0);
      assert.equal(requests.length, 0, "an abandoned delay must not reach the provider");
    } finally {
      await observer.close();
    }
  });
});

test("a client that disconnects mid-body is cleaned up exactly once", async () => {
  await withUpstream((req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "video/mp4");
    // A body that never ends: only the client can stop this transfer.
    const chunk = Buffer.alloc(65_536, 3);
    const pump = () => {
      if (res.writableEnded || res.destroyed) return;
      if (res.write(chunk)) setTimeout(pump, 5);
      else res.once("drain", pump);
    };
    pump();
  }, async ({ baseUrl }) => {
    const observer = await createObservedProxy({ upstream: baseUrl });
    try {
      const controller = new AbortController();
      const response = await fetch(`${observer.baseUrl}/Videos/i1/stream`, { signal: controller.signal });
      await response.body.getReader().read();
      controller.abort(new Error("client left"));
      assert.equal(await waitFor(() => observer.counters("original").inFlight === 0), true);
      const counters = observer.counters("original");
      assert.equal(counters.starts, 1);
      assert.equal(counters.completions, 0);
      assert.equal(counters.aborts, 1);
      assert.equal(observer.pending(), 0);
    } finally {
      await observer.close();
    }
  });
});

test("finite faults are served once and then disappear", async () => {
  await withUpstream(providerHandler, async ({ baseUrl }) => {
    const observer = await createObservedProxy({ upstream: baseUrl });
    try {
      observer.armFault("versions", { kind: "status", status: 503, times: 1 });
      const faulted = await fetch(`${observer.baseUrl}/Items/i1/PlaybackInfo`);
      assert.equal(faulted.status, 503);
      await faulted.arrayBuffer();
      const restored = await fetch(`${observer.baseUrl}/Items/i1/PlaybackInfo`);
      assert.equal(restored.status, 404, "the fixture origin answers its own 404 after the fault is spent");
      await restored.arrayBuffer();
      const dials = observer.stats().upstreamDials.versions ?? 0;
      assert.equal(dials, 1, "the fault itself never dials upstream");
      assert.equal(observer.counters("versions").starts, 2);

      observer.armFault("listing", { kind: "status", status: 429, retryAfterSeconds: 5, times: 1 });
      const limited = await fetch(`${observer.baseUrl}/Users/u1/Items`);
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "5");
      await limited.arrayBuffer();

      observer.armFault("original", { kind: "drop", times: 1 });
      await assert.rejects(fetch(`${observer.baseUrl}/Videos/i1/stream`));
      const after = await fetch(`${observer.baseUrl}/Videos/i1/stream`);
      assert.equal(after.status, 200);
      await after.arrayBuffer();
      assert.deepEqual(observer.stats().faultsServed, { "versions:status": 1, "listing:status": 1, "original:drop": 1 });
    } finally {
      await observer.close();
    }
  });
});

test("the fixture lane is counted apart from the application's own reads", async () => {
  await withUpstream(providerHandler, async ({ baseUrl }) => {
    const observer = await createObservedProxy({ upstream: baseUrl });
    try {
      const mine = await fetch(`${observer.baseUrl}/Items/i1/PlaybackInfo`, { headers: { "x-mcv-lane": FIXTURE_LANE } });
      await mine.arrayBuffer();
      const stats = observer.stats();
      assert.equal(stats.fixture.versions.starts, 1);
      assert.equal(stats.app.versions, undefined, "the application's own counters stay untouched");
    } finally {
      await observer.close();
    }
  });
});

test("the recorded event tail is bounded", async () => {
  await withUpstream(providerHandler, async ({ baseUrl }) => {
    const observer = await createObservedProxy({ upstream: baseUrl, maxEvents: 3 });
    try {
      for (let index = 0; index < 6; index += 1) {
        const response = await fetch(`${observer.baseUrl}/System/Info/Public`);
        await response.arrayBuffer();
      }
      assert.equal(observer.stats().events.length, 3);
      assert.equal(observer.counters("info").starts, 6);
    } finally {
      await observer.close();
    }
  });
});

test("closing the observer is idempotent and ends in-flight work", async () => {
  await withUpstream((req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.flushHeaders();
    // Never completes: the observer has to break it up on close.
  }, async ({ baseUrl }) => {
    const observer = await createObservedProxy({ upstream: baseUrl });
    const controller = new AbortController();
    const pending = fetch(`${observer.baseUrl}/System/Info/Public`, { signal: controller.signal }).catch(() => undefined);
    assert.equal(await waitFor(() => observer.counters("info").inFlight === 1), true);
    await observer.close();
    await observer.close();
    controller.abort();
    await pending;
    assert.equal(observer.pending(), 0);
  });
});

test("the synthetic provider answers the real protocol one page at a time", async () => {
  const provider = await createSyntheticProvider({ items: 1_234, folders: 3 });
  try {
    const info = await fetch(`${provider.baseUrl}/System/Info/Public`);
    assert.equal((await info.json()).Id, provider.serverId);

    const login = await fetch(`${provider.baseUrl}/Users/AuthenticateByName`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Username: provider.username, Pw: provider.password }),
    });
    assert.equal(login.status, 200);
    const session = await login.json();
    assert.equal(session.User.Id, provider.accountId);

    const views = await fetch(`${provider.baseUrl}/Users/${provider.accountId}/Views`);
    const libraries = (await views.json()).Items;
    assert.equal(libraries.length, 1);
    assert.equal(libraries[0].CollectionType, "", "a folder catalogue advertises the mixed layout");

    const first = await fetch(`${provider.baseUrl}/Users/${provider.accountId}/Items?ParentId=${provider.libraryId}&Recursive=false&StartIndex=0&Limit=60&EnableTotalRecordCount=true`);
    const firstPage = await first.json();
    assert.equal(firstPage.Items.length, 3);
    assert.equal(firstPage.Items[0].Type, "Folder");
    assert.equal(firstPage.TotalRecordCount, 3);

    const titles = await fetch(`${provider.baseUrl}/Users/${provider.accountId}/Items?ParentId=${provider.libraryId}&Recursive=true&StartIndex=60&Limit=60&EnableTotalRecordCount=false`);
    const titlePage = await titles.json();
    assert.equal(titlePage.Items.length, 60);
    assert.equal(titlePage.Items[0].Id, "item-0000060");
    assert.equal(titlePage.TotalRecordCount, undefined, "a continuation carries no count of its own");

    const counted = await fetch(`${provider.baseUrl}/Users/${provider.accountId}/Items?ParentId=${provider.libraryId}&Recursive=true&StartIndex=60&Limit=60`);
    assert.equal((await counted.json()).TotalRecordCount, 1_234, "a server that is asked for the count answers it");

    const last = await fetch(`${provider.baseUrl}/Users/${provider.accountId}/Items?ParentId=${provider.libraryId}&Recursive=true&StartIndex=1200&Limit=60`);
    const lastPage = await last.json();
    assert.equal(lastPage.Items.length, 34);
    assert.equal(lastPage.Items.at(-1).Id, "item-0001233");

    const stats = provider.stats();
    assert.equal(stats.pages, 4);
    assert.equal(stats.itemsFetched, 3 + 60 + 60 + 34);
    assert.ok(stats.pageSizes.every((size) => size <= 200));
    assert.equal(stats.details, 0, "a listing never reads a detail");
  } finally {
    await provider.close();
  }
});

test("the synthetic provider bounds an upstream page size and refuses mutations", async () => {
  const provider = await createSyntheticProvider({ items: 100, folders: 0 });
  try {
    const huge = await fetch(`${provider.baseUrl}/Users/${provider.accountId}/Items?ParentId=${provider.libraryId}&Recursive=true&StartIndex=0&Limit=5000`);
    const body = await huge.json();
    assert.ok(body.Items.length <= 200, "a page size above the transport bound is clamped");
    assert.equal(Math.max(...provider.stats().pageSizes), 200);
    const mutation = await fetch(`${provider.baseUrl}/Sessions/Playing`, { method: "POST", body: "{}" });
    assert.equal(mutation.status, 405);
    const search = await fetch(`${provider.baseUrl}/Users/${provider.accountId}/Items?ParentId=${provider.libraryId}&Recursive=true&StartIndex=0&Limit=10&SearchTerm=title%2042`);
    const searched = await search.json();
    assert.equal(searched.TotalRecordCount, 1);
    assert.equal(searched.Items[0].Id, "item-0000041");
    assert.equal(provider.stats().unexpected, 1);
  } finally {
    await provider.close();
  }
});

test("a hundred thousand item catalogue is answered page by page", async () => {
  const provider = await createSyntheticProvider({ items: 100_000, folders: 0 });
  try {
    const response = await fetch(`${provider.baseUrl}/Users/${provider.accountId}/Items?ParentId=${provider.libraryId}&Recursive=true&StartIndex=99940&Limit=60&EnableTotalRecordCount=true`);
    const body = await response.json();
    assert.equal(body.TotalRecordCount, 100_000);
    assert.equal(body.Items.length, 60);
    assert.equal(body.Items.at(-1).Id, "item-0099999");
    assert.equal(provider.stats().itemsFetched, 60, "only the requested page is ever built");
  } finally {
    await provider.close();
  }
});

test("readBounded stops at its cap and says so", async () => {
  await withUpstream((req, res) => {
    res.statusCode = 200;
    res.end(Buffer.alloc(1_000, 1));
  }, async ({ baseUrl }) => {
    const response = await fetch(baseUrl);
    const bounded = await readBounded(response, 128);
    assert.equal(bounded.bytes.length, 128);
    assert.equal(bounded.truncated, true);
    const whole = await readBounded(await fetch(baseUrl), 4_096);
    assert.equal(whole.bytes.length, 1_000);
    assert.equal(whole.truncated, false);
  });
});

test("a report carrying an address or a session name is refused", () => {
  const clean = { checks: [{ id: "a.b", status: "pass", detail: { status: 200, bytes: 12 } }], ok: true };
  assert.deepEqual(assertReportSafe(clean), clean);
  assert.throws(() => assertReportSafe({ detail: { upstream: "http://127.0.0.1:8096" } }), /address/);
  assert.throws(() => assertReportSafe({ detail: { note: "the cookie was kept" } }), /cookie/);
  assert.throws(() => assertReportSafe({ detail: { header: "Path=/" } }), /attribute/);
  assert.equal(labelHash("a-secret-upstream-id").length, 12);
  assert.notEqual(labelHash("a"), labelHash("b"));
});

test("the runner's documented contract stays in step with its constants", () => {
  assert.equal(BROWSE_LIMIT, 60);
  assert.equal(RUNNER_FACTS, "HTTP-level evidence; media and history are never written upstream");
});

test("a converted playlist's children resolve the way a player resolves them", () => {
  const master = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Titulky",DEFAULT=YES,AUTOSELECT=YES,URI="index-0_vtt.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=8000000,SUBTITLES="subs"',
    "index-0.m3u8",
  ].join("\n");
  const masterChildren = playlistChildren(master, "http://127.0.0.1:1/api/playback/session-1/0/master.m3u8");
  assert.equal(masterChildren.variant, "/api/playback/session-1/0/index-0.m3u8");
  assert.equal(masterChildren.segment, undefined, "a master playlist names no media of its own");

  const variant = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    '#EXT-X-MAP:URI="init.mp4"',
    "#EXTINF:2.000000,",
    "seg-0-000000.m4s",
    "#EXTINF:2.000000,",
    "seg-0-000001.m4s",
  ].join("\n");
  const variantChildren = playlistChildren(variant, "http://127.0.0.1:1/api/playback/session-1/0/index-0.m3u8");
  assert.equal(variantChildren.variant, undefined);
  assert.equal(variantChildren.segment, "/api/playback/session-1/0/seg-0-000000.m4s");
  assert.equal(playlistChildren('#EXT-X-MAP:URI="init.mp4"\nseg.mp4', "http://127.0.0.1:1/a/b.m3u8").init, "/a/init.mp4");
  assert.equal(playlistChildren("#EXTM3U\n", "http://127.0.0.1:1/a/b.m3u8").segment, undefined, "an empty playlist proves nothing");
});

test("the content check asks for a nonzero range only where one exists", () => {
  const big = rangeProbe(40_000_000);
  assert.equal(big.nonzero, true);
  assert.equal(big.offset, 1_000_000, "the probe never walks deeper than a megabyte in");
  assert.equal(big.window, 65_536);
  const medium = rangeProbe(100_000);
  assert.equal(medium.offset, 50_000);
  assert.equal(medium.window, 50_000);
  const small = rangeProbe(3_000);
  assert.equal(small.nonzero, false);
  assert.equal(small.range, "bytes=0-2999");
  const unknown = rangeProbe(Number.NaN);
  assert.equal(unknown.offset, 0);
  assert.equal(unknown.window, 65_536);
});

test("a ranged content comparison passes only on the same nonzero range", () => {
  const bytes = Buffer.from("the provider's own bytes for this range");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const good = {
    requestedRange: "bytes=100-149",
    responseStatus: 206,
    responseRange: "bytes 100-149/900",
    responseBytes: 50,
    providerStatus: 206,
    providerRange: "bytes 100-149/900",
    providerBytes: 50,
    providerHash: hash,
    responseHash: hash,
  };
  assert.equal(classifyContentProbe(good).status, "pass");

  // An answer without a range proves nothing about the offsets.
  assert.equal(classifyContentProbe({ ...good, responseStatus: 200, responseRange: null }).status, "fail");
  assert.equal(classifyContentProbe({ ...good, responseRange: null }).status, "fail");
  // The provider's own Content-Range has to agree, total included; an unknown total
  // is only equal to an unknown total.
  assert.equal(classifyContentProbe({ ...good, responseRange: "bytes 100-149/*" }).status, "fail");
  assert.equal(classifyContentProbe({ ...good, responseRange: "bytes 100-149/*", providerRange: "bytes 100-149/*" }).status, "pass");
  assert.equal(classifyContentProbe({ ...good, responseStatus: 502, responseRange: null }).status, "fail");
  // A different window than the one asked for, or a length that disagrees with it.
  assert.equal(classifyContentProbe({ ...good, responseRange: "bytes 0-49/900" }).status, "fail");
  assert.equal(classifyContentProbe({ ...good, responseBytes: 49 }).status, "fail");
  // Anything that cannot be compared is unmeasured, never a pass.
  assert.equal(classifyContentProbe({ ...good, providerStatus: undefined, providerRange: undefined, providerBytes: undefined, providerHash: undefined }).status, "unmeasured");
  assert.equal(classifyContentProbe({ ...good, providerStatus: 0 }).status, "fail");
  assert.equal(classifyContentProbe({ ...good, providerStatus: 200, providerRange: null }).status, "fail");
  assert.equal(classifyContentProbe({ ...good, providerRange: "bytes 100-149/901" }).status, "fail");
  assert.equal(classifyContentProbe({ ...good, providerBytes: 49 }).status, "fail");
  assert.equal(classifyContentProbe({ ...good, providerHash: "0".repeat(64) }).status, "fail");
  // A resource too small for a nonzero range is served correctly and proves nothing.
  assert.equal(classifyContentProbe({ ...good, requestedRange: "bytes=0-19", responseRange: "bytes 0-19/20", responseBytes: 20, providerRange: "bytes 0-19/20", providerBytes: 20 }).status, "unmeasured");
  assert.equal(classifyContentProbe({ ...good, requestedRange: "bytes=5-" }).status, "fail");
});

test("a stalled application body is cut off at its own deadline", async () => {
  await withUpstream((req, res) => {
    if (req.url === "/stall") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/octet-stream");
      res.flushHeaders();
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/octet-stream");
    res.end(Buffer.alloc(64, 5));
  }, async ({ baseUrl }) => {
    const client = createAppClient(baseUrl);
    const bounded = await client.bytes("/body", { maxBytes: 8, timeoutMs: 500 });
    assert.equal(bounded.status, 200);
    assert.equal(bounded.bytes.length, 8, "the read stops at its cap");
    assert.equal(bounded.truncated, true);

    const started = Date.now();
    await assert.rejects(client.bytes("/stall", { timeoutMs: 300 }), "a body that never arrives is an error, not a hang");
    assert.ok(Date.now() - started < 4_000, "the deadline ends the read");

    const again = await client.bytes("/body", { maxBytes: 64, timeoutMs: 500 });
    assert.equal(again.bytes.length, 64, "the next call is unaffected by the one that timed out");
  });
});

test("the observer cuts off an upstream that answers and then stalls", async () => {
  await withUpstream((req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("content-length", "4096");
    res.flushHeaders();
  }, async ({ baseUrl }) => {
    const observer = await createObservedProxy({ upstream: baseUrl, upstreamDeadlineMs: 1_000 });
    try {
      const started = Date.now();
      const response = await fetch(`${observer.baseUrl}/Users/u1/Items`);
      // The observer relays the head together with the first body byte, so a body
      // that never starts arrives as the observer's own 502 -- with a body that
      // matches it, rather than the upstream's unfulfilled length. What it must not
      // do is hang.
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error.length > 0, true);
      assert.ok(Date.now() - started < 5_000, `the deadline must end the exchange (${Date.now() - started}ms)`);
      assert.equal(await waitFor(() => observer.counters("listing").inFlight === 0), true);
      assert.equal(observer.pending(), 0, "the deadline leaves nothing in flight");
      assert.ok(observer.counters("listing").failures >= 1, "a cut-off exchange is counted as a failure");
    } finally {
      await observer.close();
    }
  });
});

test("the disposable child inherits only the platform environment", () => {
  const parent = {
    PATH: "/usr/bin:/bin",
    TMPDIR: "/var/folders/tmp",
    HOME: "/Users/somebody",
    MEDIA_SERVER_KEY_FILE: "/Users/somebody/install/media-server.key",
    LIBRARY_ROOTS: "/Users/somebody/Media",
    ADMIN_PASSWORD: "an-operator-secret",
    DATA_DIR: "/Users/somebody/install/data",
    DOWNLOAD_DIR: "/Users/somebody/Downloads",
    IMAGE_CACHE_MB: "256",
    ALLOW_PRIVATE_ADDONS: "1",
    HOST_CHECK: "published",
    RESTRICTED_MODE: "1",
  };
  const { env, stripped } = disposableAppEnv({ PORT: "1234", DATA_DIR: "/tmp/owned/data" }, parent);
  assert.equal(env.PATH, "/usr/bin:/bin", "the platform needs its own PATH");
  assert.equal(env.TMPDIR, "/var/folders/tmp");
  assert.equal(env.HOME, undefined, "no user home reaches the child");
  assert.equal(env.DATA_DIR, "/tmp/owned/data", "the run decides, not the parent");
  for (const name of ["MEDIA_SERVER_KEY_FILE", "LIBRARY_ROOTS", "ADMIN_PASSWORD", "DOWNLOAD_DIR", "IMAGE_CACHE_MB", "ALLOW_PRIVATE_ADDONS", "HOST_CHECK", "RESTRICTED_MODE"]) {
    assert.equal(env[name], undefined, `${name} must not be inherited`);
    assert.ok(stripped.includes(name), `${name} is recorded as stripped`);
  }
  assert.ok(!stripped.includes("PATH"), "a platform variable is not app-sensitive");
  assert.ok(!Object.values(env).includes("an-operator-secret"), "no value travels through the record");
});

test("a disposable application uses its own key and roots and leaves nothing behind", async (t) => {
  if (!existsSync(path.join(repoRoot, "server", "dist", "index.js")) || !existsSync(path.join(repoRoot, "web", "dist"))) {
    t.skip("no build in this checkout; the runner exercises this path explicitly");
    return;
  }
  const savedKey = process.env.MEDIA_SERVER_KEY_FILE;
  const savedRoots = process.env.LIBRARY_ROOTS;
  // A user installation that points its own key and library elsewhere must not be
  // able to reach the disposable child.
  process.env.MEDIA_SERVER_KEY_FILE = "/nonexistent/user/media-server.key";
  process.env.LIBRARY_ROOTS = "/nonexistent/user/library";
  let app;
  try {
    app = await startDisposableApp({ repoRoot });
    assert.ok(app.strippedInheritedEnv.includes("MEDIA_SERVER_KEY_FILE"), "the parent's key path is not inherited");
    assert.ok(app.strippedInheritedEnv.includes("LIBRARY_ROOTS"), "the parent's library roots are not inherited");
    assert.equal(existsSync(app.keyFile), true, "the run prepared its own vault key");
    assert.equal(statSync(app.keyFile).mode & 0o777, 0o600);
    const status = await app.request("/api/status");
    assert.equal(status.status, 200, "the application boots with its own key");
    const bytes = await app.bytes("/api/status");
    assert.equal(bytes.status, 200);
    assert.equal(JSON.parse(bytes.bytes.toString("utf8")).status, "ok");

    const dir = app.dir;
    await app.stop();
    assert.equal(existsSync(dir), false, "the owned tree is removed");
    await app.stop(); // idempotent
    const closed = await app.request("/api/status").catch(() => undefined);
    assert.equal(closed, undefined, "the application no longer answers");
  } finally {
    if (app) await app.stop();
    if (savedKey === undefined) delete process.env.MEDIA_SERVER_KEY_FILE; else process.env.MEDIA_SERVER_KEY_FILE = savedKey;
    if (savedRoots === undefined) delete process.env.LIBRARY_ROOTS; else process.env.LIBRARY_ROOTS = savedRoots;
  }
});


test("observer counters are stable snapshots for before/after measurements", async () => {
  await withUpstream(providerHandler, async ({ baseUrl }) => {
    const observer = await createObservedProxy({ upstream: baseUrl });
    try {
      const before = observer.counters("info");
      await (await fetch(`${observer.baseUrl}/System/Info/Public`)).arrayBuffer();
      assert.equal(before.starts, 0);
      assert.equal(observer.counters("info").starts, 1);
      const current = observer.counters("info");
      current.starts = 999;
      assert.equal(observer.counters("info").starts, 1);
    } finally { await observer.close(); }
  });
});


test("fixture authentication supplies device identity and the token in Authorization", async () => {
  await withUpstream((req, res) => {
    assert.match(req.headers.authorization ?? "", /DeviceId="mcv-fixture"/);
    if (req.url === "/Users/AuthenticateByName") return json(res, 200, { User: { Id: "u1" }, AccessToken: "fixture-token" });
    assert.match(req.headers.authorization ?? "", /Token="fixture-token"/);
    assert.equal(req.headers["x-emby-token"], "fixture-token");
    return json(res, 200, { UserData: { PlaybackPositionTicks: 0, Played: false, PlayCount: 0, IsFavorite: false } });
  }, async ({ baseUrl }) => {
    const observer = await createObservedProxy({ upstream: baseUrl });
    try {
      const client = createFixtureClient({ observer, username: "fixture", password: "fixture", provider: "jellyfin" });
      await client.authenticate();
      const state = await client.userData("u1", "item1");
      assert.equal(state.PlaybackPositionTicks, 0);
      assert.equal(client.failures().length, 0);
    } finally { await observer.close(); }
  });
});


test("embedded subtitle selection uses the production track endpoint before reading cues", async () => {
  const { createAppClient } = await import("./media-client-verification-fixtures.mjs");
  await withUpstream((req, res, body) => {
    if (req.method === "POST" && req.url === "/api/playback/s1/track") {
      assert.equal(JSON.parse(body.toString()).subtitle, 3);
      return json(res, 200, { id: "s1", sidecarUrl: "/cues.vtt" });
    }
    if (req.url === "/cues.vtt") { res.writeHead(200, { "content-type": "text/vtt" }); return res.end("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFixture cue\n"); }
    json(res, 404, {});
  }, async ({ baseUrl, requests }) => {
    const checks = [];
    await verifySidecar({ app: createAppClient(baseUrl), session: { id: "s1", offset: 0, subtitleTracks: [{ index: 3 }] }, itemLabel: "fixture",
      recorder: { record: (id, status) => checks.push({ id, status }), skip: () => assert.fail("track exists"), fail: () => assert.fail("selection failed") } });
    assert.deepEqual(checks, [{ id: "fixture.embedded-subtitle", status: "pass" }]);
    assert.deepEqual(requests.map(r => [r.method, r.url]), [["POST", "/api/playback/s1/track"], ["GET", "/cues.vtt"]]);
  });
});

test("streaming a large original does not accumulate response-close listeners", async () => {
  const payload = Buffer.alloc(3 * 1024 * 1024, 17);
  const warnings = [];
  const onWarning = warning => { if (warning.name === "MaxListenersExceededWarning") warnings.push(warning); };
  process.on("warning", onWarning);
  try {
    await withUpstream((_req, res) => { res.writeHead(200, { "content-length": payload.length }); res.end(payload); }, async ({ baseUrl }) => {
      const observer = await createObservedProxy({ upstream: baseUrl });
      try {
        const body = Buffer.from(await (await fetch(`${observer.baseUrl}/Videos/i1/stream`)).arrayBuffer());
        assert.equal(sha256(body), sha256(payload));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(warnings.length, 0);
      } finally { await observer.close(); }
    });
  } finally { process.off("warning", onWarning); }
});
