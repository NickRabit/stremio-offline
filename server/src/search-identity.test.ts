import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ClusterKeyTracker,
  clusterIdentities,
  episodeIdentity,
  pickPrimary,
  strongIdsFromStremioId,
  titleRank,
  validStrongIds,
  type DisplayCandidate,
  type IdentityInput,
} from "./search-identity.js";

const record = (
  memberKey: string,
  sequence: number,
  ids: IdentityInput["ids"],
  extra: Partial<IdentityInput> = {},
): IdentityInput => ({
  memberKey,
  sequence,
  kind: "movie",
  ids,
  ...extra,
});

const groupsOf = (records: IdentityInput[]): string[][] =>
  clusterIdentities(records).map((group) => group.memberKeys);

test("Stremio ids are accepted only in their exact strong-id forms", () => {
  assert.deepEqual(strongIdsFromStremioId("tt123"), { imdb: "tt123" });
  assert.deepEqual(strongIdsFromStremioId("tmdb:10"), { tmdb: "10" });
  assert.deepEqual(strongIdsFromStremioId("tvdb:20"), { tvdb: "20" });
  for (const value of [
    "mpa:x:tt123",
    "mpa:webshare-index:tt2709692",
    "TT123",
    "tmdb:0",
    "tvdb:020",
    "imdb:tt123",
    "tt" + "1".repeat(13),
    "tt123\n",
  ]) {
    assert.deepEqual(strongIdsFromStremioId(value), {});
  }
  assert.deepEqual(validStrongIds({ imdb: "TT123", tmdb: "10", tvdb: "no" }), { imdb: "tt123", tmdb: "10" });
});

test("title rank is the better of the two display titles", () => {
  assert.equal(titleRank("matrix", "The Matrix"), 0);
  assert.equal(titleRank("trix", "Local file", "The Matrix"), 2);
  assert.equal(titleRank("the matrix", "The Matrix", undefined), 0);
  assert.equal(titleRank("zzz", "The Matrix"), 3);
});

test("a strong-id bridge joins both namespaces", () => {
  const groups = groupsOf([
    record("a", 1, { imdb: "tt1" }),
    record("b", 2, { tmdb: "10" }),
    record("c", 3, { imdb: "tt1", tmdb: "10" }),
  ]);
  assert.deepEqual(groups, [["a", "b", "c"]]);
  assert.deepEqual(groupsOf([
    record("c", 1, { imdb: "tt1", tmdb: "10" }),
    record("b", 2, { tmdb: "10" }),
    record("a", 3, { imdb: "tt1" }),
  ]), [["c", "b", "a"]]);
});

test("contradictory ids keep only legal pairs", () => {
  const base = [
    record("A", 1, { imdb: "tt1", tmdb: "10" }),
    record("B", 2, { imdb: "tt2", tmdb: "20" }),
    record("C", 3, { imdb: "tt1", tmdb: "20" }),
    record("D", 4, { imdb: "tt2", tmdb: "20" }),
  ];
  assert.deepEqual(groupsOf(base), [["A"], ["B", "D"], ["C"]]);
  assert.deepEqual(groupsOf([...base].reverse()), [["A"], ["B", "D"], ["C"]]);
  const renamed = [
    record("d", 1, { imdb: "tt1", tmdb: "10" }),
    record("c", 2, { imdb: "tt2", tmdb: "20" }),
    record("b", 3, { imdb: "tt1", tmdb: "20" }),
    record("a", 4, { imdb: "tt2", tmdb: "20" }),
  ];
  assert.deepEqual(groupsOf(renamed), [["d"], ["c", "a"], ["b"]]);
});

test("a hub joins the deterministically smaller side and never joins a contradiction", () => {
  const run = (keys: readonly [string, string, string], reverse: boolean) => {
    const inputs = [
      record(keys[0], 1, { imdb: "tt1" }),
      record(keys[1], 2, { imdb: "tt1", tmdb: "10" }),
      record(keys[2], 3, { imdb: "tt1", tmdb: "20" }),
    ];
    if (reverse) inputs.reverse();
    return groupsOf(inputs);
  };
  for (const keys of [["x", "y", "z"], ["z", "y", "x"]] as const) {
    const firstSide = [keys[0], keys[1]].sort().join("\n");
    const secondSide = [keys[0], keys[2]].sort().join("\n");
    const winner = firstSide < secondSide ? "y" : "z";
    const loser = winner === "y" ? "z" : "y";
    const expected = winner === "y"
      ? [[keys[0], keys[1]], [keys[2]]]
      : [[keys[0], keys[2]], [keys[1]]];
    assert.deepEqual(run(keys, false), expected);
    assert.deepEqual(run(keys, true), expected);
    assert.equal(groupsOf([
      record("X", 1, { imdb: "tt1" }),
      record("Y", 2, { imdb: "tt1", tmdb: "10" }),
      record("Z", 3, { imdb: "tt1", tmdb: "20" }),
    ]).some((group) => group.includes("Y") && group.includes("Z")), false);
    assert.ok(loser !== winner);
  }
});

