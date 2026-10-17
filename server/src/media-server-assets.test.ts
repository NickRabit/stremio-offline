import assert from "node:assert/strict";
import { test } from "node:test";
import { createMediaServerTransport, type MediaServerFetch } from "./media-server-security.js";
import { MediaServerError } from "./media-server-types.js";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const SRT = "1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nWorld\r\n";
const SRT_BYTES = new Uint8Array(Buffer.from(SRT, "utf8"));
const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "utf8"));

/** A closed body carrying `bytes`; nothing is invented when a length or type is left out. */
const body = (bytes: Uint8Array, headers: Record<string, string> = {}, status = 200): Response =>
  new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  }), { status, headers });

/** Heads but never ends, so a test can prove the slot outlives the response headers. */
const held = (headers: Record<string, string> = {}): Response =>
  new Response(new ReadableStream<Uint8Array>({ start() { /* stays open */ } }), { status: 200, headers });

/** A held body that records whether its cancel was fired. */
const tracked = (headers: Record<string, string>, status = 200): { cancelled: () => boolean; response: Response } => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1])); },
    cancel() { cancelled = true; },
  }), { status, headers });
  return { cancelled: () => cancelled, response };
};

const serve = (build: () => Response | Promise<Response>): MediaServerFetch => () => Promise.resolve(build());

interface Captured { url: string; init: RequestInit; abortedAtCall: boolean; }
const recording = (build: (url: string, init: RequestInit) => Response | Promise<Response>) => {
  const calls: Captured[] = [];
  const fetch: MediaServerFetch = (url, init) => {
    calls.push({ url, init, abortedAtCall: (init.signal as AbortSignal | null)?.aborted ?? false });
    return Promise.resolve(build(url, init));
  };
  return { calls, fetch };
};

const transportWith = (fetch: MediaServerFetch, baseUrl = "http://127.0.0.1/prefix") =>
  createMediaServerTransport({ baseUrl, allowLan: false, allowLoopback: true, deviceId: "mconn_asset-identity" }, { fetch });

const headersOf = (init: RequestInit): Record<string, string> => init.headers as Record<string, string>;

test("requestAsset builds the fixed artwork and subtitle paths, auth and headers", async () => {
  const { calls, fetch } = recording((url) => (url.includes("/Images/")
    ? body(JPEG, { "content-length": String(JPEG.length), "content-type": "image/jpeg" })
    : body(SRT_BYTES, { "content-length": String(SRT_BYTES.length), "content-type": "application/x-subrip" })));
  const transport = transportWith(fetch);

  const artwork = await transport.requestAsset({ kind: "artwork", itemId: "item-1", imageType: "Primary" }, "tok");
  const request = calls[0];
  const first = new URL(request.url);
  assert.equal(`${first.origin}${first.pathname}`, "http://127.0.0.1/prefix/Items/item-1/Images/Primary");
  assert.equal(first.search, "?MaxWidth=640&Quality=85&Format=Jpg");
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.body, undefined);
  const headers = headersOf(request.init);
  assert.equal(headers.accept, "image/*");
  assert.equal(headers["accept-encoding"], "identity");
  assert.equal(headers["x-emby-token"], "tok");
  assert.equal(headers.range, undefined);
  assert.equal(
    headers.authorization,
    'MediaBrowser Client="Stremio Offline", Device="Desktop", DeviceId="mconn_asset-identity", Version="1.0.0", Token="tok"',
  );
  assert.equal(request.abortedAtCall, false, "the fetch is handed a live abort signal");
  assert.equal(typeof (request.init.signal as AbortSignal).addEventListener, "function");
  assert.equal(request.url.includes("tok"), false, "the token never reaches the request line");
  assert.equal(artwork.contentType, "image/jpeg");
  assert.deepEqual(artwork.bytes, JPEG);
  assert.deepEqual(Object.keys(artwork), ["bytes", "contentType"], "the result carries no headers, url or credentials");

  const subtitle = await transport.requestAsset({ kind: "subtitle", itemId: "item-2", mediaSourceId: "source-9", index: 3 }, "tok");
  const second = calls[1];
  const secondUrl = new URL(second.url);
  assert.equal(`${secondUrl.origin}${secondUrl.pathname}${secondUrl.search}`, "http://127.0.0.1/prefix/Videos/item-2/source-9/Subtitles/3/Stream.srt");
  assert.equal(headersOf(second.init).accept, "text/plain");
  assert.equal(headersOf(second.init)["accept-encoding"], "identity");
  assert.equal(subtitle.contentType, "application/x-subrip");
  assert.deepEqual(subtitle.bytes, SRT_BYTES);
  await transport.close();
});

