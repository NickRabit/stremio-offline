import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchCatalogPage,
  searchAll,
  searchableCatalogs,
  type CatalogTarget,
} from "./addons.js";
import { defaultDownloadSettings } from "./naming.js";
import { setFetchTransport } from "./security.js";
import {
  SEARCH_LIMITS,
  SearchError,
  type SearchStartRequest,
} from "./search-contracts.js";
import {
  CatalogSearchManager,
  parseCatalogSearchRequest,
  type CatalogSearchRequest,
} from "./search-catalog-session.js";
import { SearchScheduler } from "./search-scheduler.js";
import {
  SearchSessionManager,
  type SearchAuthority,
} from "./search-session.js";
import type { AddonRecord, CatalogDefinition, MetaItem } from "./types.js";

class ManualTimers {
  now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; callback: () => void; every?: number }>();

  setTimeout = (callback: () => void, milliseconds: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + milliseconds, callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };

  setInterval = (callback: () => void, milliseconds: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + milliseconds, callback, every: milliseconds });
    return id;
  };

  clearInterval = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };

  tick(milliseconds: number): void {
    const target = this.now + milliseconds;
    for (;;) {
      let next: { id: number; at: number; callback: () => void; every?: number } | undefined;
      for (const [id, task] of this.tasks) {
        if (task.at <= target && (next === undefined || task.at < next.at || (task.at === next.at && id < next.id))) {
          next = { id, ...task };
        }
      }
      if (next === undefined) break;
      this.now = next.at;
      if (next.every === undefined) this.tasks.delete(next.id);
      else this.tasks.set(next.id, { ...next, at: next.at + next.every });
      next.callback();
    }
    this.now = target;
  }
}

type Waiting = {
  resolve(value: MetaItem[]): void;
  reject(error: unknown): void;
};

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const authority = (userId = "user", sid = "browser", current = true) => {
  const value = {
    userId,
    sid,
    current,
    isCurrent(): boolean { return value.current; },
  };
  return value satisfies SearchAuthority & { current: boolean };
};

const request = (slotId = "slot_12345", generation = 1): CatalogSearchRequest => ({
  query: "matrix",
  slotId,
  generation,
});

const addon = (key: string, options: { globalSearch?: boolean } = {}): AddonRecord => ({
  key,
  manifestUrl: `https://${key}.example/manifest.json`,
  role: "both",
  enabled: true,
  globalSearch: options.globalSearch ?? true,
  addedAt: "2026-01-01T00:00:00.000Z",
  downloadSettings: defaultDownloadSettings(),
  manifest: {
    id: key,
    name: key.toUpperCase(),
    version: "1",
    catalogs: [{ type: "movie", id: "movies", extra: [{ name: "search" }] }],
  },
});

const target = (key: string, definition: CatalogDefinition = { type: "movie", id: "movies" }): CatalogTarget => ({
  addon: addon(key),
  definition,
});

const targetKey = (value: CatalogTarget): string => value.addon.key;

const build = (
  targets: CatalogTarget[],
  options: {
    fetchPage?: (
      target: CatalogTarget,
      query: string,
      skip: number,
      signal: AbortSignal,
      key: string,
    ) => Promise<MetaItem[]>;
    stillAllowed?: (authority: SearchAuthority, target: CatalogTarget) => boolean;
    limits?: ConstructorParameters<typeof CatalogSearchManager>[0]["limits"];
  } = {},
) => {
  const timers = new ManualTimers();
  const scheduler = new SearchScheduler({ sourceHardLimitMs: 60_000 }, () => timers.now, timers);
  let id = 0;
  const calls: Array<{ target: string; skip: number; key: string; signal: AbortSignal; wait?: Waiting }> = [];
  const manager = new CatalogSearchManager({
    scheduler,
    targets: () => targets,
    stillAllowed: options.stillAllowed ?? (() => true),
    fetchPage: options.fetchPage ?? ((value, _query, skip, signal, key) => {
      let wait!: Waiting;
      const promise = new Promise<MetaItem[]>((resolve, reject) => {
        wait = { resolve, reject };
      });
      calls.push({ target: targetKey(value), skip, key, signal, wait });
      return promise;
    }),
    rewriteMeta: (meta) => meta,
    now: () => timers.now,
    randomId: () => String(++id),
    timers,
    limits: options.limits,
  });
  const respond = (key: string, metas: MetaItem[]) => {
    const call = calls.find((candidate) => candidate.target === key && candidate.wait !== undefined);
    assert.ok(call?.wait, `no pending call for ${key}`);
    const wait = call.wait;
    call.wait = undefined;
    wait.resolve(metas);
  };
  const fail = (key: string) => {
    const call = calls.find((candidate) => candidate.target === key && candidate.wait !== undefined);
    assert.ok(call?.wait, `no pending call for ${key}`);
    const wait = call.wait;
    call.wait = undefined;
    wait.reject(new Error("upstream"));
  };
  return { manager, scheduler, timers, calls, respond, fail };
};

