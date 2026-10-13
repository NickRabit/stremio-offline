import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  assertMediaServerAddress,
  createMediaServerTransport,
  MEDIA_SERVER_ORIGINAL_LIMITS,
  normalizeMediaServerUrl,
  type LookupAddress,
} from "./media-server-security.js";
import { MediaServerError } from "./media-server-types.js";

interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Fixture {
  origin: string;
  requests: Recorded[];
  connections: () => number;
  close: () => Promise<void>;
}

async function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<Fixture> {
  const requests: Recorded[] = [];
  let connections = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      handler(req, res, body);
    });
  });
  server.on("connection", () => { connections += 1; });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, requests, connections: () => connections, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const json = (res: http.ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

const open = (origin: string) => createMediaServerTransport({ baseUrl: origin, allowLan: false, allowLoopback: true });

const readMedia = async (body: ReadableStream<Uint8Array> | null): Promise<Buffer> => {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
};

/** A cooperative upstream stream that emits headers but never ends on its own, so a test can
 *  prove the streaming slot outlives the response headers. */
const heldMedia = (): Response => new Response(
  new ReadableStream<Uint8Array>({ start() { /* stays open until released or cancelled */ } }),
  { status: 200 },
);

test("normalizeMediaServerUrl keeps the origin and base path and strips one final slash", () => {
  assert.equal(normalizeMediaServerUrl("http://media.example"), "http://media.example");
  assert.equal(normalizeMediaServerUrl("http://media.example/"), "http://media.example");
  assert.equal(normalizeMediaServerUrl("https://media.example:8443/jf/"), "https://media.example:8443/jf");
  assert.equal(normalizeMediaServerUrl("http://2130706433/prefix"), "http://127.0.0.1/prefix", "unusual IPv4 notation becomes the literal");
  assert.equal(normalizeMediaServerUrl("http://[2001:db8::1]:8080/x"), "http://[2001:db8::1]:8080/x");
});

test("normalizeMediaServerUrl refuses credentials, query, fragments and path tricks", () => {
  for (const bad of [
    "http://user:pass@media.example",
    "http://media.example?a=1",
    "http://media.example#frag",
    "http://media.example/a/../b",
    "http://media.example/a//b",
    "http://media.example/%2e%2e/",
    "http://media.example/a%2fb",
    "http://media.example/a%252fb",
    "http://media.example\\x",
    "http://media.example/ sp",
    "ftp://media.example",
    "media.example",
    "http://[fe80::1%25eth0]/",
  ]) {
    assert.throws(() => normalizeMediaServerUrl(bad), { code: "invalid-input" }, bad);
  }
  assert.throws(() => normalizeMediaServerUrl("http://media.example/" + "a".repeat(2048)), { code: "invalid-input" });
});

test("address policy: loopback and LAN are opt-in, the rest fails closed", () => {
  const off = { allowLan: false, allowLoopback: false };
  const lan = { allowLan: true, allowLoopback: false };
  const loop = { allowLan: false, allowLoopback: true };

  assert.throws(() => assertMediaServerAddress("127.0.0.1", off), { code: "unsafe-address" });
  assert.doesNotThrow(() => assertMediaServerAddress("127.0.0.1", loop));
  assert.throws(() => assertMediaServerAddress("::1", off), { code: "unsafe-address" });
  assert.doesNotThrow(() => assertMediaServerAddress("::1", loop));
  assert.throws(() => assertMediaServerAddress("10.0.0.5", off), { code: "unsafe-address" });
  assert.doesNotThrow(() => assertMediaServerAddress("10.0.0.5", lan));
  assert.doesNotThrow(() => assertMediaServerAddress("172.16.1.1", lan));
  assert.throws(() => assertMediaServerAddress("172.16.1.1", off), { code: "unsafe-address" });
  assert.doesNotThrow(() => assertMediaServerAddress("192.168.1.1", lan));
  assert.doesNotThrow(() => assertMediaServerAddress("fd00::1", lan));
  assert.throws(() => assertMediaServerAddress("fd00::1", off), { code: "unsafe-address" });

  for (const blocked of ["0.0.0.0", "169.254.1.1", "100.64.0.1", "192.0.0.1", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.0.0.1", "255.255.255.255", "168.63.129.16", "fe80::1", "ff02::1", "::", "2001:db8::1", "2002::1", "3fff::1", "2001::1"]) {
    assert.throws(() => assertMediaServerAddress(blocked, lan), { code: "unsafe-address" }, blocked);
    assert.throws(() => assertMediaServerAddress(blocked, loop), { code: "unsafe-address" }, blocked);
  }

  for (const allowed of ["93.184.216.34", "8.8.8.8", "2606:4700::1111", "2a00:1450:4001::1"]) {
    assert.doesNotThrow(() => assertMediaServerAddress(allowed, off), allowed);
  }
});

test("IPv4-mapped IPv6 is unwrapped before classification, in dotted and hex form", () => {
  const loop = { allowLan: false, allowLoopback: true };
  const off = { allowLan: false, allowLoopback: false };
  assert.doesNotThrow(() => assertMediaServerAddress("::ffff:127.0.0.1", loop));
  assert.doesNotThrow(() => assertMediaServerAddress("::ffff:7f00:1", loop));
  assert.throws(() => assertMediaServerAddress("::ffff:127.0.0.1", off), { code: "unsafe-address" });
  assert.throws(() => assertMediaServerAddress("::ffff:169.254.1.1", loop), { code: "unsafe-address" });
  assert.doesNotThrow(() => assertMediaServerAddress("::ffff:8.8.8.8", off));
});

test("a non-literal or zoned address is refused rather than classified", () => {
  for (const bad of ["example.com", "", "fe80::1%eth0", "10.0.0.1%x"]) {
    assert.throws(() => assertMediaServerAddress(bad, { allowLan: true, allowLoopback: true }), { code: "unsafe-address" }, bad);
  }
});

test("a literal address is checked when the transport is built", () => {
  assert.throws(() => createMediaServerTransport({ baseUrl: "http://169.254.1.1", allowLan: false, allowLoopback: false }), { code: "unsafe-address" });
  assert.throws(() => createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: false }), { code: "unsafe-address" });
  assert.throws(() => createMediaServerTransport({ baseUrl: "http://2130706433", allowLan: false, allowLoopback: false }), { code: "unsafe-address" });
});

test("the addon LAN environment exceptions never apply to a media-server connection", () => {
  const previous = { private: process.env.ALLOW_PRIVATE_ADDONS, hosts: process.env.ALLOW_ADDON_HOSTS };
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  process.env.ALLOW_ADDON_HOSTS = "127.0.0.1";
  try {
    assert.throws(() => createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: false }), { code: "unsafe-address" });
  } finally {
    if (previous.private === undefined) delete process.env.ALLOW_PRIVATE_ADDONS; else process.env.ALLOW_PRIVATE_ADDONS = previous.private;
    if (previous.hosts === undefined) delete process.env.ALLOW_ADDON_HOSTS; else process.env.ALLOW_ADDON_HOSTS = previous.hosts;
  }
});

test("the transport builds the exact metadata request and headers", async () => {
  let fixture: Fixture | undefined;
  try {
    fixture = await startServer((_req, res) => json(res, { Id: "server-1", Version: "12.2.0" }));
    const transport = createMediaServerTransport({ baseUrl: `${fixture.origin}/prefix`, allowLan: false, allowLoopback: true, deviceId: "mconn_fixture-identity" });
    const info = await transport.requestJson("info", {});
    assert.deepEqual(info, { Id: "server-1", Version: "12.2.0" });
    assert.equal(fixture.requests[0].url, "/prefix/System/Info/Public");
    assert.equal(fixture.requests[0].headers.authorization?.includes("Token="), false, "no token is sent where none is needed");
    assert.match(fixture.requests[0].headers.authorization ?? "", /DeviceId="mconn_fixture-identity"/);
    await transport.close();
  } finally {
    await fixture?.close();
  }
});

test("device identity is bounded and cannot inject an authorization header field", () => {
  for (const deviceId of ["", "x".repeat(65), 'device", Token="injected', "device\r\nheader", 123]) {
    assert.throws(() => createMediaServerTransport({
      baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true, deviceId: deviceId as string,
    }), { code: "invalid-input" });
  }
});

test("items carries only the fixed allow-listed query and drops raw path fields", async () => {
  let fixture: Fixture | undefined;
  try {
    fixture = await startServer((_req, res) => json(res, { Items: [], TotalRecordCount: 0 }));
    const transport = open(fixture.origin);
    await transport.requestJson("items", { userId: "user-1", parentId: "lib-1", includeItemTypes: "Movie,Series,Season,Episode,MusicVideo", startIndex: 0, limit: 25, searchTerm: "a b" }, "tok");
    const query = new URLSearchParams(fixture.requests[0].url.split("?")[1]);
    assert.equal(query.get("Recursive"), "true");
    assert.equal(query.get("IncludeItemTypes"), "Movie,Series,Season,Episode,MusicVideo");
    assert.equal(query.get("Fields"), "ProviderIds,ParentId,SeriesInfo");
    assert.equal(query.get("EnableUserData"), "false");
    assert.equal(query.get("ParentId"), "lib-1");
    assert.equal(query.get("StartIndex"), "0");
    assert.equal(query.get("Limit"), "25");
    assert.equal(query.get("SearchTerm"), "a b");
    assert.equal(fixture.requests[0].headers["x-emby-token"], "tok");
    assert.equal(fixture.requests[0].headers.authorization, 'MediaBrowser Client="Stremio Offline", Device="Server", DeviceId="stremio-offline-server", Version="1.0.0", Token="tok"');
    await transport.close();
  } finally {
    await fixture?.close();
  }
});

test("login sends client identity without a token and the password only in the JSON body", async () => {
  let fixture: Fixture | undefined;
  try {
    fixture = await startServer((_req, res) => json(res, { User: { Id: "u1" }, AccessToken: "tok" }));
    const transport = open(fixture.origin);
    await transport.requestJson("login", { username: "alice", password: "hunter2" });
    assert.equal(fixture.requests[0].method, "POST");
    assert.equal(fixture.requests[0].url, "/Users/AuthenticateByName");
    assert.match(fixture.requests[0].headers.authorization ?? "", /^MediaBrowser Client=/);
    assert.equal(fixture.requests[0].headers.authorization?.includes("Token="), false);
    assert.equal(fixture.requests[0].headers["x-emby-token"], undefined);
    assert.deepEqual(JSON.parse(fixture.requests[0].body), { Username: "alice", Pw: "hunter2" });
    assert.equal(fixture.requests[0].url.includes("hunter2"), false);
    await transport.close();
  } finally {
    await fixture?.close();
  }
});

