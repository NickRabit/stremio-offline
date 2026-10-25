import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddonRecord } from "./types.js";

process.env.LOG_STDOUT = "0";
process.env.ADDON_MAX_CONCURRENT = "1";
process.env.ALLOW_PRIVATE_ADDONS = "1";
process.env.STREAM_ADDON_TIMEOUT_MS = "100";

const { loadAddon, streamListings, streams, subtitles } = await import("./addons.js");
const { AppError } = await import("./errors.js");
const { flushLog, initLogger } = await import("./logger.js");
const { defaultDownloadSettings } = await import("./naming.js");
const { outbound } = await import("./outbound.js");
const { setFetchTransport } = await import("./security.js");

await initLogger(await mkdtemp(path.join(os.tmpdir(), "stremio-addons-outbound-")));

const json = (body: unknown) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" },
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await tick();
  }
  throw new Error("condition was not reached");
};

const addon = (host: string, resource: "stream" | "subtitles"): AddonRecord => ({
  key: host,
  manifestUrl: `https://${host}/manifest.json`,
  role: "both",
  enabled: true,
  globalSearch: true,
  addedAt: "2026-01-01T00:00:00.000Z",
  downloadSettings: defaultDownloadSettings(),
  manifest: { id: host, name: host, version: "1", resources: [resource], types: ["movie"] },
});

const hostDiagnostics = (host: string) => outbound.diagnostics().find((entry) => entry.host === host);

test("stream listings distinguish a successful empty response from provider failure", async () => {
  setFetchTransport(async (url) => {
    const host = new URL(url).hostname;
    if (host === "failed-stream.example") return new Response("{}", { status: 503 });
    if (host === "empty-stream.example") return json({ streams: [] });
    return json({ streams: [{ url: "https://cdn.example/video.mp4" }] });
  });

  const listings = await streamListings([
    addon("failed-stream.example", "stream"),
    addon("empty-stream.example", "stream"),
    addon("full-stream.example", "stream"),
  ], "movie", "tt0241527");
  assert.deepEqual(listings, [
    { addonKey: "failed-stream.example", status: "failure" },
    { addonKey: "empty-stream.example", status: "success", items: [] },
    { addonKey: "full-stream.example", status: "success", items: [{
      url: "https://cdn.example/video.mp4", addonKey: "full-stream.example", addonName: "full-stream.example",
    }] },
  ]);
});

test("non-search JSON holds its host slot through the body read while other hosts proceed", async () => {
  const calls: string[] = [];
  let releaseFirst = () => {};

  setFetchTransport(async (url) => {
    const host = new URL(url).hostname;
    calls.push(host);
    if (host === "held.example" && calls.filter((item) => item === host).length === 1) {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          releaseFirst = () => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ id: host, name: host, version: "1" })));
            controller.close();
          };
        },
      }), { headers: { "content-type": "application/json" } });
    }
    return json({ id: host, name: host, version: "1" });
  });

  const first = loadAddon("https://held.example/manifest.json", "both");
  await waitFor(() => calls.length === 1);
  const sameHost = loadAddon("https://held.example/manifest.json", "both");
  await tick();

  assert.equal(calls.filter((host) => host === "held.example").length, 1, "the second request waits for the first body");
  assert.equal(outbound.diagnostics().find((entry) => entry.host === "held.example")?.active, 1);

  await loadAddon("https://other.example/manifest.json", "both");
  assert.equal(calls.filter((host) => host === "other.example").length, 1, "a separate host has its own slot");
  assert.equal(calls.filter((host) => host === "held.example").length, 1);

  releaseFirst();
  await first;
  await sameHost;
  assert.equal(calls.filter((host) => host === "held.example").length, 2);
  assert.equal(hostDiagnostics("held.example"), undefined, "a successful host no longer has an active slot");
});

test("oversized and malformed non-search bodies count as failures and release their slots", async () => {
  setFetchTransport(async (url) => {
    const host = new URL(url).hostname;
    if (host === "oversized.example") {
      return new Response("{}", {
        headers: { "content-type": "application/json", "content-length": String(16 * 1024 * 1024 + 1) },
      });
    }
    return new Response("{", { headers: { "content-type": "application/json" } });
  });

  assert.deepEqual(await subtitles([
    addon("oversized.example", "subtitles"),
    addon("malformed.example", "subtitles"),
  ], "movie", "tt0241527"), []);

  assert.deepEqual(hostDiagnostics("oversized.example"), {
    host: "oversized.example", state: "closed", active: 0, queued: 0, failures: 1, rejected: 0, opened: 0,
    opensInSeconds: undefined,
  });
  assert.deepEqual(hostDiagnostics("malformed.example"), {
    host: "malformed.example", state: "closed", active: 0, queued: 0, failures: 1, rejected: 0, opened: 0,
    opensInSeconds: undefined,
  });
});

test("a stalled non-search body reaches its deadline and releases the host", async () => {
  let cancelled = false;
  setFetchTransport(async () => new Response(new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => undefined),
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/json" } }));

  const startedAt = Date.now();
  const keepAlive = setTimeout(() => undefined, 500);
  try {
    assert.deepEqual(await streams([addon("stalled.example", "stream")], "movie", "tt0241527"), []);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.ok(Date.now() - startedAt < 1_000, "the body read is covered by the request deadline");
  await flushLog();

  assert.equal(cancelled, true);
  assert.deepEqual(hostDiagnostics("stalled.example"), {
    host: "stalled.example", state: "closed", active: 0, queued: 0, failures: 1, rejected: 0, opened: 0,
    opensInSeconds: undefined,
  });
});

test("non-search JSON keeps HTTP and JSON errors recognizable to callers", async () => {
  setFetchTransport(async (url) => {
    const host = new URL(url).hostname;
    if (host === "http.example") return new Response("{}", { status: 503 });
    if (host === "text.example") return new Response("{}", { headers: { "content-type": "text/plain" } });
    return new Response("{", { headers: { "content-type": "application/json" } });
  });

  await assert.rejects(loadAddon("https://http.example/manifest.json", "both"), (error: unknown) =>
    error instanceof Error && error.message === "The addon answered HTTP 503.");
  for (const host of ["text.example", "malformed.example"]) {
    await assert.rejects(loadAddon(`https://${host}/manifest.json`, "both"), (error: unknown) =>
      error instanceof AppError && error.messageKey === "err.addonNotJson");
  }
});
