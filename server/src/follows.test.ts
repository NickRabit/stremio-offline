import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DownloadSelection } from "./downloads.js";
import type { AppError } from "./errors.js";
import { activityItems, aheadWindow, calendarFeed, calendarItems, downloadEligibility, effectiveSelection, FollowService, FollowStore, followStaggerMs, graceUntil, movieEpisode, normalizeFollowEpisodes, reconcileReleaseDates, seasonsForReconcile, undatedCalendarItems, type EpisodeDownload, type Follow, type FollowAutoDownload, type FollowDeps, type FollowEpisode, type FollowJob, type FollowQueue } from "./follows.js";
import type { MediaInfo } from "./naming.js";
import type { MetaItem } from "./types.js";

const temp = () => mkdtempSync(path.join(tmpdir(), "follows-"));
const file = (dir: string) => path.join(dir, "follows.json");
const meta = (videos: Array<Record<string, unknown>>): MetaItem =>
  ({ id: "tt1", type: "series", name: "Show", videos });
const episode = (season: number, number: number, videoId: string, released?: string, ambiguous?: boolean): FollowEpisode => ({
  key: `${season}:${number}`, videoId, season, episode: number,
  firstSeenAt: "2024-01-01T00:00:00.000Z",
  ...(released ? { released } : {}),
  ...(ambiguous ? { ambiguous: true } : {}),
});
const loaded = async (dir: string) => { const store = new FollowStore(dir); await store.load(); return store; };
const messageKeyOf = (error: unknown) => (error as { messageKey?: string }).messageKey;

interface FakeJob {
  id: string;
  status: string;
  errorKey?: string;
  follow?: { followId: string; episodeKey: string; intent: string };
  source?: { type: string; videoId: string };
}

/** A lazy queue kept in memory: it admits one job per unfinished source, records what it was
 *  asked to do, and can be told to complete, fail, drop or refuse a job. */
const fakeQueue = () => {
  const jobs: FakeJob[] = [];
  const added: Array<{ title: string; source: { type: string; videoId: string; selection?: DownloadSelection }; ownerUserId: string; follow: { followId: string; episodeKey: string; intent: string } }> = [];
  const retried: string[] = [];
  const retriedWith: DownloadSelection[] = [];
  const removed: string[] = [];
  const hooks: { remove?: (job: FakeJob) => Promise<void> } = {};
  let nextId = 1;
  let failAdd = false;
  const queue: FollowQueue = {
    addPending: async (title, source, _media: MediaInfo | undefined, ownerUserId, follow) => {
      if (failAdd) { failAdd = false; throw new Error("addPending failed"); }
      if (jobs.some((job) => job.source?.type === source.type && job.source?.videoId === source.videoId && job.status !== "completed" && job.status !== "failed")) return undefined;
      const job: FakeJob = { id: `job-${nextId++}`, status: "queued", follow, source: { type: source.type, videoId: source.videoId } };
      jobs.push(job);
      added.push({ title, source, ownerUserId, follow });
      return { id: job.id };
    },
    findActiveEpisode: (_ownerUserId, type, videoId) => jobs.find((job) => job.source?.type === type && job.source?.videoId === videoId && job.status !== "completed" && job.status !== "failed"),
    adopt: async (id, follow) => { const job = jobs.find((item) => item.id === id); if (job) job.follow = follow; },
    followJobs: () => jobs.map((job) => ({ id: job.id, status: job.status, ...(job.errorKey ? { errorKey: job.errorKey } : {}), ...(job.follow ? { follow: job.follow } : {}) })),
    get: (id) => { const job = jobs.find((item) => item.id === id); return job ? { id: job.id, status: job.status, ...(job.errorKey ? { errorKey: job.errorKey } : {}) } : undefined; },
    retry: async (id, selection) => { retried.push(id); if (selection) retriedWith.push(selection); const job = jobs.find((item) => item.id === id); if (job) job.status = "queued"; },
    remove: async (id) => {
      const index = jobs.findIndex((job) => job.id === id);
      if (index < 0) throw new Error("not found");
      if (hooks.remove) await hooks.remove(jobs[index]);
      jobs.splice(index, 1);
      removed.push(id);
    },
  };
  return {
    queue, jobs, added, retried, retriedWith, removed, hooks,
    failNextAdd: () => { failAdd = true; },
    complete: (id: string) => { const job = jobs.find((item) => item.id === id); if (job) job.status = "completed"; },
    fail: (id: string, errorKey?: string) => { const job = jobs.find((item) => item.id === id); if (job) { job.status = "failed"; job.errorKey = errorKey; } },
  };
};

test("normalizeFollowEpisodes reads the aliases the episode reader does", () => {
  const episodes = normalizeFollowEpisodes(meta([
    { id: "tt1:1:1", season: 1, number: 1, name: "Pilot", firstAired: "2024-03-01" },
    { id: "tt1:1:2", season: "1", episode: "2", title: "Second", released: "2024-03-02T10:00:00Z" },
  ]));
  assert.deepEqual(episodes, [
    { key: "1:1", videoId: "tt1:1:1", season: 1, episode: 1, title: "Pilot", released: "2024-03-01T23:59:59.999Z" },
    { key: "1:2", videoId: "tt1:1:2", season: 1, episode: 2, title: "Second", released: "2024-03-02T10:00:00.000Z" },
  ]);
});

test("specials and rows that are not whole numbers are dropped", () => {
  const episodes = normalizeFollowEpisodes(meta([
    { id: "tt1:0:1", season: 0, episode: 1 },
    { id: "tt1:1:0", season: 1, episode: 0 },
    { id: "tt1:1:15", season: 1, episode: 1.5 },
    { id: "", season: 1, episode: 2 },
    { season: 1, episode: 2 },
    { id: "tt1:1:3", season: 1, episode: 3 },
  ]));
  assert.deepEqual(episodes.map((entry) => entry.key), ["1:3"]);
});

test("a date that will not parse leaves released off the episode", () => {
  const [only] = normalizeFollowEpisodes(meta([{ id: "tt1:1:1", season: 1, episode: 1, released: "not a date" }]));
  assert.equal("released" in only, false);
});

test("two ids claiming one slot keep the first and mark it ambiguous", () => {
  const episodes = normalizeFollowEpisodes(meta([
    { id: "a", season: 1, episode: 1 },
    { id: "b", season: 1, episode: 1 },
  ]));
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].videoId, "a");
  assert.equal(episodes[0].ambiguous, true);
  const repeated = normalizeFollowEpisodes(meta([
    { id: "a", season: 1, episode: 1 },
    { id: "a", season: 1, episode: 1 },
  ]));
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].ambiguous, undefined);
});

test("reconcileReleaseDates takes a differing TMDB day and keeps an addon day TMDB agrees with", () => {
  const episodes = [episode(3, 1, "v1", "2026-09-01T20:30:00.000Z"), episode(3, 2, "v2", "2026-09-01T20:30:00.000Z")];
  const tmdb = new Map<string, string | null>([["3:1", "2026-09-01"], ["3:2", "2026-09-08"]]);

  const out = reconcileReleaseDates(episodes, tmdb, Date.parse("2026-08-01T00:00:00.000Z"));

  assert.equal(out[0].released, "2026-09-01T20:30:00.000Z", "the same day keeps the addon's time");
  assert.equal(out[0].releasedSource, "addon");
  assert.equal(out[0].dateUncertain, undefined);
  assert.equal(out[1].released, "2026-09-08T23:59:59.999Z", "a different day takes TMDB's, at the end of that day");
  assert.equal(out[1].releasedSource, "tmdb");
  assert.equal(out[1].dateUncertain, undefined);
});

test("reconcileReleaseDates drops a placeholder cluster TMDB cannot date", () => {
  const episodes = [episode(3, 1, "v1", "2026-09-01T20:30:00.000Z"), episode(3, 2, "v2", "2026-09-01T20:30:00.000Z")];
  const tmdb = new Map<string, string | null>([["3:1", null], ["3:2", null]]);

  const out = reconcileReleaseDates(episodes, tmdb, Date.parse("2026-08-01T00:00:00.000Z"));

  for (const item of out) {
    assert.equal(item.released, undefined);
    assert.equal(item.releasedSource, undefined);
    assert.equal(item.dateUncertain, true);
  }
});

test("reconcileReleaseDates marks the later episodes of a fresh shared date uncertain without TMDB", () => {
  const now = Date.parse("2024-06-01T00:00:00.000Z");
  const episodes = [episode(3, 1, "v1", "2024-05-25T00:00:00.000Z"), episode(3, 2, "v2", "2024-05-25T00:00:00.000Z"), episode(3, 3, "v3", "2024-05-25T00:00:00.000Z")];

  const out = reconcileReleaseDates(episodes, undefined, now);

  assert.equal(out[0].dateUncertain, undefined, "the first episode genuinely premieres then");
  assert.equal(out[0].released, "2024-05-25T00:00:00.000Z");
  assert.equal(out[1].dateUncertain, true);
  assert.equal(out[2].dateUncertain, true);
});

