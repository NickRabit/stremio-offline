import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppError } from "./errors.js";

process.env.LOG_STDOUT = "0";
process.env.ALLOW_PRIVATE_ADDONS = "1";
process.env.ADDON_MAX_CONCURRENT = "1";
process.env.ADDON_MAX_QUEUE = "8";

const { initLogger } = await import("./logger.js");
const { guardedBody, outbound } = await import("./outbound.js");
const { ImageProxy } = await import("./images.js");
const { savePosterAs, savePosterFromUrl } = await import("./artwork.js");
const { readLimitedBody } = await import("./response-body.js");
const { setFetchTransport } = await import("./security.js");

await initLogger(await mkdtemp(path.join(os.tmpdir(), "stremio-image-guard-log-")));

const MiB = 1024 * 1024;
const png = Buffer.alloc(24);
png.writeUInt32BE(0x89504e47, 0);
png.writeUInt32BE(100, 16);
png.writeUInt32BE(100, 20);

const imageResponse = () => new Response(png, { headers: { "content-type": "image/png" } });
const settle = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

function blockedBody() {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      body = controller;
      controller.enqueue(png);
    },
    cancel() {
      return new Promise<void>(() => undefined);
    },
  }), { headers: { "content-type": "image/png" } });
  return {
    response,
    close() {
      if (closed) return;
      closed = true;
      body.close();
    },
  };
}

test("ImageProxy keeps a host slot through a blocked image body", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-image-body-"));
  const blocked = blockedBody();
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  const firstUrl = "https://same-images.test/first.png";
  const secondUrl = "https://same-images.test/second.png";
  const otherUrl = "https://other-images.test/third.png";
  const proxy = new ImageProxy(directory, 1024 * 1024, 0, async (url, init) => {
    calls.push(url);
    assert.ok(init.signal instanceof AbortSignal);
    signals.push(init.signal);
    return url === firstUrl ? blocked.response : imageResponse();
  });
  try {
    await proxy.load();
    const first = proxy.fetch(proxy.proxied(firstUrl)!.split("/").pop()!);
    await settle();
    assert.deepEqual(calls, [firstUrl]);

    const second = proxy.fetch(proxy.proxied(secondUrl)!.split("/").pop()!);
    const other = proxy.fetch(proxy.proxied(otherUrl)!.split("/").pop()!);
    await settle();
    assert.deepEqual(calls, [firstUrl, otherUrl], "the same host queues while the other host proceeds");

    blocked.close();
    assert.ok(await first);
    assert.ok(await second);
    assert.ok(await other);
    assert.deepEqual(calls, [firstUrl, otherUrl, secondUrl]);
    assert.equal(signals.length, calls.length);
  } finally {
    await proxy.flush();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ImageProxy cancels rejected bodies without breaker failures", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-image-reject-"));
  const cancelled: string[] = [];
  const rejected = (status: number, type: string) => new Response(new ReadableStream<Uint8Array>({
    start() {},
    cancel() {
      cancelled.push(type);
      return new Promise<void>(() => undefined);
    },
  }), { status, headers: { "content-type": type } });
  const responses = new Map([
    ["https://status-image.test/missing.png", rejected(404, "missing")],
    ["https://type-image.test/page.html", rejected(200, "text/html")],
    ["https://empty-image.test/empty.png", new Response(null, { headers: { "content-type": "image/png" } })],
    ["https://large-image.test/large.png", new Response(new Uint8Array(8 * MiB + 1), { headers: { "content-type": "image/png" } })],
  ]);
  const proxy = new ImageProxy(directory, 1024 * 1024, 0, async (url) => responses.get(url)!);
  try {
    await proxy.load();
    for (const url of responses.keys()) {
      assert.equal(await proxy.fetch(proxy.proxied(url)!.split("/").pop()!), undefined);
    }
    assert.deepEqual(cancelled.sort(), ["missing", "text/html"]);
    assert.deepEqual(outbound.diagnostics(), []);
  } finally {
    await proxy.flush();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a redirect body remains accounted to the original host, not the target", async () => {
  const blocked = blockedBody();
  const original = "https://redirect-images.test/start.png";
  const target = "https://cdn-images.test/final.png";
  const calls: string[] = [];
  setFetchTransport(async (url) => {
    calls.push(url.toString());
    if (url.toString() === original) {
      return new Response(null, { status: 302, headers: { location: target } });
    }
    return calls.length === 2 ? blocked.response : imageResponse();
  });
  try {
    const redirected = guardedBody(
      original,
      {},
      (response, signal) => readLimitedBody(response, 1024, signal),
      { deadlineMs: 5_000 },
    );
    await settle();

    const direct = guardedBody(
      target,
      {},
      (response, signal) => readLimitedBody(response, 1024, signal),
      { deadlineMs: 5_000 },
    );
    await settle();
    assert.deepEqual(calls, [original, target, target], "the direct CDN request is not queued behind the redirect");

    blocked.close();
    assert.deepEqual([...await redirected], [...png]);
    assert.deepEqual([...await direct], [...png]);
  } finally {
    setFetchTransport();
  }
});

