import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DownloadQueue, REMOTE_DOWNLOAD_MARKER, type RemoteDownloadBackend } from "./downloads.js";
import { relativeWithin, type LibraryRecord } from "./libraries.js";
import { isRemoteDownloadReference, type RemoteDownloadReference } from "./media-server-download.js";
import { MediaServerError } from "./media-server-types.js";
import { sealRemoteContent } from "./media-server-reference.js";
import { defaultDownloadSettings } from "./naming.js";
import type { StreamItem } from "./types.js";

process.env.ALLOW_PRIVATE_ADDONS = "1";

const MiB = 1024 ** 2;
const LIBRARY_ID = "lib_a1b2c3d4";
const CONNECTION = `mconn_${"a".repeat(32)}`;
const OTHER_CONNECTION = `mconn_${"b".repeat(32)}`;
const REMOTE_LIBRARY = `rlib_${"c".repeat(32)}`;
const OWNER = "usr_00000001";

const library = (root: string): LibraryRecord => ({
  id: LIBRARY_ID, name: "Downloads", type: "mixed", root, enabled: true, order: 0,
  addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false,
});

const settings = { subfolder: "", layout: "structured" as const, libraryId: LIBRARY_ID, explicit: true as const };

const reference = (over: Partial<RemoteDownloadReference> = {}): RemoteDownloadReference => ({
  schemaVersion: 1, ownerUserId: OWNER, connectionId: CONNECTION, libraryId: REMOTE_LIBRARY,
  generation: 1, provider: "jellyfin", serverId: "server-1", accountId: "account-1",
  itemId: "item-1", mediaSourceId: "v1", ...over,
});

const sealedStream = (ref: RemoteDownloadReference, total: number): StreamItem => ({
  url: sealRemoteContent({
    provider: ref.provider, serverId: ref.serverId, accountId: ref.accountId, itemId: ref.itemId,
    connectionId: ref.connectionId, libraryId: ref.libraryId, generation: ref.generation,
    mediaSourceId: ref.mediaSourceId,
    owner: { userId: ref.ownerUserId, sid: "sid-a", expiresAt: Number.MAX_SAFE_INTEGER, secretStamp: "d".repeat(64) },
  }),
  name: "Movie.2020.mkv",
  behaviorHints: { videoSize: total },
});

const bytes = (total: number): Buffer => {
  const buf = Buffer.alloc(total);
  for (let index = 0; index < total; index += 1) buf[index] = (index * 31 + 7) % 251;
  return buf;
};

interface RemoteState {
  allowed: boolean;
  ignoreRange: boolean;
  chunkDelayMs: number;
  body: Buffer;
  calls: Array<{ id: string; method: string; range?: string }>;
  cancelled: number;
  revalidations: number;
  revalidateFailure: "none" | "immediate" | "hang" | "ignore";
  revalidateGate?: Promise<void>;
  gate?: Promise<void>;
  statusByAttempt?: Record<string, number>;
  attempts: Record<string, number>;
  openError?: Error;
  activeOpens: number;
  maxActiveOpens: number;
}

const state = (total: number): RemoteState => ({
  allowed: true, ignoreRange: false, body: bytes(total), calls: [], cancelled: 0,
  revalidations: 0, revalidateFailure: "none", attempts: {}, chunkDelayMs: 0,
  activeOpens: 0, maxActiveOpens: 0,
});

const chunkStream = (buf: Buffer, start: number, end: number, remote: RemoteState, signal: AbortSignal): ReadableStream<Uint8Array> => {
  let at = start;
  const size = 64 * 1024;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remote.chunkDelayMs) await new Promise((resolve) => setTimeout(resolve, remote.chunkDelayMs));
      if (signal.aborted) { controller.error(new Error("aborted")); return; }
      if (at > end) { controller.close(); return; }
      const stop = Math.min(end, at + size - 1);
      controller.enqueue(new Uint8Array(buf.subarray(at, stop + 1)));
      at = stop + 1;
    },
    cancel() { remote.cancelled += 1; },
  });
};

const trackedStream = (source: ReadableStream<Uint8Array>, remote: RemoteState): ReadableStream<Uint8Array> => {
  const reader = source.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    remote.activeOpens -= 1;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
};

