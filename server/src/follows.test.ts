import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DownloadSelection } from "./downloads.js";
import type { AppError } from "./errors.js";
import { downloadEligibility, FollowService, FollowStore, followStaggerMs, normalizeFollowEpisodes, type Follow, type FollowAutoDownload, type FollowDeps, type FollowEpisode, type FollowJob, type FollowQueue } from "./follows.js";
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

test("an edit while the metadata is in flight discards the result", async (t) => {
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
  assert.deepEqual(store.get(follow.id)!.episodes, {});
  assert.equal(store.get(follow.id)!.lastCheckedAt, undefined);
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

  const from = rule({ startMode: "from", startSeason: 2, startEpisode: 3 });
  assert.equal(downloadEligibility(follow(from), ep({ season: 2, episode: 3, released: RELEASED }), NOW), "eligible");
  assert.equal(downloadEligibility(follow(from), ep({ season: 2, episode: 2, released: RELEASED }), NOW), "outside", "before the start episode");
  assert.equal(downloadEligibility(follow(from), ep({ season: 1, episode: 9, released: RELEASED }), NOW), "outside", "season is compared first");
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
