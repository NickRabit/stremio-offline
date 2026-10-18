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

test("an id-less title joins its one exact name and year match", () => {
  const groups = clusterIdentities([
    record("idless", 1, {}, { opaque: "sosac:matrix", title: "Matrix", year: 1999 }),
    record("imdb", 2, { imdb: "tt0133093" }, { title: "The Matrix", year: 1999 }),
  ]);
  assert.deepEqual(groups, [{ memberKeys: ["idless", "imdb"], conflict: false }]);
});

test("an id-less title can match a candidate by original title", () => {
  assert.deepEqual(groupsOf([
    record("idless", 1, {}, { title: "Matrix", originalTitle: "The Matrix", year: 1999 }),
    record("candidate", 2, { imdb: "tt0133093" }, { title: "Matrix", year: 1999 }),
  ]), [["idless", "candidate"]]);
});

test("an id-less title stays alone when its name and year have two candidates", () => {
  assert.deepEqual(groupsOf([
    record("idless", 1, {}, { title: "Matrix", year: 1999 }),
    record("first", 2, { imdb: "tt1" }, { title: "Matrix", year: 1999 }),
    record("second", 3, { imdb: "tt2" }, { title: "Matrix", year: 1999 }),
  ]), [["idless"], ["first"], ["second"]]);
});

test("an id-less title needs the same year and kind", () => {
  assert.deepEqual(groupsOf([
    record("idless", 1, {}, { title: "Matrix", year: 1999 }),
    record("candidate", 2, { imdb: "tt1" }, { title: "Matrix", year: 1998 }),
  ]), [["idless"], ["candidate"]]);
  assert.deepEqual(groupsOf([
    record("idless", 1, {}, { title: "Matrix" }),
    record("candidate", 2, { imdb: "tt1" }, { title: "Matrix", year: 1999 }),
  ]), [["idless"], ["candidate"]]);
  assert.deepEqual(groupsOf([
    record("idless", 1, {}, { title: "Matrix", year: 1999 }),
    record("candidate", 2, { imdb: "tt1" }, { title: "Matrix" }),
  ]), [["idless"], ["candidate"]]);
  assert.deepEqual(groupsOf([
    record("idless", 1, {}, { title: "Matrix", year: 1999 }),
    record("candidate", 2, { imdb: "tt1" }, { title: "Matrix", year: 1999, kind: "series" }),
  ]), [["idless"], ["candidate"]]);
});

test("id-less groups never join each other", () => {
  assert.deepEqual(groupsOf([
    record("one", 1, {}, { title: "Matrix", year: 1999 }),
    record("two", 2, {}, { title: "Matrix", year: 1999 }),
  ]), [["one"], ["two"]]);
});

test("a conflicting candidate group is not used", () => {
  assert.deepEqual(groupsOf([
    record("idless", 1, {}, { title: "Matrix", year: 1999 }),
    record("first", 2, { imdb: "tt1", tmdb: "10" }, { title: "Matrix", year: 1999 }),
    record("second", 3, { imdb: "tt1", tmdb: "10" }, { title: "Matrix", year: 1999 }),
    record("third", 4, { imdb: "tt1", tmdb: "20" }, { title: "Matrix", year: 1999 }),
  ]), [["idless"], ["first", "second"], ["third"]]);
});

test("an id-less group linked by one opaque id joins as a whole", () => {
  assert.deepEqual(groupsOf([
    record("first", 1, {}, { opaque: "sosac:matrix:1999", title: "Matrix", year: 1999 }),
    record("second", 2, {}, { opaque: "sosac:matrix:1999", title: "Matrix", year: 1999 }),
    record("candidate", 3, { imdb: "tt0133093" }, { title: "The Matrix", year: 1999 }),
  ]), [["first", "second", "candidate"]]);
});

test("unique IMDb and TMDB names join before an id-less copy", () => {
  assert.deepEqual(groupsOf([
    record("imdb", 1, { imdb: "tt7131622" }, { title: "Tenkrát v Hollywoodu", year: 2019 }),
    record("tmdb", 2, { tmdb: "466272" }, { title: "Tenkrát v Hollywoodu", year: 2019 }),
    record("idless", 3, {}, {
      opaque: "sosac:tenkrat-v-hollywoodu",
      title: "Tenkrát v Hollywoodu",
      year: 2019,
    }),
  ]), [["imdb", "tmdb", "idless"]]);
});

test("cross-namespace name matching keeps a film and a series apart", () => {
  assert.deepEqual(groupsOf([
    record("imdb", 1, { imdb: "tt1" }, { title: "Batman", year: 1966 }),
    record("tmdb", 2, { tmdb: "10" }, { title: "Batman", year: 1966, kind: "series" }),
  ]), [["imdb"], ["tmdb"]]);
});

test("two groups in one namespace prevent a cross-namespace merge", () => {
  assert.deepEqual(groupsOf([
    record("imdb-one", 1, { imdb: "tt1" }, { title: "Matrix", year: 1999 }),
    record("imdb-two", 2, { imdb: "tt2" }, { title: "Matrix", year: 1999 }),
    record("tmdb", 3, { tmdb: "10" }, { title: "Matrix", year: 1999 }),
  ]), [["imdb-one"], ["imdb-two"], ["tmdb"]]);
});

test("a cross-namespace group never takes two counterparts", () => {
  assert.deepEqual(groupsOf([
    record("tmdb", 1, { tmdb: "10" }, {
      title: "Matrix",
      originalTitle: "The Matrix",
      year: 1999,
    }),
    record("imdb-title", 2, { imdb: "tt1" }, { title: "Matrix", year: 1999 }),
    record("imdb-original", 3, { imdb: "tt2" }, { title: "The Matrix", year: 1999 }),
  ]), [["tmdb"], ["imdb-title"], ["imdb-original"]]);
});

test("a group carrying both namespaces is not a cross-namespace candidate", () => {
  assert.deepEqual(groupsOf([
    record("both", 1, { imdb: "tt1", tmdb: "10" }, { title: "Matrix", year: 1999 }),
    record("imdb", 2, { imdb: "tt2" }, { title: "Matrix", year: 1999 }),
  ]), [["both"], ["imdb"]]);
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

test("primary member follows relevance, identity, metadata, class, source and item order", () => {
  const base: DisplayCandidate = {
    memberKey: "a",
    sequence: 1,
    sourceOrder: 1,
    sourceClass: "catalog",
    itemKey: "a",
    title: "The Matrix",
    hasStrongId: false,
    score: 0,
  };
  assert.equal(pickPrimary("The Matrix", [
    { ...base, score: 100 },
    { ...base, memberKey: "b", title: "Other", hasStrongId: true },
  ]).memberKey, "a");
  assert.equal(pickPrimary("Other", [
    base,
    { ...base, memberKey: "b", title: "Other", hasStrongId: true, score: 100 },
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

test("files join only the same file from the same addon, never through a title id", () => {
  const groups = clusterIdentities([
    record("a", 1, {}, { kind: "file", opaque: "addon:x:file:1" }),
    record("b", 2, {}, { kind: "file", opaque: "addon:x:file:1" }),
    record("c", 3, { imdb: "tt1" }, { kind: "file", opaque: "addon:x:file:2" }),
    record("d", 4, { imdb: "tt1" }, { kind: "file", opaque: "addon:x:file:3" }),
  ]).map((group) => group.memberKeys);
  assert.deepEqual(groups, [["a", "b"], ["c"], ["d"]]);
});