test("operations refuse unknown fields, raw paths and missing tokens", async () => {
  let fixture: Fixture | undefined;
  try {
    fixture = await startServer((_req, res) => json(res, {}));
    const transport = open(fixture.origin);
    await assert.rejects(transport.requestJson("info", { extra: 1 } as never), { code: "invalid-input" });
    await assert.rejects(transport.requestJson("user", { userId: "u1" }), { code: "authentication-required" });
    await assert.rejects(transport.requestJson("items", { userId: "u1", includeItemTypes: "Movie", limit: 500 } as never, "tok"), { code: "invalid-input" });
    await assert.rejects(transport.requestJson("items", { userId: "u1", includeItemTypes: "Music" } as never, "tok"), { code: "invalid-input" });
    await assert.rejects(transport.requestJson("detail", { userId: "u1", itemId: "a/b" }, "tok"), { code: "invalid-input" });
    await assert.rejects(transport.requestJson("detail", { userId: "u1", itemId: ".." }, "tok"), { code: "invalid-input" });
    await assert.rejects(transport.requestJson("user", { userId: "u1" }, 'bad"token'), { code: "invalid-input" });
    assert.deepEqual(fixture.requests, [], "a refused request never reaches the socket");
    await transport.close();
  } finally {
    await fixture?.close();
  }
});

test("status codes map to typed errors, rate limits carry a clamped retry hint", async () => {
  let fixture: Fixture | undefined;
  try {
    fixture = await startServer((req, res) => {
      const status = Number(req.url?.split("/").pop() ?? 0);
      if (status === 429) res.setHeader("retry-after", "600");
      json(res, {}, status);
    });
    const transport = open(fixture.origin);
    await assert.rejects(transport.requestJson("user", { userId: "401" }, "tok"), { code: "authentication-required", status: 401 });
    await assert.rejects(transport.requestJson("user", { userId: "403" }, "tok"), { code: "forbidden", status: 403 });
    await assert.rejects(transport.requestJson("user", { userId: "404" }, "tok"), { code: "not-found", status: 404 });
    await assert.rejects(transport.requestJson("user", { userId: "503" }, "tok"), { code: "unavailable", status: 503 });
    const limited = await transport.requestJson("user", { userId: "429" }, "tok").then(() => undefined, (error) => error as { code: string; retryAfterMs?: number });
    assert.equal(limited?.code, "rate-limited");
    assert.equal(limited?.retryAfterMs, 300_000, "the hint is clamped");
    await transport.close();
  } finally {
    await fixture?.close();
  }
});

/** A transport whose fetch is stubbed, so the cooldown can be driven without a socket. */
const stubbed = (fetch: (url: string) => Promise<Response>) =>
  createMediaServerTransport({ baseUrl: "http://media.example", allowLan: false, allowLoopback: false }, {
    lookupAll: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: (url) => fetch(url),
  });

const failed = async (work: Promise<unknown>): Promise<MediaServerError> =>
  work.then(() => { throw new Error("expected a rejection"); }, (error) => error as MediaServerError);

test("a metadata 429 puts the transport in cooldown and blocks later JSON, asset and original work", async () => {
  let fetches = 0;
  const transport = stubbed(async () => {
    fetches += 1;
    return new Response("{}", { status: 429, headers: { "retry-after": "2" } });
  });
  const limited = await failed(transport.requestJson("user", { userId: "u1" }, "tok"));
  assert.equal(limited.code, "rate-limited");
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAfterMs, 2_000, "the parsed hint is reported");
  assert.equal(fetches, 1);

  // Every transport operation is answered locally with the remaining hint; none opens a socket.
  const blocked = [
    await failed(transport.requestJson("user", { userId: "u1" }, "tok")),
    await failed(transport.requestAsset({ kind: "artwork", itemId: "i1", imageType: "Primary" }, "tok")),
    await failed(transport.requestOriginal({ itemId: "i1", mediaSourceId: "ms", method: "HEAD" }, "tok")),
  ];
  for (const error of blocked) {
    assert.equal(error.code, "rate-limited");
    assert.equal(error.status, 429);
    assert.ok((error.retryAfterMs ?? 0) > 0 && (error.retryAfterMs ?? 0) <= 2_000, `remaining hint ${error.retryAfterMs}`);
  }
  assert.equal(fetches, 1, "a cooling transport performs no fetch");
  await transport.close();
});

test("a 429 with no Retry-After parks the transport for the default thirty seconds", async () => {
  let fetches = 0;
  const transport = stubbed(async () => { fetches += 1; return new Response("{}", { status: 429 }); });
  const limited = await failed(transport.requestJson("info", {}));
  assert.equal(limited.code, "rate-limited");
  assert.equal(limited.retryAfterMs, 30_000, "the default cooldown is reported when the header is absent");
  const blocked = await failed(transport.requestJson("info", {}));
  assert.ok((blocked.retryAfterMs ?? 0) > 29_000 && (blocked.retryAfterMs ?? 0) <= 30_000, `remaining hint ${blocked.retryAfterMs}`);
  assert.equal(fetches, 1);
  await transport.close();
});

test("the cooldown expires on its own and a Retry-After is capped at five minutes", async () => {
  let status = 429;
  const transport = stubbed(async () => status === 429
    ? new Response("{}", { status: 429, headers: { "retry-after": "0.05" } })
    : new Response(JSON.stringify({ Id: "server-1" }), { status: 200, headers: { "content-type": "application/json" } }));
  const first = await failed(transport.requestJson("info", {}));
  assert.equal(first.retryAfterMs, 50);
  const still = await failed(transport.requestJson("info", {}));
  assert.equal(still.code, "rate-limited", "the cooldown is still armed");
  status = 200;
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.deepEqual(await transport.requestJson("info", {}), { Id: "server-1" }, "an expired cooldown lets the request through");
  await transport.close();

  const capped = stubbed(async () => new Response("{}", { status: 429, headers: { "retry-after": "99999" } }));
  const limited = await failed(capped.requestJson("info", {}));
  assert.equal(limited.retryAfterMs, 300_000, "the applied cooldown never exceeds the cap");
  await capped.close();
});

test("a 429 observed while another request is preparing stops it before the socket is opened", async () => {
  let fetches = 0;
  let releaseLookup!: () => void;
  const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
  let firstLookup = true;
  const transport = createMediaServerTransport({ baseUrl: "http://media.example", allowLan: false, allowLoopback: false }, {
    lookupAll: async () => {
      if (firstLookup) { firstLookup = false; }
      else await lookupGate;
      return [{ address: "93.184.216.34", family: 4 }];
    },
    fetch: async () => { fetches += 1; return new Response("{}", { status: 429, headers: { "retry-after": "5" } }); },
  });
  const leading = transport.requestJson("info", {});
  const trailing = transport.requestJson("info", {});
  const first = await failed(leading);
  assert.equal(first.code, "rate-limited");
  releaseLookup();
  const second = await failed(trailing);
  assert.equal(second.code, "rate-limited", "the prepared request is refused once the cooldown is armed");
  assert.equal(fetches, 1, "only the request that saw the 429 reached the socket");
  await transport.close();
});

test("a redirect is refused and an oversized body is cut off", async () => {
  let redirect: Fixture | undefined;
  let big: Fixture | undefined;
  try {
    redirect = await startServer((_req, res) => { res.writeHead(302, { location: "/elsewhere" }); res.end(); });
    const redirectTransport = open(redirect.origin);
    await assert.rejects(redirectTransport.requestJson("info", {}), { code: "invalid-response" });
    await redirectTransport.close();

    big = await startServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("x".repeat(3 * 1024 * 1024)); });
    const bigTransport = open(big.origin);
    await assert.rejects(bigTransport.requestJson("info", {}), { code: "response-too-large" });
    await bigTransport.close();
  } finally {
    await redirect?.close();
    await big?.close();
  }
});

test("a body that is not JSON is an invalid response", async () => {
  let fixture: Fixture | undefined;
  try {
    fixture = await startServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("not json"); });
    const transport = open(fixture.origin);
    await assert.rejects(transport.requestJson("info", {}), { code: "invalid-response" });
    await transport.close();
  } finally {
    await fixture?.close();
  }
});

test("the fifth concurrent request fails fast with busy", async () => {
  let fixture: Fixture | undefined;
  try {
    fixture = await startServer((_req, res) => setTimeout(() => json(res, { ok: true }), 60));
    const transport = open(fixture.origin);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => transport.requestJson("info", {})));
    const rejected = results.filter((entry) => entry.status === "rejected");
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0] as PromiseRejectedResult).reason.code, "busy");
    assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 4);
    await transport.close();
  } finally {
    await fixture?.close();
  }
});

