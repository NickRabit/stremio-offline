import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  assertMediaServerAddress,
  createMediaServerTransport,
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
    const transport = createMediaServerTransport({ baseUrl: `${fixture.origin}/prefix`, allowLan: false, allowLoopback: true });
    const info = await transport.requestJson("info", {});
    assert.deepEqual(info, { Id: "server-1", Version: "12.2.0" });
    assert.equal(fixture.requests[0].url, "/prefix/System/Info/Public");
    assert.equal(fixture.requests[0].headers.authorization?.includes("Token="), false, "no token is sent where none is needed");
    await transport.close();
  } finally {
    await fixture?.close();
  }
});

test("items carries only the fixed allow-listed query and drops raw path fields", async () => {
  let fixture: Fixture | undefined;
  try {
    fixture = await startServer((_req, res) => json(res, { Items: [], TotalRecordCount: 0 }));
    const transport = open(fixture.origin);
    await transport.requestJson("items", { userId: "user-1", parentId: "lib-1", includeItemTypes: "Movie,Series,Season,Episode", startIndex: 0, limit: 25, searchTerm: "a b" }, "tok");
    const query = new URLSearchParams(fixture.requests[0].url.split("?")[1]);
    assert.equal(query.get("Recursive"), "true");
    assert.equal(query.get("IncludeItemTypes"), "Movie,Series,Season,Episode");
    assert.equal(query.get("Fields"), "ProviderIds,ParentId");
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