const remoteBackend = (remote: RemoteState) => {
  const backend: RemoteDownloadBackend = {
    current: () => remote.allowed,
    open: async (job, args, signal) => {
      remote.calls.push({ id: job.id, method: args.method, range: args.range });
      remote.attempts[job.id] = (remote.attempts[job.id] ?? 0) + 1;
      if (remote.openError) throw remote.openError;
      const forced = remote.statusByAttempt?.[`${job.id}:${remote.attempts[job.id]}`];
      if (forced) return new Response(null, { status: forced, headers: forced === 429 ? { "retry-after": "1" } : {} });
      remote.activeOpens += 1;
      remote.maxActiveOpens = Math.max(remote.maxActiveOpens, remote.activeOpens);
      if (remote.gate) await remote.gate;
      const total = remote.body.length;
      const offset = args.range ? Number(/bytes=(\d+)-/.exec(args.range)?.[1] ?? 0) : 0;
      if (remote.ignoreRange || offset === 0) {
        return new Response(trackedStream(chunkStream(remote.body, 0, total - 1, remote, signal), remote), { status: 200, headers: { "content-length": String(total) } });
      }
      return new Response(trackedStream(chunkStream(remote.body, offset, total - 1, remote, signal), remote), {
        status: 206, headers: { "content-range": `bytes ${offset}-${total - 1}/${total}`, "content-length": String(total - offset) },
      });
    },
    revalidate: async (_job, signal) => {
      remote.revalidations += 1;
      if (remote.revalidateFailure === "immediate") throw new Error("withdrawn");
      if (remote.revalidateFailure === "ignore") await remote.revalidateGate;
      if (remote.revalidateFailure === "hang") await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
      });
    },
  };
  return backend;
};