test("cancelled calls retain their DNS slots until the resolver settles", async () => {
  const pending: Array<(answers: LookupAddress[]) => void> = [];
  let fetched = 0;
  const transport = createMediaServerTransport({ baseUrl: "http://media.example", allowLan: false, allowLoopback: false }, {
    lookupAll: () => new Promise<LookupAddress[]>((resolve) => { pending.push(resolve); }),
    fetch: async () => { fetched += 1; return new Response("{}"); },
  });
  try {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(transport.requestJson("info", {}, undefined, alreadyAborted.signal), { code: "cancelled" });
    assert.equal(pending.length, 0);
    for (let index = 0; index < 4; index += 1) {
      const controller = new AbortController();
      const request = transport.requestJson("info", {}, undefined, controller.signal);
      const rejected = assert.rejects(request, { code: "cancelled" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(pending.length, index + 1);
      controller.abort();
      await rejected;
    }
    await assert.rejects(transport.requestJson("info", {}), { code: "busy" });
    assert.equal(pending.length, 4);
    assert.equal(fetched, 0);
    for (const resolve of pending) resolve([{ address: "93.184.216.34", family: 4 }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const request = transport.requestJson("info", {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pending.length, 5);
    pending[4]([{ address: "93.184.216.34", family: 4 }]);
    assert.deepEqual(await request, {});
    assert.equal(fetched, 1);
  } finally {
    await transport.close();
  }
});

test("a caller abort is cancelled, a deadline is timeout, and close ends the transport", async () => {
  const transport = createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true }, {
    fetch: (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  const controller = new AbortController();
  const cancelled = assert.rejects(transport.requestJson("info", {}, undefined, controller.signal), { code: "cancelled" });
  controller.abort();
  await cancelled;

  const slow = createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true }, {
    fetch: (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  const pending = assert.rejects(slow.requestJson("info", {}), { code: "closed" });
  await slow.close();
  await pending;
  await assert.rejects(slow.requestJson("info", {}), { code: "closed" });
  await transport.close();
});

test("a request that outlives the deadline fails with timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const transport = createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true }, {
    fetch: (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  const pending = assert.rejects(transport.requestJson("info", {}), { code: "timeout" });
  t.mock.timers.tick(10_000);
  await pending;
  await transport.close();
});

test("DNS is checked per instance and fails closed on empty, blocked or mixed answers", async () => {
  const answers = (list: LookupAddress[]) => async () => list;
  let lookups = 0;
  const counting = async () => { lookups += 1; return [{ address: "93.184.216.34", family: 4 }]; };
  const never = () => { throw new Error("fetch must not run"); };

  const empty = createMediaServerTransport({ baseUrl: "http://media.example", allowLan: false, allowLoopback: false }, { lookupAll: answers([]), fetch: never });
  await assert.rejects(empty.requestJson("info", {}), { code: "unsafe-address" });

  const malformed = createMediaServerTransport({ baseUrl: "http://media.example", allowLan: false, allowLoopback: false }, { lookupAll: async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); }, fetch: never });
  await assert.rejects(malformed.requestJson("info", {}), { code: "unsafe-address" });

  const blocked = createMediaServerTransport({ baseUrl: "http://media.example", allowLan: false, allowLoopback: false }, { lookupAll: answers([{ address: "169.254.1.1", family: 4 }]), fetch: never });
  await assert.rejects(blocked.requestJson("info", {}), { code: "unsafe-address" });

  const mixed = createMediaServerTransport({ baseUrl: "http://media.example", allowLan: false, allowLoopback: false }, { lookupAll: answers([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }]), fetch: never });
  await assert.rejects(mixed.requestJson("info", {}), { code: "unsafe-address" });

  const ok = createMediaServerTransport({ baseUrl: "http://media.example", allowLan: false, allowLoopback: false }, {
    lookupAll: counting,
    fetch: async () => new Response(JSON.stringify({ Id: "s", Version: "1" }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await ok.requestJson("info", {});
  assert.equal(lookups, 1);
  await empty.close();
  await blocked.close();
  await mixed.close();
  await ok.close();
});

test("a name that answers public first and blocked at the real socket lookup is refused", async () => {
  let call = 0;
  const lookupAll = async () => {
    call += 1;
    return call === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "169.254.10.10", family: 4 }];
  };
  const transport = createMediaServerTransport({ baseUrl: "http://media.example", allowLan: false, allowLoopback: false }, { lookupAll });
  try {
    await assert.rejects(transport.requestJson("info", {}), { code: "unsafe-address" });
    assert.ok(call >= 2, "the socket-time lookup was consulted");
  } finally {
    await transport.close();
  }
});

test("a late DNS answer cannot start a request after the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolveLookup: ((value: LookupAddress[]) => void) | undefined;
  let fetched = false;
  const transport = createMediaServerTransport({ baseUrl: "http://media.example", allowLan: false, allowLoopback: false }, {
    lookupAll: () => new Promise<LookupAddress[]>((resolve) => { resolveLookup = resolve; }),
    fetch: async () => { fetched = true; return new Response("{}", { status: 200 }); },
  });
  const pending = assert.rejects(transport.requestJson("info", {}), { code: "timeout" });
  t.mock.timers.tick(10_000);
  await pending;
  resolveLookup?.([{ address: "93.184.216.34", family: 4 }]);
  await Promise.resolve();
  assert.equal(fetched, false);
  await transport.close();
});

test("the address policy must be exact booleans, never a truthy parsed value", () => {
  assert.throws(() => createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: "false" as never }), { code: "invalid-input" });
  assert.throws(() => createMediaServerTransport({ baseUrl: "https://media.example", allowLan: "true" as never, allowLoopback: false }), { code: "invalid-input" });
  assert.throws(() => assertMediaServerAddress("127.0.0.1", { allowLan: false, allowLoopback: "false" as never }), { code: "invalid-input" });
  assert.throws(() => assertMediaServerAddress("93.184.216.34", { allowLan: 1 as never, allowLoopback: 0 as never }), { code: "invalid-input" });
});

test("items requires a parent id, bounds the limit and always sends explicit paging", async () => {
  let fixture: Fixture | undefined;
  try {
    fixture = await startServer((_req, res) => json(res, { Items: [], TotalRecordCount: 0 }));
    const transport = open(fixture.origin);
    await assert.rejects(transport.requestJson("items", { userId: "u1", includeItemTypes: "Movie" } as never, "tok"), { code: "invalid-input" });
    await assert.rejects(transport.requestJson("items", { userId: "u1", parentId: "lib", includeItemTypes: "Movie", limit: 0 } as never, "tok"), { code: "invalid-input" });
    await assert.rejects(transport.requestJson("items", { userId: "u1", parentId: "lib", includeItemTypes: "Movie", limit: 201 } as never, "tok"), { code: "invalid-input" });
    assert.equal(fixture.requests.length, 0, "a refused items request never reaches the socket");
    await transport.requestJson("items", { userId: "u1", parentId: "lib", includeItemTypes: "Movie" }, "tok");
    const query = new URLSearchParams(fixture.requests[0].url.split("?")[1]);
    assert.equal(query.get("ParentId"), "lib");
    assert.equal(query.get("Limit"), "100");
    assert.equal(query.get("StartIndex"), "0");
    await transport.close();
  } finally {
    await fixture?.close();
  }
});

test("a failing response body becomes a fixed error with no upstream message", async () => {
  const stream = new ReadableStream({ start(controller) { controller.error(new Error("upstream-sensitive-message")); } });
  const transport = createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true }, {
    fetch: async () => new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
  });
  const error = await transport.requestJson("info", {}).then(() => undefined, (value) => value as MediaServerError);
  assert.ok(error instanceof MediaServerError, "a body failure is a typed transport error");
  assert.equal(error.message.includes("upstream-sensitive-message"), false);
  await transport.close();
});

test("an abort midway through the body cancels promptly", async () => {
  let pulls = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) controller.enqueue(new TextEncoder().encode("{"));
    },
  });
  const transport = createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true }, {
    fetch: async () => new Response(stream, { status: 200 }),
  });
  const controller = new AbortController();
  const pending = assert.rejects(transport.requestJson("info", {}, undefined, controller.signal), { code: "cancelled" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await pending;
  await transport.close();
});

test("a never-settling body cancel cannot hold the slot or the deadline", async () => {
  const stream = new ReadableStream({
    start(controller) { controller.error(new Error("boom")); },
    cancel() { return new Promise(() => {}); },
  });
  const transport = createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true }, {
    fetch: async () => new Response(stream, { status: 200 }),
  });
  const outcome = await Promise.race([
    transport.requestJson("info", {}).then(() => "resolved", () => "rejected"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 1000)),
  ]);
  assert.equal(outcome, "rejected");
  const second = await transport.requestJson("info", {}).then(() => "resolved", (error) => (error as MediaServerError).code);
  assert.notEqual(second, "busy", "the slot was released");
  await transport.close();
});

test("inherited operation names and unknown arguments are refused without reflection", async () => {
  const never = () => { throw new Error("fetch must not run"); };
  const transport = createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true }, { fetch: never });
  for (const name of ["toString", "hasOwnProperty", "constructor", "__proto__", "valueOf"]) {
    await assert.rejects(transport.requestJson(name as never, {} as never), { code: "invalid-input" }, name);
  }
  const error = await transport.requestJson("info", { "token=SECRET-KEY": 1 } as never).then(() => undefined, (value) => value as MediaServerError);
  assert.equal(error?.code, "invalid-input");
  assert.equal(error?.message.includes("SECRET-KEY"), false);
  await transport.close();
});

test("a malformed lookup answer shape is refused before any request", async () => {
  const never = () => { throw new Error("fetch must not run"); };
  const build = (list: unknown) => createMediaServerTransport(
    { baseUrl: "http://media.example", allowLan: false, allowLoopback: false },
    { lookupAll: (async () => list) as never, fetch: never },
  );
  const cases: unknown[] = [
    [{ address: "93.184.216.34", family: 6 }],
    [{ address: "not-an-ip", family: 4 }],
    [{ address: "93.184.216.34" }],
    "nope",
    [{ address: "93.184.216.34", family: 4 }, { address: "fe80::1", family: 6 }],
  ];
  for (const list of cases) {
    const transport = build(list);
    try { await assert.rejects(transport.requestJson("info", {}), { code: "unsafe-address" }); }
    finally { await transport.close(); }
  }
});

test("a mixed-family answer set is refused before family filtering, with zero HTTP requests", async () => {
  let fixture: Fixture | undefined;
  try {
    fixture = await startServer((_req, res) => json(res, { Id: "s", Version: "1" }));
    const port = new URL(fixture.origin).port;
    let call = 0;
    const lookupAll = async () => {
      call += 1;
      return call === 1
        ? [{ address: "127.0.0.1", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }, { address: "fe80::1", family: 6 }];
    };
    const transport = createMediaServerTransport(
      { baseUrl: `http://media.example:${port}`, allowLan: false, allowLoopback: true },
      { lookupAll, connectOptions: { family: 4 } },
    );
    await assert.rejects(transport.requestJson("info", {}), { code: "unsafe-address" });
    assert.ok(call >= 2, "the socket-time lookup ran");
    assert.equal(fixture.requests.length, 0, "no HTTP request is sent");
    assert.equal(fixture.connections(), 0, "no TCP connection is opened");
    await transport.close();
  } finally {
    await fixture?.close();
  }
});

