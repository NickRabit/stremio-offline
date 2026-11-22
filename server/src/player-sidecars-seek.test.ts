import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import express from "express";
import type { SessionInfo } from "./auth.js";
import { mediaResources, type ResourceOwner } from "./media-resources.js";
import type { MediaServerSources } from "./media-server-sources.js";
import { PlayerSidecars } from "./player-sidecars.js";
import { registerPlaybackRoutes, type PlaybackDeps } from "./routes/playback.js";
import type { StreamItem } from "./types.js";

const ID = "sidecar_seek_session";
const TRACK = 2;

interface Run {
  from: number;
  track: number;
  file: string;
  append: boolean;
  ended: boolean;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const whenAborted = (signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) resolve();
  else signal.addEventListener("abort", () => resolve(), { once: true });
});

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
const cueRanges = (text: string) => [...text.matchAll(/(\d{2,}:\d{2}:\d{2}\.\d{3}) --> (\d{2,}:\d{2}:\d{2}\.\d{3})/g)]
  .map((match) => {
    const seconds = (value: string) => value.split(":").map(Number).reduce((total, part) => total * 60 + part, 0);
    return [seconds(match[1]), seconds(match[2])] as const;
  });

/** A source-shaped extractor: it records the position FFmpeg would have been given and leaves
 *  the output open until aborted. Publishing a cue is the source finally reaching it. */
class FakeExtractor {
  readonly runs: Run[] = [];
  private active?: Run;
  private readonly initialized = new Set<string>();

  run = async (args: string[], file: string, append: boolean, signal: AbortSignal) => {
    const nextArg = (name: string) => {
      const index = args.indexOf(name);
      return index < 0 ? 0 : Number(args[index + 1]);
    };
    const run = { from: nextArg("-ss"), track: nextArg("-track"), file, append, ended: false };
    this.runs.push(run);
    this.active = run;
    try {
      await whenAborted(signal);
    } finally {
      run.ended = true;
      if (this.active === run) this.active = undefined;
    }
  };

  async publish(...cues: string[]) {
    const run = this.active;
    if (!run) throw new Error("no active fake extractor");
    const first = !this.initialized.has(run.file);
    const header = first && !run.append ? "WEBVTT\n\n" : "";
    await writeFile(run.file, `${header}${cues.join("\n\n")}\n\n`, { flag: first && !run.append ? "w" : "a" });
    this.initialized.add(run.file);
  }

  running() {
    return this.runs.filter((run) => !run.ended).length;
  }
}

interface Sample {
  status: number;
  body: string;
  complete: boolean;
  coverage: number;
  correct: boolean;
  elapsedMs: number;
}

interface RouteHarness {
  sample(revision: string | undefined, position: number, offset?: number, startedAt?: number): Promise<Sample>;
  reposition(position: number, seekId: number): Promise<{ status: number; sidecarUrl?: string; seekId?: number }>;
  close(): Promise<void>;
}

