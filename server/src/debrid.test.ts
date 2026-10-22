import assert from "node:assert/strict";
import test from "node:test";
import { addMagnet, advanceTorrent, DebridError, isRetryableDebridFailure, magnetFromHash, RD_API, RD_MAX_JSON_BYTES, resolveIfReady, videoFileIds, verifyRealDebridToken, type FetchLike } from "./debrid.js";
import { messageKeyOf } from "./errors.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const MiB = 1024 * 1024;

function streamed(chunks: Uint8Array[], options: {
  status?: number;
  contentLength?: string;
  cancelPending?: boolean;
  onCancel?: () => void;
} = {}) {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[pulled];
      if (!chunk) { controller.close(); return; }
      pulled += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
      options.onCancel?.();
      if (options.cancelPending) return new Promise<void>(() => undefined);
    },
  }, { highWaterMark: 0 });
  const headers = options.contentLength === undefined ? undefined : { "content-length": options.contentLength };
  return {
    response: new Response(body, { status: options.status, headers }),
    pulled: () => pulled,
    cancelled: () => cancelled,
  };
}

const failingBody = (error: unknown, status = 200) =>
  new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.error(error); },
  }), { status });

const oversizedFailure = (error: unknown) =>
  error instanceof DebridError
  && error.status === 413
  && error.code === "response_too_large"
  && !isRetryableDebridFailure(error);

test("a premium token is accepted", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const user = await verifyRealDebridToken("  secret-token  ", async (url, init) => {
    calls.push({ url, init });
    return json({ username: "nick", type: "premium", premium: 86_400 });
  });
  assert.deepEqual(user, { username: "nick", premium: true });
  assert.equal(calls[0].url, `${RD_API}/user`);
  assert.equal((calls[0].init?.headers as Record<string, string>).authorization, "Bearer secret-token");
});

test("a free account is rejected", async () => {
  await assert.rejects(
    verifyRealDebridToken("free", async () => json({ username: "free", type: "free", premium: 0 })),
    (error: unknown) => error instanceof DebridError && /not premium/.test(error.message) && error.status === 400,
  );
});

test("an invalid token is rejected without storing a guess", async () => {
  await assert.rejects(
    verifyRealDebridToken("nope", async () => json({ error: "bad_token" }, 401)),
    (error: unknown) => error instanceof DebridError && error.status === 401 && /token is not valid/.test(error.message),
  );
});

test("an empty token is rejected before any request", async () => {
  let called = false;
  await assert.rejects(
    verifyRealDebridToken("   ", async () => { called = true; return json({}); }),
    /Enter the Real-Debrid API token/,
  );
  assert.equal(called, false);
});

const HASH = "59e11cef8c2152ac73681092844ebd3db19025bc";
const files = [
  { id: 1, path: "/Sample.nfo", bytes: 20, selected: 0 },
  { id: 2, path: "/Movie.mkv", bytes: 2e9, selected: 1 },
];

test("a magnet is built from a 40-character infoHash", () => {
  assert.equal(magnetFromHash(HASH), `magnet:?xt=urn:btih:${HASH}`);
  assert.throws(() => magnetFromHash("nope"), /infoHash/);
});

test("file selection prefers the addon fileIdx, then video files", () => {
  assert.equal(videoFileIds(files, 1), "2");
  assert.equal(videoFileIds(files), "2");
  assert.equal(videoFileIds([{ id: 9, path: "/a.bin", bytes: 1, selected: 0 }]), "9");
});

const fakeRd = (info: { status: string; links?: string[]; files?: typeof files }) => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const path = String(url).slice(RD_API.length);
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/torrents/addMagnet") return json({ id: "rd1" }, 201);
    if (path === "/torrents/selectFiles/rd1") return new Response(null, { status: 204 });
    if (path === "/torrents/info/rd1") return json({ id: "rd1", status: info.status, progress: info.status === "downloaded" ? 100 : 40, files: info.files ?? files, links: info.links ?? [] });
    if (path === "/unrestrict/link") return json({ download: "https://cdn.example/file.mkv", filename: "Movie.mkv" });
    return json({ error: "unknown" }, 404);
  };
  return { calls, fetchImpl };
};