test("a socket lookup that resolves after an abort opens no connection", async () => {
  let fixture: Fixture | undefined;
  try {
    fixture = await startServer((_req, res) => json(res, { Id: "s", Version: "1" }));
    const port = new URL(fixture.origin).port;
    let lookups = 0;
    let release: ((value: LookupAddress[]) => void) | undefined;
    const lookupAll = async () => {
      lookups += 1;
      if (lookups === 1) return [{ address: "127.0.0.1", family: 4 }];
      return new Promise<LookupAddress[]>((resolve) => { release = resolve; });
    };
    const transport = createMediaServerTransport(
      { baseUrl: `http://late.example:${port}`, allowLan: false, allowLoopback: true },
      { lookupAll },
    );
    const controller = new AbortController();
    const pending = assert.rejects(transport.requestJson("info", {}, undefined, controller.signal), { code: "cancelled" });
    while (lookups < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await pending;
    release?.([{ address: "127.0.0.1", family: 4 }]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fixture.connections(), 0, "the late socket lookup opened no TCP connection");
    assert.equal(fixture.requests.length, 0);
    await transport.close();
  } finally {
    await fixture?.close();
  }
});

test("normalized URL length and the IPv6 documentation prefix have exact bounds", () => {
  assert.throws(() => normalizeMediaServerUrl(`https://media.example/${"中".repeat(300)}`), { code: "invalid-input" });
  const policy = { allowLan: false, allowLoopback: false };
  assert.doesNotThrow(() => assertMediaServerAddress("3ffe::1", policy));
  assert.throws(() => assertMediaServerAddress("3fff:fff::1", policy), { code: "unsafe-address" });
  assert.doesNotThrow(() => assertMediaServerAddress("3fff:1000::1", policy));
});

test("an aborted socket lookup cannot borrow another request's lifetime", { timeout: 5000 }, async () => {
  const fixture = await startServer((_req, res) => json(res, { Id: "s", Version: "1" }));
  let count = 0;
  let releaseFirst: ((answers: LookupAddress[]) => void) | undefined;
  let releaseSecond: ((answers: LookupAddress[]) => void) | undefined;
  const answers = [{ address: "127.0.0.1", family: 4 }];
  const lookupAll = async () => {
    count += 1;
    if (count === 2) return new Promise<LookupAddress[]>((resolve) => { releaseFirst = resolve; });
    if (count === 4) return new Promise<LookupAddress[]>((resolve) => { releaseSecond = resolve; });
    return answers;
  };
  const transport = createMediaServerTransport({ baseUrl: `http://concurrent.example:${new URL(fixture.origin).port}`, allowLan: false, allowLoopback: true }, { lookupAll });
  try {
    const controller = new AbortController();
    const first = assert.rejects(transport.requestJson("info", {}, undefined, controller.signal), { code: "cancelled" });
    while (!releaseFirst) await new Promise((resolve) => setTimeout(resolve, 5));
    const second = transport.requestJson("info", {});
    void second.catch(() => undefined);
    while (!releaseSecond) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await first;
    releaseFirst(answers);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fixture.connections(), 0);
    releaseSecond(answers);
    assert.deepEqual(await second, { Id: "s", Version: "1" });
    assert.equal(fixture.connections(), 1);
    assert.equal(fixture.requests.length, 1);
  } finally {
    releaseFirst?.(answers);
    releaseSecond?.(answers);
    await transport.close();
    await fixture.close();
  }
});

test("the original transport builds the fixed static path, auth and sanitized headers", async () => {
  let fixture: Fixture | undefined;
  try {
    const data = Buffer.from("0123456789abcdef");
    fixture = await startServer((req, res) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ""));
      if (req.method === "HEAD") {
        res.writeHead(200, {
          "content-length": String(data.length),
          "accept-ranges": "bytes",
          "content-type": "video/mp4",
          etag: '"v1"',
          "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT",
          "set-cookie": "secret=1",
          server: "Jellyfin",
          location: "/nope",
        });
        res.end();
        return;
      }
      if (match) {
        const start = Number(match[1]);
        const end = Number(match[2]);
        res.writeHead(206, {
          "content-range": `bytes ${start}-${end}/${data.length}`,
          "content-length": String(end - start + 1),
          "accept-ranges": "bytes",
          "content-type": "video/mp4",
        });
        res.end(data.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { "content-length": String(data.length), "content-type": "video/mp4" });
      res.end(data);
    });
    const transport = createMediaServerTransport({ baseUrl: `${fixture.origin}/prefix`, allowLan: false, allowLoopback: true, deviceId: "mconn_original-identity" });

    const ranged = await transport.requestOriginal({ itemId: "it-1", mediaSourceId: "ms-1", method: "GET", range: "bytes=4-7" }, "tok");
    assert.equal(ranged.status, 206);
    assert.equal((await readMedia(ranged.body)).toString("utf8"), "4567");
    assert.equal(ranged.headers.get("content-range"), "bytes 4-7/16");
    assert.equal(ranged.headers.get("content-length"), "4");
    assert.equal(ranged.headers.get("accept-ranges"), "bytes");
    assert.equal(ranged.url, "", "the sanitized response carries no upstream URL");
    assert.equal(ranged.statusText, "", "the sanitized response carries no upstream status text");
    const request = fixture.requests[0];
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/prefix/Videos/it-1/stream?Static=true&MediaSourceId=ms-1");
    assert.equal(request.url.includes("tok"), false, "the token never appears in the request line");
    assert.equal(request.headers.range, "bytes=4-7");
    assert.equal(request.headers.accept, "application/octet-stream");
    // Undici appends its own `accept-encoding: identity` when a Range header is present, so the
    // upstream may see the coding twice; the only coding sent is still identity.
    const codings = String(request.headers["accept-encoding"]).split(",").map((value) => value.trim());
    assert.ok(codings.length >= 1 && codings.every((value) => value === "identity"), "no compression is requested");
    assert.equal(request.headers["x-emby-token"], "tok");
    assert.match(request.headers.authorization ?? "", /DeviceId="mconn_original-identity"/);
    assert.match(request.headers.authorization ?? "", /Token="tok"/);

    const head = await transport.requestOriginal({ itemId: "it-1", mediaSourceId: "ms-1", method: "HEAD" }, "tok");
    assert.equal(head.status, 200);
    assert.equal(head.body, null, "a HEAD response has no body");
    assert.equal(head.headers.get("content-length"), "16");
    assert.equal(head.headers.get("etag"), '"v1"');
    assert.equal(head.headers.get("last-modified"), "Wed, 21 Oct 2015 07:28:00 GMT");
    assert.equal(head.headers.get("content-type"), "video/mp4");
    assert.equal(head.headers.get("set-cookie"), null, "cookies are never copied");
    assert.equal(head.headers.get("server"), null, "the upstream server name is dropped");
    assert.equal(head.headers.get("location"), null, "Location is never copied");
    assert.equal(fixture.requests[1].method, "HEAD");
    assert.equal(fixture.requests[1].headers.range, undefined);
    await transport.close();
  } finally {
    await fixture?.close();
  }
});

test("original arguments are validated before any network work", async () => {
  let fixture: Fixture | undefined;
  try {
    fixture = await startServer((_req, res) => { res.writeHead(200); res.end(); });
    const transport = open(fixture.origin);
    const good = { itemId: "it", mediaSourceId: "ms", method: "GET" } as const;
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["unknown key", () => transport.requestOriginal({ ...good, url: "http://evil" } as never, "tok")],
      ["raw path", () => transport.requestOriginal({ ...good, path: "/x" } as never, "tok")],
      ["header injection", () => transport.requestOriginal({ ...good, headers: { range: "bytes=0-1" } } as never, "tok")],
      ["missing method", () => transport.requestOriginal({ itemId: "it", mediaSourceId: "ms" } as never, "tok")],
      ["unsupported method", () => transport.requestOriginal({ ...good, method: "POST" } as never, "tok")],
      ["null request", () => transport.requestOriginal(null as never, "tok")],
      ["array request", () => transport.requestOriginal([] as never, "tok")],
      ["item separator", () => transport.requestOriginal({ ...good, itemId: "a/b" }, "tok")],
      ["item dot segment", () => transport.requestOriginal({ ...good, itemId: ".." }, "tok")],
      ["empty media source", () => transport.requestOriginal({ ...good, mediaSourceId: "" }, "tok")],
      ["range of the wrong type", () => transport.requestOriginal({ ...good, range: 5 } as never, "tok")],
      ["a token that cannot be sent", () => transport.requestOriginal(good, 'bad"token')],
    ];
    for (const [label, call] of calls) await assert.rejects(call(), { code: "invalid-input" }, label);
    assert.equal(fixture.requests.length, 0, "a refused original request never reaches the socket");
    await transport.close();
  } finally {
    await fixture?.close();
  }
});

test("exactly one canonical byte range is accepted and canonicalized", async () => {
  let fixture: Fixture | undefined;
  try {
    fixture = await startServer((req, res) => { res.writeHead(200, { "content-length": req.method === "HEAD" ? "10" : "0" }); res.end(); });
    const transport = open(fixture.origin);
    const base = { itemId: "it", mediaSourceId: "ms", method: "GET" } as const;
    const accepted: Array<[string, string]> = [
      ["bytes=0-0", "bytes=0-0"],
      ["bytes=0-3", "bytes=0-3"],
      ["bytes=5-", "bytes=5-"],
      ["bytes=-5", "bytes=5-9"],
      ["bytes=0-", "bytes=0-"],
    ];
    for (const [input, expected] of accepted) {
      const response = await transport.requestOriginal({ ...base, range: input }, "tok");
      await response.body?.cancel();
      assert.equal(fixture.requests.at(-1)?.headers.range, expected, input);
    }
    const before = fixture.requests.length;
    for (const input of [
      "", "bytes=", "bytes=-", "bytes=-0", "bytes=3-1", "bytes=0-1,3-4", "bytes=0 - 1", "bytes=+1-2",
      "bytes=01-2", "bytes= 0-1", "bytes=0-1\r\nX: y", "items=0-1", "bytes=1-2-3",
      "bytes=99999999999999999999-1", "bytes=-99999999999999999999", "bytes=0-1\\", `bytes=${"0".repeat(123)}`,
    ]) {
      await assert.rejects(transport.requestOriginal({ ...base, range: input } as never, "tok"), { code: "invalid-input" }, input);
    }
    assert.equal(fixture.requests.length, before, "an invalid range never reaches the socket");
    await transport.close();
  } finally {
    await fixture?.close();
  }
});