test("a contradicted component splits the same way whatever order the records arrived in", () => {
  const ids = { x: { imdb: "tt1" }, y: { imdb: "tt1", tmdb: "10" }, z: { imdb: "tt1", tmdb: "20" } } as const;
  const arrive = (order: ReadonlyArray<"x" | "y" | "z">) =>
    groupsOf(order.map((key, index) => record(key, index + 1, ids[key])))
      .map((group) => [...group].sort()).sort((a, b) => a[0]!.localeCompare(b[0]!));
  const expected = arrive(["x", "y", "z"]);
  assert.deepEqual(expected, [["x", "y"], ["z"]]);
  for (const order of [["z", "y", "x"], ["y", "z", "x"], ["z", "x", "y"]] as const) assert.deepEqual(arrive(order), expected);
});

test("contradicted components with more than 200 records remain alone", () => {
  const records = [record("hub", 1, { imdb: "tt1" })];
  for (let index = 0; index < 200; index += 1) {
    records.push(record(`leaf-${index}`, index + 2, { imdb: "tt1", tmdb: String(index + 1) }));
  }
  const groups = clusterIdentities(records);
  assert.equal(groups.length, 201);
  assert.ok(groups.every((group) => group.memberKeys.length === 1 && group.conflict));
});

test("opaque identity merges only inside the same scope and kind", () => {
  assert.deepEqual(groupsOf([
    record("a", 1, {}, { opaque: "addon:a:movie:1" }),
    record("b", 2, {}, { opaque: "addon:a:movie:1" }),
  ]), [["a", "b"]]);
  assert.deepEqual(groupsOf([
    record("a", 1, {}, { opaque: "addon:a:movie:1" }),
    record("b", 2, {}, { opaque: "addon:b:movie:1" }),
    record("c", 3, {}, { opaque: "addon:a:movie:1", kind: "series" }),
  ]), [["a"], ["b"], ["c"]]);
  assert.deepEqual(groupsOf([record("a", 1, {}), record("b", 2, {})]), [["a"], ["b"]]);
  assert.deepEqual(groupsOf([
    record("movie", 1, { tmdb: "10" }),
    record("series", 2, { tmdb: "10" }, { kind: "series" }),
  ]), [["movie"], ["series"]]);
});

test("episodes use synthetic parent identity", () => {
  assert.deepEqual(episodeIdentity({ imdb: "tt1", tmdb: "10" }, 1, 2), {
    imdb: "tt1#1#2#",
    tmdb: "10#1#2#",
  });
  assert.deepEqual(episodeIdentity({ imdb: "tt1" }, 1, 2, 4), { imdb: "tt1#1#2#4" });
  const first = record("local", 1, episodeIdentity({ imdb: "tt1" }, 1, 2), { kind: "episode" });
  const remote = record("remote", 2, episodeIdentity({ imdb: "tt1" }, 1, 2), { kind: "episode" });
  assert.deepEqual(groupsOf([first, remote]), [["local", "remote"]]);
  const range = record("range", 3, episodeIdentity({ imdb: "tt1" }, 1, 2, 3), { kind: "episode" });
  assert.deepEqual(groupsOf([first, range]), [["local"], ["range"]]);
});

test("primary member follows rank, identity, metadata, class, source and item order", () => {
  const base: DisplayCandidate = {
    memberKey: "a",
    sequence: 1,
    sourceOrder: 1,
    sourceClass: "catalog",
    itemKey: "a",
    title: "The Matrix",
    hasStrongId: false,
  };
  assert.equal(pickPrimary("The Matrix", [
    base,
    { ...base, memberKey: "b", title: "Other", hasStrongId: true },
  ]).memberKey, "a");
  assert.equal(pickPrimary("Other", [
    base,
    { ...base, memberKey: "b", title: "Other", hasStrongId: true },
  ]).memberKey, "b");
  assert.equal(pickPrimary("same", [
    { ...base, memberKey: "catalog", title: "same", hasStrongId: true, sourceClass: "catalog" },
    { ...base, memberKey: "local", title: "same", hasStrongId: true, sourceClass: "local" },
  ]).memberKey, "local");
  assert.equal(pickPrimary("same", [
    { ...base, memberKey: "z", title: "same", itemKey: "z", hasStrongId: true },
    { ...base, memberKey: "a", title: "same", itemKey: "a", hasStrongId: true },
  ]).memberKey, "a");
});

test("cluster keys survive merges, split into a new key, and retire aliases on reuse", () => {
  const tracker = new ClusterKeyTracker();
  const sequences = new Map([["a", 1], ["b", 2], ["c", 5]]);
  const seqOf = (key: string) => sequences.get(key)!;
  assert.deepEqual(tracker.assign([["a"], ["b"], ["c"]], seqOf).keys, ["c1", "c2", "c5"]);
  const merged = tracker.assign([["a", "b", "c"]], seqOf);
  assert.deepEqual(merged.keys, ["c1"]);
  assert.deepEqual(merged.aliases.sort((left, right) => left.retired.localeCompare(right.retired)), [
    { retired: "c2", current: "c1" },
    { retired: "c5", current: "c1" },
  ]);
  const split = tracker.assign([["a", "b"], ["c"]], seqOf);
  assert.deepEqual(split.keys, ["c1", "c5"]);
  assert.deepEqual(split.aliases, [{ retired: "c2", current: "c1" }]);
});
