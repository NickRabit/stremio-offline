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
    const limited = await call("st429").then(() => undefined, (value) => value as MediaServerError);
    assert.equal(limited?.code, "rate-limited");
    assert.equal(limited?.retryAfterMs, 300_000, "the hint is clamped");

    const unsatisfied = await call("st416");
    assert.equal(unsatisfied.status, 416);
    assert.equal(unsatisfied.body, null);
    assert.equal(unsatisfied.headers.get("content-range"), "bytes */100");
    assert.equal(unsatisfied.headers.get("content-length"), null, "the error-document length is not copied");
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