test("original statuses map to typed errors and a 416 keeps only its sanitized range", async () => {
  let fixture: Fixture | undefined;
  try {
    const leak = "UPSTREAM-SECRET-PAYLOAD";
    fixture = await startServer((req, res) => {
      const id = new URL(req.url ?? "/", "http://placeholder").pathname.split("/")[2];
      if (id === "st401") { res.writeHead(401, { "content-type": "text/plain", "set-cookie": "s=1" }); res.end(leak); return; }
      if (id === "st403") { res.writeHead(403); res.end(leak); return; }
      if (id === "st404") { res.writeHead(404); res.end(leak); return; }
      if (id === "st429") { res.writeHead(429, { "retry-after": "600" }); res.end(leak); return; }
      if (id === "st500") { res.writeHead(500); res.end(leak); return; }
      if (id === "st416") { res.writeHead(416, { "content-range": "bytes */100", "content-length": String(leak.length), "content-type": "text/html" }); res.end(leak); return; }
      res.writeHead(200, { "content-length": "0" }); res.end();
    });
    const transport = open(fixture.origin);
    const call = (itemId: string) => transport.requestOriginal({ itemId, mediaSourceId: "ms", method: "GET" }, "tok");
    const fails = async (itemId: string, code: string, status?: number) => {
      const error = await call(itemId).then(() => undefined, (value) => value as MediaServerError);
      assert.equal(error?.code, code, itemId);
      if (status !== undefined) assert.equal(error?.status, status, itemId);
      assert.equal(error?.message.includes(leak), false, itemId);
    };
    await fails("st401", "authentication-required", 401);
    await fails("st403", "forbidden", 403);
    await fails("st404", "not-found", 404);
    await fails("st500", "unavailable", 500);

    const unsatisfied = await call("st416");
    assert.equal(unsatisfied.status, 416);
    assert.equal(unsatisfied.body, null);
    assert.equal(unsatisfied.headers.get("content-range"), "bytes */100");
    assert.equal(unsatisfied.headers.get("content-length"), null, "the error-document length is not copied");

    // A 429 parks the whole transport, so it is the last request this fixture takes.
    const limited = await call("st429").then(() => undefined, (value) => value as MediaServerError);
    assert.equal(limited?.code, "rate-limited");
    assert.equal(limited?.retryAfterMs, 300_000, "the hint is clamped");
    await transport.close();
  } finally {
    await fixture?.close();
  }
});

test("malformed 206, length and encoding responses are refused", async () => {
  const closedStream = () => new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
  const cases: Array<[string, () => Response]> = [
    ["206 without content-range", () => new Response(closedStream(), { status: 206 })],
    ["206 with a wildcard total", () => new Response(closedStream(), { status: 206, headers: { "content-range": "bytes 0-3/*" } })],
    ["206 with an inconsistent length", () => new Response(closedStream(), { status: 206, headers: { "content-range": "bytes 0-3/10", "content-length": "5" } })],
    ["206 with a reversed span", () => new Response(closedStream(), { status: 206, headers: { "content-range": "bytes 5-3/10" } })],
    ["200 with a malformed length", () => new Response("x", { status: 200, headers: { "content-length": "abc" } })],
    ["a non-identity encoding", () => new Response("x", { status: 200, headers: { "content-encoding": "x-custom" } })],
    ["a 200 without a body", () => new Response(null, { status: 200 })],
  ];
  for (const [label, build] of cases) {
    const transport = createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true }, { fetch: async () => build() });
    await assert.rejects(transport.requestOriginal({ itemId: "it", mediaSourceId: "ms", method: "GET" }, "tok"), { code: "invalid-response" }, label);
    await transport.close();
  }
});

test("only safe bounded headers are copied and content-type defaults", async () => {
  const transport = createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true }, {
    fetch: async () => new Response("x", {
      status: 200,
      headers: { "content-type": "x".repeat(300), "accept-ranges": "millimeters", etag: "e".repeat(600), "last-modified": "d".repeat(200) },
    }),
  });
  const response = await transport.requestOriginal({ itemId: "it", mediaSourceId: "ms", method: "GET" }, "tok");
  assert.equal(response.headers.get("content-type"), "application/octet-stream", "an oversized content-type falls back");
  assert.equal(response.headers.get("accept-ranges"), null);
  assert.equal(response.headers.get("etag"), null, "an oversized etag is dropped");
  assert.equal(response.headers.get("last-modified"), null, "an oversized date is dropped");
  assert.equal(response.headers.get("content-length"), null, "no length is invented");
  assert.equal((await readMedia(response.body)).toString("utf8"), "x");
  await transport.close();
});

test("eight originals stream independently in their own pool while metadata runs", async () => {
  let streams = 0;
  const transport = createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true }, {
    fetch: async (url) => {
      if (url.includes("/stream")) { streams += 1; return heldMedia(); }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const open = (id: string) => transport.requestOriginal({ itemId: id, mediaSourceId: "ms", method: "GET" }, "tok");
  const held = await Promise.all(Array.from({ length: 8 }, (_value, index) => open(`it-${index}`)));
  assert.equal(held.length, 8);
  assert.equal(streams, 8);
  await assert.rejects(open("it-9"), { code: "busy" }, "all eight slots stay occupied after headers");
  assert.deepEqual(await transport.requestJson("info", {}), { ok: true }, "metadata keeps its separate pool");

  await held[0].body?.cancel();
  const ninth = await open("it-9");
  assert.equal(streams, 9, "cancelling one original frees exactly one slot");
  await ninth.body?.cancel();

  await transport.close();
  assert.equal(await held[1].body!.getReader().read().then(() => "resolved", (error) => (error as MediaServerError).code), "closed");
  await assert.rejects(open("it-10"), { code: "closed" }, "a new original after close is refused");
  // The remaining bodies were already errored by close, so cancelling them rejects with the same
  // stored error; that is exactly the intended "error rather than quietly complete" behaviour.
  await Promise.all(held.slice(2).map((response) => response.body!.cancel().then(() => "cancelled", (error) => (error as MediaServerError).code)));
});

test("an original that never answers times out and frees its slot", async () => {
  let first = true;
  const transport = createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true }, {
    originalHeaderMs: 25,
    fetch: async () => {
      if (first) { first = false; return new Promise<Response>(() => { /* never settles without an abort */ }); }
      return new Response("x", { status: 200, headers: { "content-length": "1" } });
    },
  });
  await assert.rejects(transport.requestOriginal({ itemId: "t", mediaSourceId: "ms", method: "GET" }, "tok"), { code: "timeout" });
  const ok = await transport.requestOriginal({ itemId: "t", mediaSourceId: "ms", method: "GET" }, "tok");
  assert.equal((await readMedia(ok.body)).toString("utf8"), "x", "the slot was released");
  await transport.close();
});

test("a stalled original body hits the idle deadline", async () => {
  const transport = createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true }, {
    originalIdleMs: 25,
    originalLifetimeMs: 60_000,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([7])); } }), { status: 200 }),
  });
  const response = await transport.requestOriginal({ itemId: "t", mediaSourceId: "ms", method: "GET" }, "tok");
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.deepEqual([...(first.value ?? [])], [7]);
  await assert.rejects(reader.read(), { code: "timeout" });
  await transport.close();
});

test("an original stream that outlives its lifetime is aborted", async () => {
  const transport = createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true }, {
    originalLifetimeMs: 25,
    fetch: async () => heldMedia(),
  });
  const response = await transport.requestOriginal({ itemId: "t", mediaSourceId: "ms", method: "GET" }, "tok");
  await assert.rejects(response.body!.getReader().read(), { code: "timeout" }, "the lifetime deadline fires before the idle one");
  await transport.close();
});

test("a caller abort before headers cancels and frees the slot", async () => {
  let first = true;
  const transport = createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true }, {
    fetch: async () => {
      if (first) { first = false; return new Promise<Response>(() => { /* never settles */ }); }
      return new Response("x", { status: 200, headers: { "content-length": "1" } });
    },
  });
  const controller = new AbortController();
  const pending = assert.rejects(transport.requestOriginal({ itemId: "t", mediaSourceId: "ms", method: "GET" }, "tok", controller.signal), { code: "cancelled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await pending;
  const ok = await transport.requestOriginal({ itemId: "t", mediaSourceId: "ms", method: "GET" }, "tok");
  assert.equal((await readMedia(ok.body)).toString("utf8"), "x");
  await transport.close();
});

test("a caller abort during the body errors the readable and frees the slot", async () => {
  const transport = createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true }, {
    fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); } }), { status: 200 }),
  });
  const controller = new AbortController();
  const response = await transport.requestOriginal({ itemId: "t", mediaSourceId: "ms", method: "GET" }, "tok", controller.signal);
  const reader = response.body!.getReader();
  await reader.read();
  controller.abort();
  await assert.rejects(reader.read(), { code: "cancelled" });
  await transport.close();
});

test("a stalled upstream cancel cannot hold the slot or block close", async () => {
  let first = true;
  const transport = createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true }, {
    fetch: async () => {
      if (first) {
        first = false;
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { return new Promise<void>(() => { /* never settles */ }); } }), { status: 200 });
      }
      return new Response("y", { status: 200, headers: { "content-length": "1" } });
    },
  });
  const response = await transport.requestOriginal({ itemId: "t", mediaSourceId: "ms", method: "GET" }, "tok");
  await response.body!.cancel();
  const ok = await transport.requestOriginal({ itemId: "t", mediaSourceId: "ms", method: "GET" }, "tok");
  assert.equal((await readMedia(ok.body)).toString("utf8"), "y", "the slot was freed despite the stalled cancel");
  const outcome = await Promise.race([
    transport.close().then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
  ]);
  assert.equal(outcome, "closed");
});

