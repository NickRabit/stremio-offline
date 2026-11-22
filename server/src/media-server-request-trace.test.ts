import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DownloadQueue, remoteDownloadStream, type RemoteDownloadBackend } from "./downloads.js";
import type { LibraryRecord } from "./libraries.js";
import { ResourceError } from "./media-resources.js";
import { MediaServerIndex } from "./media-server-index.js";
import { canonicalRemoteDownloadReference, type RemoteDownloadReference } from "./media-server-download.js";
import { MediaServerManager, type MediaServerAuthority } from "./media-server-manager.js";
import { MediaServerPlaybackReporter } from "./media-server-playing.js";
import {
  type MediaServerProvider,
  type ProviderItem,
  type ProviderLibrary,
  type ProviderPlaybackInfo,
  type ProviderPlaybackReport,
  type ProviderVersion,
  type RemoteAccountPolicy,
} from "./media-server-provider.js";
import { openRemoteContent, remoteSecretStamp, sealRemoteContent, type RemoteContentRef } from "./media-server-reference.js";
import { MediaServerSecrets } from "./media-server-secrets.js";
import type { MediaServerTransport } from "./media-server-security.js";
import { MediaServerError, type RemoteLibraryRecord } from "./media-server-types.js";
import { Store } from "./store.js";
import { emptyUserData, type UserRecord } from "./users.js";

const USER_ID = "usr_00000001";
const REMOTE_LIBRARY_ID = "lib-1";
const ITEM_ID = "m1";
const SOURCE_ID = "v1";

type Operation =
  | "login"
  | "identity"
  | "account"
  | "views"
  | "item"
  | "ancestors"
  | "versions"
  | "playback-info"
  | "GET"
  | "HEAD"
  | "playing"
  | "progress"
  | "stopped";

interface TraceRecord {
  operation: Operation;
  startedAt: number;
  finishedAt?: number;
  retry: boolean;
  failed: boolean;
  range?: string;
  bytes: number;
  firstByteAt?: number;
}

interface Hold {
  operation: Operation;
  count: number;
  wait: Promise<void>;
  entered: (active: number) => void;
}

const user = (): UserRecord => ({
  id: USER_ID,
  username: "reader",
  passwordHash: "scrypt$aa$bb",
  secret: "local-user-secret",
  role: "admin",
  createdAt: "2026-01-01T00:00:00.000Z",
  permissions: { downloadToLibrary: true, downloadToDevice: true },
  permissionsVersion: 0,
});

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const clone = <T>(value: T): T => structuredClone(value);

const fileBytes = (size: number): Uint8Array =>
  Uint8Array.from({ length: size }, (_unused, index) => (index * 31 + 7) % 251);

class FakeServer {
  serverId = "server-1";
  accountId = "account-1";
  token = "token-value-1";
  policy: RemoteAccountPolicy = {
    disabled: false,
    mediaPlayback: true,
    allFolders: true,
    folderIds: [],
    hasAdditionalRestrictions: false,
  };
  libraries: ProviderLibrary[] = [{ id: REMOTE_LIBRARY_ID, name: "Movies", type: "movie" }];
  detailOf: Record<string, ProviderItem> = {
    [ITEM_ID]: { id: ITEM_ID, name: "Movie", type: "movie", providerIds: {} },
  };
  ancestorsOf: Record<string, string[]> = { [ITEM_ID]: [REMOTE_LIBRARY_ID] };
  versionsOf: Record<string, ProviderVersion[]> = { [ITEM_ID]: [{ id: SOURCE_ID, name: "Original", container: "mkv" }] };
  playbackInfoOf: Record<string, ProviderPlaybackInfo> = {};
  calls: TraceRecord[] = [];
  failures = new Map<Operation, number>();
  errors = new Map<Operation, MediaServerError>();
  hold: Hold | undefined;
  body = fileBytes(8 * 1024);
  originalDelayMs = 2;
  originalCancels = 0;
  /** While set, a body stops at `at` bytes of the file until `wait` settles: a test that has to
   *  act mid-transfer does not depend on timing. */
  bodyStop: { at: number; wait: Promise<void> } | undefined;
  private active = new Map<Operation, number>();
  private failed = new Set<Operation>();

  reset(): void {
    this.calls = [];
    this.failures.clear();
    this.errors.clear();
    this.failed.clear();
    this.hold = undefined;
    this.originalCancels = 0;
  }

