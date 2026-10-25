import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AirPlayAccess } from "./airplay-access.js";
import { resetImdbTargets, subtitles, type StreamListing } from "./addons.js";
import { DownloadQueue, ownerMayDownload, type DownloadSelection } from "./downloads.js";
import type { LibraryRecord } from "./libraries.js";
import { MediaResources } from "./media-resources.js";
import { defaultDownloadSettings } from "./naming.js";
import type { MediaInfo } from "./probe.js";
import { Revocations } from "./revocation.js";
import { setFetchTransport } from "./security.js";
import { createSourceResolver } from "./source-resolver.js";
import { StreamListingCache } from "./stream-listing-cache.js";
import type { AddonRecord, StreamItem } from "./types.js";
import type { UserRecord } from "./users.js";

const OWNER = "usr_00000011";
const OTHER_OWNER = "usr_00000012";
const LIBRARY_ID = "lib_51a0ce01";
const VIDEO_ID = "custom-source-race";

process.env.ALLOW_PRIVATE_ADDONS = "1";

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

const waitFor = async (predicate: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout");
};

const owner = (id = OWNER): UserRecord => ({
  id,
  username: id,
  passwordHash: "scrypt$aa$bb",
  secret: `secret-${id}`,
  role: "user",
  createdAt: "2026-01-01T00:00:00.000Z",
  permissions: { downloadToLibrary: true, downloadToDevice: true },
  permissionsVersion: 0,
});

const addon = (key: string, resources: AddonRecord["manifest"]["resources"], allowedUsers: string[]): AddonRecord => ({
  key,
  manifestUrl: `https://${key}.example/manifest.json`,
  role: key === "stream-a" ? "source" : "both",
  enabled: true,
  globalSearch: true,
  allowedUsers,
  addedAt: "2026-01-01T00:00:00.000Z",
  downloadSettings: defaultDownloadSettings(),
  manifest: { id: key, name: key, version: "1", resources },
});

const selection = (addonKeys: string[], subtitleMode: DownloadSelection["subtitleMode"] = "off"): DownloadSelection => ({
  addonKeys,
  sourceStrategy: "priority",
  audioLanguage: "en",
  subtitleMode,
  subtitleLanguage: "en",
  targetSettings: { subfolder: "", layout: "structured" },
});

const media = (audioLanguage = "en", subtitleLanguages: string[] = []): MediaInfo => ({
  container: "matroska",
  duration: 120,
  video: { codec: "h264" },
  audioTracks: [{ index: 0, codec: "aac", language: audioLanguage }],
  subtitleTracks: subtitleLanguages.map((language, index) => ({ index, codec: "subrip", language })),
});

const success = (addonRecord: AddonRecord, items: StreamItem[]): StreamListing =>
  ({ addonKey: addonRecord.key, status: "success", items });

const listen = (handler: Parameters<typeof createServer>[1]) => new Promise<{ server: Server; port: number }>((resolve) => {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
});

interface Harness {
  directory: string;
  queue: DownloadQueue;
  resolver: ReturnType<typeof createSourceResolver>;
  revocations: Revocations;
  users: UserRecord[];
  addons: AddonRecord[];
  library: LibraryRecord;
  close(): Promise<void>;
}