test("a fast catalogue answers while a slow one is still pending", async () => {
  const { manager, timers, respond } = build([target("fast"), target("slow")]);
  const auth = authority();
  const starting = manager.start(auth, request());
  respond("fast", [{ id: "tt1", type: "movie", name: "Fast" }]);
  timers.tick(SEARCH_LIMITS.firstSnapshotMs);
  const started = await starting;

  assert.equal(started.snapshot.state, "partial");
  assert.deepEqual(started.snapshot.items.map((item) => item.name), ["Fast"]);
  assert.equal(started.snapshot.pending, 1);
  manager.close();
});

test("fold order follows target order, and duplicates keep the first target's fields", async () => {
  const { manager, timers, respond } = build([target("first"), target("second")]);
  const auth = authority();
  const starting = manager.start(auth, request());
  respond("second", [{ id: "tt1", type: "movie", name: "Second fields" }]);
  respond("first", [{ id: "tt1", type: "movie", name: "First fields" }]);
  timers.tick(SEARCH_LIMITS.firstSnapshotMs);
  const started = await starting;

  assert.equal(started.snapshot.items.length, 1);
  assert.equal(started.snapshot.items[0]?.name, "First fields");
  assert.deepEqual(started.snapshot.items[0]?.sources, ["FIRST", "SECOND"]);
  manager.close();
});

test("page advances each raw offset by the rows returned and repeated calls do not stack", async () => {
  const { manager, calls, respond } = build([target("one")]);
  const auth = authority();
  const starting = manager.start(auth, request());
  respond("one", [
    { id: "tt1", type: "movie", name: "One" },
    { id: "tt2", type: "movie", name: "Two" },
  ]);
  const started = await starting;
  assert.equal(started.snapshot.hasMore, true);

  manager.page(auth, started.id);
  manager.page(auth, started.id);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.skip, 2);

  respond("one", []);
  await flush();
  const finished = await manager.poll(auth, started.id, started.snapshot.revision);
  assert.equal(finished.changed, true);
  if (!finished.changed) return;
  assert.equal(finished.snapshot.hasMore, false);
  assert.equal(finished.snapshot.state, "complete");
  manager.close();
});

test("an empty page and a failed page both stop their target", async () => {
  const { manager, timers, respond, fail } = build([target("empty"), target("down")]);
  const auth = authority();
  const starting = manager.start(auth, request());
  respond("empty", []);
  fail("down");
  await flush();
  timers.tick(SEARCH_LIMITS.firstSnapshotMs);
  const started = await starting;

  assert.equal(started.snapshot.state, "complete");
  assert.equal(started.snapshot.failed, 1);
  assert.equal(started.snapshot.hasMore, false);
  manager.close();
});

test("browser seats are counted separately from Search everywhere", async () => {
  const timers = new ManualTimers();
  const scheduler = new SearchScheduler({ sourceHardLimitMs: 60_000 }, () => timers.now, timers);
  const everywhere = new SearchSessionManager({
    scheduler,
    discover: () => [],
    now: () => timers.now,
    timers,
  });
  const auth = authority();
  const globalRequest = (slotId: string): SearchStartRequest => ({
    query: "matrix",
    kind: "all",
    sources: ["catalog"],
    slotId,
    generation: 1,
  });
  await everywhere.start(auth, globalRequest("global_1"));
  await everywhere.start(auth, globalRequest("global_2"));

  const manager = new CatalogSearchManager({
    scheduler,
    targets: () => [],
    stillAllowed: () => true,
    fetchPage: async () => [],
    rewriteMeta: (meta) => meta,
    now: () => timers.now,
    timers,
  });
  await manager.start(auth, request("catalog_1"));
  await manager.start(auth, request("catalog_2"));
  assert.equal(manager.size(), 2);
  assert.equal(everywhere.size(), 2);

  await manager.start(auth, request("catalog_3"));
  assert.equal(manager.size(), 2, "the catalogue manager evicts its own oldest seat");
  assert.equal(everywhere.size(), 2, "and leaves the other manager's seats alone");
  manager.close();
  everywhere.close();
});

test("a newer generation replaces the slot and tombstones the old id", async () => {
  const { manager } = build([]);
  const auth = authority();
  const first = await manager.start(auth, request("slot_replace", 1));
  const second = await manager.start(auth, request("slot_replace", 2));
  assert.notEqual(first.id, second.id);
  await assert.rejects(
    manager.poll(auth, first.id, first.snapshot.revision),
    (error: unknown) => error instanceof SearchError && error.status === 410,
  );
  await assert.rejects(
    manager.start(auth, request("slot_replace", 1)),
    (error: unknown) => error instanceof SearchError && error.status === 409,
  );
  const duplicate = await manager.start(auth, request("slot_replace", 2));
  assert.equal(duplicate.id, second.id);
  manager.close();
});