test("an upstream body failure becomes a fixed error and frees the slot", async () => {
  let first = true;
  const transport = createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true }, {
    fetch: async () => {
      if (first) { first = false; return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("UPSTREAM-SECRET")); } }), { status: 200 }); }
      return new Response("z", { status: 200, headers: { "content-length": "1" } });
    },
  });
  const response = await transport.requestOriginal({ itemId: "t", mediaSourceId: "ms", method: "GET" }, "tok");
  const error = await response.body!.getReader().read().then(() => undefined, (value) => value as MediaServerError);
  assert.equal(error?.code, "unavailable");
  assert.equal(error?.message.includes("UPSTREAM-SECRET"), false);
  const ok = await transport.requestOriginal({ itemId: "t", mediaSourceId: "ms", method: "GET" }, "tok");
  assert.equal((await readMedia(ok.body)).toString("utf8"), "z", "the slot was released");
  await transport.close();
});

test("the original transport reuses the full DNS, opt-in and redirect guard", async () => {
  const policy = { allowLan: false, allowLoopback: false };
  const never = () => { throw new Error("fetch must not run"); };

  const blocked = createMediaServerTransport({ baseUrl: "http://media.example", ...policy }, { lookupAll: async () => [{ address: "169.254.1.1", family: 4 }], fetch: never });
  await assert.rejects(blocked.requestOriginal({ itemId: "t", mediaSourceId: "ms", method: "GET" }, "tok"), { code: "unsafe-address" });
  await blocked.close();

  const mixed = createMediaServerTransport({ baseUrl: "http://media.example", ...policy }, { lookupAll: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }], fetch: never });
  await assert.rejects(mixed.requestOriginal({ itemId: "t", mediaSourceId: "ms", method: "GET" }, "tok"), { code: "unsafe-address" });
  await mixed.close();

  assert.throws(() => createMediaServerTransport({ baseUrl: "http://10.0.0.1", allowLan: false, allowLoopback: false }), { code: "unsafe-address" });
  assert.doesNotThrow(() => createMediaServerTransport({ baseUrl: "http://10.0.0.1", allowLan: true, allowLoopback: false }));

  let fixture: Fixture | undefined;
  try {
    fixture = await startServer((_req, res) => { res.writeHead(302, { location: "/elsewhere" }); res.end(); });
    const redirect = open(fixture.origin);
    await assert.rejects(redirect.requestOriginal({ itemId: "t", mediaSourceId: "ms", method: "GET" }, "tok"), { code: "invalid-response" });
    await redirect.close();
  } finally {
    await fixture?.close();
  }

  let call = 0;
  const lookupAll = async () => {
    call += 1;
    return call === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "169.254.10.10", family: 4 }];
  };
  const rebind = createMediaServerTransport({ baseUrl: "http://media.example", ...policy }, { lookupAll });
  try {
    await assert.rejects(rebind.requestOriginal({ itemId: "t", mediaSourceId: "ms", method: "GET" }, "tok"), { code: "unsafe-address" });
    assert.ok(call >= 2, "the socket-time lookup was consulted");
  } finally {
    await rebind.close();
  }
});

test("original test deadlines are bounded at construction", () => {
  assert.equal(MEDIA_SERVER_ORIGINAL_LIMITS.concurrency, 8);
  assert.equal(MEDIA_SERVER_ORIGINAL_LIMITS.headerMs, 10_000);
  assert.equal(MEDIA_SERVER_ORIGINAL_LIMITS.idleMs, 30_000);
  assert.equal(MEDIA_SERVER_ORIGINAL_LIMITS.lifetimeMs, 6 * 60 * 60 * 1000);
  assert.equal(MEDIA_SERVER_ORIGINAL_LIMITS.rangeMax, 128);
  const base = { baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true };
  for (const bad of [0, -1, 1.5, 20_001, Number.POSITIVE_INFINITY, Number.NaN, "10"]) {
    assert.throws(() => createMediaServerTransport(base, { originalHeaderMs: bad as never }), { code: "invalid-input" }, String(bad));
  }
  assert.throws(() => createMediaServerTransport(base, { originalIdleMs: 30_001 }), { code: "invalid-input" });
  assert.throws(() => createMediaServerTransport(base, { originalLifetimeMs: 6 * 60 * 60 * 1000 + 1 }), { code: "invalid-input" });
  assert.doesNotThrow(() => createMediaServerTransport(base, { originalHeaderMs: 10_000, originalIdleMs: 1, originalLifetimeMs: 5 }));
});

test("aborting a backpressured original frees its slot and cancels the upstream immediately", async () => {
  let cancelled = 0;
  const transport = createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true }, {
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
      cancel() { cancelled += 1; },
    })),
  });
  const request = { itemId: "movie", mediaSourceId: "version", method: "GET" as const };
  const controller = new AbortController();
  const responses: Response[] = [];
  try {
    responses.push(await transport.requestOriginal(request, "safe-token", controller.signal));
    for (let count = 1; count < 8; count += 1) responses.push(await transport.requestOriginal(request, "safe-token"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    assert.equal(cancelled, 1);
    responses.push(await transport.requestOriginal(request, "safe-token"));
    await assert.rejects(responses[0]!.arrayBuffer(), { code: "cancelled" });
    await transport.close();
    assert.equal(cancelled, 9);
    await assert.rejects(responses[1]!.arrayBuffer(), { code: "closed" });
  } finally {
    for (const response of responses) await response.body?.cancel().catch(() => undefined);
    await transport.close();
  }
});

test("original media refuses a different range and incomplete or overlong bodies", async () => {
  const samples: Array<{ status: number; headers: Record<string, string>; bytes: number[]; range?: string; headersFail: boolean }> = [
    { status: 206, headers: { "content-range": "bytes 0-2/6" }, bytes: [1, 2, 3], range: "bytes=3-5", headersFail: true },
    { status: 200, headers: { "content-length": "4" }, bytes: [1, 2, 3], range: undefined, headersFail: false },
    { status: 200, headers: { "content-length": "2" }, bytes: [1, 2, 3], range: undefined, headersFail: false },
    { status: 206, headers: { "content-range": "bytes 3-5/6" }, bytes: [1, 2], range: "bytes=3-5", headersFail: false },
  ];
  for (const sample of samples) {
    let cancelled = false;
    const transport = createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true }, {
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(sample.bytes)); controller.close(); },
        cancel() { cancelled = true; },
      }), { status: sample.status, headers: sample.headers }),
    });
    try {
      const pending = transport.requestOriginal({ itemId: "movie", mediaSourceId: "version", method: "GET", range: sample.range }, "safe-token");
      if (sample.headersFail) {
        await assert.rejects(pending, { code: "invalid-response" });
        assert.equal(cancelled, true);
      } else {
        const response = await pending;
        await assert.rejects(response.arrayBuffer(), { code: "invalid-response" });
      }
    } finally { await transport.close(); }
  }
});

test("original media refuses a different range but accepts a shorter or longer span at the same start", async () => {
  const samples: Array<{ range: string; contentRange: string; bytes: number[] }> = [
    { range: "bytes=0-1", contentRange: "bytes 0-5/6", bytes: [1, 2, 3, 4, 5, 6] },
    { range: "bytes=0-10", contentRange: "bytes 0-2/6", bytes: [1, 2, 3] },
  ];
  for (const sample of samples) {
    const transport = createMediaServerTransport({ baseUrl: "http://127.0.0.1", allowLan: false, allowLoopback: true }, {
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(sample.bytes)); controller.close(); },
      }), { status: 206, headers: { "content-range": sample.contentRange } }),
    });
    try {
      const response = await transport.requestOriginal({ itemId: "movie", mediaSourceId: "version", method: "GET", range: sample.range }, "safe-token");
      assert.equal(response.headers.get("content-range"), sample.contentRange, sample.range);
      assert.equal((await response.arrayBuffer()).byteLength, sample.bytes.length, sample.range);
    } finally { await transport.close(); }
  }
});

test("directory pins Recursive, the folder-admitting type set, the fixed sort pair and drops every other field", async () => {
  const captured: string[] = [];
  const transport = createMediaServerTransport({ baseUrl: "http://media.example", allowLan: false, allowLoopback: false }, {
    lookupAll: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (url) => {
      captured.push(url);
      return new Response(JSON.stringify({ Items: [], TotalRecordCount: 0 }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const query = (index: number) => new URL(captured[index]!).searchParams;
  try {
    await transport.requestJson("directory", {
      userId: "user-1", parentId: "library-1", includeItemTypes: "Folder,Movie,Series,Season,Episode,MusicVideo",
      recursive: false, sortBy: "SortName", sortOrder: "Ascending", startIndex: 0, limit: 60,
    }, "safe-token");
    assert.equal(query(0).get("Recursive"), "false");
    assert.equal(query(0).get("IncludeItemTypes"), "Folder,Movie,Series,Season,Episode,MusicVideo");
    assert.equal(query(0).get("SortBy"), "SortName");
    assert.equal(query(0).get("SortOrder"), "Ascending");
    assert.equal(query(0).get("StartIndex"), "0");
    assert.equal(query(0).get("Limit"), "60");
    assert.ok(query(0).get("Fields")?.includes("ImageTags"), "the directory query asks for image tags");
    assert.equal(query(0).get("SearchTerm"), null);

    await transport.requestJson("directory", {
      userId: "user-1", parentId: "series-1", includeItemTypes: "Episode",
      recursive: true, sortBy: "Size", sortOrder: "Descending", limit: 4, searchTerm: "alien",
    }, "safe-token");
    assert.equal(query(1).get("Recursive"), "true");
    assert.equal(query(1).get("IncludeItemTypes"), "Episode");
    assert.equal(query(1).get("SortBy"), "Size");
    assert.equal(query(1).get("SortOrder"), "Descending");
    assert.equal(query(1).get("SearchTerm"), "alien");

    const rejected: Array<[string, Record<string, unknown>]> = [
      ["unknown field", { userId: "u", parentId: "p", includeItemTypes: "Movie", recursive: false, sortBy: "SortName", sortOrder: "Ascending", rawUrl: "/x" }],
      ["non-boolean recursion", { userId: "u", parentId: "p", includeItemTypes: "Movie", recursive: "false", sortBy: "SortName", sortOrder: "Ascending" }],
      ["unsupported type", { userId: "u", parentId: "p", includeItemTypes: "Music", recursive: false, sortBy: "SortName", sortOrder: "Ascending" }],
      ["unsupported sort", { userId: "u", parentId: "p", includeItemTypes: "Movie", recursive: false, sortBy: "Name", sortOrder: "Ascending" }],
      ["unsupported order", { userId: "u", parentId: "p", includeItemTypes: "Movie", recursive: false, sortBy: "SortName", sortOrder: "asc" }],
      ["raw parent path", { userId: "u", parentId: "a/b", includeItemTypes: "Movie", recursive: false, sortBy: "SortName", sortOrder: "Ascending" }],
      ["limit out of range", { userId: "u", parentId: "p", includeItemTypes: "Movie", recursive: false, sortBy: "SortName", sortOrder: "Ascending", limit: 201 }],
    ];
    for (const [label, args] of rejected) {
      await assert.rejects(transport.requestJson("directory", args as never, "safe-token"), { code: "invalid-input" }, label);
    }
    assert.equal(captured.length, 2, "a refused directory request never reaches the socket");
  } finally {
    await transport.close();
  }
});

/** A permitted raster body whose leading bytes are the JPEG signature the transport sniffs. */
const jpegBytes = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff; bytes[3] = 0xe0;
  return bytes;
};

/** An image response that returns validated headers at once but never ends its body, so a test can
 *  prove the image slot outlives the headers. */
const heldImage = (): Response => new Response(
  new ReadableStream<Uint8Array>({ start() { /* stays open until released or cancelled */ } }),
  { status: 200, headers: { "content-type": "image/jpeg" } },
);

const imageFetch = (url: string): boolean => url.includes("/Images/");

test("artwork streams the first image bytes before the rest of the body arrives", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const transport = createMediaServerTransport({ baseUrl: "http://media.example", allowLan: false, allowLoopback: false }, {
    lookupAll: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(value) { controller = value; controller.enqueue(jpegBytes(48)); },
    }), { status: 200, headers: { "content-type": "image/jpeg" } }),
  });
  try {
    const response = await transport.requestArtwork({ itemId: "i1", imageType: "Primary", tag: "abc" }, "tok");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false, "the first chunk resolves before the body ends");
    assert.deepEqual([...first.value!.slice(0, 3)], [0xff, 0xd8, 0xff]);
    controller.enqueue(jpegBytes(16));
    controller.close();
    const rest = await reader.read();
    assert.equal(rest.done, false);
    assert.equal(rest.value!.byteLength, 16);
    assert.equal((await reader.read()).done, true);
  } finally {
    await transport.close();
  }
});