test("reconcileReleaseDates leaves an old shared date alone without TMDB", () => {
  const now = Date.parse("2024-06-01T00:00:00.000Z");
  const episodes = [episode(3, 1, "v1", "2024-04-01T00:00:00.000Z"), episode(3, 2, "v2", "2024-04-01T00:00:00.000Z")];

  const out = reconcileReleaseDates(episodes, undefined, now);

  assert.deepEqual(out.map((item) => item.dateUncertain), [undefined, undefined]);
  assert.equal(out[0].released, "2024-04-01T00:00:00.000Z");
});

test("reconcileReleaseDates keeps a genuine binge TMDB confirms", () => {
  const released = "2026-03-01T00:00:00.000Z";
  const episodes = [episode(1, 1, "v1", released), episode(1, 2, "v2", released), episode(1, 3, "v3", released)];
  const tmdb = new Map<string, string | null>([["1:1", "2026-03-01"], ["1:2", "2026-03-01"], ["1:3", "2026-03-01"]]);

  const out = reconcileReleaseDates(episodes, tmdb, Date.parse("2026-02-01T00:00:00.000Z"));

  assert.deepEqual(out.map((item) => item.released), [released, released, released]);
  assert.deepEqual(out.map((item) => item.dateUncertain), [undefined, undefined, undefined]);
  assert.deepEqual(out.map((item) => item.releasedSource), ["addon", "addon", "addon"]);
});

test("seasonsForReconcile keeps undated and recent seasons plus the download's, newest three", () => {
  const now = Date.parse("2024-06-01T00:00:00.000Z");
  const episodes = [
    { season: 1, released: "2024-05-25T00:00:00.000Z" },
    { season: 2, released: "2020-01-01T00:00:00.000Z" },
    { season: 4, released: "2024-04-15T00:00:00.000Z" },
    { season: 5 },
    { season: 6, released: "2024-05-01T00:00:00.000Z" },
  ];
  const stored: Record<string, FollowEpisode> = { "7:1": { ...episode(7, 1, "v7", "2020-01-01T00:00:00.000Z"), download: download({ state: "waiting" }) } };

  assert.deepEqual(seasonsForReconcile(episodes, stored, now), [7, 6, 5]);
});

test("creating the same series twice returns the follow already there", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await loaded(dir);
  const first = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show" }, 1_000);
  const again = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show" }, 2_000);
  assert.equal(again.id, first.id);
  assert.equal(store.listForOwner("u1").length, 1);
});

test("two owners get two follows of the same series", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await loaded(dir);
  const one = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show" }, 1_000);
  const two = await store.create({ ownerUserId: "u2", type: "series", metaId: "tt1", name: "Show" }, 1_000);
  assert.notEqual(one.id, two.id);
  assert.deepEqual(store.listForOwner("u1").map((follow) => follow.id), [one.id]);
  assert.deepEqual(store.listForOwner("u2").map((follow) => follow.id), [two.id]);
});

test("a file that cannot be read is left alone and blocks every write", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(file(dir), "not json at all");
  const store = await loaded(dir);
  assert.equal(store.unavailable, true);
  assert.deepEqual(store.listForOwner("u1"), []);
  await assert.rejects(
    store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show" }, 1_000),
    (error) => messageKeyOf(error) === "err.followsUnreadable",
  );
  assert.equal(readFileSync(file(dir), "utf8"), "not json at all");
});

test("a version other than one is kept rather than replaced", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const body = JSON.stringify({ version: 2, follows: [] });
  writeFileSync(file(dir), body);
  const store = await loaded(dir);
  assert.equal(store.unavailable, true);
  await assert.rejects(
    store.removeOwner("u1"),
    (error) => (error as AppError).messageKey === "err.followsUnreadable",
  );
  assert.equal(readFileSync(file(dir), "utf8"), body);
});

test("a written follow comes back the way it went in", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await loaded(dir);
  const created = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show", poster: "poster.jpg" }, 1_000);
  await store.recordCheck(created.id, { episodes: [episode(1, 1, "tt1:1:1", "2024-01-02T00:00:00.000Z")], now: 5_000 });
  const reloaded = await loaded(dir);
  const follow = reloaded.get(created.id);
  assert.equal(follow?.name, "Show");
  assert.equal(follow?.poster, "poster.jpg");
  assert.equal(follow?.episodes["1:1"]?.videoId, "tt1:1:1");
  assert.equal(follow?.lastCheckedAt, new Date(5_000).toISOString());
});

test("fields a later version adds survive a reload and an update", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(file(dir), JSON.stringify({
    version: 1,
    follows: [{
      id: "f1", ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show",
      createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z",
      enabled: true, revision: 1, nextCheckAt: "2024-01-01T00:00:00.000Z", failures: 0,
      autoDownload: { quality: "1080p" },
      episodes: {
        "1:1": { key: "1:1", videoId: "tt1:1:1", season: 1, episode: 1, firstSeenAt: "2024-01-01T00:00:00.000Z", downloadState: "queued" },
      },
    }],
  }));
  const store = await loaded(dir);
  await store.recordCheck("f1", { episodes: [episode(1, 2, "tt1:1:2", "2024-01-03T00:00:00.000Z")], now: 5_000 });
  await store.update("f1", (follow) => { follow.enabled = false; follow.revision += 1; });
  const onDisk = JSON.parse(readFileSync(file(dir), "utf8")) as { follows: Array<Record<string, unknown>> };
  assert.deepEqual(onDisk.follows[0].autoDownload, { quality: "1080p" });
  assert.equal((onDisk.follows[0].episodes as Record<string, Record<string, unknown>>)["1:1"].downloadState, "queued");
  assert.equal(onDisk.follows[0].enabled, false);
});

test("a successful check comes back a day later plus the follow's stagger", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await loaded(dir);
  const follow = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show" }, 1_000_000);
  await store.recordCheck(follow.id, { episodes: [], now: 1_000_000 });
  const after = store.get(follow.id)!;
  assert.equal(after.nextCheckAt, new Date(1_000_000 + 86_400_000 + followStaggerMs(follow.id)).toISOString());
  assert.equal(after.failures, 0);
  assert.equal(after.lastCheckedAt, new Date(1_000_000).toISOString());
  assert.equal(after.lastSuccessfulCheckAt, new Date(1_000_000).toISOString());
  assert.equal(after.lastErrorKey, undefined);
});

test("failures back off fifteen minutes, then an hour, then six", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await loaded(dir);
  const follow = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show" }, 0);
  const fail = async (now: number) => {
    await store.recordCheck(follow.id, { errorKey: "err.followMetaUnavailable", now });
    return store.get(follow.id)!;
  };
  let after = await fail(0);
  assert.equal(after.nextCheckAt, new Date(15 * 60_000).toISOString());
  assert.equal(after.failures, 1);
  assert.equal(after.lastErrorKey, "err.followMetaUnavailable");
  after = await fail(15 * 60_000);
  assert.equal(after.nextCheckAt, new Date(15 * 60_000 + 60 * 60_000).toISOString());
  assert.equal(after.failures, 2);
  after = await fail(15 * 60_000 + 60 * 60_000);
  assert.equal(after.nextCheckAt, new Date(15 * 60_000 + 60 * 60_000 + 6 * 60 * 60_000).toISOString());
  assert.equal(after.failures, 3);
  after = await fail(15 * 60_000 + 60 * 60_000 + 6 * 60 * 60_000);
  assert.equal(after.nextCheckAt, new Date(15 * 60_000 + 60 * 60_000 + 12 * 60 * 60_000).toISOString());
  assert.equal(after.failures, 4);
});

test("a success clears the failures a check collected", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await loaded(dir);
  const follow = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show" }, 0);
  await store.recordCheck(follow.id, { errorKey: "err.followMetaUnavailable", now: 0 });
  await store.recordCheck(follow.id, { episodes: [], now: 1_000 });
  const after = store.get(follow.id)!;
  assert.equal(after.failures, 0);
  assert.equal(after.lastErrorKey, undefined);
});

test("a paused follow is never due", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await loaded(dir);
  const follow = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show" }, 0);
  assert.deepEqual(store.due(0).map((entry) => entry.id), [follow.id]);
  await store.update(follow.id, (entry) => { entry.enabled = false; entry.revision += 1; });
  assert.deepEqual(store.due(10_000), []);
});

test("due answers the longest waiting follow first", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await loaded(dir);
  const first = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "One" }, 0);
  const second = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt2", name: "Two" }, 0);
  await store.recordCheck(second.id, { episodes: [], now: 0 });
  assert.deepEqual(store.due(0).map((entry) => entry.id), [first.id]);
});