test("revalidation drops a target and its rows", async () => {
  let allowed = true;
  const { manager, timers, respond } = build([target("one")], {
    stillAllowed: () => allowed,
  });
  const auth = authority();
  const starting = manager.start(auth, request());
  respond("one", [{ id: "tt1", type: "movie", name: "One" }]);
  timers.tick(SEARCH_LIMITS.firstSnapshotMs);
  const started = await starting;
  assert.equal(started.snapshot.items.length, 1);

  allowed = false;
  const changed = await manager.poll(auth, started.id, started.snapshot.revision);
  assert.equal(changed.changed, true);
  if (!changed.changed) return;
  assert.deepEqual(changed.snapshot.items, []);
  assert.equal(changed.snapshot.sources, 0);
  manager.close();
});

test("scope includes a global-search opt-out only when that addon was picked", async () => {
  const addons = [addon("normal"), addon("private", { globalSearch: false })];
  const resolve = (_authority: SearchAuthority, incoming: CatalogSearchRequest) =>
    searchableCatalogs(
      addons,
      incoming.type,
      incoming.scope
        ? { ...incoming.scope, respectGlobalSearch: false }
        : { respectGlobalSearch: true },
    );
  const timers = new ManualTimers();
  const scheduler = new SearchScheduler({ sourceHardLimitMs: 60_000 }, () => timers.now, timers);
  const manager = new CatalogSearchManager({
    scheduler,
    targets: resolve,
    stillAllowed: () => true,
    fetchPage: async () => [],
    rewriteMeta: (meta) => meta,
    now: () => timers.now,
    timers,
  });
  const auth = authority();
  const scoped = await manager.start(auth, {
    ...request("slot_scope"),
    scope: { addonKey: "private" },
  });
  const unscoped = await manager.start(auth, request("slot_unscoped"));
  assert.equal(scoped.snapshot.sources, 1);
  assert.equal(unscoped.snapshot.sources, 1, "only the normal addon is in the global search");
  manager.close();
});

test("request parsing refuses extra keys and accepts the optional catalogue scope", () => {
  assert.deepEqual(parseCatalogSearchRequest({
    query: "matrix",
    type: "movie",
    scope: { addonKey: "alpha", catalogType: "movie", catalogId: "top" },
    slotId: "slot_12345",
    generation: 2,
  }), {
    query: "matrix",
    type: "movie",
    scope: { addonKey: "alpha", catalogType: "movie", catalogId: "top" },
    slotId: "slot_12345",
    generation: 2,
  });
  assert.throws(
    () => parseCatalogSearchRequest({
      query: "matrix",
      slotId: "slot_12345",
      generation: 2,
      extra: true,
    }),
    (error: unknown) => error instanceof SearchError && error.status === 400,
  );
});

test("the completed session folds exactly like searchAll", async () => {
  const addons = [addon("alpha"), addon("beta")];
  const previousPrivate = process.env.ALLOW_PRIVATE_ADDONS;
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  setFetchTransport(async (url) => {
    const host = new URL(String(url)).hostname;
    const metas = host === "alpha.example"
      ? [
        { id: "tt1", type: "movie", name: "Alpha one" },
        { id: "tt2", type: "movie", name: "Alpha two" },
      ]
      : [
        { id: "tt1", type: "movie", name: "Beta one" },
        { id: "tt3", type: "movie", name: "Beta three" },
      ];
    return new Response(JSON.stringify({ metas }), {
      headers: { "content-type": "application/json" },
    });
  });
  try {
    const timers = new ManualTimers();
    const scheduler = new SearchScheduler({ sourceHardLimitMs: 60_000 }, () => timers.now, timers);
    const rewrite = (meta: MetaItem): MetaItem => ({ ...meta, poster: "rewritten" });
    const manager = new CatalogSearchManager({
      scheduler,
      targets: (_authority, incoming) =>
        searchableCatalogs(addons, incoming.type, { respectGlobalSearch: true }),
      stillAllowed: () => true,
      fetchPage: (value, query, skip, signal, key) =>
        fetchCatalogPage(value, query, skip, { signal, key }),
      rewriteMeta: rewrite,
      now: () => timers.now,
      timers,
    });
    const started = await manager.start(authority(), request());
    const expected = (await searchAll(addons, "matrix", undefined, undefined, {
      respectGlobalSearch: true,
    })).items.map(rewrite);
    assert.deepEqual(started.snapshot.items, expected);
    manager.close();
  } finally {
    setFetchTransport();
    if (previousPrivate === undefined) delete process.env.ALLOW_PRIVATE_ADDONS;
    else process.env.ALLOW_PRIVATE_ADDONS = previousPrivate;
  }
});