async function harness(options: {
  users: UserRecord[];
  addons: AddonRecord[];
  listStreams: (addons: AddonRecord[], type: string, id: string) => Promise<StreamItem[]>;
  inspect: (stream: StreamItem, signal: AbortSignal) => Promise<MediaInfo | undefined>;
  listSubtitles?: (addons: AddonRecord[], type: string, id: string, signal: AbortSignal) => ReturnType<typeof subtitles>;
}): Promise<Harness> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-source-resolver-"));
  const downloads = path.join(directory, "downloads");
  await mkdir(downloads, { recursive: true });
  const library: LibraryRecord = {
    id: LIBRARY_ID,
    name: "Downloads",
    type: "mixed",
    root: downloads,
    enabled: true,
    visibleTo: [OWNER, OTHER_OWNER],
    order: 0,
    addedAt: "2026-01-01T00:00:00.000Z",
    writeArtwork: false,
  };
  const state = { users: options.users, addons: options.addons };
  const queue = new DownloadQueue(() => 2, () => 1, path.join(directory, "data"), downloads, {
    stallInitialMs: 2_000,
    stallTransferMs: 2_000,
    libraries: () => [library],
    defaultLibrary: () => library,
    ownerAllowed: (job) => ownerMayDownload({
      owner: state.users.find((candidate) => candidate.id === job.ownerUserId),
      addons: state.addons,
      libraries: [library],
    }, job),
  });
  const resolver = createSourceResolver({
    users: () => state.users,
    addons: () => state.addons,
    prefs: () => ({ audioLanguage: "en" }),
    hasRealDebrid: () => false,
    serverReady: Promise.resolve(),
    listStreams: options.listStreams,
    listSubtitles: options.listSubtitles ?? (async () => []),
    inspect: options.inspect,
  });
  queue.setResolver(resolver);
  await queue.load();
  const resources = new MediaResources();
  const revocations = new Revocations({
    source: {
      users: () => state.users,
      addons: () => state.addons,
      libraries: () => [library],
      mediaConnections: () => [],
      remoteLibraries: () => [],
    },
    resources,
    airplay: new AirPlayAccess(resources),
    playbackOwners: new Map(),
    activeMedia: new Set(),
    deviceTickets: new Map(),
    stopPlayback: async () => undefined,
    queue,
  });
  return {
    directory,
    queue,
    resolver,
    revocations,
    get users() { return state.users; },
    get addons() { return state.addons; },
    library,
    close: async () => {
      await queue.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("revocation after the listing await starts no subtitle lookup or probe", async () => {
  const gate = deferred();
  let listingStarted = false;
  let listingFetches = 0;
  let subtitleLookups = 0;
  let probes = 0;
  const stream = addon("stream-a", ["stream"], [OWNER, OTHER_OWNER]);
  const meta = addon("meta-a", ["meta"], [OWNER]);
  const subtitle = addon("subtitle-a", [{ name: "subtitles", types: ["series"] }], [OWNER]);
  const cache = new StreamListingCache({
    fetch: async (asked) => {
      listingStarted = true;
      listingFetches += 1;
      await gate.promise;
      return success(asked, [{ url: "https://media.example/episode.mkv", addonKey: asked.key }]);
    },
  });
  const h = await harness({
    users: [owner(), owner(OTHER_OWNER)],
    addons: [stream, meta, subtitle],
    listStreams: (addons, type, id) => cache.list(addons, type, id),
    listSubtitles: async () => { subtitleLookups += 1; return []; },
    inspect: async () => { probes += 1; return media(); },
  });
  try {
    const job = await h.queue.addPending("Show", {
      type: "series",
      videoId: VIDEO_ID,
      selection: selection([stream.key], "required"),
    }, { kind: "episode", title: "Show", season: 1, episode: 1 }, OWNER);
    await waitFor(() => listingStarted);

    h.addons[0] = { ...stream, allowedUsers: [OTHER_OWNER] };
    const revoking = h.revocations.stopContent({ userId: OWNER, addonKey: stream.key });
    gate.release();
    await revoking;
    await waitFor(() => h.queue.get(job!.id)?.status === "paused");

    assert.equal(subtitleLookups, 0);
    assert.equal(probes, 0);
    assert.equal(h.queue.get(job!.id)?.pauseReason, "permission");

    const reused = await h.resolver({ type: "series", videoId: VIDEO_ID, tried: [] }, OTHER_OWNER, new AbortController().signal);
    assert.equal(reused?.stream.url, "https://media.example/episode.mkv");
    assert.equal(listingFetches, 1);
  } finally {
    gate.release();
    await h.close();
  }
});

test("deleting the owner during the stream listing leaves no job and starts no probe", async () => {
  const gate = deferred();
  let listingStarted = false;
  let subtitleLookups = 0;
  let probes = 0;
  const stream = addon("stream-a", ["stream"], [OWNER]);
  const cache = new StreamListingCache({
    fetch: async (asked) => {
      listingStarted = true;
      await gate.promise;
      return success(asked, [{ url: "https://media.example/episode.mkv", addonKey: asked.key }]);
    },
  });
  const h = await harness({
    users: [owner()],
    addons: [stream],
    listStreams: (addons, type, id) => cache.list(addons, type, id),
    listSubtitles: async () => { subtitleLookups += 1; return []; },
    inspect: async () => { probes += 1; return media(); },
  });
  try {
    const job = await h.queue.addPending("Show", {
      type: "series",
      videoId: VIDEO_ID,
      selection: selection([stream.key], "required"),
    }, { kind: "episode", title: "Show", season: 1, episode: 1 }, OWNER);
    await waitFor(() => listingStarted);

    h.users.splice(0);
    const deleting = h.revocations.deleteUser(OWNER);
    gate.release();
    await deleting;
    await waitFor(() => h.queue.get(job!.id) === undefined);

    assert.equal(subtitleLookups, 0);
    assert.equal(probes, 0);
  } finally {
    gate.release();
    await h.close();
  }
});

test("revocation during subtitle title lookup sends no subtitle request", async () => {
  resetImdbTargets();
  const gate = deferred();
  let titleLookups = 0;
  let subtitleRequests = 0;
  let probes = 0;
  const stream = addon("stream-a", ["stream"], [OWNER]);
  const meta = addon("meta-a", ["meta"], [OWNER]);
  const subtitle = addon("subtitle-a", [{ name: "subtitles", types: ["series"], idPrefixes: ["tt"] }], [OWNER]);
  setFetchTransport(async (rawUrl) => {
    const url = String(rawUrl);
    if (url.startsWith(meta.manifestUrl.replace("manifest.json", ""))) {
      titleLookups += 1;
      await gate.promise;
      return new Response(JSON.stringify({ meta: { id: "tt990001", type: "series", name: "Show" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith(subtitle.manifestUrl.replace("manifest.json", ""))) {
      subtitleRequests += 1;
      return new Response(JSON.stringify({ subtitles: [] }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected addon URL: ${url}`);
  });
  const cache = new StreamListingCache({
    fetch: async (asked) => success(asked, [{ url: "https://media.example/episode.mkv", addonKey: asked.key }]),
  });
  const h = await harness({
    users: [owner()],
    addons: [stream, meta, subtitle],
    listStreams: (addons, type, id) => cache.list(addons, type, id),
    listSubtitles: (addons, type, id, signal) => subtitles(addons, type, id, false, signal),
    inspect: async () => { probes += 1; return media(); },
  });
  try {
    const job = await h.queue.addPending("Show", {
      type: "series",
      videoId: VIDEO_ID,
      selection: selection([stream.key], "required"),
    }, { kind: "episode", title: "Show", season: 1, episode: 1 }, OWNER);
    await waitFor(() => titleLookups === 1);

    h.addons[0] = { ...stream, allowedUsers: [] };
    const revoking = h.revocations.stopContent({ userId: OWNER, addonKey: stream.key });
    gate.release();
    await revoking;
    await waitFor(() => h.queue.get(job!.id)?.status === "paused");

    assert.equal(titleLookups, 1);
    assert.equal(subtitleRequests, 0);
    assert.equal(probes, 0);
    assert.equal(h.queue.get(job!.id)?.pauseReason, "permission");
  } finally {
    gate.release();
    setFetchTransport();
    await h.close();
  }
});

test("revocation during the first probe runs no second probe and selects nothing", async () => {
  const probeStarted = deferred();
  const releaseProbe = deferred();
  let probes = 0;
  let probeSignal: AbortSignal | undefined;
  const stream = addon("stream-a", ["stream"], [OWNER]);
  const cache = new StreamListingCache({
    fetch: async (asked) => success(asked, [
      { url: "https://media.example/one.mkv", addonKey: asked.key },
      { url: "https://media.example/two.mkv", addonKey: asked.key },
    ]),
  });
  const h = await harness({
    users: [owner()],
    addons: [stream],
    listStreams: (addons, type, id) => cache.list(addons, type, id),
    inspect: async (_stream, signal) => {
      probes += 1;
      probeSignal = signal;
      if (probes === 1) {
        probeStarted.release();
        await releaseProbe.promise;
        return media("en");
      }
      return media("en");
    },
  });
  try {
    const job = await h.queue.addPending("Film", {
      type: "movie",
      videoId: VIDEO_ID,
      selection: selection([stream.key]),
    }, { kind: "movie", title: "Film" }, OWNER);
    await probeStarted.promise;

    h.users[0]!.disabled = true;
    const revoking = h.revocations.stopUser(OWNER);
    releaseProbe.release();
    await revoking;
    await waitFor(() => h.queue.get(job!.id)?.status === "paused");

    assert.equal(probes, 1);
    assert.equal(probeSignal?.aborted, true);
    assert.equal(h.queue.get(job!.id)?.target, "");
    assert.equal(h.queue.get(job!.id)?.pauseReason, "permission");
  } finally {
    releaseProbe.release();
    await h.close();
  }
});

test("a currently authorized owner completes through the production resolver", async () => {
  const payload = Buffer.alloc(128, 4);
  const mediaServer = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(payload.length), "content-type": "video/mp4" });
    res.end(payload);
  });
  let probes = 0;
  const stream = addon("stream-a", ["stream"], [OWNER]);
  const cache = new StreamListingCache({
    fetch: async (asked) => success(asked, [{ url: `http://127.0.0.1:${mediaServer.port}/film.mp4`, addonKey: asked.key }]),
  });
  const h = await harness({
    users: [owner()],
    addons: [stream],
    listStreams: (addons, type, id) => cache.list(addons, type, id),
    inspect: async () => { probes += 1; return media(); },
  });
  try {
    const job = await h.queue.addPending("Film", {
      type: "movie",
      videoId: VIDEO_ID,
      selection: selection([stream.key]),
    }, { kind: "movie", title: "Film" }, OWNER);
    await waitFor(() => h.queue.get(job!.id)?.status === "completed" || h.queue.get(job!.id)?.status === "failed");

    assert.equal(h.queue.get(job!.id)?.status, "completed", h.queue.get(job!.id)?.error);
    assert.equal(probes, 1);
  } finally {
    await h.close();
    mediaServer.server.close();
  }
});

test("authorized owners share the provider listing cache", async () => {
  let fetches = 0;
  const stream = addon("stream-a", ["stream"], [OWNER, OTHER_OWNER]);
  const cache = new StreamListingCache({
    fetch: async (asked) => {
      fetches += 1;
      return success(asked, [{ url: "https://media.example/film.mp4", addonKey: asked.key }]);
    },
  });
  const h = await harness({
    users: [owner(), owner(OTHER_OWNER)],
    addons: [stream],
    listStreams: (addons, type, id) => cache.list(addons, type, id),
    inspect: async () => media(),
  });
  const source = { type: "movie", videoId: VIDEO_ID, tried: [] };
  try {
    const first = await h.resolver(source, OWNER, new AbortController().signal);
    const second = await h.resolver(source, OTHER_OWNER, new AbortController().signal);

    assert.equal(first?.stream.url, "https://media.example/film.mp4");
    assert.equal(second?.stream.url, "https://media.example/film.mp4");
    assert.equal(fetches, 1);
  } finally {
    await h.close();
  }
});

test("the resolver reauthorizes the owner after the listing without a revocation signal", async () => {
  let subtitleLookups = 0;
  let probes = 0;
  let h: Harness | undefined;
  const stream = addon("stream-a", ["stream"], [OWNER]);
  const cache = new StreamListingCache({
    fetch: async (asked) => {
      h!.users[0]!.permissions.downloadToLibrary = false;
      return success(asked, [{ url: "https://media.example/film.mp4", addonKey: asked.key }]);
    },
  });
  h = await harness({
    users: [owner()],
    addons: [stream],
    listStreams: (addons, type, id) => cache.list(addons, type, id),
    listSubtitles: async () => { subtitleLookups += 1; return []; },
    inspect: async () => { probes += 1; return media(); },
  });
  try {
    const resolved = await h.resolver({
      type: "movie",
      videoId: VIDEO_ID,
      tried: [],
      selection: selection([stream.key], "required"),
    }, OWNER, new AbortController().signal);

    assert.equal(resolved, undefined);
    assert.equal(subtitleLookups, 0);
    assert.equal(probes, 0);
  } finally {
    await h.close();
  }
});