test("a second check joins the one already in flight", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await loaded(dir);
  const follow = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show" }, 0);
  let calls = 0;
  let release!: (value: MetaItem | null) => void;
  const pending = new Promise<MetaItem | null>((resolve) => { release = resolve; });
  const service = new FollowService({
    store, now: () => 0, owner: () => ({ id: "u1", role: "user" }),
    queue: fakeQueue().queue, mayDownload: () => true,
    meta: () => { calls += 1; return pending; },
  });
  const first = service.check(follow.id, "manual");
  const second = service.check(follow.id, "manual");
  assert.equal(first, second);
  release(meta([{ id: "tt1:1:1", season: 1, episode: 1 }]));
  await first;
  assert.equal(calls, 1);
});

test("a deleted or switched-off owner is never asked for metadata", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await loaded(dir);
  const follow = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show" }, 0);
  let calls = 0;
  const metaStub = async () => { calls += 1; return meta([]); };
  await new FollowService({ store, now: () => 0, owner: () => undefined, queue: fakeQueue().queue, mayDownload: () => true, meta: metaStub }).check(follow.id, "schedule");
  await new FollowService({ store, now: () => 0, owner: () => ({ id: "u1", role: "user", disabled: true }), queue: fakeQueue().queue, mayDownload: () => true, meta: metaStub }).check(follow.id, "schedule");
  assert.equal(calls, 0);
  assert.equal(store.get(follow.id)!.lastCheckedAt, undefined);
});

test("a null answer is recorded as a failure", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await loaded(dir);
  const follow = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show" }, 0);
  await new FollowService({ store, now: () => 100, owner: () => ({ id: "u1", role: "user" }), queue: fakeQueue().queue, mayDownload: () => true, meta: async () => null }).check(follow.id, "schedule");
  const after = store.get(follow.id)!;
  assert.equal(after.failures, 1);
  assert.equal(after.lastErrorKey, "err.followMetaUnavailable");
});

test("an edit while the metadata is in flight keeps the episodes it brought", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await loaded(dir);
  const follow = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show" }, 0);
  let release!: (value: MetaItem | null) => void;
  const pending = new Promise<MetaItem | null>((resolve) => { release = resolve; });
  const service = new FollowService({ store, now: () => 1_000, owner: () => ({ id: "u1", role: "user" }), queue: fakeQueue().queue, mayDownload: () => true, meta: () => pending });
  const run = service.check(follow.id, "manual");
  await store.update(follow.id, (entry) => { entry.revision += 1; });
  release(meta([{ id: "tt1:1:1", season: 1, episode: 1 }]));
  await run;
  assert.deepEqual(Object.keys(store.get(follow.id)!.episodes), ["1:1"], "switching downloads on after following must not lose the first check");
  assert.ok(store.get(follow.id)!.lastCheckedAt);
});

test("a follow removed while the metadata is in flight records nothing", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await loaded(dir);
  const follow = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show" }, 0);
  let release!: (value: MetaItem | null) => void;
  const pending = new Promise<MetaItem | null>((resolve) => { release = resolve; });
  const service = new FollowService({ store, now: () => 1_000, owner: () => ({ id: "u1", role: "user" }), queue: fakeQueue().queue, mayDownload: () => true, meta: () => pending });
  const run = service.check(follow.id, "manual");
  await store.remove(follow.id);
  release(meta([{ id: "tt1:1:1", season: 1, episode: 1 }]));
  await run;
  assert.equal(store.get(follow.id), undefined);
});

test("a manual check is refused inside the cooldown and answered after it", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await loaded(dir);
  const follow = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show" }, 0);
  let now = 0;
  const service = new FollowService({ store, now: () => now, owner: () => ({ id: "u1", role: "user" }), queue: fakeQueue().queue, mayDownload: () => true, meta: async () => meta([]) });
  await service.checkNow(follow.id, "u1");
  await assert.rejects(service.checkNow(follow.id, "u1"), (error) => messageKeyOf(error) === "err.followCooldown");
  await assert.rejects(service.checkNow(follow.id, "u2"), (error) => (error as AppError).status === 404);
  now = 60_000;
  await service.checkNow(follow.id, "u1");
  assert.equal(store.get(follow.id)!.lastCheckedAt, new Date(60_000).toISOString());
});

test("new episodes are the owner's own, inside the window and after the marker", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await loaded(dir);
  const follow = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show" }, Date.parse("2024-01-01T00:00:00.000Z"));
  await store.recordCheck(follow.id, { episodes: [
    episode(1, 1, "tt1:1:1", "2024-04-06T00:00:00.000Z"),
    episode(1, 2, "tt1:1:2", "2024-04-05T00:00:00.000Z"),
    episode(1, 3, "tt1:1:3", "2024-04-20T00:00:00.000Z"),
    episode(1, 4, "tt1:1:4", "2024-03-20T00:00:00.000Z"),
    episode(1, 5, "tt1:1:5", "2024-05-10T00:00:00.000Z"),
    episode(1, 6, "tt1:1:6", "2024-04-02T00:00:00.000Z"),
    episode(2, 1, "tt1:2:1", "2024-04-10T00:00:00.000Z", true),
    { key: "2:2", videoId: "tt1:2:2", season: 2, episode: 2, firstSeenAt: "2024-01-01T00:00:00.000Z" },
  ], now: Date.parse("2024-04-01T00:00:00.000Z") });
  const paused = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt2", name: "Other" }, Date.parse("2024-01-01T00:00:00.000Z"));
  await store.recordCheck(paused.id, { episodes: [episode(1, 1, "tt2:1:1", "2024-04-25T00:00:00.000Z")], now: Date.parse("2024-04-01T00:00:00.000Z") });
  await store.update(paused.id, (entry) => { entry.enabled = false; entry.revision += 1; });
  const stranger = await store.create({ ownerUserId: "u2", type: "series", metaId: "tt1", name: "Show" }, Date.parse("2024-01-01T00:00:00.000Z"));
  await store.recordCheck(stranger.id, { episodes: [episode(1, 1, "tt1:1:1", "2024-04-15T00:00:00.000Z")], now: Date.parse("2024-04-01T00:00:00.000Z") });

  const service = new FollowService({
    store,
    now: () => Date.parse("2024-04-30T00:00:00.000Z"),
    owner: () => ({ id: "u1", role: "user" }),
    queue: fakeQueue().queue, mayDownload: () => true,
    meta: async () => null,
  });
  const items = service.newEpisodes("u1", (metaId) => metaId === "tt1" ? { season: 1, episode: 1 } : undefined);
  assert.deepEqual(items.map((item) => `${item.metaId}:${item.season}:${item.episode}`), ["tt2:1:1", "tt1:1:3", "tt1:1:2", "tt1:1:6"]);
  assert.deepEqual(items.map((item) => item.followId), [paused.id, follow.id, follow.id, follow.id]);
  assert.equal(items[1].name, "Show");
  assert.equal(items[1].type, "series");
  assert.equal(items[1].videoId, "tt1:1:3");
});

const NOW = Date.parse("2024-06-01T00:00:00.000Z");
const RELEASED = "2024-03-01T00:00:00.000Z";

const selection = (): DownloadSelection => ({
  addonKeys: ["addon"], sourceStrategy: "priority", audioLanguage: "en", audioMode: "listed",
  subtitleMode: "off", targetSettings: { subfolder: "", layout: "structured" },
});
const rule = (over: Partial<FollowAutoDownload> = {}): FollowAutoDownload => ({
  enabledAt: "2024-01-01T00:00:00.000Z", startMode: "new", selection: selection(), ...over,
});
const buildService = (store: FollowStore, q: ReturnType<typeof fakeQueue>, over: Partial<FollowDeps> = {}) => new FollowService({
  store, now: () => NOW, owner: () => ({ id: "u1", role: "user" }), meta: async () => null,
  queue: q.queue, mayDownload: () => true, ...over,
});
const seedSeries = async (store: FollowStore, episodes: FollowEpisode[], auto: FollowAutoDownload, now = 0): Promise<string> => {
  const follow = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show" }, now);
  await store.recordCheck(follow.id, { episodes, now });
  await store.update(follow.id, (current) => { current.autoDownload = auto; });
  return follow.id;
};
const withStore = async (t: { after: (fn: () => void) => void }) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: await loaded(dir) };
};

test("TMDB corrections leave the seasons it was not asked about alone", () => {
  const old = [1, 2, 3].map((n) => ({ key: `1:${n}`, videoId: `v${n}`, season: 1, episode: n, released: "2019-05-01T08:00:00.000Z", firstSeenAt: "2026-01-01T00:00:00.000Z" }));
  const fresh = { key: "2:1", videoId: "w1", season: 2, episode: 1, released: "2026-09-01T20:30:00.000Z", firstSeenAt: "2026-01-01T00:00:00.000Z" };
  const result = reconcileReleaseDates([...old, fresh], new Map([["2:1", "2026-09-01"]]), Date.parse("2026-10-04T00:00:00Z"));
  for (const episode of result.filter((item) => item.season === 1)) {
    assert.equal(episode.released, "2019-05-01T08:00:00.000Z", "an old binge season keeps its shared date");
    assert.equal(episode.dateUncertain, undefined);
  }
});

