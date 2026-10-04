import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AppError } from "./errors.js";
import { FollowService, FollowStore, followStaggerMs, normalizeFollowEpisodes, type FollowEpisode } from "./follows.js";
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
  await new FollowService({ store, now: () => 0, owner: () => undefined, meta: metaStub }).check(follow.id, "schedule");
  await new FollowService({ store, now: () => 0, owner: () => ({ id: "u1", role: "user", disabled: true }), meta: metaStub }).check(follow.id, "schedule");
  assert.equal(calls, 0);
  assert.equal(store.get(follow.id)!.lastCheckedAt, undefined);
});

test("a null answer is recorded as a failure", async (t) => {
  const dir = temp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await loaded(dir);
  const follow = await store.create({ ownerUserId: "u1", type: "series", metaId: "tt1", name: "Show" }, 0);
  await new FollowService({ store, now: () => 100, owner: () => ({ id: "u1", role: "user" }), meta: async () => null }).check(follow.id, "schedule");
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
  const service = new FollowService({ store, now: () => 1_000, owner: () => ({ id: "u1", role: "user" }), meta: () => pending });
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
  const service = new FollowService({ store, now: () => now, owner: () => ({ id: "u1", role: "user" }), meta: async () => meta([]) });
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
    meta: async () => null,
  });
  const items = service.newEpisodes("u1", (metaId) => metaId === "tt1" ? { season: 1, episode: 1 } : undefined);
  assert.deepEqual(items.map((item) => `${item.metaId}:${item.season}:${item.episode}`), ["tt2:1:1", "tt1:1:3", "tt1:1:2", "tt1:1:6"]);
  assert.deepEqual(items.map((item) => item.followId), [paused.id, follow.id, follow.id, follow.id]);
  assert.equal(items[1].name, "Show");
  assert.equal(items[1].type, "series");
  assert.equal(items[1].videoId, "tt1:1:3");
});