  async run<T>(operation: Operation, work: (record: TraceRecord) => T | Promise<T> = () => undefined as T): Promise<T> {
    const record: TraceRecord = {
      operation,
      startedAt: performance.now(),
      retry: this.failed.has(operation),
      failed: false,
      bytes: 0,
    };
    this.calls.push(record);
    const active = (this.active.get(operation) ?? 0) + 1;
    this.active.set(operation, active);
    try {
      const hold = this.hold;
      if (hold?.operation === operation) {
        hold.entered(active);
        if (active >= hold.count) await hold.wait;
      }
      const remaining = this.failures.get(operation) ?? 0;
      if (remaining > 0) {
        this.failures.set(operation, remaining - 1);
        record.failed = true;
        this.failed.add(operation);
        throw new MediaServerError("unavailable", "The fake provider is unavailable.");
      }
      const error = this.errors.get(operation);
      if (error) {
        record.failed = true;
        this.failed.add(operation);
        throw error;
      }
      const value = await work(record);
      this.failed.delete(operation);
      return value;
    } finally {
      record.finishedAt = performance.now();
      const next = active - 1;
      if (next === 0) this.active.delete(operation);
      else this.active.set(operation, next);
    }
  }

  original(request: { method: "GET" | "HEAD"; range?: string }, signal?: AbortSignal): Promise<Response> {
    return this.run(request.method, async (record) => {
      record.range = request.range;
      if (request.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": String(this.body.length),
            "content-type": "video/x-matroska",
          },
        });
      }
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.range ?? "");
      const start = match ? Number(match[1]) : 0;
      const end = match?.[2] ? Math.min(Number(match[2]), this.body.length - 1) : this.body.length - 1;
      if (start < 0 || start > end || start >= this.body.length) {
        return new Response(null, {
          status: 416,
          headers: { "content-range": `bytes */${this.body.length}` },
        });
      }
      let offset = start;
      const server = this;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (signal?.aborted) {
            controller.error(new Error("aborted"));
            return;
          }
          if (offset > end) {
            controller.close();
            return;
          }
          if (server.originalDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, server.originalDelayMs));
          }
          const held = server.bodyStop;
          if (held && offset >= held.at) await held.wait;
          if (signal?.aborted) {
            controller.error(new Error("aborted"));
            return;
          }
          const stop = Math.min(end + 1, offset + 1024);
          const chunk = server.body.slice(offset, stop);
          record.bytes += chunk.byteLength;
          record.firstByteAt ??= performance.now();
          offset = stop;
          controller.enqueue(chunk);
        },
        cancel() {
          server.originalCancels += 1;
        },
      });
      return new Response(stream, {
        status: match ? 206 : 200,
        headers: {
          "content-length": String(end - start + 1),
          "content-type": "video/x-matroska",
          ...(match ? { "content-range": `bytes ${start}-${end}/${server.body.length}` } : {}),
        },
      });
    });
  }
}

const providerFor = (server: FakeServer): MediaServerProvider => ({
  verifyIdentity: () => server.run("identity", () => ({ serverId: server.serverId, version: "1.0.0" })),
  authenticate: (username, password) => server.run("login", () => {
    if (!username || !password) throw new MediaServerError("invalid-input", "bad credentials");
    return { serverId: server.serverId, accountId: server.accountId, token: server.token };
  }),
  logout: () => server.run("login"),
  currentAccount: () => server.run("account", () => ({ accountId: server.accountId, policy: clone(server.policy) })),
  listLibraries: () => server.run("views", () => clone(server.libraries)),
  pageItems: () => server.run("item", () => ({ items: [], total: 0 })),
  pageDirectory: () => server.run("item", () => ({ items: [], total: 0 })),
  findByProviderIds: () => server.run("item", () => []),
  detail: (_token, _accountId, itemId) => server.run("item", () => {
    const item = server.detailOf[itemId];
    if (!item) throw new MediaServerError("not-found", "missing");
    return clone(item);
  }),
  ancestors: (_token, _accountId, itemId) => server.run("ancestors", () => [...(server.ancestorsOf[itemId] ?? [])]),
  versions: (_token, _accountId, itemId) => server.run("versions", () => clone(server.versionsOf[itemId] ?? [])),
  playbackInfo: (_token, _accountId, itemId) => server.run("playback-info", () => clone(server.playbackInfoOf[itemId] ?? {
    mediaSources: (server.versionsOf[itemId] ?? []).map((version) => ({
      id: version.id,
      ...(version.bitrate === undefined ? {} : { bitrate: version.bitrate }),
      supportsDirectPlay: true,
      supportsDirectStream: false,
      supportsTranscoding: false,
    })),
  })),
  reportPlayback: (_token, _itemId, report: ProviderPlaybackReport) =>
    server.run(report.kind, () => undefined),
});

const transportFor = (server: FakeServer): MediaServerTransport => ({
  requestJson: async () => { throw new Error("the fake provider does not use requestJson"); },
  requestOriginal: (request, _token, signal) => server.original(request, signal),
  requestArtwork: async () => { throw new Error("artwork is outside this trace"); },
  requestAsset: async () => { throw new Error("assets are outside this trace"); },
  noteRateLimit: () => undefined,
  close: async () => undefined,
});