test("asset arguments are validated before any network work", async () => {
  let touched = 0;
  const transport = transportWith(() => { touched += 1; throw new Error("fetch must not run"); });
  const good = { kind: "artwork", itemId: "it", imageType: "Primary" } as const;
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["null", () => transport.requestAsset(null as never, "tok")],
    ["array", () => transport.requestAsset([] as never, "tok")],
    ["string", () => transport.requestAsset("artwork" as never, "tok")],
    ["unknown kind", () => transport.requestAsset({ ...good, kind: "video" } as never, "tok")],
    ["unknown key", () => transport.requestAsset({ ...good, url: "http://evil" } as never, "tok")],
    ["path key", () => transport.requestAsset({ ...good, path: "/x" } as never, "tok")],
    ["query key", () => transport.requestAsset({ ...good, query: "a=1" } as never, "tok")],
    ["headers key", () => transport.requestAsset({ ...good, headers: { accept: "text/html" } } as never, "tok")],
    ["method key", () => transport.requestAsset({ ...good, method: "POST" } as never, "tok")],
    ["format key", () => transport.requestAsset({ ...good, format: "Png" } as never, "tok")],
    ["missing item", () => transport.requestAsset({ kind: "artwork", imageType: "Primary" } as never, "tok")],
    ["missing image type", () => transport.requestAsset({ kind: "artwork", itemId: "it" } as never, "tok")],
    ["unknown image type", () => transport.requestAsset({ ...good, imageType: "Logo" } as never, "tok")],
    ["subtitle with image type", () => transport.requestAsset({ kind: "subtitle", itemId: "it", mediaSourceId: "ms", index: 0, imageType: "Primary" } as never, "tok")],
    ["item separator", () => transport.requestAsset({ ...good, itemId: "a/b" } as never, "tok")],
    ["item escape", () => transport.requestAsset({ ...good, itemId: "a%2fb" } as never, "tok")],
    ["item dot segment", () => transport.requestAsset({ ...good, itemId: ".." } as never, "tok")],
    ["empty item", () => transport.requestAsset({ ...good, itemId: "" } as never, "tok")],
    ["missing source", () => transport.requestAsset({ kind: "subtitle", itemId: "it", index: 0 } as never, "tok")],
    ["empty source", () => transport.requestAsset({ kind: "subtitle", itemId: "it", mediaSourceId: "", index: 0 } as never, "tok")],
    ["index too large", () => transport.requestAsset({ kind: "subtitle", itemId: "it", mediaSourceId: "ms", index: 1024 } as never, "tok")],
    ["index negative", () => transport.requestAsset({ kind: "subtitle", itemId: "it", mediaSourceId: "ms", index: -1 } as never, "tok")],
    ["index fractional", () => transport.requestAsset({ kind: "subtitle", itemId: "it", mediaSourceId: "ms", index: 1.5 } as never, "tok")],
    ["index string", () => transport.requestAsset({ kind: "subtitle", itemId: "it", mediaSourceId: "ms", index: "0" } as never, "tok")],
    ["token that cannot be sent", () => transport.requestAsset(good, 'bad"token')],
  ];
  for (const [label, call] of calls) await assert.rejects(call(), { code: "invalid-input" }, label);

  await assert.rejects(transport.requestAsset({ ...good, [Symbol("x")]: 1 } as never, "tok"), { code: "invalid-input" }, "symbol key");
  await assert.rejects(
    transport.requestAsset({ kind: "artwork", itemId: "it", get imageType() { return "Primary"; } } as never, "tok"),
    { code: "invalid-input" },
    "accessor",
  );
  await assert.rejects(transport.requestAsset(Object.create({ ...good }) as never, "tok"), { code: "invalid-input" }, "spoofed prototype");
  assert.equal(touched, 0, "a refused asset request never reaches the socket");
  await transport.close();
});