test("artwork refuses a declared oversized image, an unsafe type and a transformed body", async () => {
  const cases: Array<[string, () => Promise<Response>, string]> = [
    ["declared oversized", async () => new Response(null, { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(5 * 1024 * 1024 + 1) } }), "response-too-large"],
    ["unsafe type", async () => new Response(null, { status: 200, headers: { "content-type": "text/html" } }), "invalid-response"],
    ["transformed", async () => new Response(null, { status: 200, headers: { "content-type": "image/jpeg", "content-encoding": "gzip" } }), "invalid-response"],
    ["not ok", async () => new Response(null, { status: 500 }), "unavailable"],
  ];
  for (const [label, fetch, code] of cases) {
    const transport = stubbed(fetch);
    await assert.rejects(transport.requestArtwork({ itemId: "i", imageType: "Primary" }, "tok"), { code }, label);
    await transport.close();
  }
});

test("artwork cuts off a body that exceeds its byte cap", async () => {
  const megabyte = jpegBytes(1024 * 1024);
  let sent = 0;
  const transport = stubbed(async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= 6) { controller.close(); return; }
      sent += 1;
      controller.enqueue(megabyte.slice());
    },
  }), { status: 200, headers: { "content-type": "image/jpeg" } }));
  try {
    const response = await transport.requestArtwork({ itemId: "i", imageType: "Primary" }, "tok");
    await assert.rejects(readMedia(response.body), { code: "response-too-large" });
  } finally {
    await transport.close();
  }
});

test("artwork holds its own thirty-two slots and answers an overflow with busy", async () => {
  const transport = stubbed(async () => heldImage());
  try {
    const live = await Promise.all(Array.from({ length: 32 }, (_, index) =>
      transport.requestArtwork({ itemId: `i${index}`, imageType: "Primary" }, "tok")));
    assert.equal(live.length, 32);
    await assert.rejects(transport.requestArtwork({ itemId: "overflow", imageType: "Primary" }, "tok"), { code: "busy" });
  } finally {
    await transport.close();
  }
});

test("twenty-four concurrent artworks leave the metadata pool and its DNS slots free", async () => {
  let releaseLookup!: () => void;
  const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
  const transport = createMediaServerTransport({ baseUrl: "http://media.example", allowLan: false, allowLoopback: false }, {
    lookupAll: async () => { await lookupGate; return [{ address: "93.184.216.34", family: 4 }]; },
    fetch: async (url) => imageFetch(url)
      ? heldImage()
      : new Response(JSON.stringify({ Id: "server-1", Version: "1" }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  try {
    const artworks = Array.from({ length: 24 }, (_, index) =>
      transport.requestArtwork({ itemId: `i${index}`, imageType: "Primary" }, "tok"));
    // Every image lookup is parked on the gate at once. Were image DNS sharing the four metadata
    // slots, the fifth lookup would already be refused with busy.
    await new Promise((resolve) => setImmediate(resolve));
    releaseLookup();
    const settled = await Promise.allSettled(artworks);
    assert.equal(settled.filter((entry) => entry.status === "rejected").length, 0, "every artwork resolved its headers");
    const info = await transport.requestJson("info", {});
    assert.deepEqual(info, { Id: "server-1", Version: "1" }, "metadata still runs while 24 image slots are held");
  } finally {
    await transport.close();
  }
});

test("an artwork that never answers times out and frees its slot", async () => {
  let hang = true;
  const transport = createMediaServerTransport({ baseUrl: "http://media.example", allowLan: false, allowLoopback: false }, {
    lookupAll: async () => [{ address: "93.184.216.34", family: 4 }],
    imageHeaderMs: 30,
    fetch: async () => hang
      ? new Promise<Response>(() => { /* never answers */ })
      : new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(jpegBytes(40)); controller.close(); } }), { status: 200, headers: { "content-type": "image/jpeg" } }),
  });
  try {
    await assert.rejects(transport.requestArtwork({ itemId: "i", imageType: "Primary" }, "tok"), { code: "timeout" });
    hang = false;
    const ok = await transport.requestArtwork({ itemId: "i", imageType: "Primary" }, "tok");
    assert.equal(ok.status, 200, "the timed-out slot is free again");
    await readMedia(ok.body);
  } finally {
    await transport.close();
  }
});

test("a caller abort before artwork headers cancels and frees its slot", async () => {
  let hang = true;
  const transport = createMediaServerTransport({ baseUrl: "http://media.example", allowLan: false, allowLoopback: false }, {
    lookupAll: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async () => hang
      ? new Promise<Response>(() => { /* never answers */ })
      : new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(jpegBytes(40)); controller.close(); } }), { status: 200, headers: { "content-type": "image/jpeg" } }),
  });
  try {
    const controller = new AbortController();
    const pending = transport.requestArtwork({ itemId: "i", imageType: "Primary" }, "tok", controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, { code: "cancelled" });
    hang = false;
    const ok = await transport.requestArtwork({ itemId: "i", imageType: "Primary" }, "tok");
    assert.equal(ok.status, 200);
    await readMedia(ok.body);
  } finally {
    await transport.close();
  }
});

test("cancelling a held artwork body frees its slot immediately", async () => {
  let held = true;
  const transport = createMediaServerTransport({ baseUrl: "http://media.example", allowLan: false, allowLoopback: false }, {
    lookupAll: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async () => held
      ? heldImage()
      : new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(jpegBytes(40)); controller.close(); } }), { status: 200, headers: { "content-type": "image/jpeg" } }),
  });
  try {
    const first = await transport.requestArtwork({ itemId: "i1", imageType: "Primary" }, "tok");
    await first.body!.cancel();
    held = false;
    const second = await transport.requestArtwork({ itemId: "i2", imageType: "Primary" }, "tok");
    assert.equal(second.status, 200, "the cancelled slot is reusable");
  } finally {
    await transport.close();
  }
});

test("closing the transport errors a held artwork body and frees every image slot", async () => {
  const transport = stubbed(async () => heldImage());
  const responses = await Promise.all(Array.from({ length: 32 }, (_, index) =>
    transport.requestArtwork({ itemId: `i${index}`, imageType: "Primary" }, "tok")));
  await transport.close();
  await assert.rejects(readMedia(responses[0].body), { code: "closed" });
});