const waitFor = async (queue: DownloadQueue, predicate: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout: ${JSON.stringify(queue.snapshot().jobs)}`);
};

interface Options {
  total?: number;
  segments?: number;
  chunkDelayMs?: number;
  perProvider?: number;
  concurrency?: number;
  revalidateMs?: number;
  revalidateTimeoutMs?: number;
}

const harness = async (options: Options = {}) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-remote-"));
  const downloads = path.join(directory, "downloads");
  const root = library(downloads);
  const remote = state(options.total ?? 300 * 1024);
  remote.chunkDelayMs = options.chunkDelayMs ?? 0;
  let free: { freeBytes?: number; totalBytes?: number } = { freeBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 };
  const queue = new DownloadQueue(
    () => options.concurrency ?? 2,
    () => options.perProvider ?? 4,
    path.join(directory, "data"),
    downloads,
    {
      retryDelay: () => 5,
      stallInitialMs: 5_000,
      stallTransferMs: 5_000,
      segments: () => options.segments ?? 1,
      libraries: () => [root],
      defaultLibrary: () => root,
      freeSpace: async () => free,
      remoteDownload: remoteBackend(remote),
      ...(options.revalidateMs === undefined ? {} : { remoteRevalidateMs: options.revalidateMs }),
      ...(options.revalidateTimeoutMs === undefined ? {} : { remoteRevalidateTimeoutMs: options.revalidateTimeoutMs }),
    },
  );
  await queue.load();
  return {
    directory, downloads, queue, remote, root,
    setFree: (next: { freeBytes?: number; totalBytes?: number }) => { free = next; },
    file: (target: string) => path.join(downloads, relativeWithin(LIBRARY_ID, target)),
    stateFile: path.join(directory, "data", "downloads.json"),
  };
};

const close = async (h: { queue: DownloadQueue; directory: string }) => {
  await h.queue.stop();
  await rm(h.directory, { recursive: true, force: true });
};

test("an automatic native copy never switches libraries after its destination disappears", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-native-target-"));
  const downloads = path.join(directory, "downloads");
  const fallback = library(downloads);
  const remote = state(4096);
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
    libraries: () => [fallback], defaultLibrary: () => fallback,
    libraryRetryMs: 10, libraryWaitMs: 30, remoteDownload: remoteBackend(remote),
  });
  await queue.load();
  try {
    const ref = reference();
    const job = await queue.add("Movie", sealedStream(ref, 4096), undefined,
      { subfolder: "new-folder", layout: "flat", libraryId: "lib_deadbeef" }, OWNER, ref);
    await waitFor(queue, () => queue.get(job.id)?.status === "failed");
    assert.equal(queue.get(job.id)?.errorKey, "err.chosenLibraryGone");
    assert.equal(remote.calls.length, 0);
    await assert.rejects(stat(path.join(downloads, "new-folder", "Movie.mkv")));
  } finally { await close({ queue, directory }); }
});

test("a remote original is copied byte for byte over one authenticated GET", async () => {
  const h = await harness({ total: 300 * 1024, segments: 8 });
  try {
    const ref = reference();
    await h.queue.add("Movie", sealedStream(ref, h.remote.body.length), undefined, settings, OWNER, ref);
    await waitFor(h.queue, () => h.queue.list()[0]?.status === "completed");
    const job = h.queue.list()[0]!;
    assert.equal(job.status, "completed");
    assert.equal(await readFile(h.file(job.target)).then((buf) => buf.equals(h.remote.body)), true, "the bytes match the original");
    assert.deepEqual(h.remote.calls.map((call) => call.method), ["GET"], "no HEAD probe and no segment GET");
    assert.equal(h.remote.calls.length, 1, "one sequential GET despite the segment preference");
  } finally { await close(h); }
});

test("a paused remote copy resumes from its partial file with a range request", async () => {
  const h = await harness({ total: 2 * MiB, chunkDelayMs: 6 });
  try {
    const ref = reference();
    await h.queue.add("Movie", sealedStream(ref, h.remote.body.length), undefined, settings, OWNER, ref);
    const id = h.queue.list()[0]!.id;
    await waitFor(h.queue, () => (h.queue.get(id)?.received ?? 0) > 0);
    const partial = `${h.file(h.queue.get(id)!.target)}.part`;
    await waitFor(h.queue, () => {
      try { return statSync(partial).size > 0; } catch { return false; }
    });
    await h.queue.pause(id);
    const paused = h.queue.get(id)!;
    const kept = (await stat(partial)).size;
    assert.equal(paused.status, "paused");
    assert.ok(kept > 0 && kept < h.remote.body.length, `partial kept: ${kept}`);
    await h.queue.resume(id);
    await waitFor(h.queue, () => h.queue.get(id)?.status === "completed");
    assert.ok(h.remote.calls.some((call) => call.range === `bytes=${kept}-`), "the resume uses the actual partial file size");
    assert.equal(await readFile(h.file(h.queue.get(id)!.target)).then((buf) => buf.equals(h.remote.body)), true);
  } finally { await close(h); }
});

test("a source that ignores a resume range restarts safely from zero", async () => {
  const h = await harness({ total: 2 * MiB, chunkDelayMs: 6 });
  try {
    const ref = reference();
    await h.queue.add("Movie", sealedStream(ref, h.remote.body.length), undefined, settings, OWNER, ref);
    const id = h.queue.list()[0]!.id;
    await waitFor(h.queue, () => (h.queue.get(id)?.received ?? 0) > 0);
    await h.queue.pause(id);
    h.remote.ignoreRange = true;
    await h.queue.resume(id);
    await waitFor(h.queue, () => h.queue.get(id)?.status === "completed");
    assert.equal(await readFile(h.file(h.queue.get(id)!.target)).then((buf) => buf.equals(h.remote.body)), true, "the file is not corrupt after the restart");
  } finally { await close(h); }
});

test("a legacy sealed address and a restored segment plan are refused, never run", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-remote-restore-"));
  const downloads = path.join(directory, "downloads");
  const root = library(downloads);
  const remote = state(256 * 1024);
  try {
    const ref = reference();
    const legacy = { ...reference({ itemId: "item-2" }) };
    const jobs = [
      { id: "orphan-marker", title: "Orphan", ownerUserId: OWNER, status: "queued", target: "", received: 0, speed: 0,
        createdAt: "2026-01-01T00:00:00.000Z", stream: { url: REMOTE_DOWNLOAD_MARKER } },
      // A sealed address cannot be re-proved after a restart: the job is dropped, not run.
      { id: "legacy", title: "Legacy", ownerUserId: OWNER, status: "queued", target: "", received: 0, speed: 0,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        remoteDownload: legacy, stream: sealedStream(legacy, 100) },
      // A durable reference with a marker is kept, and a stale segment plan is reset.
      { id: "durable", title: "Durable", ownerUserId: OWNER, status: "queued", target: `${LIBRARY_ID}/Durable/Durable.mkv`, received: 40, speed: 0,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        remoteDownload: ref, segments: [{ start: 0, end: 99, received: 40 }],
        stream: { url: REMOTE_DOWNLOAD_MARKER, name: "Durable.mkv", behaviorHints: { videoSize: 100 } } },
    ];
    await mkdir(path.join(directory, "data"), { recursive: true });
    await writeFile(path.join(directory, "data", "downloads.json"), JSON.stringify(jobs));
    // The restored job is not allowed to start: this test is only about what survives the load.
    remote.allowed = false;
    const restored = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
      libraries: () => [root], defaultLibrary: () => root, remoteDownload: remoteBackend(remote),
    });
    await restored.load();
    const kept = restored.snapshot().jobs.map((job) => job.id);
    assert.deepEqual(kept, ["durable"], "only the durable reference survives, and only as a marker job");
    assert.equal(restored.snapshot().jobs[0]!.segments, undefined, "the stale remote plan is dropped");
    await restored.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("persisted remote state carries no seal, session or credential", async () => {
  const h = await harness({ total: 512 * 1024 });
  try {
    const ref = reference();
    await h.queue.add("Movie", sealedStream(ref, h.remote.body.length), undefined, settings, OWNER, ref);
    await waitFor(h.queue, () => h.queue.list()[0]?.status === "completed");
    const raw = await readFile(h.stateFile, "utf8");
    assert.equal(raw.includes("media-server:"), false, "no sealed address is persisted");
    assert.equal(/sid|token|secretStamp|expiresAt|proxyHeaders/.test(raw), false, "no session or credential is persisted");
    assert.equal(raw.includes(REMOTE_DOWNLOAD_MARKER), true, "only the internal marker replaces the address");
    assert.equal(isRemoteDownloadReference(JSON.parse(raw)[0].remoteDownload), true);
    assert.equal("stream" in h.queue.get(h.queue.list()[0]!.id)!, false, "the marker never reaches the public job");
  } finally { await close(h); }
});

test("a withdrawal before the first byte pauses the copy without writing anything", async () => {
  const h = await harness({ total: 2 * MiB });
  try {
    const ref = reference();
    h.remote.allowed = false;
    await h.queue.add("Movie", sealedStream(ref, h.remote.body.length), undefined, settings, OWNER, ref);
    const id = h.queue.list()[0]!.id;
    await waitFor(h.queue, () => h.queue.get(id)?.pauseReason === "permission");
    assert.equal(h.remote.calls.length, 0, "nothing was fetched");
    assert.equal(await stat(h.file(h.queue.get(id)!.target)).then(() => true, () => false), false, "no file was created");
  } finally { await close(h); }
});

test("a withdrawal mid-transfer stops the bytes and keeps the partial file", async () => {
  const h = await harness({ total: 4 * MiB, chunkDelayMs: 6 });
  try {
    const ref = reference();
    await h.queue.add("Movie", sealedStream(ref, h.remote.body.length), undefined, settings, OWNER, ref);
    const id = h.queue.list()[0]!.id;
    await waitFor(h.queue, () => (h.queue.get(id)?.received ?? 0) > 0);
    h.remote.allowed = false;
    await waitFor(h.queue, () => h.queue.get(id)?.pauseReason === "permission");
    const paused = h.queue.get(id)!;
    assert.equal(paused.status, "paused");
    assert.ok(paused.received > 0 && paused.received < h.remote.body.length, "the partial is kept for a valid resume");
    assert.ok(h.remote.cancelled > 0, "the response body was cancelled");
  } finally { await close(h); }
});

test("a slow open whose grant is withdrawn afterwards still cancels the body", async () => {
  const h = await harness({ total: 4 * MiB });
  try {
    const ref = reference();
    let release!: () => void;
    h.remote.gate = new Promise<void>((resolve) => { release = resolve; });
    await h.queue.add("Movie", sealedStream(ref, h.remote.body.length), undefined, settings, OWNER, ref);
    const id = h.queue.list()[0]!.id;
    await waitFor(h.queue, () => h.remote.calls.length > 0);
    h.remote.allowed = false;
    release();
    await waitFor(h.queue, () => h.queue.get(id)?.pauseReason === "permission");
    assert.ok(h.remote.cancelled > 0, "the body was cancelled rather than written");
    assert.equal(h.queue.get(id)!.status, "paused");
  } finally { await close(h); }
});

test("a periodic revalidation that fails stops the transfer", async () => {
  const h = await harness({ total: 4 * MiB, chunkDelayMs: 8, revalidateMs: 20, revalidateTimeoutMs: 50 });
  try {
    const ref = reference();
    await h.queue.add("Movie", sealedStream(ref, h.remote.body.length), undefined, settings, OWNER, ref);
    const id = h.queue.list()[0]!.id;
    await waitFor(h.queue, () => (h.queue.get(id)?.received ?? 0) > 0);
    h.remote.revalidateFailure = "immediate";
    await waitFor(h.queue, () => h.queue.get(id)?.status === "paused");
    assert.ok(h.remote.revalidations > 0, "the periodic proof ran");
    assert.ok(h.remote.cancelled > 0, "the read was aborted, not trusted");
  } finally { await close(h); }
});

test("a revalidation that outlives its deadline is a denial, not a pass", async () => {
  const h = await harness({ total: 4 * MiB, chunkDelayMs: 8, revalidateMs: 20, revalidateTimeoutMs: 40 });
  try {
    const ref = reference();
    await h.queue.add("Movie", sealedStream(ref, h.remote.body.length), undefined, settings, OWNER, ref);
    const id = h.queue.list()[0]!.id;
    await waitFor(h.queue, () => (h.queue.get(id)?.received ?? 0) > 0);
    h.remote.revalidateFailure = "hang";
    await waitFor(h.queue, () => h.queue.get(id)?.status === "paused");
  } finally { await close(h); }
});

test("a 429 is retried within the existing bound instead of tight looping", async () => {
  const h = await harness({ total: 512 * 1024 });
  try {
    const ref = reference();
    await h.queue.add("Movie", sealedStream(ref, h.remote.body.length), undefined, settings, OWNER, ref);
    const id = h.queue.list()[0]!.id;
    h.remote.statusByAttempt = Object.fromEntries([1, 2, 3, 4].map((attempt) => [`${id}:${attempt}`, 429]));
    await waitFor(h.queue, () => h.queue.get(id)?.status === "failed");
    assert.equal(h.remote.attempts[id], 4, "one attempt plus three bounded retries, then it fails");
  } finally { await close(h); }
});

test("a failed disk halts the remote copy instead of writing through it", async () => {
  const h = await harness({ total: 512 * 1024 });
  try {
    const ref = reference();
    h.setFree({ freeBytes: 1024, totalBytes: 1024 ** 3 });
    await h.queue.add("Movie", sealedStream(ref, h.remote.body.length), undefined, settings, OWNER, ref);
    await waitFor(h.queue, () => Boolean(h.queue.snapshot().halt) || h.queue.list()[0]?.status === "paused");
    assert.ok(h.queue.snapshot().halt, "the queue halted for storage");
  } finally { await close(h); }
});

test("two jobs on one provider and server run one at a time, whatever the settings say", async () => {
  const h = await harness({ total: 6 * MiB, concurrency: 4, perProvider: 8, segments: 8 });
  try {
    const first = reference({ connectionId: CONNECTION });
    const second = reference({ connectionId: OTHER_CONNECTION, mediaSourceId: "v2", itemId: "item-2" });
    await h.queue.add("One", sealedStream(first, h.remote.body.length), undefined, settings, OWNER, first);
    await h.queue.add("Two", sealedStream(second, h.remote.body.length), undefined, settings, OWNER, second);
    await waitFor(h.queue, () => h.queue.list().every((job) => job.status === "completed"));
    // Both opens are sequential and never overlap: the second cannot start before the first ends.
    assert.equal(h.remote.calls.length, 2, "one GET per job, no segments");
    assert.deepEqual(h.remote.calls.map((call) => call.range), [undefined, undefined], "a remote copy never probes ranges");
    assert.equal(h.remote.maxActiveOpens, 1, "two jobs on one media server never transfer concurrently");
    assert.deepEqual(h.remote.calls.map((call) => call.id), [h.queue.list()[0]!.id, h.queue.list()[1]!.id]);
  } finally { await close(h); }
});

test("a remote job is refused without a matching reference or a backend", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-remote-"));
  const downloads = path.join(directory, "downloads");
  const root = library(downloads);
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
    libraries: () => [root], defaultLibrary: () => root,
  });
  try {
    await queue.load();
    const ref = reference();
    await assert.rejects(
      queue.add("Movie", sealedStream(ref, 1000), undefined, settings, OWNER, ref),
      (error: unknown) => (error as { messageKey?: string }).messageKey === "library.readOnly",
    );
    assert.deepEqual(queue.snapshot().jobs, []);
  } finally { await queue.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("a forged reference for another owner is refused before admission", async () => {
  const h = await harness({ total: 128 * 1024 });
  try {
    const ref = reference({ ownerUserId: "usr_00000009" });
    await assert.rejects(
      h.queue.add("Movie", sealedStream(ref, h.remote.body.length), undefined, settings, OWNER, ref),
      (error: unknown) => (error as { messageKey?: string }).messageKey === "library.readOnly",
    );
    assert.deepEqual(h.queue.snapshot().jobs, []);
  } finally { await close(h); }
});

test("a missing or read-only target pauses the remote copy before any byte", async () => {
  const h = await harness({ total: 512 * 1024 });
  try {
    const ref = reference();
    // The target's own current() answer is what the queue trusts; a refusal pauses, keeping the
    // queue position, and never starts a transfer.
    h.remote.allowed = false;
    await h.queue.add("Movie", sealedStream(ref, h.remote.body.length), undefined, settings, OWNER, ref);
    const id = h.queue.list()[0]!.id;
    await waitFor(h.queue, () => h.queue.get(id)?.pauseReason === "permission");
    assert.equal(h.remote.calls.length, 0);
    assert.equal(h.queue.get(id)!.status, "paused");
  } finally { await close(h); }
});


test("the native proof deadline stops bytes even when revalidation ignores abort", async () => {
  const h = await harness({ total: 4 * MiB, chunkDelayMs: 8, revalidateMs: 20, revalidateTimeoutMs: 30 });
  let release!: () => void;
  h.remote.revalidateGate = new Promise<void>((resolve) => { release = resolve; });
  h.remote.revalidateFailure = "ignore";
  try {
    const ref = reference();
    await h.queue.add("Movie", sealedStream(ref, h.remote.body.length), undefined, settings, OWNER, ref);
    const id = h.queue.list()[0]!.id;
    await waitFor(h.queue, () => h.remote.revalidations > 0);
    await waitFor(h.queue, () => h.queue.get(id)?.status === "paused", 200);
    assert.ok((h.queue.get(id)?.received ?? 0) < h.remote.body.length);
    assert.equal(h.remote.calls.length, 1);
  } finally {
    release();
    await close(h);
  }
});

const LIB_A = "lib_aaaaaaaa";
const LIB_B = "lib_bbbbbbbb";

const namedLibrary = (id: string, root: string): LibraryRecord => ({
  id, name: id, type: "mixed", root, enabled: true, order: 0,
  addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false,
});

/** Two writable libraries, so one original can be saved to two destinations in one test. */
const destinationHarness = async (options: { allow?: boolean } = {}) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-remote-dest-"));
  const downloads = path.join(directory, "downloads");
  const a = namedLibrary(LIB_A, path.join(downloads, "a"));
  const b = namedLibrary(LIB_B, path.join(downloads, "b"));
  const remote = state(256 * 1024);
  remote.allowed = options.allow ?? true;
  const queue = new DownloadQueue(() => 2, () => 4, path.join(directory, "data"), downloads, {
    retryDelay: () => 5,
    segments: () => 1,
    libraries: () => [a, b],
    defaultLibrary: () => a,
    freeSpace: async () => ({ freeBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 }),
    remoteDownload: remoteBackend(remote),
  });
  await queue.load();
  return { directory, downloads, queue, remote, a, b };
};

const at = (libraryId: string | undefined, subfolder = "") => ({ subfolder, layout: "structured" as const, ...(libraryId ? { libraryId } : {}), explicit: true as const });

test("the same original may be saved to another destination, but not twice to one", async () => {
  const h = await destinationHarness();
  try {
    const ref = reference();
    const stream = () => sealedStream(ref, h.remote.body.length);
    const done = () => h.queue.list().filter((job) => job.status === "completed").length;
    await h.queue.add("Movie", stream(), undefined, at(LIB_A), OWNER, ref);
    await waitFor(h.queue, () => done() === 1);
    // Another library is a different save of the same original.
    await h.queue.add("Movie", stream(), undefined, at(LIB_B), OWNER, ref);
    await waitFor(h.queue, () => done() === 2);
    // Another folder in the same library is a different save too.
    await h.queue.add("Movie", stream(), undefined, at(LIB_A, "Other"), OWNER, ref);
    await waitFor(h.queue, () => done() === 3);
    // The same destination is a duplicate, exactly like a second click.
    await assert.rejects(h.queue.add("Movie", stream(), undefined, at(LIB_A), OWNER, ref),
      (error: unknown) => (error as { messageKey?: string }).messageKey === "err.sourceDownloaded");
    await assert.rejects(h.queue.add("Movie", stream(), undefined, at(LIB_B), OWNER, ref),
      (error: unknown) => (error as { messageKey?: string }).messageKey === "err.sourceDownloaded");
    await assert.rejects(h.queue.add("Movie", stream(), undefined, at(LIB_A, "Other"), OWNER, ref),
      (error: unknown) => (error as { messageKey?: string }).messageKey === "err.sourceDownloaded");
  } finally { await close(h); }
});

test("the same original may be saved to the default destination only once", async () => {
  const h = await destinationHarness();
  try {
    const ref = reference();
    const stream = () => sealedStream(ref, h.remote.body.length);
    // No library is named: the queue resolves the default for the kind, and so does the check.
    await h.queue.add("Movie", stream(), undefined, at(undefined), OWNER, ref);
    await waitFor(h.queue, () => h.queue.list().some((job) => job.status === "completed"));
    // An explicit naming of that same resolved default is the same destination.
    await assert.rejects(h.queue.add("Movie", stream(), undefined, at(LIB_A), OWNER, ref),
      (error: unknown) => (error as { messageKey?: string }).messageKey === "err.sourceDownloaded");
  } finally { await close(h); }
});

test("a queued copy at one destination does not block another, but blocks its own", async () => {
  const h = await destinationHarness({ allow: false });
  try {
    const ref = reference();
    const stream = () => sealedStream(ref, h.remote.body.length);
    await h.queue.add("Movie", stream(), undefined, at(LIB_A), OWNER, ref);
    const id = h.queue.list()[0]!.id;
    await waitFor(h.queue, () => h.queue.get(id)?.status === "paused");
    await h.queue.add("Movie", stream(), undefined, at(LIB_B), OWNER, ref);
    assert.equal(h.queue.list().length, 2, "a copy to another destination is queued");
    await assert.rejects(h.queue.add("Movie", stream(), undefined, at(LIB_A), OWNER, ref),
      (error: unknown) => (error as { messageKey?: string }).messageKey === "err.sourceQueued");
  } finally { await close(h); }
});

test("another account's hidden finished copy does not refuse a fresh save", async () => {
  const h = await destinationHarness();
  try {
    const mine = reference();
    await h.queue.add("Movie", sealedStream(mine, h.remote.body.length), undefined, at(LIB_A), OWNER, mine);
    await waitFor(h.queue, () => h.queue.list().some((job) => job.status === "completed"));
    // The asker owns nothing here and cannot see the library, so the finished copy is invisible.
    const other = reference({ ownerUserId: "usr_00000002" });
    const job = await h.queue.add("Movie", sealedStream(other, h.remote.body.length), undefined, at(LIB_A), other.ownerUserId, other);
    assert.ok(job, "a hidden finished copy does not refuse someone else's save");
  } finally { await close(h); }
});

test("a proof still in flight when the copy finishes cannot touch it", async () => {
  const h = await harness({ total: 128 * 1024, chunkDelayMs: 4, revalidateMs: 1, revalidateTimeoutMs: 1_000 });
  let settle!: (error: Error) => void;
  h.remote.revalidateGate = new Promise<void>((_resolve, reject) => { settle = reject; });
  h.remote.revalidateFailure = "ignore";
  try {
    const ref = reference();
    await h.queue.add("Movie", sealedStream(ref, h.remote.body.length), undefined, settings, OWNER, ref);
    const id = h.queue.list()[0]!.id;
    await waitFor(h.queue, () => h.queue.get(id)?.status === "completed");
    assert.equal(h.remote.revalidations, 1, "exactly one proof was started");
    const calls = h.remote.calls.length;
    settle(new Error("withdrawn"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(h.queue.get(id)?.status, "completed", "a late proof failure never mutates the finished job");
    assert.equal(h.remote.revalidations, 1, "and never starts another proof");
    assert.equal(h.remote.calls.length, calls, "and never reads bytes again");
  } finally { settle?.(new Error("done")); await close(h); }
});

test("pausing a copy cancels a proof that is still in flight", async () => {
  const h = await harness({ total: 4 * MiB, chunkDelayMs: 6, revalidateMs: 5, revalidateTimeoutMs: 1_000 });
  let settle!: (error: Error) => void;
  h.remote.revalidateGate = new Promise<void>((_resolve, reject) => { settle = reject; });
  h.remote.revalidateFailure = "ignore";
  try {
    const ref = reference();
    await h.queue.add("Movie", sealedStream(ref, h.remote.body.length), undefined, settings, OWNER, ref);
    const id = h.queue.list()[0]!.id;
    await waitFor(h.queue, () => h.remote.revalidations > 0);
    await h.queue.pause(id);
    const calls = h.remote.calls.length;
    settle(new Error("withdrawn"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.queue.get(id)?.status, "paused", "the pause stands");
    assert.equal(h.remote.revalidations, 1, "the held proof was cancelled, not repeated");
    assert.equal(h.remote.calls.length, calls, "no byte read was restarted");
  } finally { settle?.(new Error("done")); await close(h); }
});

test("a named original keeps its container extension in the copied file name", async () => {
  const h = await harness({ total: 128 * 1024 });
  try {
    const ref = reference();
    const stream: StreamItem = {
      url: sealedStream(ref, h.remote.body.length).url,
      name: "Version1",
      behaviorHints: { filename: "Version1.mkv", videoSize: h.remote.body.length },
    };
    await h.queue.add("Movie", stream, undefined, settings, OWNER, ref);
    await waitFor(h.queue, () => h.queue.list()[0]?.status === "completed");
    const job = h.queue.list()[0]!;
    assert.equal(job.target.endsWith("/Movie.mkv"), true, `the container decides the extension: ${job.target}`);
    assert.equal(await readFile(h.file(job.target)).then((buf) => buf.equals(h.remote.body)), true);
  } finally { await close(h); }
});

for (const status of [undefined, 403]) {
  test(`native download refusal (${status ?? "policy"}) pauses without retry and keeps the partial file`, async () => {
    const h = await harness({ total: MiB, chunkDelayMs: 10 });
    try {
      const ref = reference();
      await h.queue.add("Movie", sealedStream(ref, h.remote.body.length), undefined, settings, OWNER, ref);
      const id = h.queue.list()[0]!.id;
      await waitFor(h.queue, () => (h.queue.get(id)?.received ?? 0) > 0);
      await h.queue.pause(id);
      const job = h.queue.get(id)!;
      const partial = `${h.file(job.target)}.part`;
      const before = await readFile(partial);
      const attempts = h.remote.calls.length;
      h.remote.openError = new MediaServerError("forbidden", "The media server denied the request.", status);
      await h.queue.resume(id);
      await waitFor(h.queue, () => h.queue.get(id)?.pauseReason === "permission");
      assert.equal(h.queue.get(id)?.status, "paused");
      assert.equal(h.queue.get(id)?.errorKey, "download.pausedNoPermission");
      assert.deepEqual(await readFile(partial), before);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(h.remote.calls.length, attempts + 1, "a denial is not retried");
    } finally { await close(h); }
  });
}

test("a native original without a known extension is refused instead of mislabeled MP4", async () => {
  const h = await harness();
  try {
    const ref = reference();
    const source = { ...sealedStream(ref, h.remote.body.length), name: "Unknown format", behaviorHints: { filename: "1080p" } };
    await assert.rejects(h.queue.add("Movie", source, undefined, settings, OWNER, ref),
      (error: unknown) => (error as { messageKey?: string }).messageKey === "err.mediaServerFormatUnknown");
    assert.deepEqual(h.queue.list(), []);
    assert.equal(h.remote.calls.length, 0);
  } finally { await close(h); }
});