test("the asset transport reuses the DNS, rebinding and redirect guard with no token in the query", async () => {
  const policy = { allowLan: false, allowLoopback: false };
  const never: MediaServerFetch = () => { throw new Error("fetch must not run"); };

  const blocked = createMediaServerTransport({ baseUrl: "http://media.example", ...policy }, {
    lookupAll: async () => [{ address: "169.254.1.1", family: 4 }],
    fetch: never,
  });
  await assert.rejects(blocked.requestAsset({ kind: "artwork", itemId: "it", imageType: "Primary" }, "tok"), { code: "unsafe-address" });
  await blocked.close();

  let lookups = 0;
  const rebind = createMediaServerTransport({ baseUrl: "http://media.example", ...policy }, {
    lookupAll: async () => (++lookups === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "10.0.0.1", family: 4 }]),
  });
  await assert.rejects(rebind.requestAsset({ kind: "subtitle", itemId: "it", mediaSourceId: "ms", index: 0 }, "tok"), { code: "unsafe-address" });
  assert.ok(lookups >= 2, "the socket-time lookup was consulted");
  await rebind.close();

  const redirect = recording(() => { throw Object.assign(new Error("unexpected redirect"), { name: "Error" }); });
  const redirectTransport = transportWith(redirect.fetch);
  await assert.rejects(
    redirectTransport.requestAsset({ kind: "artwork", itemId: "it", imageType: "Primary" }, "secret-token"),
    { code: "invalid-response" },
  );
  assert.equal(redirect.calls[0].init.redirect, "error", "no redirect is ever followed");
  assert.equal(redirect.calls[0].url.includes("secret-token"), false);
  await redirectTransport.close();

  const seen = recording(() => body(JPEG, { "content-length": String(JPEG.length), "content-type": "image/jpeg" }));
  const transport = transportWith(seen.fetch);
  await transport.requestAsset({ kind: "artwork", itemId: "it", imageType: "Backdrop" }, "secret-token");
  const query = new URL(seen.calls[0].url).searchParams;
  assert.deepEqual([...query.keys()].sort(), ["Format", "MaxWidth", "Quality"]);
  assert.equal(query.get("Format"), "Jpg");
  assert.equal(query.get("MaxWidth"), "1920");
  assert.equal(query.get("Quality"), "85");
  assert.equal(seen.calls[0].url.includes("secret-token"), false);
  await transport.close();
});

test("asset size caps reject declared and streamed overflow while a missing length is accepted", async () => {
  const declared = transportWith(serve(() => body(SRT_BYTES, { "content-length": String(2 * 1024 * 1024), "content-type": "text/plain" })));
  await assert.rejects(declared.requestAsset({ kind: "subtitle", itemId: "it", mediaSourceId: "ms", index: 0 }, "tok"), { code: "response-too-large" });
  await declared.close();

  const streamed = transportWith(serve(() => body(new Uint8Array(1024 * 1024 + 1), { "content-type": "text/plain" })));
  await assert.rejects(streamed.requestAsset({ kind: "subtitle", itemId: "it", mediaSourceId: "ms", index: 0 }, "tok"), { code: "response-too-large" });
  await streamed.close();

  const streamedArtwork = transportWith(serve(() => body(new Uint8Array(5 * 1024 * 1024 + 1), { "content-type": "image/png" })));
  await assert.rejects(streamedArtwork.requestAsset({ kind: "artwork", itemId: "it", imageType: "Primary" }, "tok"), { code: "response-too-large" });
  await streamedArtwork.close();

  const missing = transportWith(serve(() => body(SRT_BYTES, { "content-type": "text/plain" })));
  const fine = await missing.requestAsset({ kind: "subtitle", itemId: "it", mediaSourceId: "ms", index: 0 }, "tok");
  assert.deepEqual(fine.bytes, SRT_BYTES, "a missing length is read under the cap rather than refused");
  await missing.close();
});

test("malformed headers deny an asset and cancel its body before it is read", async () => {
  const denials: Array<[string, Record<string, string>, number]> = [
    ["a malformed length", { "content-length": "abc", "content-type": "image/jpeg" }, 200],
    ["a negative length", { "content-length": "-1", "content-type": "image/jpeg" }, 200],
    ["an oversized declared length", { "content-length": String(6 * 1024 * 1024), "content-type": "image/jpeg" }, 200],
    ["a compressed body", { "content-encoding": "gzip", "content-type": "image/jpeg" }, 200],
    ["an unknown image type", { "content-type": "image/gif" }, 200],
    ["an svg type", { "content-type": "image/svg+xml" }, 200],
    ["a missing type", {}, 200],
    ["an oversized type header", { "content-type": `image/${"j".repeat(300)}` }, 200],
    ["a partial status", { "content-type": "image/jpeg" }, 206],
  ];
  for (const [label, headers, status] of denials) {
    const { cancelled, response } = tracked(headers, status);
    const transport = transportWith(serve(() => response));
    const error = await transport.requestAsset({ kind: "artwork", itemId: "it", imageType: "Primary" }, "tok").then(() => undefined, (value) => value as MediaServerError);
    assert.ok(error, label);
    assert.equal(cancelled(), true, `${label}: the body is cancelled`);
    await transport.close();
  }

  const html = transportWith(serve(() => body(utf8("<html><body>hi</body></html>"), { "content-type": "text/html" })));
  await assert.rejects(html.requestAsset({ kind: "subtitle", itemId: "it", mediaSourceId: "ms", index: 0 }, "tok"), { code: "invalid-response" });
  await html.close();
});