test("guardedBody preserves a redirect validation AppError and records the failure", async () => {
  const allowedHosts = process.env.ALLOW_ADDON_HOSTS;
  const original = "https://redirect-validation.test/start.png";
  const target = "http://127.0.0.1:1/final.png";
  setFetchTransport(async (url) => {
    assert.equal(url.toString(), original);
    process.env.ALLOW_PRIVATE_ADDONS = "0";
    process.env.ALLOW_ADDON_HOSTS = "";
    return new Response(null, { status: 302, headers: { location: target } });
  });
  try {
    let refusal: unknown;
    await assert.rejects(
      guardedBody(
        original,
        {},
        async () => assert.fail("a rejected redirect must not reach the body reader"),
        { deadlineMs: 5_000 },
      ),
      (error: unknown) => {
        refusal = error;
        return error instanceof AppError;
      },
    );
    assert.equal((refusal as AppError).messageKey, "err.privateAddon");
    assert.match((refusal as Error).message, /private network/);
    assert.equal(
      outbound.diagnostics().find((entry) => entry.host === "redirect-validation.test")?.failures,
      1,
    );
  } finally {
    process.env.ALLOW_PRIVATE_ADDONS = "1";
    if (allowedHosts === undefined) delete process.env.ALLOW_ADDON_HOSTS;
    else process.env.ALLOW_ADDON_HOSTS = allowedHosts;
    setFetchTransport();
  }
});

test("savePosterAs holds the slot through its body", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-poster-body-"));
  const blocked = blockedBody();
  const calls: string[] = [];
  setFetchTransport(async (url) => {
    calls.push(url.toString());
    return calls.length === 1 ? blocked.response : imageResponse();
  });
  try {
    const first = savePosterAs(path.join(directory, "first.jpg"), "https://poster-body.test/first.png");
    await settle();
    const second = savePosterAs(path.join(directory, "second.jpg"), "https://poster-body.test/second.png");
    await settle();
    assert.equal(calls.length, 1);

    blocked.close();
    assert.deepEqual(await first, { ok: true });
    assert.deepEqual(await second, { ok: true });
    assert.deepEqual(calls, ["https://poster-body.test/first.png", "https://poster-body.test/second.png"]);
  } finally {
    setFetchTransport();
    await rm(directory, { recursive: true, force: true });
  }
});

test("savePosterFromUrl holds the slot through its body", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stremio-folder-poster-body-"));
  const firstDirectory = path.join(root, "first");
  const secondDirectory = path.join(root, "second");
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  const blocked = blockedBody();
  const calls: string[] = [];
  setFetchTransport(async (url) => {
    calls.push(url.toString());
    return calls.length === 1 ? blocked.response : imageResponse();
  });
  try {
    const first = savePosterFromUrl(firstDirectory, "https://folder-poster-body.test/first.png");
    await settle();
    const second = savePosterFromUrl(secondDirectory, "https://folder-poster-body.test/second.png");
    await settle();
    assert.equal(calls.length, 1);

    blocked.close();
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.deepEqual(await readFile(path.join(firstDirectory, "poster.jpg")), png);
    assert.deepEqual(await readFile(path.join(secondDirectory, "poster.jpg")), png);
  } finally {
    setFetchTransport();
    await rm(root, { recursive: true, force: true });
  }
});
