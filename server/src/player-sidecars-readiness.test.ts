import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import express from "express";
import type { SessionInfo } from "./auth.js";
import { mediaResources, type ResourceOwner } from "./media-resources.js";
import type { MediaServerSources } from "./media-server-sources.js";
import { defaultSidecarIO, PlayerSidecars, type SidecarIO } from "./player-sidecars.js";
import { registerPlaybackRoutes, type PlaybackDeps } from "./routes/playback.js";
import type { StreamItem } from "./types.js";

const ID = "sidecar_readiness_session";
const TRACK = 2;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (condition: () => boolean, message: string) => {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await wait(5);
  }
};
const stamp = (value: number) =>
  `${String(Math.floor(value / 3600)).padStart(2, "0")}:${String(Math.floor((value % 3600) / 60)).padStart(2, "0")}:${(value % 60).toFixed(3).padStart(6, "0")}`;
const cue = (from: number, to: number, text: string) => `${stamp(from)} --> ${stamp(to)}\n${text}`;
const cues = (from: number, to: number, step: number, silenceFrom: number, silenceTo: number) => {
  const blocks: string[] = [];
  for (let at = from; at < to; at += step) {
    if (at >= silenceFrom && at < silenceTo) continue;
    blocks.push(cue(at, at + 10, `line at ${at}`));
  }
  return blocks;
};

interface Counts {
  fullReads: number;
  readFromCalls: number;
  bytesRead: number;
  completeVttBlocks: number;
  shiftVtt: number;
  vttCoverage: number;
  vttBlockCoverage: number;
}

const emptyCounts = (): Counts => ({
  fullReads: 0, readFromCalls: 0, bytesRead: 0,
  completeVttBlocks: 0, shiftVtt: 0, vttCoverage: 0, vttBlockCoverage: 0,
});

function countingIO(counts: Counts): SidecarIO {
  return {
    async readFull(file) {
      const text = await defaultSidecarIO.readFull(file);
      counts.fullReads += 1;
      counts.bytesRead += Buffer.byteLength(text);
      return text;
    },
    async readFrom(file, offset) {
      const result = await defaultSidecarIO.readFrom(file, offset);
      counts.readFromCalls += 1;
      counts.bytesRead += result.bytes.length;
      return result;
    },
    completeVttBlocks(text) {
      counts.completeVttBlocks += 1;
      return defaultSidecarIO.completeVttBlocks(text);
    },
    shiftVtt(text, offset) {
      counts.shiftVtt += 1;
      return defaultSidecarIO.shiftVtt(text, offset);
    },
    vttCoverage(text) {
      counts.vttCoverage += 1;
      return defaultSidecarIO.vttCoverage(text);
    },
    vttBlockCoverage(block) {
      counts.vttBlockCoverage += 1;
      return defaultSidecarIO.vttBlockCoverage(block);
    },
  };
}

class ProgressiveExtractor {
  private active?: { file: string; append: boolean; finish: () => void };
  private initialized = new Set<string>();
  runs = 0;