test("downloadEligibility follows the start rule, the clock and the episode's facts", () => {
  const follow = (auto?: FollowAutoDownload): Follow => ({
    id: "f", ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show", createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z", enabled: true, revision: 1, nextCheckAt: "2024-01-01T00:00:00.000Z", failures: 0,
    ...(auto ? { autoDownload: auto } : {}), episodes: {},
  });
  const ep = (over: Partial<FollowEpisode> = {}): FollowEpisode => ({ key: "1:1", videoId: "v1", season: 1, episode: 1, firstSeenAt: "2024-02-01T00:00:00.000Z", ...over });

  assert.equal(downloadEligibility(follow(), ep({ released: RELEASED }), NOW), "outside", "no rule is never automatic");
  assert.equal(downloadEligibility(follow(rule()), ep({ released: RELEASED }), NOW), "eligible");
  assert.equal(downloadEligibility(follow(rule({ enabledAt: "2024-04-01T00:00:00.000Z" })), ep({ released: RELEASED }), NOW), "outside", "released before the rule");
  assert.equal(downloadEligibility(follow(rule()), ep(), NOW), "attention-no-date", "an unseen date is not proof");
  assert.equal(downloadEligibility(follow(rule({ enabledAt: "2024-03-01T00:00:00.000Z" })), ep(), NOW), "outside", "first seen before the rule");
  assert.equal(downloadEligibility(follow(rule()), ep({ released: RELEASED, ambiguous: true }), NOW), "attention-ambiguous");
  assert.equal(downloadEligibility(follow(rule()), ep({ released: "2024-07-01T00:00:00.000Z" }), NOW), "upcoming");
  assert.equal(downloadEligibility(follow(rule()), ep({ dateUncertain: true }), NOW), "upcoming", "an uncertain episode with no date waits rather than asking to be resolved");
  assert.equal(downloadEligibility(follow(rule()), ep({ released: RELEASED, dateUncertain: true }), NOW), "eligible", "an uncertain episode with a past date still downloads");

  const from = rule({ startMode: "from", startSeason: 2, startEpisode: 3 });
  assert.equal(downloadEligibility(follow(from), ep({ season: 2, episode: 3, released: RELEASED }), NOW), "eligible");
  assert.equal(downloadEligibility(follow(from), ep({ season: 2, episode: 2, released: RELEASED }), NOW), "outside", "before the start episode");
  assert.equal(downloadEligibility(follow(from), ep({ season: 1, episode: 9, released: RELEASED }), NOW), "outside", "season is compared first");
});

test("aheadWindow is the next N regular episodes after the marker, or the first N", () => {
  const series = (episodes: FollowEpisode[], aheadCount = 3): Follow => ({
    id: "f", ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show", createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z", enabled: true, revision: 1, nextCheckAt: "2024-01-01T00:00:00.000Z", failures: 0,
    autoDownload: { enabledAt: "2024-01-01T00:00:00.000Z", startMode: "ahead", aheadCount, selection: selection() },
    episodes: Object.fromEntries(episodes.map((episode) => [episode.key, episode])),
  });
  const numbered = (count: number): FollowEpisode[] =>
    Array.from({ length: count }, (_unused, index) => episode(1, index + 1, `v1${index + 1}`, RELEASED));

  assert.deepEqual([...aheadWindow(series(numbered(5)), undefined)].sort(), ["1:1", "1:2", "1:3"], "no marker starts at the first episode");
  assert.deepEqual([...aheadWindow(series(numbered(5)), { season: 1, episode: 2 })].sort(), ["1:3", "1:4", "1:5"], "a mid-season marker slides the window on");

  const across = [episode(1, 9, "v19", RELEASED), episode(1, 10, "v110", RELEASED), episode(2, 1, "v21", RELEASED), episode(2, 2, "v22", RELEASED)];
  assert.deepEqual([...aheadWindow(series(across, 2), { season: 1, episode: 10 })].sort(), ["2:1", "2:2"], "the window crosses a season boundary");

  const withSpecials = [episode(0, 1, "s1", RELEASED), episode(0, 2, "s2", RELEASED), episode(1, 1, "v11", RELEASED), episode(1, 2, "v12", RELEASED), episode(1, 3, "v13", RELEASED)];
  assert.deepEqual([...aheadWindow(series(withSpecials, 2), undefined)].sort(), ["1:1", "1:2"], "specials are ignored");

  const holed = [episode(1, 1, "v11", RELEASED), episode(1, 2, "v12"), episode(1, 3, "v13", RELEASED), episode(1, 4, "v14", RELEASED)];
  const ahead = series(holed, 2);
  assert.deepEqual([...aheadWindow(ahead, { season: 1, episode: 1 })].sort(), ["1:2", "1:3"], "an episode with no date still spends a slot");
  assert.equal(downloadEligibility(ahead, ahead.episodes["1:1"], NOW, { season: 1, episode: 1 }), "outside", "the marker's own episode is behind the window");
  assert.equal(downloadEligibility(ahead, ahead.episodes["1:3"], NOW, { season: 1, episode: 1 }), "eligible");
  assert.equal(downloadEligibility(ahead, ahead.episodes["1:4"], NOW, { season: 1, episode: 1 }), "outside", "beyond the window nothing is automatic");
  assert.equal(downloadEligibility(ahead, ahead.episodes["1:2"], NOW, { season: 1, episode: 1 }), "attention-no-date", "inside the window the usual checks still apply");
});

test("an ahead rule admits only its window, older seasons included, and slides with the marker", async (t) => {
  const { store } = await withStore(t);
  const episodes = [episode(1, 1, "v11", RELEASED), episode(1, 2, "v12", RELEASED), episode(2, 1, "v21", RELEASED), episode(2, 2, "v22", RELEASED)];
  let marker: { season: number; episode: number } | undefined;
  const q = fakeQueue();
  const service = buildService(store, q, { watched: () => marker });
  const id = await seedSeries(store, episodes, rule({ startMode: "ahead", aheadCount: 2 }));
  await service.admit(id);
  assert.deepEqual(q.added.map((item) => item.follow.episodeKey), ["1:1", "1:2"], "nothing beyond the window is queued");
  marker = { season: 1, episode: 2 };
  await service.admit(id);
  assert.deepEqual(q.added.map((item) => item.follow.episodeKey), ["1:1", "1:2", "2:1", "2:2"], "the marker slides the window onto the next episodes");
  assert.deepEqual(q.removed, [], "moving the window cancels nothing");
});

const DAY = 24 * 60 * 60_000;

test("graceUntil opens for graceDays after release and never without one", () => {
  const auto = rule({ graceDays: 7 });
  assert.equal(graceUntil(auto, episode(1, 1, "v1", RELEASED)), Date.parse(RELEASED) + 7 * DAY);
  assert.equal(graceUntil(auto, episode(1, 2, "v2")), undefined, "no release date, no window");
  assert.equal(graceUntil(rule({ graceDays: 0 }), episode(1, 1, "v1", RELEASED)), undefined, "zero means no waiting");
  assert.equal(graceUntil(rule(), episode(1, 1, "v1", RELEASED)), undefined, "absent means no waiting");
});

test("effectiveSelection strips the fallback inside the window and restores it after", () => {
  const auto = rule({ graceDays: 7, selection: { ...selection(), fallbackAudioLanguage: "cs", audioMode: "preferred" } });
  const film = episode(1, 1, "v1", RELEASED);
  const until = Date.parse(RELEASED) + 7 * DAY;
  const inside = effectiveSelection(auto, film, until - 1);
  assert.equal(inside.fallbackAudioLanguage, undefined);
  assert.equal(inside.audioMode, "listed");
  assert.equal(inside.audioLanguage, "en", "the preferred language itself never changes");
  const after = effectiveSelection(auto, film, until);
  assert.equal(after, auto.selection, "at the boundary the saved rules stand");
  assert.equal(after.fallbackAudioLanguage, "cs");
  assert.equal(after.audioMode, "preferred");
});

test("effectiveSelection keeps a strict mode strict and an undated episode unchanged", () => {
  const strict = rule({ graceDays: 7, selection: { ...selection(), fallbackAudioLanguage: "cs", audioMode: "strict" } });
  const dated = episode(1, 1, "v1", RELEASED);
  assert.equal(effectiveSelection(strict, dated, Date.parse(RELEASED) + 1).audioMode, "strict");
  assert.equal(effectiveSelection(strict, dated, Date.parse(RELEASED) + 1).fallbackAudioLanguage, undefined, "the fallback is dropped whatever the mode");
  assert.equal(effectiveSelection(strict, episode(1, 2, "v2"), NOW), strict.selection, "no date leaves the selection alone");
  const noWindow = rule({ graceDays: 0 });
  assert.equal(effectiveSelection(noWindow, dated, NOW), noWindow.selection, "no window leaves the selection alone");
});