test("asset bytes must match the declared type and signature", async () => {
  const cases: Array<[string, Response]> = [
    ["a premature end", body(JPEG, { "content-length": "99", "content-type": "image/jpeg" })],
    ["a mismatched signature", body(PNG, { "content-type": "image/jpeg" })],
    ["a fake image", body(utf8("not an image"), { "content-type": "image/png" })],
    ["an empty image", body(new Uint8Array(0), { "content-type": "image/jpeg" })],
    ["html smuggled as jpeg", body(utf8("<!doctype html>"), { "content-type": "image/jpeg" })],
  ];
  for (const [label, response] of cases) {
    const transport = transportWith(serve(() => response));
    await assert.rejects(transport.requestAsset({ kind: "artwork", itemId: "it", imageType: "Primary" }, "tok"), { code: "invalid-response" }, label);
    await transport.close();
  }
});

test("subtitle content must be UTF-8 SubRip text with a real time range", async () => {
  const cases: Array<[string, Uint8Array, string]> = [
    ["json", utf8('{"a":1}'), "text/plain"],
    ["html", utf8("<html></html>"), "application/x-subrip"],
    ["a leading NUL", new Uint8Array([...utf8("00:00:01,000 --> 00:00:02,000\n"), 0x00]), "text/plain"],
    ["invalid utf-8", new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "application/octet-stream"],
    ["words without timing", utf8("just words\n"), "text/srt"],
    ["out-of-range minutes", utf8("00:99:01,000 --> 00:99:02,000\n"), "text/plain"],
    ["a lone arrow", utf8("--> nothing\n"), "text/plain"],
  ];
  for (const [label, bytes, type] of cases) {
    const transport = transportWith(serve(() => body(bytes, { "content-type": type })));
    await assert.rejects(transport.requestAsset({ kind: "subtitle", itemId: "it", mediaSourceId: "ms", index: 0 }, "tok"), { code: "invalid-response" }, label);
    await transport.close();
  }
});

test("a signal-ignoring asset fetch is bounded by the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const transport = transportWith(() => { calls += 1; return new Promise<Response>(() => { /* ignores the signal */ }); });
  const pending = assert.rejects(transport.requestAsset({ kind: "artwork", itemId: "it", imageType: "Primary" }, "tok"), { code: "timeout" });
  for (let turn = 0; turn < 20 && calls === 0; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, "the fetch started and ignores the abort signal");
  t.mock.timers.tick(10_000);
  await pending;
  await transport.close();
});