test("a cached torrent is unrestricted without waiting", async () => {
  const { calls, fetchImpl } = fakeRd({ status: "downloaded", links: ["https://real-debrid.com/d/ABC"] });
  const result = await advanceTorrent("token", HASH, 1, undefined, fetchImpl);
  assert.deepEqual(result, { ready: true, url: "https://cdn.example/file.mkv", filename: "Movie.mkv", torrentId: "rd1" });
  assert.equal(calls.includes("POST /torrents/selectFiles/rd1"), false);
});

test("an uncached torrent stays waiting after files are selected", async () => {
  const { calls, fetchImpl } = fakeRd({ status: "waiting_files_selection" });
  const result = await advanceTorrent("token", HASH, 1, undefined, fetchImpl);
  assert.deepEqual(result, { ready: false, torrentId: "rd1", progress: 40, status: "waiting_files_selection" });
  assert.ok(calls.includes("POST /torrents/selectFiles/rd1"));
});

test("no selection is attempted while the magnet is still being converted", async () => {
  // Real-Debrid answers selectFiles with 404 parameter_missing until it knows
  // the file list, which used to fail the whole job on the very first poll.
  const { calls, fetchImpl } = fakeRd({ status: "magnet_conversion", files: [] });
  const result = await advanceTorrent("token", HASH, 1, undefined, fetchImpl);
  assert.equal(result.ready, false);
  assert.equal(calls.some((call) => call.includes("selectFiles")), false);
});

test("a torrent already downloading is not selected again", async () => {
  const { calls, fetchImpl } = fakeRd({ status: "downloading" });
  await advanceTorrent("token", HASH, 1, "rd1", fetchImpl);
  assert.equal(calls.some((call) => call.includes("selectFiles")), false);
});

test("a later poll reuses the torrent id and does not add it again", async () => {
  const { calls, fetchImpl } = fakeRd({ status: "downloading" });
  await advanceTorrent("token", HASH, 1, "rd1", fetchImpl);
  assert.equal(calls.some((call) => call.includes("addMagnet")), false);
});

test("resolveIfReady returns nothing while Real-Debrid is still downloading", async () => {
  const { fetchImpl } = fakeRd({ status: "downloading" });
  assert.equal(await resolveIfReady("token", HASH, 1, fetchImpl), undefined);
});

test("a full slot is a retryable error", async () => {
  await assert.rejects(
    advanceTorrent("token", HASH, 0, undefined, async () => json({ error: "too_many_active_downloads" }, 509)),
    (error: unknown) => error instanceof DebridError && error.status === 509 && isRetryableDebridFailure(error),
  );
});

test("a generic 503 is unavailable, not an infringing torrent", async () => {
  await assert.rejects(
    addMagnet("token", magnetFromHash(HASH), async () => json({ error: "service_unavailable" }, 503)),
    (error: unknown) => error instanceof DebridError && error.status === 503 && /not answering/.test(error.message) && isRetryableDebridFailure(error),
  );
});

test("an infringing torrent is a fatal rejection", async () => {
  await assert.rejects(
    addMagnet("token", magnetFromHash(HASH), async () => json({ error: "infringing_file", error_code: 16 }, 503)),
    (error: unknown) => error instanceof DebridError && error.code === "infringing_file" && /refused this torrent/.test(error.message) && !isRetryableDebridFailure(error),
  );
});

test("a dropped connection is retried", async () => {
  await assert.rejects(
    addMagnet("token", magnetFromHash(HASH), async () => { throw new TypeError("fetch failed"); }),
    (error: unknown) => error instanceof DebridError && error.status === 408 && isRetryableDebridFailure(error),
  );
});

test("every Real-Debrid request carries a deadline, so a host that never answers is retried", async () => {
  const signals: Array<AbortSignal | null | undefined> = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    signals.push(init?.signal);
    return json({ username: "nick", type: "premium", premium: 1 });
  };
  await verifyRealDebridToken("token", fetchImpl);
  await addMagnet("token", magnetFromHash("a".repeat(40)), async (url, init) => { signals.push(init?.signal); return json({ id: "t1" }); });
  assert.equal(signals.length, 2);
  for (const signal of signals) {
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
  }
});

test("a request that ran past its deadline is a retryable failure", async () => {
  const error = await verifyRealDebridToken("token", async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); })
    .then(() => undefined, (value: unknown) => value);
  assert.ok(error instanceof DebridError);
  assert.equal(isRetryableDebridFailure(error), true);
});