test("admission inside the window passes the stripped selection, and the close restores it", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  const released = "2024-05-25T00:00:00.000Z";
  const until = Date.parse(released) + 7 * DAY;
  let now = until - 30 * 60_000;
  const service = buildService(store, q, { now: () => now });
  const auto = rule({ graceDays: 7, selection: { ...selection(), fallbackAudioLanguage: "cs", audioMode: "preferred" } });
  const id = await seedSeries(store, [episode(1, 1, "v1", released)], auto);

  await service.admit(id);
  assert.equal(q.added[0].source.selection?.fallbackAudioLanguage, undefined, "the fallback is dropped inside the window");
  assert.equal(q.added[0].source.selection?.audioMode, "listed", "a preferred mode softens to listed");

  q.fail(q.jobs[0].id, "err.noMatchingSource");
  await service.sync();
  let download = store.get(id)!.episodes["1:1"].download!;
  assert.equal(download.state, "waiting");
  assert.equal(download.nextAttemptAt, new Date(until).toISOString(), "the ladder never reaches past the window's close");
  assert.equal(download.graceUntil, new Date(until).toISOString());

  now = until + 60_000;
  await service.sync();
  const retried = q.retriedWith.at(-1)!;
  assert.equal(retried.fallbackAudioLanguage, "cs", "after the window the full rules return");
  assert.equal(retried.audioMode, "preferred");
  download = store.get(id)!.episodes["1:1"].download!;
  assert.equal(download.state, "queued");
});

test("admission queues in season order and stops at the caps", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  const service = buildService(store, q);
  const id = await seedSeries(store, [episode(1, 3, "v3", RELEASED), episode(1, 1, "v1", RELEASED), episode(1, 2, "v2", RELEASED)], rule());
  await service.admit(id);
  assert.deepEqual(q.added.map((entry) => entry.follow.episodeKey), ["1:1", "1:2", "1:3"]);
  assert.equal(q.added[0].title, "Show · S01E01");
  assert.equal(store.get(id)!.episodes["1:1"].download?.state, "queued");
});

test("a long season is admitted over several passes, never more than twenty at once", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  const service = buildService(store, q);
  const episodes = Array.from({ length: 25 }, (_unused, index) => episode(1, index + 1, `v${index + 1}`, RELEASED));
  const id = await seedSeries(store, episodes, rule());
  await service.admit(id);
  assert.equal(q.added.length, 20);
  await service.admit(id);
  assert.equal(q.added.length, 20, "twenty are already outstanding, so a second pass adds nothing");
  for (const job of q.jobs) q.complete(job.id);
  await service.sync();
  await service.admit(id);
  assert.equal(q.added.length, 25);
  assert.equal(store.get(id)!.episodes["1:25"].download?.state, "queued");
});

test("the outstanding budget is shared across every follow", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  const service = buildService(store, q);
  const many = Array.from({ length: 15 }, (_unused, index) => episode(1, index + 1, `a${index + 1}`, RELEASED));
  const first = await seedSeries(store, many, rule());
  const second = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt2", name: "Other" }, 0);
  await store.recordCheck(second.id, { episodes: many.map((entry, index) => ({ ...entry, key: `2:${index + 1}`, videoId: `b${index + 1}` })), now: 0 });
  await store.update(second.id, (current) => { current.autoDownload = rule(); });
  await service.admit(first);
  assert.equal(q.added.length, 15);
  await service.admit(second.id);
  assert.equal(q.added.length, 20, "only the room left in the budget is used");
  assert.equal(store.get(second.id)!.episodes["2:6"].download, undefined);
});

test("a crash between reserving and queueing is re-admitted once", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  const service = buildService(store, q);
  const id = await seedSeries(store, [episode(1, 1, "v1", RELEASED)], rule());
  q.failNextAdd();
  await assert.rejects(service.admit(id));
  assert.equal(store.get(id)!.episodes["1:1"].download?.state, "reserved");
  assert.equal(q.added.length, 0);
  await service.admit(id);
  assert.equal(store.get(id)!.episodes["1:1"].download?.state, "queued");
  assert.equal(q.added.length, 1, "re-admitted exactly once");
  assert.equal(store.get(id)!.episodes["1:1"].download?.generation, 1, "the same generation is reused");
  await service.admit(id);
  assert.equal(q.added.length, 1, "a third pass adds nothing");
});

test("a crash between queueing and linking is linked by sync without a second job", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  const service = buildService(store, q);
  const id = await seedSeries(store, [episode(1, 1, "v1", RELEASED)], rule());
  await service.admit(id);
  const job = q.jobs[0];
  // Simulate the crash: the job landed, but the episode was never moved off `reserved`.
  await store.update(id, (current) => { current.episodes["1:1"].download = { state: "reserved", intent: job.follow!.intent, generation: 1, attempts: 0, updatedAt: RELEASED }; });
  await service.sync();
  const download = store.get(id)!.episodes["1:1"].download!;
  assert.equal(download.state, "queued");
  assert.equal(download.jobId, job.id);
  assert.equal(q.added.length, 1, "sync links the existing job rather than queueing another");
});

test("a failed job waits on the ladder and is retried in place", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  let now = NOW;
  const service = buildService(store, q, { now: () => now });
  const id = await seedSeries(store, [episode(1, 1, "v1", RELEASED)], rule());
  await service.admit(id);
  const jobId = q.jobs[0].id;

  q.fail(jobId, "err.noMatchingSource");
  await service.sync();
  let download = store.get(id)!.episodes["1:1"].download!;
  assert.equal(download.state, "waiting");
  assert.equal(download.attempts, 1);
  assert.equal(download.reasonKey, "err.noMatchingSource");
  assert.equal(download.nextAttemptAt, new Date(now + 3_600_000).toISOString());

  await service.sync();
  assert.deepEqual(q.retried, [], "not due yet");
  now += 3_600_000;
  await service.sync();
  download = store.get(id)!.episodes["1:1"].download!;
  assert.equal(download.state, "queued");
  assert.deepEqual(q.retried, [jobId]);
  assert.equal(q.added.length, 1, "the same job is retried, never a second one");

  q.fail(jobId, "err.noMatchingSource");
  await service.sync();
  download = store.get(id)!.episodes["1:1"].download!;
  assert.equal(download.attempts, 2);
  assert.equal(download.nextAttemptAt, new Date(now + 6 * 3_600_000).toISOString());

  now += 6 * 3_600_000;
  await service.sync();
  q.fail(jobId);
  await service.sync();
  download = store.get(id)!.episodes["1:1"].download!;
  assert.equal(download.attempts, 3);
  assert.equal(download.reasonKey, "err.followDownloadFailed", "a job with no key uses the fallback");
  assert.equal(download.nextAttemptAt, new Date(now + 24 * 3_600_000).toISOString());
});

test("a vanished accepted job goes to attention and only an explicit retry re-queues it", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  const service = buildService(store, q);
  const id = await seedSeries(store, [episode(1, 1, "v1", RELEASED)], rule());
  await service.admit(id);
  q.jobs.splice(0, 1);

  await service.sync();
  let download = store.get(id)!.episodes["1:1"].download!;
  assert.equal(download.state, "attention");
  assert.equal(download.reasonKey, "err.followJobMissing");
  await service.admit(id);
  assert.equal(store.get(id)!.episodes["1:1"].download?.state, "attention", "never re-admitted blindly");
  assert.equal(q.added.length, 1);

  await service.retryEpisode(id, "u1", "1:1");
  download = store.get(id)!.episodes["1:1"].download!;
  assert.equal(download.state, "queued");
  assert.equal(download.generation, 2);
  assert.equal(download.intent, `${id}:1:1:2`);
  assert.equal(q.added.length, 2, "exactly one new job");
  assert.equal(q.added[1].follow.intent, `${id}:1:1:2`);
});

test("removing a job records a skip that is never re-admitted", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  const service = buildService(store, q);
  q.hooks.remove = (job) => service.jobRemoving(job, "user");
  const id = await seedSeries(store, [episode(1, 1, "v1", RELEASED)], rule());
  await service.admit(id);
  await q.queue.remove(q.jobs[0].id);
  assert.equal(store.get(id)!.episodes["1:1"].download?.state, "skipped");
  assert.equal(store.get(id)!.episodes["1:1"].download?.reasonKey, "err.followSkipped");
  await service.admit(id);
  assert.equal(store.get(id)!.episodes["1:1"].download?.state, "skipped");
  assert.equal(q.added.length, 1);
});