test("artwork shares the upstream 429 cooldown in both directions", async () => {
  let fetches = 0;
  const fromImage = stubbed(async (url) => {
    fetches += 1;
    return imageFetch(url)
      ? new Response(null, { status: 429, headers: { "retry-after": "2" } })
      : new Response(JSON.stringify({ Id: "s", Version: "1" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const limited = await failed(fromImage.requestArtwork({ itemId: "i", imageType: "Primary" }, "tok"));
  assert.equal(limited.code, "rate-limited");
  assert.equal(limited.retryAfterMs, 2_000);
  const blocked = await failed(fromImage.requestJson("info", {}));
  assert.equal(blocked.code, "rate-limited", "an image 429 parks the whole transport");
  assert.equal(fetches, 1, "the JSON request is refused locally during the cooldown");
  await fromImage.close();

  let jsonFetches = 0;
  const fromJson = stubbed(async () => { jsonFetches += 1; return new Response(null, { status: 429, headers: { "retry-after": "2" } }); });
  await failed(fromJson.requestJson("info", {}));
  const blockedImage = await failed(fromJson.requestArtwork({ itemId: "i", imageType: "Primary" }, "tok"));
  assert.equal(blockedImage.code, "rate-limited", "a metadata 429 parks artwork too");
  assert.equal(jsonFetches, 1);
  await fromJson.close();
});

test("artwork validates and encodes the tag before any network work", async () => {
  const captured: string[] = [];
  const transport = createMediaServerTransport({ baseUrl: "http://media.example", allowLan: false, allowLoopback: false }, {
    lookupAll: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (url) => {
      captured.push(url);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(jpegBytes(40)); controller.close(); } }), { status: 200, headers: { "content-type": "image/jpeg" } });
    },
  });
  try {
    const response = await transport.requestArtwork({ itemId: "i1", imageType: "Primary", tag: "Ab.c-9_~" }, "tok");
    assert.equal(new URL(captured[0]).searchParams.get("tag"), "Ab.c-9_~", "the tag round-trips through the query");
    await readMedia(response.body);
    for (const tag of ["", "a".repeat(129), "bad tag", "a&b", "a%20b", "a/b", "a?b", "héllo", 42, null]) {
      await assert.rejects(transport.requestArtwork({ itemId: "i", imageType: "Primary", tag: tag as never }, "tok"), { code: "invalid-input" }, String(tag));
    }
    assert.equal(captured.length, 1, "an invalid tag never reaches the socket");
  } finally {
    await transport.close();
  }
});

test("artwork builds the fixed detail width and refuses any other size", async () => {
  const captured: string[] = [];
  const transport = createMediaServerTransport({ baseUrl: "http://media.example", allowLan: false, allowLoopback: false }, {
    lookupAll: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (url) => {
      captured.push(url);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(jpegBytes(40)); controller.close(); } }), { status: 200, headers: { "content-type": "image/jpeg" } });
    },
  });
  try {
    for (const request of [
      { itemId: "i1", imageType: "Primary", tag: "Ab.c-9_~" } as const,
      { itemId: "i1", imageType: "Primary", tag: "Ab.c-9_~", size: "detail" } as const,
      { itemId: "i1", imageType: "Backdrop", size: "detail" } as const,
    ]) {
      await (await transport.requestArtwork(request, "tok")).arrayBuffer();
    }
    assert.deepEqual(captured.map((url) => new URL(url).searchParams.get("MaxWidth")), ["640", "1920", "1920"], "a tile keeps 640 while Primary and Backdrop detail both ask 1920");
    assert.equal(new URL(captured[1]).searchParams.get("tag"), "Ab.c-9_~", "the tag still round-trips beside a detail size");

    for (const size of ["wide", "Detail", "1920", "", "detail ", 1920, ["detail"], { width: 1920 }, null]) {
      await assert.rejects(transport.requestArtwork({ itemId: "i", imageType: "Primary", size: size as never }, "tok"), { code: "invalid-input" }, String(size));
    }
    for (const args of [
      { itemId: "i", imageType: "Primary", maxWidth: 1920 },
      { itemId: "i", imageType: "Primary", width: 1920 },
      { itemId: "i", imageType: "Primary", maxWidth: "1920" },
    ]) {
      await assert.rejects(transport.requestArtwork(args as never, "tok"), { code: "invalid-input" }, JSON.stringify(args));
    }
    assert.equal(captured.length, 3, "an invalid size or an arbitrary dimension never reaches the socket");
  } finally {
    await transport.close();
  }
});

test("artwork and match refuse raw fields, paths and tokens before any network work", async () => {
  const transport = stubbed(async () => new Response(null, { status: 200 }));
  try {
    const rejects: Array<() => Promise<unknown>> = [
      () => transport.requestArtwork({ itemId: "i", imageType: "Primary", rawUrl: "http://evil" } as never, "tok"),
      () => transport.requestArtwork({ itemId: "a/b", imageType: "Primary" } as never, "tok"),
      () => transport.requestArtwork({ itemId: "..", imageType: "Primary" } as never, "tok"),
      () => transport.requestArtwork({ itemId: "i", imageType: "Poster" } as never, "tok"),
      () => transport.requestArtwork({ itemId: "i" } as never, "tok"),
      () => transport.requestArtwork(null as never, "tok"),
      () => transport.requestArtwork({ itemId: "i", imageType: "Primary" }, 'bad"token'),
      () => transport.requestJson("match", { userId: "u", parentId: "p", provider: "plex", providerName: "imdb", providerId: "tt1", includeItemTypes: "Movie" } as never, "tok"),
      () => transport.requestJson("match", { userId: "u", parentId: "p", provider: "emby", providerName: "tvrage", providerId: "1", includeItemTypes: "Movie" } as never, "tok"),
      () => transport.requestJson("match", { userId: "u", parentId: "p", provider: "emby", providerName: "imdb", providerId: "not-an-id", includeItemTypes: "Movie" } as never, "tok"),
      () => transport.requestJson("match", { userId: "u", parentId: "p", provider: "emby", providerName: "imdb", providerId: "tt1", includeItemTypes: "Episode" } as never, "tok"),
      () => transport.requestJson("match", { userId: "u", parentId: "p", provider: "emby", providerName: "imdb", providerId: "tt1", includeItemTypes: "Movie", url: "/x" } as never, "tok"),
    ];
    for (const call of rejects) await assert.rejects(call(), { code: "invalid-input" });
  } finally {
    await transport.close();
  }
});

test("match builds Emby's exact AnyProviderIdEquals and Jellyfin's documented Has-id query", async () => {
  const captured: string[] = [];
  const transport = createMediaServerTransport({ baseUrl: "http://media.example", allowLan: false, allowLoopback: false }, {
    lookupAll: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (url) => {
      captured.push(url);
      return new Response(JSON.stringify({ Items: [] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    await transport.requestJson("match", { userId: "u1", parentId: "lib-1", provider: "emby", providerName: "imdb", providerId: "tt0133093", includeItemTypes: "Movie", limit: 200 }, "tok");
    await transport.requestJson("match", { userId: "u1", parentId: "lib-1", provider: "jellyfin", providerName: "tmdb", providerId: "603", includeItemTypes: "Series", searchTerm: "Alien", limit: 200 }, "tok");
    const emby = new URL(captured[0]).searchParams;
    assert.equal(emby.get("AnyProviderIdEquals"), "imdb.tt0133093");
    assert.equal(emby.get("SearchTerm"), null);
    assert.equal(emby.get("EnableImages"), "false");
    assert.equal(emby.get("EnableUserData"), "false");
    assert.equal(emby.get("Recursive"), "true");
    assert.equal(emby.get("ParentId"), "lib-1");
    assert.equal(emby.get("IncludeItemTypes"), "Movie");
    assert.equal(emby.get("Fields"), "ProviderIds,ParentId,SeriesInfo");
    assert.equal(emby.get("Limit"), "200");
    const jellyfin = new URL(captured[1]).searchParams;
    assert.equal(jellyfin.get("AnyProviderIdEquals"), null, "Jellyfin never receives the unsupported parameter");
    assert.equal(jellyfin.get("HasTmdbId"), "true");
    assert.equal(jellyfin.get("SearchTerm"), "Alien");
    assert.equal(jellyfin.get("IncludeItemTypes"), "Series");
  } finally {
    await transport.close();
  }
});

test("directory sends ParentIndexNumber and EnableTotalRecordCount only when asked", async () => {
  const captured: string[] = [];
  const transport = createMediaServerTransport({ baseUrl: "http://media.example", allowLan: false, allowLoopback: false }, {
    lookupAll: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (url) => {
      captured.push(url);
      return new Response(JSON.stringify({ Items: [], TotalRecordCount: 0 }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    await transport.requestJson("directory", { userId: "u", parentId: "series-1", includeItemTypes: "Episode", recursive: true, sortBy: "SortName", sortOrder: "Ascending", limit: 10, parentIndexNumber: 2, enableTotalRecordCount: false }, "tok");
    const query = new URL(captured[0]).searchParams;
    assert.equal(query.get("ParentIndexNumber"), "2");
    assert.equal(query.get("EnableTotalRecordCount"), "false");
    assert.equal(query.get("ImageTypeLimit"), "1");
    assert.equal(query.get("EnableImageTypes"), "Primary,Backdrop");
    assert.equal(query.get("EnableUserData"), "false");
    assert.deepEqual(String(query.get("Fields")).split(","), ["ProviderIds", "ParentId", "SeriesInfo", "ImageTags", "ChildCount"]);
    await transport.requestJson("directory", { userId: "u", parentId: "lib-1", includeItemTypes: "Movie", recursive: false, sortBy: "SortName", sortOrder: "Ascending" }, "tok");
    const plain = new URL(captured[1]).searchParams;
    assert.equal(plain.get("ParentIndexNumber"), null);
    assert.equal(plain.get("EnableTotalRecordCount"), null);
  } finally {
    await transport.close();
  }
});


test("artwork handles a raster signature split over short chunks without stalling", async () => {
  const jpeg = jpegBytes(32);
  const transport = stubbed(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(jpeg.slice(0, 2));
      controller.enqueue(jpeg.slice(2, 5));
      controller.enqueue(jpeg.slice(5, 10));
      controller.enqueue(jpeg.slice(10));
      controller.close();
    },
  }), { headers: { "content-type": "image/jpeg" } }));
  try {
    const response = await transport.requestArtwork({ itemId: "i", imageType: "Primary" }, "tok");
    assert.deepEqual(await readMedia(response.body), Buffer.from(jpeg));
  } finally { await transport.close(); }
});

test("artwork rejects an empty body and bytes beyond the declared length", async () => {
  const empty = stubbed(async () => new Response(null, { headers: { "content-type": "image/jpeg" } }));
  try { await assert.rejects(empty.requestArtwork({ itemId: "i", imageType: "Primary" }, "tok"), { code: "invalid-response" }); }
  finally { await empty.close(); }
  const oversized = stubbed(async () => new Response(jpegBytes(32), { headers: { "content-type": "image/jpeg", "content-length": "16" } }));
  try {
    const response = await oversized.requestArtwork({ itemId: "i", imageType: "Primary" }, "tok");
    await assert.rejects(readMedia(response.body), { code: "invalid-response" });
  } finally { await oversized.close(); }
});

test("real artwork sockets stream tagged images and reuse their connection pool", async () => {
  const jpeg = jpegBytes(32);
  const fixture = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "image/jpeg", "content-length": String(jpeg.length) });
    response.end(jpeg);
  });
  const transport = open(fixture.origin);
  try {
    for (let index = 0; index < 8; index++) {
      const response = await transport.requestArtwork({ itemId: "image", imageType: "Primary", tag: "tag-1" }, "tok");
      assert.deepEqual(await readMedia(response.body), Buffer.from(jpeg));
    }
    assert.equal(fixture.requests.length, 8);
    assert.ok(fixture.connections() < 8, "sequential images reuse HTTP connections");
    const query = new URL(fixture.requests[0]!.url, fixture.origin).searchParams;
    assert.equal(query.get("tag"), "tag-1");
    assert.equal(query.get("MaxWidth"), "640");
    assert.equal(query.get("Quality"), "85");
  } finally { await transport.close(); await fixture.close(); }
});
