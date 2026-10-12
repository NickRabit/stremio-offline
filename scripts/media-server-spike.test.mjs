import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createReadOnlyClient, main, parseArgs, runSpike, SpikeError } from "./media-server-spike.mjs";

const ITEM_ID = "item-1";
const SOURCE_ID = "src-1";
const USER_ID = "user-1";
const TOKEN = "tok-fixture";
const DEFAULT_SUBTITLE = "1\n00:00:01,000 --> 00:00:02,000\nHello\n";

const servers = [];
const dirs = [];

after(async () => {
  await Promise.all(servers.map((fixture) => fixture.close()));
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Ephemeral loopback HTTP fixture server that records every request it receives. */
async function startFixture(handler) {
  const requests = [];
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const record = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    requests.push(record);
    const url = new URL(req.url, "http://localhost");
    try {
      handler(record, url, res);
    } catch {
      res.statusCode = 500;
      res.end("{}");
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fixture = {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  servers.push(fixture);
  return fixture;
}

async function writeFixture(bytes) {
  const dir = await mkdtemp(join(tmpdir(), "media-spike-"));
  dirs.push(dir);
  const path = join(dir, "fixture.bin");
  await writeFile(path, bytes);
  return path;
}

function sendJson(res, data, status = 200) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(data));
}

function sendStream(req, res, bytes, { rangeMode = "range", headContentLength = true } = {}) {
  res.setHeader("Accept-Ranges", "bytes");
  if (req.method === "HEAD") {
    res.statusCode = 200;
    if (headContentLength) res.setHeader("Content-Length", String(bytes.length));
    res.end();
    return;
  }
  const range = req.headers.range;
  if (!range || rangeMode === "ignore") {
    res.statusCode = 200;
    res.setHeader("Content-Length", String(bytes.length));
    res.end(bytes);
    return;
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(range);
  const start = Number(match[1]);
  const end = Number(match[2]);
  const slice = rangeMode === "wrong" ? Buffer.alloc(end - start + 1, 0x58) : bytes.subarray(start, end + 1);
  const total = rangeMode === "bad-total" ? bytes.length + 4096 : bytes.length;
  res.statusCode = 206;
  res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
  res.setHeader("Content-Length", String(slice.length));
  res.end(slice);
}

/** Minimal fake Jellyfin: only the endpoints the allowlist permits. */
function jellyfinHandler(options = {}) {
  const {
    bytes,
    rangeMode = "range",
    headContentLength = true,
    historyMutation = false,
    historyDuringPreparation = false,
    subtitleMutation = false,
    subtitle = DEFAULT_SUBTITLE,
    sessions = [],
    mediaSources,
  } = options;
  let itemReads = 0;
  let subtitleFetched = false;
  return (req, url, res) => {
    const path = url.pathname;
    if (req.method === "GET" && path === "/System/Info/Public") {
      return sendJson(res, { Version: "10.10.0", Id: "server-abc", ServerName: "Fixture" });
    }
    if (req.method === "POST" && path === "/Users/AuthenticateByName") {
      return sendJson(res, { User: { Id: USER_ID }, AccessToken: TOKEN, ServerId: "server-abc" });
    }
    if (req.method === "GET" && path === `/Users/${USER_ID}/Views`) {
      return sendJson(res, { Items: [{ Id: "view-1", Name: "Movies", CollectionType: "movies" }] });
    }
    if (req.method === "GET" && path === `/Users/${USER_ID}/Items/${ITEM_ID}`) {
      itemReads += 1;
      let position = 0;
      if (historyMutation && itemReads > 1) position = 4242;
      if (historyDuringPreparation && itemReads === 2) position = 4242;
      if (subtitleMutation && subtitleFetched) position = 4242;
      return sendJson(res, {
        Id: ITEM_ID,
        Type: "Movie",
        UserData: { PlaybackPositionTicks: position, Played: false, PlayCount: 0, IsFavorite: false },
      });
    }
    if (req.method === "GET" && path === `/Items/${ITEM_ID}/PlaybackInfo`) {
      const sources = mediaSources ?? [{ Id: SOURCE_ID, Protocol: "File", IsRemote: false, Container: "mkv" }];
      return sendJson(res, { MediaSources: sources });
    }
    if (path === `/Videos/${ITEM_ID}/stream`) return sendStream(req, res, bytes, { rangeMode, headContentLength });
    if (req.method === "GET" && /^\/Videos\/[^/]+\/[^/]+\/Subtitles\/\d+\/Stream\.srt$/.test(path)) {
      subtitleFetched = true;
      res.statusCode = 200;
      res.setHeader("content-type", "application/x-subrip");
      return res.end(subtitle);
    }
    if (req.method === "GET" && path === "/Sessions") return sendJson(res, sessions);
    res.statusCode = 404;
    res.end("{}");
  };
}

const statusOf = (report, id) => report.checks.find((entry) => entry.id === id)?.status;

const readSpikeOptions = (origin, fixturePath, extra = {}) => ({
  provider: "jellyfin",
  url: origin,
  itemId: ITEM_ID,
  fixturePath,
  username: "local-user",
  password: "local-password",
  ...extra,
});

test("rejects anything but a loopback HTTP(S) origin", () => {
  for (const origin of [
    "http://example.com",
    "https://10.0.0.5:8096",
    "ftp://127.0.0.1:8096",
    "http://user:pw@127.0.0.1:8096",
    "http://127.0.0.1:8096/?api_key=x",
    "http://127.0.0.1:8096/#frag",
    "",
    "not-a-url",
  ]) {
    assert.throws(() => createReadOnlyClient({ origin }), (error) => error instanceof SpikeError, `${origin} should be rejected`);
  }
  assert.doesNotThrow(() => createReadOnlyClient({ origin: "http://localhost:8096" }));
  assert.doesNotThrow(() => createReadOnlyClient({ origin: "http://[::1]:8096" }));
});

test("allows the exact read API and rejects everything else before fetch", async () => {
  let fetches = 0;
  const client = createReadOnlyClient({
    origin: "http://127.0.0.1:1",
    fetchImpl: async () => {
      fetches += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal((await client.request("GET", "/System/Info/Public")).status, 200);
  assert.equal((await client.views(USER_ID)).status, 200);
  assert.equal((await client.item(USER_ID, ITEM_ID)).status, 200);
  assert.equal((await client.playbackInfo(ITEM_ID, USER_ID)).status, 200);
  assert.equal((await client.headStream(ITEM_ID, SOURCE_ID)).status, 200);
  assert.equal((await client.getStreamRange(ITEM_ID, SOURCE_ID, "0-31")).status, 200);
  assert.equal((await client.subtitle(ITEM_ID, SOURCE_ID, 2)).status, 200);
  assert.equal((await client.sessions()).status, 200);
  assert.equal(
    (await client.request("GET", `/Users/${USER_ID}/Items`, {
      query: {
        ParentId: "p",
        Recursive: "true",
        IncludeItemTypes: "Movie",
        Fields: "Overview",
        StartIndex: 0,
        Limit: 10,
        EnableUserData: "true",
      },
    })).status,
    200,
  );
  const allowedFetches = fetches;

  const forbidden = [
    ["POST", "/Sessions/Playing/Stopped"],
    ["POST", "/Sessions/Playing/Progress"],
    ["POST", "/Items/item-1/PlaybackInfo"],
    ["POST", "/Library/Refresh"],
    ["POST", "/Library/VirtualFolders"],
    ["DELETE", `/Users/${USER_ID}/Items/${ITEM_ID}`],
    ["POST", `/Users/${USER_ID}/FavoriteItems/${ITEM_ID}`],
    ["POST", `/Users/${USER_ID}/PlayedItems/${ITEM_ID}`],
    ["GET", `/Videos/${ITEM_ID}/master.m3u8`],
    ["GET", `/Videos/${ITEM_ID}/stream.mkv`],
    ["GET", `/Videos/${ITEM_ID}/stream?Static=true&MediaSourceId=${SOURCE_ID}&api_key=leak`],
    ["GET", `/Users/${USER_ID}/Items?api_key=leak`],
    ["GET", `/Users/${USER_ID}/Items?SortBy=Name`],
    ["GET", "/Users/AuthenticateByName"],
    ["POST", "/System/Info/Public"],
    ["GET", "/../System/Info/Public"],
    ["GET", `/Users/${USER_ID}/Items/../../etc/passwd`],
    ["GET", `/Users/${USER_ID}/Views/extra`],
  ];
  for (const [method, path] of forbidden) {
    await assert.rejects(
      () => client.request(method, path),
      (error) => error instanceof SpikeError,
      `${method} ${path} should be rejected`,
    );
  }
  await assert.rejects(
    () => client.request("GET", `/Videos/${ITEM_ID}/stream`, { query: { Static: "false" } }),
    (error) => error.code === "query-not-allowed",
  );
  await assert.rejects(
    () => client.request("GET", `/Users/${USER_ID}/Items`, { query: { api_key: "leak" } }),
    (error) => error.code === "query-not-allowed",
  );
  await assert.rejects(
    () => client.request("GET", `/Users/${USER_ID}/Items`, { query: { SortBy: "Name" } }),
    (error) => error.code === "query-not-allowed",
  );
  await assert.rejects(
    () => client.request("POST", "/Users/AuthenticateByName"),
    (error) => error.code === "body-required",
  );
  assert.equal(fetches, allowedFetches, "no forbidden request may reach fetch");
  assert.ok(client.trace.every((entry) => entry.status === 200));
});

test("requires Static=true and a nonempty MediaSourceId on every stream request", async () => {
  let fetches = 0;
  const client = createReadOnlyClient({
    origin: "http://127.0.0.1:1",
    fetchImpl: async () => {
      fetches += 1;
      return new Response("{}", { status: 200 });
    },
  });
  const cases = [
    ["GET", `/Videos/${ITEM_ID}/stream`],
    ["HEAD", `/Videos/${ITEM_ID}/stream`],
    ["GET", `/Videos/${ITEM_ID}/stream`, { query: { Static: "true" } }],
    ["HEAD", `/Videos/${ITEM_ID}/stream`, { query: { Static: "true" } }],
    ["GET", `/Videos/${ITEM_ID}/stream`, { query: { MediaSourceId: SOURCE_ID } }],
    ["GET", `/Videos/${ITEM_ID}/stream`, { query: { Static: "false", MediaSourceId: SOURCE_ID } }],
    ["GET", `/Videos/${ITEM_ID}/stream`, { query: { Static: "1", MediaSourceId: SOURCE_ID } }],
    ["GET", `/Videos/${ITEM_ID}/stream`, { query: { Static: "true", MediaSourceId: "" } }],
  ];
  for (const [method, path, opts] of cases) {
    await assert.rejects(() => client.request(method, path, opts), (error) => error instanceof SpikeError);
  }
  assert.equal(fetches, 0, "an incomplete stream request must not reach fetch");
  assert.deepEqual(client.trace, []);

  assert.equal((await client.headStream(ITEM_ID, SOURCE_ID)).status, 200);
  assert.equal(fetches, 1);
});

test("rejects raw query, fragment, backslash and dot escapes before any fetch", async () => {
  let fetches = 0;
  const client = createReadOnlyClient({
    origin: "http://127.0.0.1:1",
    fetchImpl: async () => {
      fetches += 1;
      return new Response("{}", { status: 200 });
    },
  });
  const paths = [
    "/System/Info/Public?Static=true",
    "/System/Info/Public#frag",
    "/System/Info/Public\\extra",
    "/System/Info/Public%5cextra",
    "/System/Info/..",
    "/System/%2e%2e/Info",
    "/System/Info/Public%2Fextra",
    "/System/Info/Public%2f..%2f..",
  ];
  for (const path of paths) {
    await assert.rejects(() => client.request("GET", path), (error) => error instanceof SpikeError, path);
  }
  assert.equal(fetches, 0, "a raw-escape path must not reach fetch");
  assert.deepEqual(client.trace, []);
});

test("takes the base path from the origin path and rejects a conflicting --base-path", async () => {
  let requested;
  const client = createReadOnlyClient({
    origin: "http://127.0.0.1:1/jellyfin",
    fetchImpl: async (url) => {
      requested = String(url);
      return new Response("{}", { status: 200 });
    },
  });
  await client.systemInfo();
  assert.equal(requested, "http://127.0.0.1:1/jellyfin/System/Info/Public");
  assert.throws(
    () => createReadOnlyClient({ origin: "http://127.0.0.1:1/jellyfin", basePath: "/other" }),
    (error) => error.code === "conflicting-base-path",
  );
  assert.doesNotThrow(() => createReadOnlyClient({ origin: "http://127.0.0.1:1/jellyfin", basePath: "/jellyfin" }));
});

test("sends credentials only in the auth body and token header, never in traces or errors", async () => {
  const fixture = await startFixture((req, url, res) => {
    if (url.pathname === "/System/Info/Public") return sendJson(res, { Version: "10.10.0", Id: "server-abc" });
    if (url.pathname === "/Users/AuthenticateByName") return sendJson(res, { User: { Id: USER_ID }, AccessToken: TOKEN });
    res.statusCode = 500;
    res.end("SENSITIVE-BODY-LEAK");
  });
  const client = createReadOnlyClient({ origin: fixture.origin, timeoutMs: 2000 });
  const auth = await client.authenticate("alice", "s3cret-pw");
  assert.deepEqual(JSON.parse(fixture.requests[0].body), { Username: "alice", Pw: "s3cret-pw" });
  assert.match(fixture.requests[0].headers.authorization, /^MediaBrowser /);
  assert.doesNotMatch(fixture.requests[0].headers.authorization, /Token=/, "no token before authentication");
  assert.equal(fixture.requests[0].headers["x-emby-token"], undefined);
  client.setToken((await auth.json()).AccessToken);
  await client.systemInfo();
  const authed = fixture.requests.at(-1).headers;
  assert.equal(authed["x-emby-token"], TOKEN);
  assert.match(authed.authorization, new RegExp(`, Token="${TOKEN}"$`));

  const serialized = JSON.stringify({ trace: client.trace });
  assert.ok(!serialized.includes("s3cret-pw"), "password must not appear in the trace");
  assert.ok(!serialized.includes(TOKEN), "token must not appear in the trace");
  assert.ok(!JSON.stringify(client.trace).includes("alice"));

  for (const bad of ["", 'quote"inside', "back\\slash", "line\nbreak", "nul\u0000byte"]) {
    assert.throws(() => client.setToken(bad), (error) => error.code === "invalid-token", `token ${JSON.stringify(bad)}`);
  }
  assert.throws(
    () => createReadOnlyClient({ origin: "http://127.0.0.1:1", token: 'bad"token' }),
    (error) => error.code === "invalid-token",
  );
});

test("error messages report status only, never the response body", async () => {
  const leaky = await startFixture((req, url, res) => {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ Message: "SENSITIVE-BODY-LEAK" }));
  });
  const fixturePath = await writeFixture(Buffer.alloc(128, 0x48));
  const report = await runSpike(readSpikeOptions(leaky.origin, fixturePath, { timeoutMs: 2000 }));
  assert.equal(report.ok, false);
  assert.equal(statusOf(report, "server-info"), "fail");
  assert.match(report.checks[0].detail, /500/);
  assert.ok(!JSON.stringify(report).includes("SENSITIVE-BODY-LEAK"), "the body must not reach any error");
});

test("rejects redirects and base-path escapes without leaking the token", async () => {
  const target = await startFixture((req, url, res) => {
    res.statusCode = 200;
    res.end("{}");
  });
  const source = await startFixture((req, url, res) => {
    res.statusCode = 302;
    res.setHeader("Location", `${target.origin}/System/Info/Public`);
    res.end();
  });
  const client = createReadOnlyClient({ origin: source.origin, basePath: "/jellyfin", timeoutMs: 2000 });
  await assert.rejects(
    () => client.request("GET", "/../System/Info/Public"),
    (error) => error.code === "path-escape",
  );
  assert.equal(source.requests.length, 0);
  await assert.rejects(
    () => client.request("GET", "/System/Info/Public"),
    (error) => error instanceof SpikeError,
  );
  assert.equal(source.requests.length, 1);
  assert.equal(target.requests.length, 0);
  assert.ok(!JSON.stringify(client.trace).includes(target.origin));
});

test("runSpike passes the read-only happy path and records a safe trace", async () => {
  const bytes = Buffer.alloc(128);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
  const fixturePath = await writeFixture(bytes);
  const fixture = await startFixture(jellyfinHandler({ bytes }));
  const report = await runSpike(readSpikeOptions(fixture.origin, fixturePath));

  assert.equal(report.ok, true);
  assert.equal(report.provider, "jellyfin");
  assert.equal(report.version, "10.10.0");
  assert.equal(report.serverId, "server-abc");
  assert.equal(report.mediaSourceId, SOURCE_ID);
  for (const id of [
    "server-info",
    "authenticate",
    "views",
    "item-read",
    "playback-info",
    "media-source",
    "preparation-snapshot",
    "head-original",
    "range-first",
    "range-second",
    "stream-request-shape",
    "fixture-bytes",
    "history-isolation",
    "sessions",
  ]) {
    assert.equal(statusOf(report, id), "pass", `${id} should pass`);
  }
  assert.equal(statusOf(report, "cancellation"), "untested");
  assert.equal(statusOf(report, "subtitle"), "untested");
  assert.deepEqual(report.ranges, [
    { requested: "0-31", status: 206, contentRange: "0-31/128", bytes: 32 },
    { requested: "32-63", status: 206, contentRange: "32-63/128", bytes: 32 },
  ]);
  assert.ok(!JSON.stringify(report).includes(TOKEN), "the report must not carry the token");

  const streamRequests = fixture.requests.filter((request) => request.url.startsWith(`/Videos/${ITEM_ID}/stream`));
  assert.equal(streamRequests.length, 3);
  for (const request of streamRequests) {
    assert.match(request.url, /Static=true/);
    assert.match(request.url, new RegExp(`MediaSourceId=${SOURCE_ID}`));
  }
  const writes = fixture.requests.filter(
    (request) => !["GET", "HEAD"].includes(request.method) && request.url !== "/Users/AuthenticateByName",
  );
  assert.deepEqual(writes, [], "the spike must not perform any setup write");
});

test("runSpike fails when streamed bytes differ from the fixture", async () => {
  const bytes = Buffer.alloc(128, 0x41);
  const fixturePath = await writeFixture(bytes);
  const fixture = await startFixture(jellyfinHandler({ bytes, rangeMode: "wrong" }));
  const report = await runSpike(readSpikeOptions(fixture.origin, fixturePath));
  assert.equal(report.ok, false);
  assert.equal(statusOf(report, "fixture-bytes"), "fail");
  assert.equal(statusOf(report, "range-first"), "pass");
});

test("runSpike fails when a range answers 200 instead of 206", async () => {
  const bytes = Buffer.alloc(128, 0x42);
  const fixturePath = await writeFixture(bytes);
  const fixture = await startFixture(jellyfinHandler({ bytes, rangeMode: "ignore" }));
  const report = await runSpike(readSpikeOptions(fixture.origin, fixturePath));
  assert.equal(report.ok, false);
  assert.equal(statusOf(report, "range-first"), "fail");
  assert.equal(statusOf(report, "fixture-bytes"), "untested");
});

test("runSpike fails when Content-Range total disagrees with the fixture length", async () => {
  const bytes = Buffer.alloc(128, 0x4a);
  const fixturePath = await writeFixture(bytes);
  const fixture = await startFixture(jellyfinHandler({ bytes, rangeMode: "bad-total" }));
  const report = await runSpike(readSpikeOptions(fixture.origin, fixturePath));
  assert.equal(report.ok, false);
  assert.equal(statusOf(report, "range-first"), "fail");
  assert.match(report.checks.find((entry) => entry.id === "range-first").detail, /128/);
});

test("runSpike requires HEAD Content-Length to match the fixture length", async () => {
  const bytes = Buffer.alloc(128, 0x4b);
  const fixturePath = await writeFixture(bytes);
  const fixture = await startFixture(jellyfinHandler({ bytes, headContentLength: false }));
  const report = await runSpike(readSpikeOptions(fixture.origin, fixturePath));
  assert.equal(report.ok, false);
  assert.equal(statusOf(report, "head-original"), "fail");
  assert.equal(statusOf(report, "range-first"), "untested");
});

test("runSpike fails when remote user data changes after streaming", async () => {
  const bytes = Buffer.alloc(128, 0x43);
  const fixturePath = await writeFixture(bytes);
  const fixture = await startFixture(jellyfinHandler({ bytes, historyMutation: true }));
  const report = await runSpike(readSpikeOptions(fixture.origin, fixturePath));
  assert.equal(report.ok, false);
  assert.equal(statusOf(report, "history-isolation"), "fail");
  assert.match(report.checks.find((entry) => entry.id === "history-isolation").detail, /PlaybackPositionTicks/);
});

test("runSpike fails when preparation changes user data that the byte reads then restore", async () => {
  const bytes = Buffer.alloc(128, 0x48);
  const fixturePath = await writeFixture(bytes);
  const fixture = await startFixture(jellyfinHandler({ bytes, historyDuringPreparation: true }));
  const report = await runSpike(readSpikeOptions(fixture.origin, fixturePath));
  assert.equal(report.ok, false);
  assert.equal(statusOf(report, "preparation-snapshot"), "pass");
  assert.equal(statusOf(report, "history-isolation"), "fail");
  assert.match(report.checks.find((entry) => entry.id === "history-isolation").detail, /PlaybackPositionTicks/);
});

test("runSpike fails when the subtitle fetch changes remote user data", async () => {
  const bytes = Buffer.alloc(128, 0x49);
  const fixturePath = await writeFixture(bytes);
  const fixture = await startFixture(jellyfinHandler({ bytes, subtitleMutation: true }));
  const report = await runSpike(readSpikeOptions(fixture.origin, fixturePath, { subtitleIndex: 2 }));
  assert.equal(report.ok, false);
  assert.equal(statusOf(report, "subtitle"), "pass");
  assert.equal(statusOf(report, "history-isolation"), "fail");
});

test("runSpike reports an unsupported original-media path when no usable source exists", async () => {
  const bytes = Buffer.alloc(128, 0x44);
  const fixturePath = await writeFixture(bytes);
  const fixture = await startFixture(
    jellyfinHandler({ bytes, mediaSources: [{ Id: SOURCE_ID, Protocol: "Hls", IsRemote: false }] }),
  );
  const report = await runSpike(readSpikeOptions(fixture.origin, fixturePath));
  assert.equal(report.ok, false);
  assert.equal(statusOf(report, "media-source"), "unsupported");
});

test("runSpike refuses sources requiring remote/live transport preparation", async () => {
  const bytes = Buffer.alloc(128, 0x44);
  const fixturePath = await writeFixture(bytes);
  for (const fields of [{ Protocol: "Http" }, { RequiresOpening: true }, { RequiresClosing: true }, { IsInfiniteStream: true }]) {
    const fixture = await startFixture(jellyfinHandler({ bytes, mediaSources: [{ Id: SOURCE_ID, Protocol: "File", ...fields }] }));
    const report = await runSpike(readSpikeOptions(fixture.origin, fixturePath));
    assert.equal(statusOf(report, "media-source"), "unsupported");
    assert.equal(fixture.requests.some((request) => request.url.includes("/stream?")), false);
  }
});

test("capped responses and timeouts fail loudly instead of streaming", async () => {
  const bytes = Buffer.alloc(128, 0x45);
  const fixturePath = await writeFixture(bytes);
  const bigJson = await startFixture((req, url, res) => {
    sendJson(res, { Version: "10.10.0", Id: "server-abc", Pad: "z".repeat(4096) });
  });
  const capped = await runSpike(readSpikeOptions(bigJson.origin, fixturePath, { maxJsonBytes: 512 }));
  assert.equal(capped.ok, false);
  assert.match(capped.checks[0].detail, /body-too-large/);

  const slow = await startFixture(() => {});
  const timedOut = await runSpike(readSpikeOptions(slow.origin, fixturePath, { timeoutMs: 150 }));
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.checks[0].detail, /timeout/);

  const bodyCap = await startFixture(jellyfinHandler({ bytes }));
  const client = createReadOnlyClient({ origin: bodyCap.origin, maxBodyBytes: 8, timeoutMs: 2000 });
  const res = await client.getStreamRange(ITEM_ID, SOURCE_ID, "0-31");
  await assert.rejects(() => res.bytes(), (error) => error.code === "body-too-large");
});

test("runSpike fetches an external subtitle when one is requested", async () => {
  const bytes = Buffer.alloc(128, 0x46);
  const fixturePath = await writeFixture(bytes);
  const fixture = await startFixture(jellyfinHandler({ bytes }));
  const report = await runSpike(readSpikeOptions(fixture.origin, fixturePath, { subtitleIndex: 2 }));
  assert.equal(report.ok, true);
  assert.equal(statusOf(report, "subtitle"), "pass");
  assert.deepEqual(report.subtitle, { index: 2, bytes: DEFAULT_SUBTITLE.length, hasTimingLine: true });
  assert.equal(
    fixture.requests.find((request) => request.url.endsWith("/Stream.srt")).url,
    `/Videos/${ITEM_ID}/${SOURCE_ID}/Subtitles/2/Stream.srt`,
  );
});

test("the CLI parses arguments, prints help without credentials and refuses to run without them", async () => {
  assert.deepEqual(parseArgs(["--provider", "emby", "--subtitle-index", "3"]), {
    help: false,
    provider: "emby",
    subtitleIndex: 3,
  });
  assert.throws(() => parseArgs(["--nope"]), (error) => error instanceof SpikeError);
  assert.throws(() => parseArgs(["--provider"]), (error) => error instanceof SpikeError);
  assert.equal(parseArgs(["--help"]).help, true);

  const saved = { user: process.env.MEDIA_SERVER_USERNAME, password: process.env.MEDIA_SERVER_PASSWORD };
  const logged = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    assert.equal(await main(["--help"]), 0);
    delete process.env.MEDIA_SERVER_USERNAME;
    delete process.env.MEDIA_SERVER_PASSWORD;
    assert.equal(
      await main(["--provider", "jellyfin", "--url", "http://127.0.0.1:1", "--item-id", ITEM_ID, "--fixture", "/nope"]),
      2,
    );
  } finally {
    console.log = logged.log;
    console.error = logged.error;
    if (saved.user === undefined) delete process.env.MEDIA_SERVER_USERNAME;
    else process.env.MEDIA_SERVER_USERNAME = saved.user;
    if (saved.password === undefined) delete process.env.MEDIA_SERVER_PASSWORD;
    else process.env.MEDIA_SERVER_PASSWORD = saved.password;
  }
});

test("the CLI runs the spike end to end with environment credentials", async () => {
  const bytes = Buffer.alloc(128, 0x47);
  const fixturePath = await writeFixture(bytes);
  const fixture = await startFixture(jellyfinHandler({ bytes }));
  const saved = { user: process.env.MEDIA_SERVER_USERNAME, password: process.env.MEDIA_SERVER_PASSWORD };
  const logged = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  process.env.MEDIA_SERVER_USERNAME = "cli-user";
  process.env.MEDIA_SERVER_PASSWORD = "cli-password";
  try {
    const code = await main([
      "--provider",
      "jellyfin",
      "--url",
      fixture.origin,
      "--item-id",
      ITEM_ID,
      "--fixture",
      fixturePath,
    ]);
    assert.equal(code, 0);
  } finally {
    console.log = logged.log;
    console.error = logged.error;
    if (saved.user === undefined) delete process.env.MEDIA_SERVER_USERNAME;
    else process.env.MEDIA_SERVER_USERNAME = saved.user;
    if (saved.password === undefined) delete process.env.MEDIA_SERVER_PASSWORD;
    else process.env.MEDIA_SERVER_PASSWORD = saved.password;
  }
});