test("clearing a failed job keeps the episode waiting and queues a fresh one when due", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  let now = NOW;
  const service = buildService(store, q, { now: () => now });
  q.hooks.remove = (job) => service.jobRemoving(job, "user");
  const id = await seedSeries(store, [episode(1, 1, "v1", RELEASED)], rule());
  await service.admit(id);
  q.fail(q.jobs[0].id, "err.noMatchingSource");
  await service.sync();
  await q.queue.remove(q.jobs[0].id);

  let download = store.get(id)!.episodes["1:1"].download!;
  assert.equal(download.state, "waiting", "a cleared failure is not a skip");
  assert.equal(download.jobId, undefined);
  assert.equal(download.reasonKey, "err.noMatchingSource");
  await service.sync();
  assert.equal(q.added.length, 1, "nothing before the next attempt is due");

  now += 3_600_000;
  await service.sync();
  download = store.get(id)!.episodes["1:1"].download!;
  assert.equal(download.state, "queued");
  assert.equal(download.generation, 2);
  assert.equal(q.added.length, 2, "exactly one fresh job");
});

test("changing the rules retries waiting episodes at once with the new selection", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  const service = buildService(store, q);
  q.hooks.remove = (job) => service.jobRemoving(job, "user");
  const id = await seedSeries(store, [episode(1, 1, "v1", RELEASED), episode(1, 2, "v2", RELEASED), episode(1, 3, "v3", RELEASED)], rule());
  await service.admit(id);
  q.fail(q.jobs[0].id, "err.noMatchingSource");
  q.fail(q.jobs[1].id, "err.noMatchingSource");
  await service.sync();
  await q.queue.remove(q.jobs[1].id);
  await q.queue.remove(q.jobs[1].id);

  const current = store.get(id)!.autoDownload!;
  const selection = { ...current.selection, audioMode: "preferred" as const };
  await service.setAutoDownload(id, "u1", { startMode: current.startMode, startSeason: current.startSeason, startEpisode: current.startEpisode, selection });

  const episodes = store.get(id)!.episodes;
  assert.equal(episodes["1:1"].download?.state, "queued", "the failed job is retried in place");
  assert.deepEqual(q.retriedWith.map((item) => item.audioMode), ["preferred"]);
  assert.equal(episodes["1:2"].download?.state, "queued", "a cleared failure gets a fresh job now");
  assert.equal(episodes["1:2"].download?.generation, 2);
  assert.equal(episodes["1:3"].download?.state, "skipped", "a skip stays a skip");
  assert.equal(q.added.length, 4);
});

test("switching automatic downloads off frees the shared budget for other follows", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  const service = buildService(store, q);
  const many = Array.from({ length: 20 }, (_, index) => episode(1, index + 1, `a${index}`, RELEASED));
  const first = await seedSeries(store, many, rule());
  await service.admit(first);
  for (const job of q.jobs) q.fail(job.id, "err.noMatchingSource");
  await service.sync();
  const other = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt2", name: "Other" }, 0);
  await store.recordCheck(other.id, { episodes: [episode(1, 1, "b1", RELEASED)], now: 0 });
  await store.update(other.id, (current) => { current.autoDownload = rule(); });
  await service.admit(other.id);
  assert.equal(store.get(other.id)!.episodes["1:1"].download, undefined, "twenty waiting episodes hold the budget");

  await service.setAutoDownload(first, "u1", null);
  await service.admit(other.id);
  assert.equal(store.get(other.id)!.episodes["1:1"].download?.state, "queued", "a switched-off follow no longer holds it");
});

test("removing a failed job keeps a skip the person already chose", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  const service = buildService(store, q);
  q.hooks.remove = (job) => service.jobRemoving(job, "user");
  const id = await seedSeries(store, [episode(1, 1, "v1", RELEASED)], rule());
  await service.admit(id);
  q.fail(q.jobs[0].id, "err.noMatchingSource");
  await service.sync();
  await service.skipEpisode(id, "u1", "1:1");
  assert.equal(store.get(id)!.episodes["1:1"].download?.state, "skipped");
  await q.queue.remove(q.jobs[0].id);
  assert.equal(store.get(id)!.episodes["1:1"].download?.state, "skipped", "tidying the queue does not undo the skip");
  await service.sync();
  await service.admit(id);
  assert.equal(q.added.length, 1, "never queued again");
});

test("an episode already queued by hand is adopted and followed to completion", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  const service = buildService(store, q);
  const manual: (typeof q.jobs)[number] = { id: "manual-1", status: "queued", source: { type: "series", videoId: "v1" } };
  q.jobs.push(manual);
  const id = await seedSeries(store, [episode(1, 1, "v1", RELEASED)], rule());
  await service.admit(id);

  let download = store.get(id)!.episodes["1:1"].download!;
  assert.equal(download.state, "queued");
  assert.equal(download.jobId, manual.id);
  assert.equal(manual.follow?.intent, download.intent, "the manual job carries the follow's intent now");
  await service.sync();
  assert.equal(store.get(id)!.episodes["1:1"].download?.state, "queued", "sync finds it instead of calling it lost");
  q.complete(manual.id);
  await service.sync();
  download = store.get(id)!.episodes["1:1"].download!;
  assert.equal(download.state, "completed");
});

test("a removal guard that cannot write refuses the removal", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  const service = buildService(store, q);
  const id = await seedSeries(store, [episode(1, 1, "v1", RELEASED)], rule());
  await service.admit(id);
  const job = q.jobs[0];
  const original = store.update.bind(store);
  store.update = async () => { throw new Error("disk full"); };
  try {
    await assert.rejects(service.jobRemoving(job, "user"));
  } finally { store.update = original; }
  assert.equal(store.get(id)!.episodes["1:1"].download?.state, "queued", "the write failed, so nothing moved");
  await service.jobRemoving(job, "account");
  assert.equal(store.get(id)!.episodes["1:1"].download?.state, "queued", "an account removal changes nothing");
});

test("removing a completed job keeps the episode completed", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  const service = buildService(store, q);
  const id = await seedSeries(store, [episode(1, 1, "v1", RELEASED)], rule());
  await service.admit(id);
  const job = q.jobs[0];
  q.complete(job.id);
  await service.sync();
  await service.jobRemoving(job, "user");
  assert.equal(store.get(id)!.episodes["1:1"].download?.state, "completed");
});

test("clearing finished rows records completion before they go", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  const service = buildService(store, q);
  const id = await seedSeries(store, [episode(1, 1, "v1", RELEASED)], rule());
  await service.admit(id);
  const job = q.jobs[0];
  assert.equal(store.get(id)!.episodes["1:1"].download?.state, "queued");
  await service.jobsClearing([{ id: job.id, status: "completed", follow: job.follow }]);
  assert.equal(store.get(id)!.episodes["1:1"].download?.state, "completed");
});

test("a completed episode whose file is deleted stays completed", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  const service = buildService(store, q);
  const id = await seedSeries(store, [episode(1, 1, "v1", RELEASED)], rule());
  await service.admit(id);
  const job = q.jobs[0];
  await service.jobCompleted({ id: job.id, status: "completed", follow: job.follow });
  assert.equal(store.get(id)!.episodes["1:1"].download?.state, "completed");
  q.jobs.splice(0, 1);
  await service.sync();
  await service.admit(id);
  assert.equal(store.get(id)!.episodes["1:1"].download?.state, "completed", "a deleted file does not re-download");
});

test("a rule that changes while a job is being queued is not admitted", async (t) => {
  const mutations: Array<[string, (follow: Follow) => void]> = [
    ["autoDownload removed", (follow) => { delete follow.autoDownload; }],
    ["paused", (follow) => { follow.enabled = false; }],
    ["revision changed", (follow) => { follow.revision += 1; }],
  ];
  for (const [name, mutate] of mutations) {
    const { store } = await withStore(t);
    const q = fakeQueue();
    const original = store.update.bind(store);
    const service = buildService(store, q, {});
    const id = await seedSeries(store, [episode(1, 1, "v1", RELEASED)], rule());
    let reached!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = true;
    store.update = async (target, mutator) => { if (held) { held = false; reached(); await gate; } return original(target, mutator); };
    const admitting = service.admit(id);
    await entered;
    await original(id, mutate);
    release();
    await admitting;
    store.update = original;
    assert.equal(q.added.length, 0, name);
    assert.equal(store.get(id)!.episodes["1:1"].download?.state, "reserved", name);
  }
});

test("an owner who may not download is blocked and unblocked", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  let allowed = false;
  const service = buildService(store, q, { mayDownload: () => allowed });
  const id = await seedSeries(store, [episode(1, 1, "v1", RELEASED)], rule());
  await service.admit(id);
  assert.equal(store.get(id)!.autoDownload?.blockedKey, "err.downloadLibraryNotAllowed");
  assert.equal(q.added.length, 0, "nothing is queued while blocked");
  allowed = true;
  await service.admit(id);
  assert.equal(store.get(id)!.autoDownload?.blockedKey, undefined, "the block is cleared");
  assert.equal(q.added.length, 1);
});