async function mountRoute(
  sidecars: PlayerSidecars,
  reposition: (position: number, seekId: number) => { sidecarUrl?: string; seekId: number },
): Promise<RouteHarness> {
  const owner: ResourceOwner = { userId: "usr_sidecar_seek", sid: "sid_sidecar_seek", expiresAt: Date.now() + 3_600_000 };
  const resourceId = mediaResources.mediaStream({ url: "https://example.test/film.mkv" } as StreamItem, owner).resourceId;
  const playbackOwners = new Map([[ID, { owner, resourceId }]]);
  const playback = {
    attended: () => undefined,
    sidecar: (id: string, revision: string | undefined, offset: number, delay: number, position: number | null) =>
      sidecars.read(id, revision, offset, delay, position),
    repositionSidecar: async (_id: string, position: number, seekId: number) => reposition(position, seekId),
  };
  const deps = {
    airplayRequest: () => undefined,
    currentSession: () => ({ userId: owner.userId, sid: owner.sid, expiresAt: owner.expiresAt }) as SessionInfo,
    ownerOf: () => owner,
    mediaSources: { assertCurrent: () => undefined } as unknown as MediaServerSources,
    playback,
    playbackOwners,
    playbackResponse: <T extends { id: string; url: string }>(value: T) => value,
    subtitleDelay: () => 0,
    trackMedia: () => undefined,
  } as unknown as PlaybackDeps;
  const app = express();
  app.use(express.json());
  registerPlaybackRoutes(app, deps);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    async sample(revision, position, offset = 0, startedAt = performance.now()) {
      const query = new URLSearchParams({ offset: offset.toFixed(3), position: position.toFixed(3) });
      if (revision !== undefined) query.set("revision", revision);
      const response = await fetch(`http://127.0.0.1:${port}/api/playback/${ID}/sidecar.vtt?${query}`);
      const body = await response.text();
      const coverage = Number(response.headers.get("x-sidecar-coverage") ?? "");
      return {
        status: response.status,
        body,
        complete: response.headers.get("x-sidecar-complete") === "1",
        coverage: Number.isFinite(coverage) ? coverage : Infinity,
        correct: false,
        elapsedMs: performance.now() - startedAt,
      };
    },
    async reposition(position, seekId) {
      const response = await fetch(`http://127.0.0.1:${port}/api/playback/${ID}/sidecar/seek`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ position, seekId }),
      });
      return { status: response.status, ...(await response.json() as { sidecarUrl?: string; seekId?: number }) };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      mediaResources.revoke(owner.sid);
    },
  };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-seek-flow-"));
  const extractor = new FakeExtractor();
  const sidecars = new PlayerSidecars(extractor.run);
  const starts = new Map<string, number>();
  let currentTrack = TRACK;
  let newestSeekId = -1;
  let newestRevision: string | undefined;
  const seekRequests: number[] = [];
  const url = (revision: string | undefined) => revision === undefined
    ? undefined
    : `/api/playback/${ID}/sidecar.vtt?revision=${revision}&offset=0.000`;
  const route = await mountRoute(sidecars, (position, seekId) => {
    seekRequests.push(seekId);
    if (seekId <= newestSeekId) return { sidecarUrl: url(newestRevision), seekId: newestSeekId };
    newestSeekId = seekId;
    const revision = sidecars.reposition(ID, directory, currentTrack, position, args(currentTrack));
    newestRevision = revision;
    starts.set(revision, starts.get(revision) ?? position);
    return { sidecarUrl: url(revision), seekId };
  });
  t.after(async () => {
    await sidecars.stop(ID);
    await route.close();
    await rm(directory, { recursive: true, force: true });
  });
  const args = (track: number) => async (start: number) => [
    "-track", String(track),
    ...(start > 0 ? ["-ss", start.toFixed(3)] : []),
  ];
  const ensure = (track: number, position: number) => {
    currentTrack = track;
    sidecars.ensure(ID, directory, track, position, args(track));
    const revision = sidecars.revision(ID);
    assert.ok(revision);
    starts.set(revision, position);
    return revision;
  };
  const assertCorrect = (sample: Sample, revision: string, position: number, offset = 0) => {
    const start = starts.get(revision);
    const correct = sample.status === 200
      && start !== undefined && start <= position + 0.001
      && cueRanges(sample.body).some(([, end]) => end >= position - offset);
    return { ...sample, correct };
  };
  return { directory, extractor, sidecars, route, starts, ensure, assertCorrect, seekRequests };
}

test("a forward seek inside coverage keeps one reader without a control request", async (t) => {
  const { extractor, sidecars, route, ensure, assertCorrect, seekRequests } = await fixture(t);
  const revision = ensure(TRACK, 300);
  await waitFor(() => extractor.runs.length === 1, "the initial reader did not start");
  await extractor.publish(cue(500, 700, "inside coverage"));
  const initial = assertCorrect(await route.sample(revision, 300), revision, 300);
  assert.equal(initial.status, 200, initial.body);

  const direct = assertCorrect(await route.sample(revision, 600), revision, 600);
  assert.equal(sidecars.revision(ID), revision);
  assert.equal(extractor.runs.length, 1);
  assert.deepEqual(seekRequests, [], "coverage lets the client keep the running watcher");

  assert.equal(ensure(TRACK, 600), revision, "the transcode seek reuses the same revision");
  assert.equal(extractor.runs.length, 1);

  const statuses = [initial.status, direct.status];
  assert.deepEqual(statuses, [200, 200]);
  assert.equal(direct.correct, true);
  t.diagnostic(JSON.stringify({
    scenario: "forward-inside",
    starts: extractor.runs.length,
    firstCorrectMs: direct.elapsedMs,
    statuses,
  }));
});