interface Harness {
  dir: string;
  store: Store;
  server: FakeServer;
  manager: MediaServerManager;
  authority: MediaServerAuthority;
  connectionId: string;
  library: RemoteLibraryRecord;
  close(): Promise<void>;
}

interface MountOptions {
  contentDownloading?: boolean;
  clock?: () => number;
  networkStartIntervalMs?: number;
}

const mount = async (options: MountOptions = {}): Promise<Harness> => {
  const dir = await mkdtemp(path.join(tmpdir(), "media-request-trace-"));
  const owner = user();
  await writeFile(path.join(dir, "state.json"), JSON.stringify({
    schemaVersion: 3,
    addons: [],
    settings: {},
    defaultsInstalled: true,
    users: [owner],
    userData: { [USER_ID]: emptyUserData() },
    libraries: [],
  }));
  const keyFile = path.join(dir, "secret.key");
  await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
  const store = new Store(dir, dir);
  await store.load();
  const server = new FakeServer();
  server.policy = { ...server.policy, contentDownloading: options.contentDownloading ?? true };
  const manager = new MediaServerManager(store, new MediaServerSecrets(path.join(dir, "vault"), keyFile), {
    providerFactory: () => providerFor(server),
    transportFactory: () => transportFor(server),
    index: new MediaServerIndex(),
    networkStartIntervalMs: options.networkStartIntervalMs ?? 0,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  await manager.initialize();
  const authority: MediaServerAuthority = {
    actor: { id: owner.id, secret: owner.secret },
    assertCurrent: () => undefined,
  };
  const connection = await manager.createConnection(authority, {
    provider: "jellyfin",
    name: "Media",
    baseUrl: "http://media.example",
    allowLan: false,
    allowLoopback: false,
    username: "reader",
    password: "reader-password",
  });
  const library = await manager.attachLibrary(authority, connection.id, { remoteId: REMOTE_LIBRARY_ID });
  server.reset();
  return {
    dir,
    store,
    server,
    manager,
    authority,
    connectionId: connection.id,
    library,
    close: async () => {
      await manager.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
};

const withHarness = async (run: (harness: Harness) => Promise<void>, options: MountOptions = {}): Promise<void> => {
  const harness = await mount(options);
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
};

const dropRuntime = (harness: Harness): void => {
  (harness.manager as unknown as { runtimes: Map<string, unknown> }).runtimes.delete(harness.connectionId);
};

const contentRef = (harness: Harness): RemoteContentRef => {
  const connection = harness.store.mediaConnections().find((candidate) => candidate.id === harness.connectionId);
  assert.ok(connection);
  const sealed = sealRemoteContent({
    provider: connection.provider,
    serverId: connection.serverId,
    accountId: connection.accountId,
    itemId: ITEM_ID,
    connectionId: connection.id,
    libraryId: harness.library.id,
    generation: connection.generation,
    mediaSourceId: SOURCE_ID,
    owner: {
      userId: USER_ID,
      sid: "trace-session",
      expiresAt: Date.now() + 3_600_000,
      secretStamp: remoteSecretStamp(user().secret),
    },
  });
  const opened = openRemoteContent(sealed);
  assert.ok(opened);
  return opened;
};

const downloadRef = (harness: Harness): RemoteDownloadReference => {
  const connection = harness.store.mediaConnections().find((candidate) => candidate.id === harness.connectionId);
  assert.ok(connection);
  return canonicalRemoteDownloadReference({
    schemaVersion: 1,
    ownerUserId: USER_ID,
    connectionId: connection.id,
    libraryId: harness.library.id,
    generation: connection.generation,
    provider: connection.provider,
    serverId: connection.serverId,
    accountId: connection.accountId,
    itemId: ITEM_ID,
    mediaSourceId: SOURCE_ID,
  });
};

type Counts = Partial<Record<Operation, number>>;

const counts = (calls: readonly TraceRecord[]): Counts => {
  const values: Counts = {};
  for (const call of calls) values[call.operation] = (values[call.operation] ?? 0) + 1;
  return values;
};

const retryCount = (calls: readonly TraceRecord[]): number => calls.filter((call) => call.retry).length;
const byteCount = (calls: readonly TraceRecord[]): number => calls.reduce((total, call) => total + call.bytes, 0);
const firstByte = (calls: readonly TraceRecord[]): number | undefined =>
  calls.flatMap((call) => call.firstByteAt === undefined ? [] : [call.firstByteAt]).sort((left, right) => left - right)[0];

const proofInflight = (harness: Harness): Map<string, { subscribers: number }> =>
  (harness.manager as unknown as {
    runtimes: Map<string, { inflight: Map<string, { subscribers: number }> }>;
  }).runtimes.get(harness.connectionId)?.inflight ?? new Map();

const proofSubscribers = (harness: Harness, operation: string): number | undefined =>
  [...proofInflight(harness)]
    .find(([key]) => key.startsWith("original-proof\u0000") && key.endsWith(`\u0000${operation}`))?.[1].subscribers;

const liveAdmissionAt = (harness: Harness): number | undefined =>
  [...(harness.manager as unknown as {
    livePlaybackAdmissions: Map<string, { at: number }>;
  }).livePlaybackAdmissions.values()][0]?.at;

const diagnostic = (
  t: { diagnostic(message: string): void },
  label: string,
  startedAt: number,
  calls: readonly TraceRecord[],
): void => {
  const first = firstByte(calls);
  const firstMs = first === undefined ? "n/a" : (first - startedAt).toFixed(2);
  const completionMs = (performance.now() - startedAt).toFixed(2);
  t.diagnostic(`${label} firstByteMs=${firstMs} completionMs=${completionMs} bytes=${byteCount(calls)} retries=${retryCount(calls)}`);
};

const consume = async (response: Response): Promise<number> => (await response.arrayBuffer()).byteLength;

const waitFor = async (predicate: () => boolean, ms = 10_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the trace condition was never reached");
};

const queueLibraries = (root: string): LibraryRecord[] => [{
  id: "lib_d10ad10a",
  name: "Downloads",
  type: "mixed",
  root,
  enabled: true,
  order: 0,
  addedAt: "2026-01-01T00:00:00.000Z",
  writeArtwork: false,
}];

const remoteQueue = async (harness: Harness) => {
  const queueData = path.join(harness.dir, "queue-data");
  const downloads = path.join(harness.dir, "downloads");
  await mkdir(queueData, { recursive: true });
  const libraries = queueLibraries(downloads);
  const localLibrary = libraries[0]!;
  const reference = downloadRef(harness);
  const backend: RemoteDownloadBackend = {
    current: () => harness.server.policy.contentDownloading === true,
    open: (job, args, signal) => harness.manager.openDownloadOriginal(harness.authority, job.remoteDownload!, args, signal),
    revalidate: (job, signal) => harness.manager.revalidateDownloadOriginal(harness.authority, job.remoteDownload!, signal),
    readSubtitle: async () => ({ bytes: new Uint8Array(), contentType: "text/vtt" }),
  };
  const queue = new DownloadQueue(() => 1, () => 1, queueData, downloads, {
    libraries: () => libraries,
    defaultLibrary: () => localLibrary,
    freeSpace: async () => ({ freeBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 }),
    retryDelay: () => 1,
    stallInitialMs: 5_000,
    stallTransferMs: 5_000,
    remoteDownload: backend,
  });
  await queue.load();
  return { queue, reference, localLibrary };
};

const addRemote = async (
  queue: DownloadQueue,
  reference: RemoteDownloadReference,
  size: number,
  subfolder: string,
): Promise<string> => {
  const job = await queue.add(
    "Movie",
    remoteDownloadStream({
      url: "remote-download:original",
      name: "Movie.mkv",
      behaviorHints: { videoSize: size, filename: "Movie.mkv" },
    }),
    undefined,
    { subfolder, layout: "flat", libraryId: "lib_d10ad10a", explicit: true },
    USER_ID,
    reference,
  );
  return job.id;
};

test("playback direct open, seek, reporting and warm reuse have pinned request counts", async (t) => {
  await withHarness(async (harness) => {
    const ref = contentRef(harness);
    const reporter = new MediaServerPlaybackReporter(harness.manager, () => harness.authority);
    const playId = "trace-play-1";
    const play = (event: "start" | "progress" | "stop", position: number): Promise<void> =>
      reporter.report(harness.authority, harness.library.id, ITEM_ID, {
        mediaSourceId: SOURCE_ID,
        position,
        paused: false,
        event,
        playId,
      });

    dropRuntime(harness);
    const coldStarted = performance.now();
    assert.equal(await consume(await harness.manager.openOriginal(harness.authority, ref, { method: "GET" })), harness.server.body.length);
    assert.equal(await consume(await harness.manager.openOriginal(harness.authority, ref, { method: "GET", range: "bytes=1024-" })), harness.server.body.length - 1024);
    await play("start", 0);
    await play("progress", 1);
    const coldCalls = [...harness.server.calls];
    assert.deepEqual(counts(coldCalls), {
      identity: 1,
      account: 1,
      views: 1,
      item: 1,
      ancestors: 1,
      versions: 1,
      "playback-info": 1,
      GET: 2,
      playing: 1,
      progress: 1,
    });
    diagnostic(t, "playback-cold", coldStarted, coldCalls);

    harness.server.reset();
    const warmStarted = performance.now();
    assert.equal(await consume(await harness.manager.openOriginal(harness.authority, ref, { method: "GET" })), harness.server.body.length);
    assert.equal(await consume(await harness.manager.openOriginal(harness.authority, ref, { method: "GET", range: "bytes=2048-" })), harness.server.body.length - 2048);
    assert.equal(await harness.manager.openOriginal(harness.authority, ref, { method: "HEAD" }).then((response) => response.status), 200);
    await play("progress", 2);
    await play("stop", 3);
    const warmCalls = [...harness.server.calls];
    assert.deepEqual(counts(warmCalls), {
      GET: 2,
      HEAD: 1,
      progress: 1,
      stopped: 1,
    });
    diagnostic(t, "playback-warm", warmStarted, warmCalls);
  });
});

test("a reused live admission keeps its original timestamp", async (t) => {
  let now = 0;
  await withHarness(async (harness) => {
    const ref = contentRef(harness);
    dropRuntime(harness);
    await consume(await harness.manager.openOriginal(harness.authority, ref, { method: "GET" }));
    const originalAt = liveAdmissionAt(harness);
    assert.equal(originalAt, 0);

    harness.server.reset();
    now = 31_000;
    const startedAt = performance.now();
    await consume(await harness.manager.openOriginal(harness.authority, ref, { method: "GET" }));
    const calls = [...harness.server.calls];
    assert.deepEqual(counts(calls), {
      identity: 1,
      account: 1,
      views: 1,
      item: 1,
      ancestors: 1,
      versions: 1,
      GET: 1,
    });
    assert.equal(liveAdmissionAt(harness), originalAt);
    diagnostic(t, "live-admission-reused", startedAt, calls);
  }, { clock: () => now });
});

test("a DownloadQueue remote copy is one sequential GET and resumes from its received offset", async (t) => {
  await withHarness(async (harness) => {
    const { queue, reference } = await remoteQueue(harness);
    // The body stops after 2 KiB until the test has paused, so the pause always lands mid-transfer.
    let releaseBody!: () => void;
    harness.server.bodyStop = { at: 2 * 1024, wait: new Promise<void>((resolve) => { releaseBody = resolve; }) };
    try {
      dropRuntime(harness);
      const coldStarted = performance.now();
      const coldId = await addRemote(queue, reference, harness.server.body.length, "");
      await waitFor(() => (queue.get(coldId)?.received ?? 0) >= 2 * 1024);
      const pausing = queue.pause(coldId);
      // The stalled pull is let go once the pause has aborted it; the resume then reads on freely.
      harness.server.bodyStop = undefined;
      releaseBody();
      await pausing;
      assert.equal(queue.get(coldId)?.status, "paused");
      await queue.resume(coldId);
      await waitFor(() => queue.get(coldId)?.status === "completed");
      const coldJob = queue.get(coldId);
      assert.ok(coldJob);
      assert.equal(coldJob.received, harness.server.body.length);
      assert.equal(coldJob.segments, undefined, "remote copies never create a segment plan");
      const coldCalls = [...harness.server.calls];
      const gets = coldCalls.filter((call) => call.operation === "GET");
      assert.equal(gets.length, 2);
      assert.equal(gets[0]?.range, undefined);
      assert.match(gets[1]?.range ?? "", /^bytes=[1-9]\d*-$/);
      assert.equal(await readFile(path.join(harness.dir, "downloads", localPath(coldJob.target))).then((body) => body.equals(Buffer.from(harness.server.body))), true);
      assert.deepEqual(counts(coldCalls), {
        identity: 1,
        account: 1,
        views: 1,
        item: 1,
        ancestors: 1,
        versions: 1,
        "playback-info": 1,
        GET: 2,
      });
      diagnostic(t, "download-cold-pause-resume", coldStarted, coldCalls);

      harness.server.reset();
      const warmStarted = performance.now();
      const warmId = await addRemote(queue, reference, harness.server.body.length, "Warm");
      await waitFor(() => queue.get(warmId)?.status === "completed");
      const warmCalls = [...harness.server.calls];
      assert.deepEqual(counts(warmCalls), { GET: 1 });
      assert.equal(warmCalls[0]?.range, undefined);
      diagnostic(t, "download-warm", warmStarted, warmCalls);
    } finally {
      await queue.stop();
    }
  });
});

function localPath(qualified: string): string {
  const slash = qualified.indexOf("/");
  return slash === -1 ? qualified : qualified.slice(slash + 1);
}

test("explicit download revalidation always repeats the proof reads", async (t) => {
  await withHarness(async (harness) => {
    const ref = downloadRef(harness);
    dropRuntime(harness);
    const coldStarted = performance.now();
    await harness.manager.revalidateDownloadOriginal(harness.authority, ref);
    const coldCalls = [...harness.server.calls];
    assert.deepEqual(counts(coldCalls), {
      identity: 1,
      account: 1,
      views: 1,
      item: 1,
      ancestors: 1,
      versions: 1,
      "playback-info": 1,
    });
    diagnostic(t, "revalidation-cold", coldStarted, coldCalls);

    harness.server.reset();
    const warmStarted = performance.now();
    await harness.manager.revalidateDownloadOriginal(harness.authority, ref);
    const warmCalls = [...harness.server.calls];
    assert.deepEqual(counts(warmCalls), {
      item: 1,
      ancestors: 1,
      versions: 1,
      "playback-info": 1,
    });
    diagnostic(t, "revalidation-warm", warmStarted, warmCalls);
  });
});

test("simultaneous consumers share session facts and the source proof reads", async (t) => {
  await withHarness(async (harness) => {
    const ref = contentRef(harness);
    const release = deferred();
    harness.server.hold = {
      operation: "item",
      count: 1,
      wait: release.promise,
      entered: () => undefined,
    };
    dropRuntime(harness);
    const startedAt = performance.now();
    const first = harness.manager.openOriginal(harness.authority, ref, { method: "GET" });
    const second = harness.manager.openOriginal(harness.authority, ref, { method: "GET" });
    await waitFor(() => proofSubscribers(harness, "proof") === 2);
    release.resolve();
    const responses = await Promise.all([first, second]);
    await Promise.all(responses.map(consume));
    const calls = [...harness.server.calls];
    assert.deepEqual(counts(calls), {
      identity: 1,
      account: 1,
      views: 1,
      item: 1,
      ancestors: 1,
      versions: 1,
      "playback-info": 1,
      GET: 2,
    });
    diagnostic(t, "simultaneous-consumers", startedAt, calls);
  });
});

test("the four shared proof reads keep the configured request spacing", async (t) => {
  await withHarness(async (harness) => {
    const ref = contentRef(harness);
    dropRuntime(harness);
    const startedAt = performance.now();
    await consume(await harness.manager.openOriginal(harness.authority, ref, { method: "GET" }));
    const proofCalls = harness.server.calls.filter((call) =>
      ["item", "ancestors", "versions", "playback-info"].includes(call.operation));
    assert.deepEqual(proofCalls.map((call) => call.operation), ["item", "ancestors", "versions", "playback-info"]);
    const gaps = proofCalls.slice(1).map((call, index) => call.startedAt - proofCalls[index]!.startedAt);
    t.diagnostic(`proof-pacing gaps=${gaps.map((gap) => gap.toFixed(2)).join(",")}`);
    assert.deepEqual(gaps.map((gap) => gap >= 49), [true, true, true]);
    diagnostic(t, "proof-paced", startedAt, harness.server.calls);
  }, { networkStartIntervalMs: 50 });
});

test("one cancelled consumer never cancels the other's shared operation", async (t) => {
  await withHarness(async (harness) => {
    const ref = contentRef(harness);
    const release = deferred();
    harness.server.hold = {
      operation: "item",
      count: 1,
      wait: release.promise,
      entered: () => undefined,
    };
    dropRuntime(harness);
    const startedAt = performance.now();
    const controller = new AbortController();
    const cancelled = harness.manager.openOriginal(harness.authority, ref, { method: "GET" }, controller.signal);
    const continuing = harness.manager.openOriginal(harness.authority, ref, { method: "GET" });
    await waitFor(() => proofSubscribers(harness, "proof") === 2);
    controller.abort();
    release.resolve();
    await assert.rejects(cancelled, { code: "cancelled" });
    const response = await continuing;
    await consume(response);
    const calls = [...harness.server.calls];
    assert.deepEqual(counts(calls), {
      identity: 1,
      account: 1,
      views: 1,
      item: 1,
      ancestors: 1,
      versions: 1,
      "playback-info": 1,
      GET: 1,
    });
    diagnostic(t, "cancelled-consumer", startedAt, calls);
  });
});

test("the last cancelled consumer aborts the shared proof and leaves no in-flight entry", async (t) => {
  await withHarness(async (harness) => {
    const ref = contentRef(harness);
    const release = deferred();
    harness.server.hold = {
      operation: "item",
      count: 1,
      wait: release.promise,
      entered: () => undefined,
    };
    dropRuntime(harness);
    const startedAt = performance.now();
    const first = new AbortController();
    const second = new AbortController();
    const opening = [
      harness.manager.openOriginal(harness.authority, ref, { method: "GET" }, first.signal),
      harness.manager.openOriginal(harness.authority, ref, { method: "GET" }, second.signal),
    ];
    await waitFor(() => proofSubscribers(harness, "proof") === 2);
    first.abort();
    second.abort();
    await assert.rejects(opening[0]!, { code: "cancelled" });
    await assert.rejects(opening[1]!, { code: "cancelled" });
    release.resolve();
    await waitFor(() => proofInflight(harness).size === 0);
    const calls = [...harness.server.calls];
    assert.deepEqual(counts(calls), {
      identity: 1,
      account: 1,
      views: 1,
      item: 1,
    });
    diagnostic(t, "both-consumers-cancelled", startedAt, calls);
  });
});

test("one consumer's failed authority check does not refuse the other consumer", async (t) => {
  await withHarness(async (harness) => {
    const ref = contentRef(harness);
    const release = deferred();
    harness.server.hold = {
      operation: "item",
      count: 1,
      wait: release.promise,
      entered: () => undefined,
    };
    let revoked = false;
    const failingAuthority: MediaServerAuthority = {
      actor: { ...harness.authority.actor },
      assertCurrent: () => {
        if (revoked) throw new ResourceError(401, "AUTH_REQUIRED");
      },
    };
    dropRuntime(harness);
    const startedAt = performance.now();
    const refused = harness.manager.openOriginal(failingAuthority, ref, { method: "GET" });
    const continuing = harness.manager.openOriginal(harness.authority, ref, { method: "GET" });
    await waitFor(() => proofSubscribers(harness, "proof") === 2);
    revoked = true;
    release.resolve();
    await assert.rejects(refused, ResourceError);
    const response = await continuing;
    await consume(response);
    const calls = [...harness.server.calls];
    assert.deepEqual(counts(calls), {
      identity: 1,
      account: 1,
      views: 1,
      item: 1,
      ancestors: 1,
      versions: 1,
      "playback-info": 1,
      GET: 1,
    });
    diagnostic(t, "one-consumer-refused", startedAt, calls);
  });
});

test("a shared proof 401 marks reauthentication once", async (t) => {
  await withHarness(async (harness) => {
    const ref = contentRef(harness);
    const release = deferred();
    harness.server.hold = {
      operation: "item",
      count: 1,
      wait: release.promise,
      entered: () => undefined,
    };
    const internal = harness.manager as unknown as {
      markReauthentication(record: unknown): void;
    };
    const mark = internal.markReauthentication.bind(harness.manager);
    let marks = 0;
    internal.markReauthentication = (record) => {
      marks += 1;
      mark(record);
    };
    dropRuntime(harness);
    const startedAt = performance.now();
    const opening = [
      harness.manager.openOriginal(harness.authority, ref, { method: "GET" }),
      harness.manager.openOriginal(harness.authority, ref, { method: "GET" }),
    ];
    await waitFor(() => proofSubscribers(harness, "proof") === 2);
    harness.server.errors.set("item", new MediaServerError("authentication-required", "401", 401));
    release.resolve();
    await assert.rejects(opening[0]!, { code: "authentication-required" });
    await assert.rejects(opening[1]!, { code: "authentication-required" });
    assert.equal(marks, 1);
    const calls = [...harness.server.calls];
    diagnostic(t, "shared-proof-401", startedAt, calls);
  });
});

test("losing library access during an open stops before the next shared read", async (t) => {
  await withHarness(async (harness) => {
    const ref = contentRef(harness);
    const release = deferred();
    harness.server.hold = {
      operation: "item",
      count: 1,
      wait: release.promise,
      entered: () => undefined,
    };
    dropRuntime(harness);
    const startedAt = performance.now();
    const opening = harness.manager.openOriginal(harness.authority, ref, { method: "GET" });
    await waitFor(() => harness.server.calls.some((call) => call.operation === "item"));
    await harness.manager.patchLibrary(harness.authority, harness.library.id, { enabled: false });
    release.resolve();
    await assert.rejects(opening, { code: "not-found" });
    const calls = [...harness.server.calls];
    assert.deepEqual(counts(calls), {
      identity: 1,
      account: 1,
      views: 1,
      item: 1,
    });
    diagnostic(t, "library-access-lost", startedAt, calls);
  });
});

test("a download-disabled account reads only session facts cold and nothing warm", async (t) => {
  await withHarness(async (harness) => {
    const ref = downloadRef(harness);
    dropRuntime(harness);
    const coldStarted = performance.now();
    await assert.rejects(harness.manager.openDownloadOriginal(harness.authority, ref, { method: "GET" }), { code: "forbidden" });
    const coldCalls = [...harness.server.calls];
    assert.deepEqual(counts(coldCalls), { identity: 1, account: 1, views: 1 });
    diagnostic(t, "download-disabled-cold", coldStarted, coldCalls);

    harness.server.reset();
    const warmStarted = performance.now();
    await assert.rejects(harness.manager.openDownloadOriginal(harness.authority, ref, { method: "GET" }), { code: "forbidden" });
    const warmCalls = [...harness.server.calls];
    assert.deepEqual(counts(warmCalls), {});
    diagnostic(t, "download-disabled-warm", warmStarted, warmCalls);
  }, { contentDownloading: false });
});

test("a source replaced during an open is refused before the byte request", async (t) => {
  await withHarness(async (harness) => {
    const ref = contentRef(harness);
    const release = deferred();
    harness.server.hold = {
      operation: "ancestors",
      count: 1,
      wait: release.promise,
      entered: () => undefined,
    };
    dropRuntime(harness);
    const startedAt = performance.now();
    const opening = harness.manager.openOriginal(harness.authority, ref, { method: "GET" });
    await waitFor(() => harness.server.calls.some((call) => call.operation === "ancestors"));
    harness.server.versionsOf[ITEM_ID] = [{ id: "v2", name: "Replacement", container: "mkv" }];
    release.resolve();
    await assert.rejects(opening, { code: "not-found" });
    const calls = [...harness.server.calls];
    assert.deepEqual(counts(calls), {
      identity: 1,
      account: 1,
      views: 1,
      item: 1,
      ancestors: 1,
      versions: 1,
    });
    diagnostic(t, "source-replaced", startedAt, calls);
  });
});

test("a transient stopped report is retried once and classified as a retry", async (t) => {
  await withHarness(async (harness) => {
    const ref = contentRef(harness);
    await consume(await harness.manager.openOriginal(harness.authority, ref, { method: "GET" }));
    const reporter = new MediaServerPlaybackReporter(harness.manager, () => harness.authority, {
      stopRetryMs: 0,
      sleep: async () => undefined,
    });
    const playId = "trace-retry-1";
    await reporter.report(harness.authority, harness.library.id, ITEM_ID, {
      mediaSourceId: SOURCE_ID, position: 0, paused: false, event: "start", playId,
    });
    harness.server.reset();
    harness.server.failures.set("stopped", 1);
    const startedAt = performance.now();
    await reporter.report(harness.authority, harness.library.id, ITEM_ID, {
      mediaSourceId: SOURCE_ID, position: 1, paused: false, event: "stop", playId,
    });
    const calls = [...harness.server.calls];
    assert.deepEqual(counts(calls), { stopped: 2 });
    assert.equal(retryCount(calls), 1);
    assert.deepEqual(calls.map((call) => call.failed), [true, false]);
    diagnostic(t, "stopped-report-retry", startedAt, calls);
  });
});

test("a proof read under a runtime that was replaced meanwhile is not shared into the new one", async () => {
  await withHarness(async (harness) => {
    const ref = contentRef(harness);
    const release = deferred();
    harness.server.hold = { operation: "item", count: 1, wait: release.promise, entered: () => undefined };
    dropRuntime(harness);
    const manager = harness.manager as unknown as {
      runtimes: Map<string, unknown>;
      dropRuntime(id: string): void;
      liveRuntime(connection: unknown): unknown;
      liveSession(authority: unknown, connection: unknown, options: unknown, signal: AbortSignal): Promise<unknown>;
      shareFreshOriginal(...args: unknown[]): unknown;
    };
    const shared: boolean[] = [];
    const share = manager.shareFreshOriginal.bind(manager);
    manager.shareFreshOriginal = (...args: unknown[]) => {
      const [, , connection, runtime] = args;
      shared.push(runtime !== undefined && manager.liveRuntime(connection) === runtime);
      return share(...args);
    };
    const opening = harness.manager.openOriginal(harness.authority, ref, { method: "GET" });
    await waitFor(() => harness.server.calls.some((call) => call.operation === "item"));
    const before = manager.runtimes.get(harness.connectionId);
    // A 401 elsewhere drops the runtime, and another request installs a new one.
    manager.dropRuntime(harness.connectionId);
    const connection = harness.store.mediaConnections().find((candidate) => candidate.id === harness.connectionId);
    await manager.liveSession(harness.authority, connection, {}, new AbortController().signal);
    assert.notEqual(manager.runtimes.get(harness.connectionId), before);
    release.resolve();
    await consume(await opening);
    assert.deepEqual(shared, [false], "the result is offered with the runtime it was read under, which no longer matches");

    // Nor do the proof and live-admission caches keep it: the next open proves the source again.
    harness.server.calls.length = 0;
    await consume(await harness.manager.openOriginal(harness.authority, ref, { method: "GET" }));
    const again = counts(harness.server.calls);
    assert.equal(again.item, 1, "the item is read again under the new runtime");
    assert.equal(again.versions, 1, "the version is read again under the new runtime");
    assert.equal(again["playback-info"], 1, "playback is admitted again under the new runtime");
  });
});