  run = async (_args: string[], file: string, append: boolean, signal: AbortSignal) => {
    this.runs += 1;
    await new Promise<void>((resolve) => {
      this.active = { file, append, finish: resolve };
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    if (this.active?.file === file) this.active = undefined;
  };

  async publish(...blocks: string[]) {
    const active = this.active;
    if (!active) throw new Error("no active extractor");
    const first = !this.initialized.has(active.file) && !active.append;
    const header = first ? "WEBVTT\n\n" : "";
    await appendFile(active.file, `${header}${blocks.join("\n\n")}\n\n`);
    this.initialized.add(active.file);
  }

  async append(raw: string) {
    const active = this.active;
    if (!active) throw new Error("no active extractor");
    this.initialized.add(active.file);
    await appendFile(active.file, raw);
  }

  finish() {
    this.active?.finish();
  }

  activeFile() {
    return this.active?.file;
  }
}

interface Sample {
  status: number;
  body: string;
  complete: boolean;
  coverage: number;
  cacheControl: string | null;
  contentType: string | null;
}

async function mount(sidecars: PlayerSidecars, t: TestContext) {
  const owner: ResourceOwner = { userId: "usr_sidecar_ready", sid: "sid_sidecar_ready", expiresAt: Date.now() + 3_600_000 };
  const resourceId = mediaResources.mediaStream({ url: "https://example.test/film.mkv" } as StreamItem, owner).resourceId;
  const answer = async (result: Awaited<ReturnType<PlayerSidecars["readState"]>>) => {
    if (result.state === "not-ready") return undefined;
    if (result.state === "retired") {
      const revision = sidecars.revision(ID);
      return revision ? { retired: true as const, sidecarUrl: `/api/playback/${ID}/sidecar.vtt?revision=${revision}&offset=0.000` } : undefined;
    }
    return result;
  };
  const playback = {
    attended: () => undefined,
    sidecar: async (id: string, revision: string | undefined, offset: number, delay: number, position: number | null) =>
      answer(await sidecars.readState(id, revision, offset, delay, position)),
    sidecarProbe: async (id: string, revision: string | undefined, offset: number, _delay: number, position: number | null) => {
      const result = await sidecars.readiness(id, revision, offset, position);
      return result.state === "retired"
        ? answer({ state: "retired" })
        : result.state === "not-ready" ? undefined : result;
    },
    repositionSidecar: async () => ({ sidecarUrl: undefined, seekId: 0 }),
  };
  const deps = {
    airplayRequest: () => undefined,
    currentSession: () => ({ userId: owner.userId, sid: owner.sid, expiresAt: owner.expiresAt }) as SessionInfo,
    ownerOf: () => owner,
    mediaSources: { assertCurrent: () => undefined } as unknown as MediaServerSources,
    playback,
    playbackOwners: new Map([[ID, { owner, resourceId }]]),
    playbackResponse: <T extends { id: string; url: string }>(value: T) => value,
    subtitleDelay: (value: unknown) => Math.max(-10, Math.min(10, Number(value) || 0)),
    trackMedia: () => undefined,
  } as unknown as PlaybackDeps;
  const app = express();
  app.use(express.json());
  registerPlaybackRoutes(app, deps);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    mediaResources.revoke(owner.sid);
  });
  return async (revision: string, position: number, offset: number, probe = false, delay = 0): Promise<Sample> => {
    const query = new URLSearchParams({ revision, offset: offset.toFixed(3), position: position.toFixed(3) });
    if (probe) query.set("probe", "1");
    if (delay) query.set("delay", delay.toFixed(2));
    const response = await fetch(`http://127.0.0.1:${port}/api/playback/${ID}/sidecar.vtt?${query}`);
    const body = await response.text();
    const coverage = Number(response.headers.get("x-sidecar-coverage") ?? "");
    return {
      status: response.status,
      body,
      complete: response.headers.get("x-sidecar-complete") === "1",
      coverage: Number.isFinite(coverage) ? coverage : Infinity,
      cacheControl: response.headers.get("cache-control"),
      contentType: response.headers.get("content-type"),
    };
  };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-readiness-"));
  const counts = emptyCounts();
  const extractor = new ProgressiveExtractor();
  const sidecars = new PlayerSidecars(extractor.run, () => {}, countingIO(counts));
  sidecars.ensure(ID, directory, TRACK, 0, async (start) => (start > 0 ? ["-ss", start.toFixed(3)] : []));
  const revision = sidecars.revision(ID);
  assert.ok(revision);
  await waitFor(() => extractor.runs === 1, "the extractor did not start");
  t.after(async () => {
    await sidecars.stop(ID);
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, counts, extractor, sidecars, revision, sample: await mount(sidecars, t) };
}

test("the old full-response readiness path records the polling cost", { timeout: 10_000 }, async (t) => {
  const { counts, extractor, revision, sample } = await fixture(t);
  const track = cues(0, 3600, 30, 330, 1500);
  await extractor.publish(...track.slice(0, 11));
  const first = await sample(revision, 300, 300);
  assert.equal(first.status, 200);
  await extractor.publish(...track.slice(11));
  assert.equal((await sample(revision, 300, 300)).status, 200);

  const beforePolling = { ...counts };
  const polls = 20;
  let responseBytes = 0;
  for (let poll = 0; poll < polls; poll += 1) {
    const answer = await sample(revision, 300, 300);
    responseBytes += Buffer.byteLength(answer.body);
  }
  const afterPolling = { ...counts };
  const fullTransformations =
    afterPolling.completeVttBlocks - beforePolling.completeVttBlocks
    + afterPolling.shiftVtt - beforePolling.shiftVtt
    + afterPolling.vttCoverage - beforePolling.vttCoverage;
  assert.equal(afterPolling.fullReads - beforePolling.fullReads, polls);
  assert.equal(fullTransformations, polls * 3);
  assert.ok(responseBytes > 0);

  const forwardAt = performance.now();
  let forward: Sample;
  do { forward = await sample(revision, 1500, 1500); } while (forward.status !== 200 && performance.now() - forwardAt < 2_000);
  const forwardElapsed = performance.now() - forwardAt;
  const backwardAt = performance.now();
  let backward: Sample;
  do { backward = await sample(revision, 300, 300); } while (backward.status !== 200 && performance.now() - backwardAt < 2_000);
  const backwardElapsed = performance.now() - backwardAt;
  assert.match(forward.body, /00:00:00\.000 --> 00:00:10\.000/);
  assert.match(backward.body, /00:20:00\.000 --> 00:20:10\.000/);

  t.diagnostic(JSON.stringify({
    mode: "full-get",
    polls,
    fullFileReads: afterPolling.fullReads - beforePolling.fullReads,
    bytesRead: afterPolling.bytesRead - beforePolling.bytesRead,
    fullTransformations,
    responseBytes,
    forwardCorrectCueMs: Number(forwardElapsed.toFixed(2)),
    backwardCorrectCueMs: Number(backwardElapsed.toFixed(2)),
  }));
});

test("an unchanged reader costs no bytes or full VTT transformations to probe", { timeout: 10_000 }, async (t) => {
  const { counts, extractor, revision, sample } = await fixture(t);
  const track = cues(0, 3600, 30, 330, 1500);
  await extractor.publish(...track.slice(0, 11));
  const warm = await sample(revision, 300, 300, true);
  assert.equal(warm.status, 204);
  assert.equal(warm.complete, false);
  assert.equal(warm.coverage, 310);
  assert.equal(warm.body, "");

  const before = { ...counts };
  const polls = 20;
  let responseBytes = 0;
  for (let poll = 0; poll < polls; poll += 1) {
    const answer = await sample(revision, 300, 300, true);
    assert.equal(answer.status, 204);
    responseBytes += Buffer.byteLength(answer.body);
  }
  const after = { ...counts };
  const fullTransformations =
    after.completeVttBlocks - before.completeVttBlocks
    + after.shiftVtt - before.shiftVtt
    + after.vttCoverage - before.vttCoverage;

  assert.equal(after.fullReads - before.fullReads, 0);
  assert.equal(after.bytesRead - before.bytesRead, 0);
  assert.equal(fullTransformations, 0);
  assert.equal(after.vttBlockCoverage - before.vttBlockCoverage, 0);
  assert.equal(responseBytes, 0);

  const appended = `${track.slice(11).join("\n\n")}\n\n`;
  const appendedBytes = Buffer.byteLength(appended);
  await extractor.append(appended);
  const updated = await sample(revision, 300, 300, true);
  assert.equal(updated.status, 204);
  assert.equal(updated.coverage, 3580);
  assert.equal(counts.fullReads, after.fullReads);
  assert.equal(counts.bytesRead - after.bytesRead, appendedBytes);
  assert.equal(counts.completeVttBlocks, after.completeVttBlocks);
  assert.equal(counts.shiftVtt, after.shiftVtt);
  assert.equal(counts.vttCoverage, after.vttCoverage);

  t.diagnostic(JSON.stringify({
    mode: "probe",
    polls,
    fullFileReads: after.fullReads - before.fullReads,
    bytesRead: after.bytesRead - before.bytesRead,
    fullTransformations,
    blockObservations: after.vttBlockCoverage - before.vttBlockCoverage,
    responseBytes,
  }));
});

test("probe headers and status match a full GET for partial and sparse writes", { timeout: 10_000 }, async (t) => {
  const { extractor, revision, sample } = await fixture(t);
  assert.equal((await sample(revision, 0, 0, true)).status, 404);
  await extractor.append(`WEBVTT\n\n${cue(0, 10, "first")}\n\n00:01:00.000 --> `);

  const partialProbe = await sample(revision, 0, 0, true);
  const partialFull = await sample(revision, 0, 0);
  assert.equal(partialProbe.status, 204);
  assert.equal(partialFull.status, 200);
  assert.equal(partialProbe.complete, partialFull.complete);
  assert.equal(partialProbe.coverage, partialFull.coverage);
  assert.equal(partialProbe.cacheControl, partialFull.cacheControl);
  assert.equal(partialFull.body, `WEBVTT\n\n${cue(0, 10, "first")}`);

  await extractor.append(`00:01:10.000\npartial made whole\n\n${cue(1800, 1810, "after silence")}\n\n`);
  const sparseProbe = await sample(revision, 1000, 1000, true, 0.75);
  const sparseFull = await sample(revision, 1000, 1000, false, 0.75);
  assert.equal(sparseProbe.status, 204);
  assert.equal(sparseFull.status, 200);
  assert.equal(sparseProbe.complete, sparseFull.complete);
  assert.equal(sparseProbe.coverage, sparseFull.coverage);
  assert.equal(sparseProbe.coverage, 1810);
  assert.equal(sparseProbe.cacheControl, sparseFull.cacheControl);
  assert.match(sparseFull.body, /00:13:20\.750 --> 00:13:30\.750\nafter silence/);

  extractor.finish();
  let completedProbe;
  let completedFull;
  const deadline = Date.now() + 2_000;
  do {
    completedProbe = await sample(revision, 1000, 1000, true);
    completedFull = await sample(revision, 1000, 1000);
  } while ((!completedProbe.complete || !completedFull.complete) && Date.now() < deadline);
  assert.equal(completedProbe.status, 204);
  assert.equal(completedFull.status, 200);
  assert.equal(completedProbe.complete, true);
  assert.equal(completedProbe.complete, completedFull.complete);
  assert.equal(completedProbe.coverage, completedFull.coverage);
  assert.equal(completedProbe.cacheControl, completedFull.cacheControl);
  assert.equal(completedProbe.contentType, null);
  assert.match(completedFull.contentType ?? "", /^text\/vtt/);
});

test("a retired revision answers the probe and the full GET with the same 410", { timeout: 10_000 }, async (t) => {
  const { extractor, sidecars, revision, sample, directory } = await fixture(t);
  await extractor.publish(cue(0, 10, "old reader"));
  assert.equal((await sample(revision, 0, 0, true)).status, 204);
  sidecars.ensure(ID, directory, TRACK, 2000, async () => []);
  await waitFor(() => extractor.runs === 2, "the replacement reader did not start");

  const probe = await sample(revision, 2000, 2000, true);
  const full = await sample(revision, 2000, 2000);
  assert.equal(probe.status, 410);
  assert.equal(full.status, 410);
  assert.equal(probe.cacheControl, full.cacheControl);
  assert.deepEqual(JSON.parse(probe.body), JSON.parse(full.body));
  assert.match(probe.body, /"sidecarUrl":"\/api\/playback\/sidecar_readiness_session\/sidecar\.vtt\?revision=/);
});

test("the probe hands its position to keepAhead and pauses a running reader far ahead", { timeout: 10_000 }, async (t) => {
  const { extractor, revision, sample } = await fixture(t);
  await extractor.publish(cue(100, 1100, "ahead of the picture"));
  assert.equal((await sample(revision, 100, 100, true)).status, 204);
  await waitFor(() => extractor.runs === 1 && extractor.activeFile() === undefined, "the far-ahead reader did not pause");
});

test("the probe watcher reads the full track only when it seeks and attaches", { timeout: 10_000 }, async (t) => {
  const { counts, extractor, revision, sample } = await fixture(t);
  const track = cues(0, 3600, 30, 330, 1500);
  await extractor.publish(...track.slice(0, 11));
  assert.equal((await sample(revision, 300, 300, true)).status, 204);
  await extractor.append(`${track.slice(11).join("\n\n")}\n\n`);

  const before = { ...counts };
  const polls = 20;
  for (let poll = 0; poll < polls; poll += 1) assert.equal((await sample(revision, 300, 300, true)).status, 204);

  let responseBytes = 0;
  const forwardAt = performance.now();
  assert.equal((await sample(revision, 1500, 1500, true)).status, 204);
  const forward = await sample(revision, 1500, 1500);
  const forwardElapsed = performance.now() - forwardAt;
  responseBytes += Buffer.byteLength(forward.body);
  assert.match(forward.body, /00:00:00\.000 --> 00:00:10\.000/);

  const backwardAt = performance.now();
  assert.equal((await sample(revision, 300, 300, true)).status, 204);
  const backward = await sample(revision, 300, 300);
  const backwardElapsed = performance.now() - backwardAt;
  responseBytes += Buffer.byteLength(backward.body);
  assert.match(backward.body, /00:20:00\.000 --> 00:20:10\.000/);

  const after = { ...counts };
  const fullTransformations =
    after.completeVttBlocks - before.completeVttBlocks
    + after.shiftVtt - before.shiftVtt
    + after.vttCoverage - before.vttCoverage;
  t.diagnostic(JSON.stringify({
    mode: "probe-attach",
    polls,
    fullFileReads: after.fullReads - before.fullReads,
    bytesRead: after.bytesRead - before.bytesRead,
    fullTransformations,
    responseBytes,
    forwardCorrectCueMs: Number(forwardElapsed.toFixed(2)),
    backwardCorrectCueMs: Number(backwardElapsed.toFixed(2)),
  }));
});
