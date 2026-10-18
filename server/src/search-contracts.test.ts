import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SEARCH_LIMITS,
  SearchError,
  isOpaqueId,
  parseRevision,
  parseStartRequest,
  projectRecord,
  type RawSearchRecord,
} from "./search-contracts.js";

const valid = () => ({
  query: "  matrix  ",
  kind: "all",
  sources: ["catalog", "local"],
  slotId: "slot_12345",
  generation: 2,
});

const record = (changes: Partial<RawSearchRecord> = {}): RawSearchRecord => ({
  itemKey: "movie:1",
  kind: "movie",
  title: "Example",
  locator: { kind: "catalog", addonKey: "addon", type: "movie", id: "tt1" },
  ...changes,
});

test("start requests are strict and the query is trimmed", () => {
  assert.deepEqual(parseStartRequest(valid()), {
    query: "matrix",
    kind: "all",
    sources: ["catalog", "local"],
    slotId: "slot_12345",
    generation: 2,
  });
  const invalid: unknown[] = [
    null,
    [],
    { ...valid(), extra: true },
    { ...valid(), query: undefined },
    { ...valid(), query: "   " },
    { ...valid(), kind: "episode" },
    { ...valid(), sources: [] },
    { ...valid(), sources: ["catalog", "catalog"] },
    { ...valid(), sources: ["catalog", "other"] },
    { ...valid(), sources: Array(1) },
    { ...valid(), sources: ["catalog", "local", "remote", "catalog"] },
    { ...valid(), slotId: "short" },
    { ...valid(), slotId: "bad slot id" },
    { ...valid(), slotId: "slot_123\n" },
    { ...valid(), generation: -1 },
    { ...valid(), generation: 1.5 },
    { ...valid(), generation: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const body of invalid) {
    assert.throws(
      () => parseStartRequest(body),
      (error: unknown) => error instanceof SearchError && error.code === "search-invalid-request" && error.status === 400,
    );
  }
});

test("queries accept 200 code points and reject 201 or more than 256 UTF-16 units", () => {
  assert.equal(parseStartRequest({ ...valid(), query: "a".repeat(200) }).query.length, 200);
  assert.throws(() => parseStartRequest({ ...valid(), query: "a".repeat(201) }), SearchError);
  assert.throws(() => parseStartRequest({ ...valid(), query: "😀".repeat(129) }), SearchError);
  assert.equal(Array.from(parseStartRequest({ ...valid(), query: "😀".repeat(128) }).query).length, 128);
});

test("revision and opaque id parsing reject loose shapes", () => {
  assert.equal(parseRevision({ revision: 0 }), 0);
  assert.throws(() => parseRevision({ revision: 1, other: 2 }), SearchError);
  assert.throws(() => parseRevision({ revision: -1 }), SearchError);
  assert.equal(isOpaqueId("abc_123-XYZ"), true);
  assert.equal(isOpaqueId(""), false);
  assert.equal(isOpaqueId("a".repeat(65)), false);
  assert.equal(isOpaqueId("not/opaque"), false);
  assert.equal(isOpaqueId("opaque\n"), false);
});

test("records are projected with bounded display fields and no unknown properties", () => {
  const projected = projectRecord({
    ...record({
      title: `  ${"😀".repeat(301)}  `,
      originalTitle: `  ${"x".repeat(305)}  `,
      description: `  ${"d".repeat(1005)}  `,
      year: 1999,
      season: 1,
      episode: 2,
      episodeEnd: 3,
      ids: { imdb: "tt1" },
    }),
    unknown: "not copied",
  } as RawSearchRecord);
  assert.ok(projected);
  assert.equal(Array.from(projected.title).length, SEARCH_LIMITS.titleMaxCodePoints);
  assert.equal(Array.from(projected.originalTitle!).length, SEARCH_LIMITS.titleMaxCodePoints);
  assert.equal(Array.from(projected.description!).length, SEARCH_LIMITS.descriptionMaxCodePoints);
  assert.equal(projected.year, 1999);
  assert.equal(projected.season, 1);
  assert.equal(projected.episode, 2);
  assert.equal(projected.episodeEnd, 3);
  assert.deepEqual(projected.ids, { imdb: "tt1" });
  assert.equal(Object.hasOwn(projected, "unknown"), false);
});

test("record projection drops empty titles, invalid years and oversized identities", () => {
  assert.equal(projectRecord(record({ title: "   " })), undefined);
  assert.equal(projectRecord(record({ year: 1799 }))?.year, undefined);
  assert.equal(projectRecord(record({ year: 2201 }))?.year, undefined);
  assert.equal(projectRecord(record({ episodeEnd: 2, episode: 2 }))?.episodeEnd, undefined);
  assert.equal(projectRecord(record({ itemKey: "x".repeat(2049) })), undefined);
  assert.equal(
    projectRecord(record({
      locator: { kind: "catalog", addonKey: "addon", type: "movie", id: "x".repeat(2049) },
    })),
    undefined,
  );
  assert.equal(projectRecord(record({ poster: "x".repeat(2049) })), undefined);
  assert.equal(projectRecord(record({ opaque: "x".repeat(2049) })), undefined);
});

test("search errors carry fixed catalogue keys and no query text", () => {
  const error = new SearchError("search-too-broad", 422, { catalog: 70, local: 2 });
  assert.equal(error.messageKey, "err.searchTooBroad");
  assert.equal(error.status, 422);
  assert.deepEqual(error.details, { catalog: 70, local: 2 });
  assert.equal(error.message.includes("matrix"), false);
});