test("a forward seek beyond coverage gets the new revision before the next poll", async (t) => {
  const { extractor, route, sidecars, ensure, assertCorrect } = await fixture(t);
  const first = ensure(TRACK, 100);
  await waitFor(() => extractor.runs.length === 1, "the initial reader did not start");
  await extractor.publish(cue(110, 210, "old window"));
  assert.equal((await route.sample(first, 100)).status, 200);

  const transcodeAt = performance.now();
  const answer = await route.reposition(1_000, 1);
  const replacement = /revision=([^&]+)/.exec(answer.sidecarUrl ?? "")?.[1];
  assert.ok(replacement);
  assert.notEqual(replacement, first);
  assert.equal(answer.seekId, 1);
  await waitFor(() => extractor.runs.length === 2, "the replacement reader did not start");
  const pending = await route.sample(replacement, 1_000, 1_000, transcodeAt);
  assert.equal(pending.status, 404);
  const old = await route.sample(first, 1_000, 1_000, transcodeAt);
  assert.equal(old.status, 404, "the previous revision is gone as soon as it is replaced");

  await wait(30);
  await extractor.publish(cue(1_000, 1_005, "first after jump"));
  const served = assertCorrect(await route.sample(replacement, 1_000, 1_000, transcodeAt), replacement, 1_000, 1_000);
  assert.equal(served.status, 200);
  assert.equal(served.correct, true);
  assert.ok(served.elapsedMs >= 25, "the first correct cue waited for the fake slow source");
  assert.deepEqual(extractor.runs.map((run) => run.from), [100, 1_000]);
  assert.doesNotMatch(served.body, /old window/);
  const statuses = [200, pending.status, old.status, served.status];
  assert.deepEqual(statuses, [200, 404, 404, 200]);
  t.diagnostic(JSON.stringify({
    scenario: "forward-beyond",
    starts: extractor.runs.length,
    firstCorrectMs: served.elapsedMs,
    statuses,
  }));
});

test("a backward seek replaces the revision and serves no old cue after the answer", async (t) => {
  const { extractor, route, ensure, assertCorrect } = await fixture(t);
  const first = ensure(TRACK, 3_000);
  await waitFor(() => extractor.runs.length === 1, "the initial reader did not start");
  await extractor.publish(cue(2_990, 3_010, "later dialogue"));
  assert.equal((await route.sample(first, 3_000)).status, 200);

  const seekAt = performance.now();
  const answer = await route.reposition(100, 1);
  const replacement = /revision=([^&]+)/.exec(answer.sidecarUrl ?? "")?.[1];
  assert.ok(replacement);
  assert.notEqual(replacement, first);
  await waitFor(() => extractor.runs.length === 2, "the backward reader did not start");
  assert.equal((await route.sample(first, 100, 100)).status, 404);
  assert.equal((await route.sample(replacement, 100, 100, seekAt)).status, 404);
  await wait(30);
  await extractor.publish(cue(100, 105, "back here"));
  const served = assertCorrect(await route.sample(replacement, 100, 100, seekAt), replacement, 100, 100);
  assert.equal(served.status, 200);
  assert.equal(served.correct, true);
  assert.ok(served.elapsedMs >= 25);
  assert.doesNotMatch(served.body, /later dialogue/);
  assert.deepEqual(extractor.runs.map((run) => run.from), [3_000, 100]);
  t.diagnostic(JSON.stringify({
    scenario: "backward",
    starts: extractor.runs.length,
    firstCorrectMs: served.elapsedMs,
    statuses: [200, 404, 404, served.status],
  }));
});

test("three rapid seeks answer each request and launch only the latest replacement", async (t) => {
  const { extractor, route, ensure, assertCorrect } = await fixture(t);
  const first = ensure(TRACK, 100);
  await waitFor(() => extractor.runs.length === 1, "the initial reader did not start");
  await extractor.publish(cue(100, 200, "opening"));

  const seekAt = performance.now();
  const second = await route.reposition(2_000, 1);
  const third = await route.reposition(3_000, 2);
  const latest = await route.reposition(4_000, 3);
  const secondRevision = /revision=([^&]+)/.exec(second.sidecarUrl ?? "")?.[1];
  const thirdRevision = /revision=([^&]+)/.exec(third.sidecarUrl ?? "")?.[1];
  const latestRevision = /revision=([^&]+)/.exec(latest.sidecarUrl ?? "")?.[1];
  assert.ok(secondRevision && thirdRevision && latestRevision);
  assert.deepEqual([second.seekId, third.seekId, latest.seekId], [1, 2, 3]);
  await waitFor(() => extractor.runs.length === 2, "the latest replacement reader did not start");
  assert.deepEqual(extractor.runs.map((run) => run.from), [100, 4_000]);

  for (const revision of [first, secondRevision, thirdRevision]) {
    assert.equal((await route.sample(revision, 4_000, 4_000, seekAt)).status, 404);
  }
  assert.equal((await route.sample(latestRevision, 4_000, 4_000, seekAt)).status, 404);
  await wait(30);
  await extractor.publish(cue(4_000, 4_005, "latest target"));
  const served = assertCorrect(await route.sample(latestRevision, 4_000, 4_000, seekAt), latestRevision, 4_000, 4_000);
  assert.equal(served.status, 200);
  assert.equal(served.correct, true);
  assert.ok(served.elapsedMs >= 25);
  t.diagnostic(JSON.stringify({
    scenario: "three-rapid",
    starts: extractor.runs.length,
    firstCorrectMs: served.elapsedMs,
    statuses: [404, 404, 404, 404, served.status],
  }));
});