test("a successful response body that times out after its headers is retryable", async () => {
  const response = failingBody(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  await assert.rejects(
    verifyRealDebridToken("secret-token", async () => response),
    (error: unknown) => error instanceof DebridError && error.status === 408 && isRetryableDebridFailure(error),
  );
});

test("a response body transport failure is retryable", async () => {
  const response = failingBody(new TypeError("terminated"));
  await assert.rejects(
    addMagnet("token", magnetFromHash(HASH), async () => response),
    (error: unknown) => error instanceof DebridError && error.status === 408 && isRetryableDebridFailure(error),
  );
});

test("a declared oversized successful body is rejected before it is read", async () => {
  const source = streamed([new Uint8Array(1)], {
    contentLength: String(RD_MAX_JSON_BYTES + 1),
    cancelPending: true,
  });
  await assert.rejects(
    verifyRealDebridToken("token", async () => source.response),
    oversizedFailure,
  );
  assert.equal(source.pulled(), 0);
  assert.equal(source.cancelled(), true);
});

test("a declared oversized non-2xx body is rejected before it is read", async () => {
  const source = streamed([new Uint8Array(1)], {
    status: 503,
    contentLength: String(RD_MAX_JSON_BYTES + 1),
    cancelPending: true,
  });
  await assert.rejects(
    addMagnet("token", magnetFromHash(HASH), async () => source.response),
    oversizedFailure,
  );
  assert.equal(source.pulled(), 0);
  assert.equal(source.cancelled(), true);
});

test("an oversized response carries its catalogue key", async () => {
  const source = streamed([new Uint8Array(1)], { contentLength: String(RD_MAX_JSON_BYTES + 1) });
  const error = await verifyRealDebridToken("token", async () => source.response).then(() => undefined, (failure: unknown) => failure);
  assert.ok(oversizedFailure(error));
  assert.equal(messageKeyOf(error), "err.debridResponseTooLarge");
});

test("a lying-low chunked successful response stops and cancels at the byte cap", async () => {
  const chunks = Array.from({ length: 20 }, () => new Uint8Array(MiB));
  const source = streamed(chunks, { contentLength: "1", cancelPending: true });
  await assert.rejects(
    verifyRealDebridToken("token", async () => source.response),
    oversizedFailure,
  );
  assert.equal(source.cancelled(), true);
  assert.ok(source.pulled() > 0 && source.pulled() < chunks.length, `the source stopped after ${source.pulled()} chunks`);
});

test("a chunked non-2xx response stops and cancels at the byte cap", async () => {
  const chunks = Array.from({ length: 20 }, () => new Uint8Array(MiB));
  const source = streamed(chunks, { status: 500, cancelPending: true });
  await assert.rejects(
    addMagnet("token", magnetFromHash(HASH), async () => source.response),
    oversizedFailure,
  );
  assert.equal(source.cancelled(), true);
  assert.ok(source.pulled() > 0 && source.pulled() < chunks.length, `the source stopped after ${source.pulled()} chunks`);
});

test("a successful JSON body at the exact byte cap is accepted", async () => {
  const prefix = '{"username":"nick","type":"premium","padding":"';
  const suffix = '"}';
  const payload = new TextEncoder().encode(prefix + "x".repeat(RD_MAX_JSON_BYTES - prefix.length - suffix.length) + suffix);
  assert.equal(payload.byteLength, RD_MAX_JSON_BYTES);
  const response = new Response(payload, {
    headers: { "content-length": String(RD_MAX_JSON_BYTES), "content-type": "application/json" },
  });
  assert.deepEqual(await verifyRealDebridToken("token", async () => response), { username: "nick", premium: true });
});

test("malformed successful response JSON stays a data error", async () => {
  await assert.rejects(
    verifyRealDebridToken("token", async () => new Response("{")),
    (error: unknown) => error instanceof SyntaxError && !isRetryableDebridFailure(error),
  );
});

test("malformed non-2xx JSON falls back to the response status without becoming retryable", async () => {
  await assert.rejects(
    addMagnet("token", magnetFromHash(HASH), async () => new Response("{", { status: 418 })),
    (error: unknown) => error instanceof DebridError
      && error.status === 418
      && error.code === undefined
      && !isRetryableDebridFailure(error),
  );
});

test("a non-2xx response body timeout is retryable", async () => {
  const response = failingBody(new DOMException("The operation was aborted due to timeout", "TimeoutError"), 503);
  await assert.rejects(
    addMagnet("token", magnetFromHash(HASH), async () => response),
    (error: unknown) => error instanceof DebridError && error.status === 408 && isRetryableDebridFailure(error),
  );
});
