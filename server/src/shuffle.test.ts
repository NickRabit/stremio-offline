import assert from "node:assert/strict";
import { test } from "node:test";
import type { LibraryMetaRecord } from "./library-match.js";
import { SHUFFLE_ACCOUNT_LIMIT, SHUFFLE_POOL_LIMIT, SHUFFLE_SKIP_LIMIT, SHUFFLE_TTL_MS, ShuffleSessions, shuffleUnits, type ShuffleUnit } from "./shuffle.js";

const owner = { userId: "usr_00000001", sid: "sid_one" };
const chooseAvailable = (available: Set<string>) => async (unit: ShuffleUnit) =>
  unit.files.find((file) => available.has(file));
const collect = async (sessions: ShuffleSessions, id: string, available: Set<string>) => {
  const titles: string[] = [];
  for (;;) {
    const answer = await sessions.next(owner, id, chooseAvailable(available));
    assert.ok(answer);
    if (!answer.item) return titles;
    titles.push(answer.item.title);
  }
};

test("a shuffle plays every unit exactly once", async () => {
  const sessions = new ShuffleSessions({ randomInt: () => 0 });
  const units: ShuffleUnit[] = ["One", "Two", "Three"].map((title) => ({ title, files: [`Films/${title}.mkv`] }));
  const available = new Set(units.flatMap((unit) => unit.files));
  const started = await sessions.start(owner, units, chooseAvailable(available));
  assert.ok(started);
  assert.deepEqual([started.item.title, ...await collect(sessions, started.id, available)].sort(), ["One", "Three", "Two"]);
});

test("versions of one bound title are one unit and known extras are left out", () => {
  const files = [
    "Films/Heat 10.mkv",
    "Films/Heat 2.mkv",
    "Shows/Dark/Dark.S01E01.1080p.mkv",
    "Shows/Dark/Dark.S01E01.720p.mkv",
    "Shows/Dark/Dark.S01E02.mkv",
    "Films/Heat-trailer.mkv",
  ];
  const records: Record<string, LibraryMetaRecord> = {
    "lib_ab12cd34/Films/Heat 10.mkv": { type: "movie", id: "tt1", name: "Heat" },
    "lib_ab12cd34/Films/Heat 2.mkv": { type: "movie", id: "tt1", name: "Heat" },
    "lib_ab12cd34/Shows/Dark/Dark.S01E01.1080p.mkv": { type: "series", id: "tt2", name: "Dark" },
    "lib_ab12cd34/Shows/Dark/Dark.S01E01.720p.mkv": { type: "series", id: "tt2", name: "Dark" },
    "lib_ab12cd34/Shows/Dark/Dark.S01E02.mkv": { type: "series", id: "tt2", name: "Dark" },
    "lib_ab12cd34/Films/Heat-trailer.mkv": { type: "movie", id: "tt1", name: "Heat" },
  };

  const units = shuffleUnits("lib_ab12cd34", files, records);

  assert.equal(units.length, 3, "the two Heat versions and two copies of E01 each count once");
  assert.deepEqual(units[0]?.files, [
    "lib_ab12cd34/Films/Heat 2.mkv",
    "lib_ab12cd34/Films/Heat 10.mkv",
  ]);
  assert.deepEqual(units.slice(1).map(({ title, season, episode }) => ({ title, season, episode })), [
    { title: "Dark", season: 1, episode: 1 },
    { title: "Dark", season: 1, episode: 2 },
  ]);
});

test("previous and next walk the played titles", async () => {
  const sessions = new ShuffleSessions({ randomInt: () => 0 });
  const units: ShuffleUnit[] = ["One", "Two", "Three"].map((title) => ({ title, files: [`${title}.mkv`] }));
  const available = new Set(units.flatMap((unit) => unit.files));
  const started = await sessions.start(owner, units, chooseAvailable(available));
  assert.ok(started);
  const second = await sessions.next(owner, started.id, chooseAvailable(available));
  assert.ok(second?.item);
  const previous = await sessions.previous(owner, started.id, chooseAvailable(available));
  assert.ok(previous?.item);
  assert.equal(previous.item.title, started.item.title);
  const next = await sessions.next(owner, started.id, chooseAvailable(available));
  assert.ok(next?.item);
  assert.equal(next.item.title, second.item.title);
});