test("a subtitle track change during a seek replaces the revision at the seek target", async (t) => {
  const { extractor, route, ensure, assertCorrect } = await fixture(t);
  const first = ensure(TRACK, 100);
  await waitFor(() => extractor.runs.length === 1, "the initial reader did not start");
  await extractor.publish(cue(100, 200, "old track"));
  assert.equal((await route.sample(first, 100)).status, 200);

  const seekAt = performance.now();
  const pending = await route.reposition(900, 1);
  const pendingRevision = /revision=([^&]+)/.exec(pending.sidecarUrl ?? "")?.[1];
  assert.ok(pendingRevision);
  const replacement = ensure(3, 900);
  assert.notEqual(replacement, first);
  await waitFor(() => extractor.runs.length === 2, "the new track reader did not start");
  assert.equal((await route.sample(first, 900, 900, seekAt)).status, 404);
  assert.equal((await route.sample(pendingRevision, 900, 900, seekAt)).status, 404);
  assert.equal((await route.sample(replacement, 900, 900, seekAt)).status, 404);
  await wait(30);
  await extractor.publish(cue(900, 905, "new track"));
  const served = assertCorrect(await route.sample(replacement, 900, 900, seekAt), replacement, 900, 900);
  assert.equal(served.status, 200);
  assert.equal(served.correct, true);
  assert.deepEqual(extractor.runs.map((run) => [run.track, run.from]), [[TRACK, 100], [3, 900]]);
  t.diagnostic(JSON.stringify({
    scenario: "track-change-during-seek",
    starts: extractor.runs.length,
    firstCorrectMs: served.elapsedMs,
    statuses: [200, 404, 404, served.status],
  }));
});

test("ordinary playback through the silent stretch relaunches the reader once when the next cue is already far ahead", async (t) => {
  const { extractor, route, sidecars, ensure, assertCorrect } = await fixture(t);
  const revision = ensure(TRACK, 0);
  await waitFor(() => extractor.runs.length === 1, "the initial reader did not start");
  await extractor.publish(cue(0, 5, "before the silence"));
  assert.equal((await route.sample(revision, 0)).status, 200);

  const silentStatuses: number[] = [];
  for (const position of [100, 300, 600]) silentStatuses.push((await route.sample(revision, position)).status);
  assert.deepEqual(silentStatuses, [200, 200, 200]);
  await extractor.publish(cue(1_500, 1_505, "after the silence"));
  const atSixHundred = assertCorrect(await route.sample(revision, 600), revision, 600);
  assert.equal(atSixHundred.status, 200);
  assert.equal(atSixHundred.correct, true);
  await waitFor(() => extractor.running() === 0, "the far-ahead cue did not pause the reader");

  for (const position of [900, 1_200, 1_400]) await route.sample(revision, position);
  await waitFor(() => extractor.runs.length === 2, "the reader did not resume after the silence");
  assert.deepEqual(extractor.runs.map((run) => [run.from, run.append]), [[0, false], [1_505, true]]);
  assert.equal(sidecars.revision(ID), revision, "ordinary playback keeps the same revision");
  assert.equal(extractor.runs.length - 1, 1, "today's ordinary-playback restart count is one");
  assert.equal((await route.sample(revision, 1_400)).status, 200);
  t.diagnostic(JSON.stringify({
    scenario: "ordinary-sparse",
    starts: extractor.runs.length,
    restarts: extractor.runs.length - 1,
    firstCorrectMs: { asSoonAsCueWasPublished: atSixHundred.elapsedMs },
    statuses: silentStatuses,
  }));
});