test("an owner that no longer exists is blocked", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  const service = buildService(store, q, { owner: () => undefined });
  const id = await seedSeries(store, [episode(1, 1, "v1", RELEASED)], rule());
  await service.admit(id);
  assert.equal(store.get(id)!.autoDownload?.blockedKey, "err.downloadLibraryNotAllowed");
  assert.equal(q.added.length, 0);
});

test("a check keeps the download an episode already carries", async (t) => {
  const { store } = await withStore(t);
  const follow = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show" }, 0);
  await store.recordCheck(follow.id, { episodes: [episode(1, 1, "v1", RELEASED)], now: 0 });
  const download = { state: "queued" as const, intent: "keep-me", generation: 1, attempts: 0, updatedAt: RELEASED };
  await store.update(follow.id, (current) => { current.episodes["1:1"].download = download; });
  await store.recordCheck(follow.id, { episodes: [episode(1, 1, "v1", "2024-03-02T00:00:00.000Z")], now: 1_000 });
  assert.deepEqual(store.get(follow.id)!.episodes["1:1"].download, download);
  assert.equal(store.get(follow.id)!.episodes["1:1"].released, "2024-03-02T00:00:00.000Z");
});

test("a successful check drops a date the provider no longer has", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await loaded(dir);
  const follow = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show" }, 0);
  await store.recordCheck(follow.id, { episodes: [{ ...episode(1, 1, "v1", RELEASED), releasedSource: "addon" }], now: 0 });
  assert.equal(store.get(follow.id)!.episodes["1:1"].released, RELEASED);

  await store.recordCheck(follow.id, { episodes: [{ ...episode(1, 1, "v1"), dateUncertain: true }], now: 1_000 });

  const after = store.get(follow.id)!.episodes["1:1"];
  assert.equal(after.released, undefined, "the stale date is gone");
  assert.equal(after.releasedSource, undefined, "the stale source is gone");
  assert.equal(after.dateUncertain, true);
  assert.equal(after.firstSeenAt, "2024-01-01T00:00:00.000Z", "the first sighting is kept");
});

const calendarFollow = (over: Partial<Follow> = {}): Follow => ({
  id: "f1", ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show",
  createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z",
  enabled: true, revision: 1, nextCheckAt: "2024-01-01T00:00:00.000Z", failures: 0,
  episodes: {}, ...over,
});
const download = (over: Partial<EpisodeDownload> = {}): EpisodeDownload =>
  ({ state: "queued", intent: "i", generation: 1, attempts: 0, updatedAt: "2024-03-15T00:00:00.000Z", ...over });

test("calendarItems keeps [from, to) and maps the episode state", () => {
  const from = Date.parse("2024-03-01T00:00:00.000Z");
  const to = Date.parse("2024-04-01T00:00:00.000Z");
  const now = Date.parse("2024-03-18T00:00:00.000Z");
  const follow = calendarFollow({ episodes: {
    "before": { ...episode(1, 1, "v1", "2024-02-29T23:59:59.999Z") },
    "at-from": { ...episode(1, 2, "v2", "2024-03-01T00:00:00.000Z") },
    "past": { ...episode(1, 3, "v3", "2024-03-15T00:00:00.000Z") },
    "future": { ...episode(1, 4, "v4", "2024-03-25T00:00:00.000Z") },
    "at-to": { ...episode(1, 5, "v5", "2024-04-01T00:00:00.000Z") },
    "no-date": { ...episode(1, 6, "v6") },
    "waiting": { ...episode(1, 7, "v7", "2024-03-20T00:00:00.000Z"), download: download({ state: "waiting", attempts: 2, reasonKey: "err.noMatchingSource", nextAttemptAt: "2024-03-21T00:00:00.000Z" }) },
    "ambiguous": { ...episode(1, 8, "v8", "2024-03-10T00:00:00.000Z", true) },
  } });
  const items = calendarItems([follow], from, to, now);
  assert.deepEqual(items.map((item) => item.episode), [2, 8, 3, 7, 4]);
  const byEpisode = new Map(items.map((item) => [item.episode, item]));
  assert.equal(byEpisode.get(2)!.state, "released", "released at `from` is included");
  assert.equal(byEpisode.get(3)!.state, "released", "a past episode with no download is released");
  assert.equal(byEpisode.get(4)!.state, "upcoming", "a future episode with no download is upcoming");
  assert.equal(byEpisode.get(7)!.state, "waiting", "a download state wins over the clock");
  assert.equal(byEpisode.get(7)!.reasonKey, "err.noMatchingSource");
  assert.equal(byEpisode.get(7)!.nextAttemptAt, "2024-03-21T00:00:00.000Z");
  assert.equal(byEpisode.get(8)!.ambiguous, true);
});

test("calendarItems orders equal releases by name, then season and episode", () => {
  const from = Date.parse("2024-03-01T00:00:00.000Z");
  const to = Date.parse("2024-04-01T00:00:00.000Z");
  const released = "2024-03-15T00:00:00.000Z";
  const one = calendarFollow({ id: "a", name: "Beta", episodes: { x: { ...episode(1, 2, "x", released) } } });
  const two = calendarFollow({ id: "b", name: "Alpha", episodes: { y: { ...episode(1, 5, "y", released) } } });
  const three = calendarFollow({ id: "c", name: "Alpha", episodes: { z: { ...episode(2, 1, "z", released) } } });
  assert.deepEqual(calendarItems([one, two, three], from, to, 0).map((item) => item.followId), ["b", "c", "a"]);
});

test("calendarItems stops at five hundred items", () => {
  const base = Date.parse("2024-01-01T00:00:00.000Z");
  const episodes: Record<string, FollowEpisode> = {};
  for (let index = 1; index <= 501; index += 1) episodes[`1:${index}`] = episode(1, index, `v${index}`, new Date(base + index * 60_000).toISOString());
  const items = calendarItems([calendarFollow({ episodes })], base, base + 1_000 * 60_000, base);
  assert.equal(items.length, 500);
  assert.equal(items[0]!.episode, 1);
  assert.equal(items[499]!.episode, 500);
});

test("undatedCalendarItems lists only uncertain episodes with no date", () => {
  const follow = calendarFollow({ episodes: {
    "1:1": { ...episode(1, 1, "v1"), dateUncertain: true },
    "1:2": { ...episode(1, 2, "v2", "2024-03-15T00:00:00.000Z"), dateUncertain: true },
    "1:3": { ...episode(1, 3, "v3") },
  } });

  const items = undatedCalendarItems([follow], 100);

  assert.deepEqual(items.map((item) => item.episode), [1]);
  assert.equal(items[0]!.state, "upcoming");
  assert.equal(items[0]!.dateUncertain, true);
  assert.equal("released" in items[0]!, false);
});

const DAY_MS = 24 * 60 * 60_000;
const FEED_OPTIONS = { name: "Ada – Stremio Offline", language: "en" };

test("calendarFeed writes a CRLF calendar with all-day dates and a next-day DTEND", () => {
  const now = Date.parse("2024-03-18T00:00:00.000Z");
  const follow = calendarFollow({ episodes: { "1:2": { ...episode(1, 2, "v2", "2024-03-20T21:30:00.000Z") } } });
  const feed = calendarFeed([follow], now, FEED_OPTIONS);
  assert.ok(feed.endsWith("END:VCALENDAR\r\n"));
  assert.equal(feed.replace(/\r\n/g, "").includes("\n"), false, "every newline is a CRLF");
  const lines = feed.split("\r\n");
  for (const expected of [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Stremio Offline//Following//EN", "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:Ada – Stremio Offline", "BEGIN:VEVENT", "UID:f1-1-2@stremio-offline", "DTSTAMP:20240318T000000Z",
    "DTSTART;VALUE=DATE:20240320", "DTEND;VALUE=DATE:20240321", "SUMMARY:Show S01E02", "DESCRIPTION:upcoming", "END:VEVENT",
  ]) assert.ok(lines.includes(expected), expected);
});

test("calendarFeed folds a summary with its title and marks an uncertain date", () => {
  const now = Date.parse("2024-03-18T00:00:00.000Z");
  const follow = calendarFollow({ episodes: {
    "1:2": { ...episode(1, 2, "v2", "2024-03-20T00:00:00.000Z"), title: "Pilot" },
    "1:3": { ...episode(1, 3, "v3", "2024-03-21T00:00:00.000Z"), title: "Second", dateUncertain: true },
  } });
  const summaries = calendarFeed([follow], now, FEED_OPTIONS).split("\r\n").filter((line) => line.startsWith("SUMMARY:"));
  assert.deepEqual(summaries, ["SUMMARY:Show S01E02 · Pilot", "SUMMARY:≈ Show S01E03 · Second"]);
});