test("previous never rewinds the highest cursor used by next", async () => {
  const sessions = new ShuffleSessions({ randomInt: (max) => max - 1 });
  const units: ShuffleUnit[] = ["f1", "f2", "f3", "f4", "f5", "f6"].map((title) => ({
    title,
    files: [`${title}.mkv`],
  }));
  const available = new Set(units.flatMap((unit) => unit.files));
  const started = await sessions.start(owner, units, chooseAvailable(available));
  assert.ok(started);
  const titles = [started.item.title];
  for (const action of ["next", "next", "previous", "next", "next", "next", "next"] as const) {
    const answer = action === "next"
      ? await sessions.next(owner, started.id, chooseAvailable(available))
      : await sessions.previous(owner, started.id, chooseAvailable(available));
    assert.ok(answer?.item);
    titles.push(answer.item.title);
  }
  assert.deepEqual(titles, ["f1", "f2", "f3", "f2", "f3", "f4", "f5", "f6"]);
});

test("concurrent next calls advance one session serially", async () => {
  const sessions = new ShuffleSessions({ randomInt: (max) => max - 1 });
  const units: ShuffleUnit[] = ["f1", "f2", "f3", "f4"].map((title) => ({ title, files: [`${title}.mkv`] }));
  const choose = async (unit: ShuffleUnit) => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    return unit.files[0];
  };
  const started = await sessions.start(owner, units, choose);
  assert.ok(started);
  const [first, second] = await Promise.all([
    sessions.next(owner, started.id, choose),
    sessions.next(owner, started.id, choose),
  ]);
  assert.ok(first?.item);
  assert.ok(second?.item);
  assert.notEqual(first.item.title, second.item.title);
  const rest = await collect(sessions, started.id, new Set(units.flatMap((unit) => unit.files)));
  const played = [started.item.title, first.item.title, second.item.title, ...rest];
  assert.equal(new Set(played).size, units.length);
});

test("a call skips at most the missing-file budget and does not recheck dropped units", async () => {
  const sessions = new ShuffleSessions({ randomInt: (max) => max - 1 });
  const units: ShuffleUnit[] = Array.from({ length: 201 }, (_, index) => ({
    title: `f${index}`,
    files: [`f${index}.mkv`],
  }));
  const available = new Set(["f0.mkv", "f200.mkv"]);
  const checked: string[] = [];
  const choose = async (unit: ShuffleUnit) => {
    checked.push(unit.title);
    return available.has(unit.files[0]!) ? unit.files[0] : undefined;
  };
  const started = await sessions.start(owner, units, choose);
  assert.ok(started);
  assert.equal(started.item.title, "f0");
  assert.equal(checked.length, SHUFFLE_SKIP_LIMIT + 1);

  const before = checked.length;
  assert.deepEqual(await sessions.next(owner, started.id, choose), { item: null, exhausted: true });
  assert.equal(checked.length - before, SHUFFLE_SKIP_LIMIT);
  assert.equal(new Set(checked).size, checked.length);
});

test("a pool larger than the cap keeps a randomised prefix", async () => {
  const sessions = new ShuffleSessions({ randomInt: (max) => max - 1 });
  const units: ShuffleUnit[] = Array.from({ length: SHUFFLE_POOL_LIMIT + 1 }, (_, index) => ({
    title: `Title ${index}`,
    files: [`Films/${index}.mkv`],
  }));
  const available = new Set(units.flatMap((unit) => unit.files));
  const started = await sessions.start(owner, units, chooseAvailable(available));
  assert.ok(started);
  assert.equal(started.total, SHUFFLE_POOL_LIMIT);
  assert.equal(started.capped, true);
});

test("expiry starts again from the last use", async () => {
  let now = 1_000;
  const sessions = new ShuffleSessions({ now: () => now, randomInt: () => 0 });
  const units: ShuffleUnit[] = [{ title: "One", files: ["One.mkv"] }];
  const available = new Set(["One.mkv"]);
  const started = await sessions.start(owner, units, chooseAvailable(available));
  assert.ok(started);
  now += SHUFFLE_TTL_MS - 1;
  assert.ok(await sessions.next(owner, started.id, chooseAvailable(available)));
  now += SHUFFLE_TTL_MS - 1;
  assert.ok(await sessions.previous(owner, started.id, chooseAvailable(available)));
  now += SHUFFLE_TTL_MS;
  assert.equal(await sessions.next(owner, started.id, chooseAvailable(available)), undefined);
});

test("an account keeps at most three sessions", async () => {
  const sessions = new ShuffleSessions({ randomInt: () => 0 });
  const units: ShuffleUnit[] = [{ title: "One", files: ["One.mkv"] }];
  const available = new Set(["One.mkv"]);
  const started = [];
  for (let index = 0; index < SHUFFLE_ACCOUNT_LIMIT + 1; index += 1) {
    started.push(await sessions.start(owner, units, chooseAvailable(available)));
  }
  assert.ok(started.every(Boolean));
  assert.equal(sessions.size, SHUFFLE_ACCOUNT_LIMIT);
  assert.equal(sessions.delete(owner, started[0]!.id), false);
});