test("a caller abort cancels a signal-ignoring asset fetch and frees the slot", async () => {
  let calls = 0;
  const transport = transportWith(() => {
    calls += 1;
    if (calls === 1) return new Promise<Response>(() => { /* ignores the signal */ });
    return Promise.resolve(body(SRT_BYTES, { "content-type": "text/plain" }));
  });
  const controller = new AbortController();
  const pending = assert.rejects(
    transport.requestAsset({ kind: "subtitle", itemId: "it", mediaSourceId: "ms", index: 0 }, "tok", controller.signal),
    { code: "cancelled" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await pending;
  const ok = await transport.requestAsset({ kind: "subtitle", itemId: "it", mediaSourceId: "ms", index: 0 }, "tok");
  assert.deepEqual(ok.bytes, SRT_BYTES, "the aborted read released its capacity");
  await transport.close();
});

test("asset reads share the metadata pool and a lost read frees exactly one slot", async () => {
  let calls = 0;
  const transport = transportWith(() => {
    calls += 1;
    return Promise.resolve(calls <= 4 ? held({ "content-type": "text/plain" }) : body(SRT_BYTES, { "content-type": "text/plain" }));
  });
  const controller = new AbortController();
  const first = transport.requestAsset({ kind: "subtitle", itemId: "a", mediaSourceId: "ms", index: 0 }, "tok", controller.signal);
  const rejectedFirst = assert.rejects(first, { code: "cancelled" });
  const rest = [1, 2, 3].map((n) => transport.requestAsset({ kind: "subtitle", itemId: `b${n}`, mediaSourceId: "ms", index: 0 }, "tok"));
  const settledRest = Promise.allSettled(rest);
  await assert.rejects(
    transport.requestAsset({ kind: "subtitle", itemId: "e", mediaSourceId: "ms", index: 0 }, "tok"),
    { code: "busy" },
    "four held reads fill the metadata pool",
  );
  controller.abort();
  await rejectedFirst;
  const ok = await transport.requestAsset({ kind: "subtitle", itemId: "ok", mediaSourceId: "ms", index: 0 }, "tok");
  assert.deepEqual(ok.bytes, SRT_BYTES);
  await transport.close();
  const results = await settledRest;
  assert.ok(results.every((entry) => entry.status === "rejected"), "close ends the remaining reads");
});

test("closing the transport during a pending asset read cancels the body and settles promptly", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start() { /* held */ }, cancel() { cancelled = true; } });
  const transport = transportWith(serve(() => new Response(stream, { status: 200, headers: { "content-type": "text/plain" } })));
  const rejected = assert.rejects(
    transport.requestAsset({ kind: "subtitle", itemId: "it", mediaSourceId: "ms", index: 0 }, "tok"),
    { code: "cancelled" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const outcome = await Promise.race([
    transport.close().then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
  ]);
  assert.equal(outcome, "closed", "close never waits on a stuck body");
  await rejected;
  assert.equal(cancelled, true, "the pending upstream body was cancelled");
});

test("asset statuses map to typed errors without leaking the upstream body", async () => {
  const leak = "UPSTREAM-SECRET-PAYLOAD";
  const failing = async (status: number, headers: Record<string, string> = {}): Promise<MediaServerError | undefined> => {
    const transport = transportWith(serve(() => body(utf8(leak), { "content-type": "text/plain", ...headers }, status)));
    const error = await transport.requestAsset({ kind: "subtitle", itemId: "it", mediaSourceId: "ms", index: 0 }, "tok").then(() => undefined, (value) => value as MediaServerError);
    await transport.close();
    return error;
  };
  for (const [status, code] of [[401, "authentication-required"], [403, "forbidden"], [404, "not-found"], [500, "unavailable"], [503, "unavailable"]] as const) {
    const error = await failing(status);
    assert.equal(error?.code, code, String(status));
    assert.equal(error?.status, status);
    assert.equal(error?.message.includes(leak), false, "no upstream payload reaches the caller");
  }
  const limited = await failing(429, { "retry-after": "600" });
  assert.equal(limited?.code, "rate-limited");
  assert.equal(limited?.retryAfterMs, 300_000, "the retry hint is clamped");
});

test("successful assets return the exact bytes with their canonical type", async () => {
  for (const type of ["image/jpeg", "image/png", "image/webp"]) {
    const bytes = type === "image/jpeg" ? JPEG : type === "image/png" ? PNG : WEBP;
    const transport = transportWith(serve(() => body(bytes, { "content-length": String(bytes.length), "content-type": type })));
    const asset = await transport.requestAsset({ kind: "artwork", itemId: "it", imageType: "Backdrop" }, "tok");
    assert.equal(asset.contentType, type);
    assert.deepEqual(asset.bytes, bytes);
    assert.deepEqual(Object.keys(asset), ["bytes", "contentType"]);
    await transport.close();
  }
  for (const type of ["text/plain", "application/x-subrip", "application/srt", "text/srt; charset=utf-8", "application/octet-stream"]) {
    const transport = transportWith(serve(() => body(SRT_BYTES, { "content-type": type })));
    const asset = await transport.requestAsset({ kind: "subtitle", itemId: "it", mediaSourceId: "ms", index: 1023 }, "tok");
    assert.equal(asset.contentType, "application/x-subrip", type);
    assert.deepEqual(asset.bytes, SRT_BYTES, type);
    await transport.close();
  }
});


test("detail backdrops use 1920 pixels while list posters stay at 640", async () => {
  const { calls, fetch } = recording(() => body(new Uint8Array([...JPEG, 0, 0, 0, 0, 0, 0, 0, 0]), { "content-type": "image/jpeg" }));
  const transport = transportWith(fetch);
  try {
    const backdrop = await transport.requestArtwork({ itemId: "item-1", imageType: "Backdrop" }, "tok");
    await backdrop.arrayBuffer();
    const poster = await transport.requestArtwork({ itemId: "item-1", imageType: "Primary" }, "tok");
    await poster.arrayBuffer();
    await transport.requestAsset({ kind: "artwork", itemId: "item-1", imageType: "Backdrop" }, "tok");
    assert.deepEqual(calls.map((call) => new URL(call.url).searchParams.get("MaxWidth")), ["1920", "640", "1920"]);
  } finally { transport.close(); }
});