test("calendarFeed summarises a film by its name alone", () => {
  const now = Date.parse("2024-03-18T00:00:00.000Z");
  const film = calendarFollow({ id: "f9", type: "movie", name: "Dune", episodes: {
    "1:1": { key: "1:1", videoId: "tt9", season: 1, episode: 1, firstSeenAt: "2024-01-01T00:00:00.000Z", released: "2024-03-20T00:00:00.000Z" },
  } });
  const summaries = calendarFeed([film], now, FEED_OPTIONS).split("\r\n").filter((line) => line.startsWith("SUMMARY:"));
  assert.deepEqual(summaries, ["SUMMARY:Dune"]);
});

test("calendarFeed escapes separators and newlines in a text value", () => {
  const now = Date.parse("2024-03-18T00:00:00.000Z");
  const follow = calendarFollow({ episodes: {
    "1:2": { ...episode(1, 2, "v2", "2024-03-20T00:00:00.000Z"), title: "Pilot; part, one\\two\nnext" },
  } });
  const lines = calendarFeed([follow], now, { name: "Ada, Stremio; Offline", language: "en" }).split("\r\n");
  assert.ok(lines.includes("SUMMARY:Show S01E02 · Pilot\\; part\\, one\\\\two\\nnext"));
  assert.ok(lines.includes("X-WR-CALNAME:Ada\\, Stremio\\; Offline"));
});

test("calendarFeed folds long lines at 75 octets without splitting a character", () => {
  const now = Date.parse("2024-03-18T00:00:00.000Z");
  const title = "Příliš žluťoučký kůň 😀 漢字".repeat(8);
  const follow = calendarFollow({ episodes: { "1:2": { ...episode(1, 2, "v2", "2024-03-20T00:00:00.000Z"), title } } });
  const lines = calendarFeed([follow], now, FEED_OPTIONS).split("\r\n");
  const start = lines.findIndex((line) => line.startsWith("SUMMARY:"));
  let end = start;
  let rebuilt = lines[start]!;
  while (lines[end + 1]?.startsWith(" ")) { end += 1; rebuilt += lines[end]!.slice(1); }
  assert.ok(end > start, "the long summary was folded");
  assert.equal(rebuilt, `SUMMARY:Show S01E02 · ${title}`, "unfolding restores the line, so no character was split");
  for (let index = start; index <= end; index += 1) {
    assert.ok(Buffer.byteLength(lines[index]!, "utf8") <= 75, `${lines[index]} carries more than 75 octets`);
  }
});

test("calendarFeed keeps the [now - 30 days, now + 180 days) window and drops undated episodes", () => {
  const now = Date.parse("2024-06-15T00:00:00.000Z");
  const at = (offset: number) => new Date(now + offset).toISOString();
  const follow = calendarFollow({ episodes: {
    "too-old": { ...episode(1, 1, "v1", at(-31 * DAY_MS)) },
    "at-from": { ...episode(1, 2, "v2", at(-30 * DAY_MS)) },
    "at-to": { ...episode(1, 3, "v3", at(180 * DAY_MS)) },
    "before-to": { ...episode(1, 4, "v4", at(180 * DAY_MS - 1)) },
    "undated": { ...episode(1, 5, "v5"), dateUncertain: true },
  } });
  const uids = calendarFeed([follow], now, FEED_OPTIONS).split("\r\n").filter((line) => line.startsWith("UID:"));
  assert.deepEqual(uids, ["UID:f1-1-2@stremio-offline", "UID:f1-1-4@stremio-offline"]);
});

test("calendarFeed names each download state in English words", () => {
  const now = Date.parse("2024-06-15T00:00:00.000Z");
  const states = ["reserved", "waiting", "completed", "attention", "skipped"] as const;
  const episodes: Record<string, FollowEpisode> = {};
  states.forEach((state, index) => {
    episodes[`1:${index + 1}`] = { ...episode(1, index + 1, `v${index + 1}`, new Date(now - DAY_MS + index * 60_000).toISOString()), download: download({ state }) };
  });
  const descriptions = calendarFeed([calendarFollow({ episodes })], now, FEED_OPTIONS).split("\r\n").filter((line) => line.startsWith("DESCRIPTION:"));
  assert.deepEqual(descriptions, [
    "DESCRIPTION:queued", "DESCRIPTION:waiting for a source", "DESCRIPTION:downloaded", "DESCRIPTION:needs attention", "DESCRIPTION:skipped",
  ]);
});

test("activityItems keeps only episodes with a download, newest first and capped", () => {
  const first = calendarFollow({ id: "f1", name: "One", episodes: {
    "1:1": { ...episode(1, 1, "v1", RELEASED), download: download({ state: "completed", updatedAt: "2024-05-03T00:00:00.000Z" }) },
    "1:2": { ...episode(1, 2, "v2", RELEASED), download: download({ state: "queued", updatedAt: "2024-05-01T00:00:00.000Z" }) },
    "1:3": { ...episode(1, 3, "v3", RELEASED) },
  } });
  const second = calendarFollow({ id: "f2", name: "Two", episodes: {
    "1:1": { ...episode(1, 1, "w1", RELEASED), download: download({ state: "waiting", updatedAt: "2024-05-02T00:00:00.000Z" }) },
  } });
  const items = activityItems([first, second], 50);
  assert.deepEqual(items.map((item) => [item.followId, item.episode, item.state]), [
    ["f1", 1, "completed"], ["f2", 1, "waiting"], ["f1", 2, "queued"],
  ]);
  assert.deepEqual(activityItems([first, second], 2).map((item) => item.followId), ["f1", "f2"]);
});

const FILM_NOW = Date.parse("2026-10-04T12:00:00Z");
const film = { id: "tt9", type: "movie", name: "Film" } as MetaItem;

test("a film's date is its digital release, else the disc, never the premiere", () => {
  const digital = movieEpisode(film, "tt9", { theatrical: "2026-07-01", digital: "2026-09-10", physical: "2026-10-20" }, FILM_NOW);
  assert.equal(digital.released, "2026-09-10T23:59:59.999Z");
  assert.equal(digital.releaseKind, "digital");
  assert.equal(digital.key, "1:1");
  assert.equal(digital.videoId, "tt9");
  const disc = movieEpisode(film, "tt9", { theatrical: "2026-07-01", physical: "2026-10-20" }, FILM_NOW);
  assert.equal(disc.releaseKind, "physical");
  const cinema = movieEpisode(film, "tt9", { theatrical: "2026-09-25" }, FILM_NOW);
  assert.equal(cinema.released, undefined, "a film only in cinemas has no download date yet");
  assert.equal(cinema.dateUncertain, true);
  assert.equal(cinema.theatricalAt, "2026-09-25T23:59:59.999Z");
});

test("without TMDB a film keeps the catalogue date, doubted while it is recent", () => {
  const recent = movieEpisode({ ...film, released: "2026-09-01T00:00:00.000Z" } as MetaItem, "tt9", null, FILM_NOW);
  assert.equal(recent.releaseKind, "catalog");
  assert.equal(recent.dateUncertain, true);
  const old = movieEpisode({ ...film, released: "2020-01-01T00:00:00.000Z" } as MetaItem, "tt9", null, FILM_NOW);
  assert.equal(old.dateUncertain, undefined);
  const none = movieEpisode(film, "tt9", null, FILM_NOW);
  assert.equal(none.released, undefined);
  assert.equal(none.dateUncertain, true);
});

test("a followed film is downloaded once when it comes out, whatever the start rule", async (t) => {
  const { store } = await withStore(t);
  const q = fakeQueue();
  let now = FILM_NOW;
  const service = buildService(store, q, { now: () => now });
  const follow = await store.create({ ownerUserId: "u1", type: "movie", metaId: "tt9", name: "Film" }, 0);
  const upcoming = { ...movieEpisode(film, "tt9", { digital: "2026-10-10" }, now), firstSeenAt: new Date(0).toISOString() };
  await store.recordCheck(follow.id, { episodes: [upcoming], now: 0 });
  // Switched on long after following, with the series default of "new episodes only".
  await store.update(follow.id, (current) => { current.autoDownload = rule({ enabledAt: new Date(now).toISOString() }); });
  assert.equal(downloadEligibility(store.get(follow.id)!, store.get(follow.id)!.episodes["1:1"], now), "upcoming");
  await service.admit(follow.id);
  assert.equal(q.added.length, 0, "not before its digital release");

  now = Date.parse("2026-10-11T12:00:00Z");
  await service.admit(follow.id);
  assert.equal(q.added.length, 1);
  assert.deepEqual(q.added[0].source.type, "movie");
  assert.equal(q.added[0].source.videoId, "tt9");
  assert.equal(q.added[0].title, "Film");
  await service.admit(follow.id);
  assert.equal(q.added.length, 1, "exactly one download");
});
