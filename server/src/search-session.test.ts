import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SEARCH_LIMITS,
  SearchError,
  parseStartRequest,
  type RawSearchRecord,
  type SearchKind,
  type SearchSourceClass,
  type SearchStartRequest,
  type StrongIds,
} from "./search-contracts.js";
import { SearchScheduler } from "./search-scheduler.js";
import {
  SearchSessionManager,
  SourceFailure,
  type SearchAuthority,
  type SearchSource,
  type SourcePage,
} from "./search-session.js";

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

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = (value) => done(value as T);
    reject = fail;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
};

class FakeSource implements SearchSource {
  readonly calls: unknown[] = [];
  readonly signals: AbortSignal[] = [];
  readonly pending: Deferred<SourcePage>[] = [];
  allowed = true;
  private readonly readyListeners = new Set<() => void>();
  expand?: SearchSource["expand"];

  constructor(
    readonly id: string,
    readonly sourceClass: SearchSourceClass,
    readonly label = id,
    readonly poolKey = id,
    readonly continuation: "supported" | "unsupported" = "supported",
  ) {}

  next(cursor: unknown, signal: AbortSignal): Promise<SourcePage> {
    this.calls.push(cursor);
    this.signals.push(signal);
    const wait = deferred<SourcePage>();
    this.pending.push(wait);
    signal.addEventListener("abort", () => wait.reject(new SourceFailure("cancelled")), { once: true });
    return wait.promise;
  }

  stillAllowed(): boolean {
    return this.allowed;
  }

  onReady(listener: () => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  respond(page: SourcePage): void {
    const wait = this.pending.shift();
    assert.ok(wait, `no pending call for ${this.id}`);
    wait.resolve(page);
  }

  fail(error: unknown): void {
    const wait = this.pending.shift();
    assert.ok(wait, `no pending call for ${this.id}`);
    wait.reject(error);
  }

  notifyReady(): void {
    for (const listener of [...this.readyListeners]) listener();
  }
}

const authority = (userId = "user", sid = "browser", current = true) => {
  const value = {
    userId,
    sid,
    current,
    isCurrent(): boolean { return value.current; },
  };
  return value satisfies SearchAuthority & { current: boolean };
};

const request = (query = "matrix", generation = 0, slotId = "slot_12345"): SearchStartRequest => ({
  query,
  kind: "all",
  sources: ["catalog"],
  slotId,
  generation,
});

const catalogRecord = (
  itemKey: string,
  title: string,
  ids: StrongIds,
  extra: Partial<RawSearchRecord> = {},
): RawSearchRecord => ({
  itemKey,
  kind: "movie",
  title,
  ids,
  locator: { kind: "catalog", addonKey: "addon", type: "movie", id: itemKey },
  ...extra,
});

const page = (records: RawSearchRecord[], exhausted = true, cursor?: unknown): SourcePage => ({
  records,
  exhausted,
  ...(cursor === undefined ? {} : { cursor }),
});

const build = (
  sourceFactory: () => SearchSource[],
  options: {
    limits?: ConstructorParameters<typeof SearchSessionManager>[0]["limits"];
    schedulerLimits?: ConstructorParameters<typeof SearchScheduler>[0];
    discover?: ConstructorParameters<typeof SearchSessionManager>[0]["discover"];
    knownIds?: ConstructorParameters<typeof SearchSessionManager>[0]["knownIds"];
  } = {},
) => {
  const timers = new ManualTimers();
  const scheduler = new SearchScheduler(
    { sourceHardLimitMs: 60_000, ...options.schedulerLimits },
    () => timers.now,
    timers,
  );
  let id = 0;
  const manager = new SearchSessionManager({
    scheduler,
    discover: options.discover ?? (() => sourceFactory()),
    now: () => timers.now,
    randomId: () => String(++id),
    timers,
    limits: options.limits,
    ...(options.knownIds === undefined ? {} : { knownIds: options.knownIds }),
  });
  return { manager, scheduler, timers };
};

test("a fast source appears before a slow source and the slow arrival wakes polling", async () => {
  const fast = new FakeSource("fast", "catalog");
  const slow = new FakeSource("slow", "catalog");
  const { manager, timers } = build(() => [fast, slow]);
  const auth = authority();
  const starting = manager.start(auth, request());
  fast.respond(page([catalogRecord("fast:1", "Matrix", { imdb: "tt1" })]));
  timers.tick(SEARCH_LIMITS.firstSnapshotMs);
  const started = await starting;
  assert.equal(started.snapshot.state, "partial");
  assert.equal(started.snapshot.clusters.length, 1);
  assert.equal(started.snapshot.sources.find((source) => source.id === "slow")?.state, "loading");

  const polling = manager.poll(auth, started.id, started.snapshot.revision);
  slow.respond(page([catalogRecord("slow:1", "The Matrix Reloaded", { imdb: "tt2" })]));
  await flush();
  const changed = await polling;
  assert.equal(changed.changed, true);
  assert.ok(changed.changed && changed.snapshot.clusters.length === 2);
  manager.close();
});

test("start resolves at 300 ms while every source is still pending", async () => {
  const first = new FakeSource("first", "catalog");
  const second = new FakeSource("second", "catalog");
  const { manager, timers } = build(() => [first, second]);
  const starting = manager.start(authority(), request());
  timers.tick(SEARCH_LIMITS.firstSnapshotMs);
  const started = await starting;
  assert.equal(started.snapshot.state, "partial");
  assert.deepEqual(started.snapshot.sources.map((source) => source.state), ["loading", "loading"]);
  manager.close();
});

test("a new generation removes the old session's queued work and tombstones its id", async () => {
  const oldSources = Array.from({ length: 100 }, (_, index) => new FakeSource(`old-${index}`, "catalog"));
  const newSources = Array.from({ length: 100 }, (_, index) => new FakeSource(`new-${index}`, "catalog"));
  let discovery = 0;
  const { manager, scheduler, timers } = build(() => [], {
    limits: { targetsPerSession: 100 },
    schedulerLimits: { jobsServerWide: 4 },
    discover: () => (++discovery === 1 ? oldSources : newSources),
  });
  const auth = authority();
  const oldStart = manager.start(auth, request("first", 0));
  assert.equal(scheduler.stats().active, 4);
  assert.equal(scheduler.stats().queued, 96);
  const replacing = manager.start(auth, request("second", 1));
  assert.equal(scheduler.stats().active, 4);
  assert.equal(scheduler.stats().queued, 100);
  await assert.rejects(oldStart, (error: unknown) =>
    error instanceof SearchError && error.code === "search-restart-required",
  );
  await flush();
  assert.equal(scheduler.stats().active, 4);
  assert.equal(scheduler.stats().queued, 96);
  timers.tick(300);
  const replaced = await replacing;
  assert.notEqual(replaced.id, "ss_1");
  assert.equal(oldSources.slice(4).every((source) => source.calls.length === 0), true);
  await assert.rejects(
    manager.poll(auth, "ss_1", 0),
    (error: unknown) => error instanceof SearchError && error.code === "search-restart-required" && error.status === 410,
  );
  await assert.rejects(
    manager.poll(authority("user", "other"), "ss_1", 0),
    (error: unknown) => error instanceof SearchError && error.code === "search-not-found" && error.status === 404,
  );
  manager.close();
});

test("slot generations are idempotent and conflicting requests fail without replacing the search", async () => {
  const first = new FakeSource("first", "catalog");
  const { manager } = build(() => [first]);
  const auth = authority();
  const starting = manager.start(auth, request("matrix", 5));
  first.respond(page([catalogRecord("one", "Matrix", { imdb: "tt1" })]));
  const started = await starting;
  const duplicate = await manager.start(auth, request("matrix", 5));
  assert.equal(duplicate.id, started.id);
  assert.equal(first.calls.length, 1);
  await assert.rejects(manager.start(auth, request("other", 5)), SearchError);
  await assert.rejects(manager.start(auth, request("matrix", 4)), (error: unknown) =>
    error instanceof SearchError && error.code === "search-generation-conflict",
  );
  assert.equal(manager.size(), 1);
  const quiet = await manager.poll(auth, started.id, started.snapshot.revision, AbortSignal.abort());
  assert.equal(quiet.changed, false);
  manager.close();
});

test("a discovery refusal leaves the current session usable", async () => {
  const source = new FakeSource("one", "catalog");
  let calls = 0;
  const { manager } = build(() => [source], {
    discover: () => {
      calls += 1;
      if (calls === 1) return [source];
      throw new SearchError("search-too-broad", 422, { catalog: 70, local: 2 });
    },
  });
  const auth = authority();
  const starting = manager.start(auth, request("matrix", 0));
  source.respond(page([catalogRecord("one", "Matrix", { imdb: "tt1" })]));
  const started = await starting;
  await assert.rejects(manager.start(auth, request("next", 1)), (error: unknown) =>
    error instanceof SearchError && error.code === "search-too-broad",
  );
  const answer = await manager.poll(auth, started.id, started.snapshot.revision, AbortSignal.abort());
  assert.equal(answer.changed, false);
  manager.close();
});

test("a browser session at its seat limit gives up its own oldest search; the server limit refuses", async () => {
  let current!: FakeSource;
  const { manager } = build(() => [], {
    limits: { sessionsPerBrowserSession: 1, sessionsServerWide: 1 },
    discover: () => {
      current = new FakeSource("one", "catalog");
      return [current];
    },
  });
  const auth = authority();
  const firstStart = manager.start(auth, request("one", 0, "slot_12345"));
  current.respond(page([]));
  const first = await firstStart;
  const reloadStart = manager.start(auth, request("two", 0, "slot_67890"));
  current.respond(page([]));
  const reload = await reloadStart;
  assert.notEqual(first.id, reload.id);
  assert.equal(manager.size(), 1, "the reloaded page took the seat of the abandoned one");
  await assert.rejects(manager.poll(auth, first.id, 0), (error: unknown) =>
    error instanceof SearchError && error.code === "search-restart-required",
  );
  await assert.rejects(manager.start(authority("other", "browser"), request()), (error: unknown) =>
    error instanceof SearchError && error.code === "search-capacity-limit" && error.status === 503,
  );
  assert.equal(manager.size(), 1, "another account never evicts this one");
  manager.close();
});

test("the page buffer is drained before another source call", async () => {
  const source = new FakeSource("one", "catalog");
  const { manager } = build(() => [source]);
  const auth = authority();
  const starting = manager.start(auth, request());
  const rows = Array.from({ length: 50 }, (_, index) =>
    catalogRecord(`item-${index}`, `Matrix ${index}`, { imdb: `tt${index + 1}` }),
  );
  source.respond(page(rows, true));
  const started = await starting;
  assert.equal(started.snapshot.sources[0]?.loaded, 20);
  assert.equal(source.calls.length, 1);
  manager.pageAll(auth, started.id);
  await flush();
  const middle = await manager.poll(auth, started.id, 0);
  assert.equal(middle.changed && middle.snapshot.sources[0]?.loaded, 40);
  manager.pageAll(auth, started.id);
  await flush();
  const after = await manager.poll(auth, started.id, 0);
  assert.equal(after.changed, true);
  assert.equal(after.changed && after.snapshot.sources[0]?.loaded, 50);
  assert.equal(source.calls.length, 1);
  assert.equal(after.changed && after.snapshot.sources[0]?.state, "exhausted");
  manager.close();
});

test("three duplicate-only pages stall a source and retry resumes from the same cursor", async () => {
  const source = new FakeSource("one", "catalog");
  const { manager } = build(() => [source]);
  const auth = authority();
  const starting = manager.start(auth, request());
  const duplicate = () => page([catalogRecord("same", "Matrix", { imdb: "tt1" })], false, "cursor-1");
  source.respond(duplicate());
  const started = await starting;
  manager.pageAll(auth, started.id);
  source.respond(duplicate());
  await flush();
  manager.pageAll(auth, started.id);
  source.respond(duplicate());
  await flush();
  manager.pageAll(auth, started.id);
  source.respond(duplicate());
  await flush();
  const stalled = await manager.poll(auth, started.id, 0);
  assert.equal(stalled.changed && stalled.snapshot.sources[0]?.state, "stalled");
  assert.equal(stalled.changed && stalled.snapshot.sources[0]?.continuation, "blocked");
  manager.retry(auth, started.id, "one");
  assert.deepEqual(source.calls.at(-1), "cursor-1");
  manager.close();
});

test("failure keeps the cursor and a quick second retry is rate-limited", async () => {
  const source = new FakeSource("one", "catalog");
  const { manager } = build(() => [source]);
  const auth = authority();
  const starting = manager.start(auth, request());
  source.respond(page([catalogRecord("one", "Matrix", { imdb: "tt1" })], false, "cursor-1"));
  const started = await starting;
  manager.pageAll(auth, started.id);
  source.fail(new SourceFailure("network"));
  await flush();
  let snapshot = await manager.poll(auth, started.id, 0);
  assert.equal(snapshot.changed && snapshot.snapshot.sources[0]?.state, "failed");
  manager.retry(auth, started.id, "one");
  assert.equal(source.calls.at(-1), "cursor-1");
  source.fail(new SourceFailure("network"));
  await flush();
  assert.throws(() => manager.retry(auth, started.id, "one"), (error: unknown) =>
    error instanceof SearchError && error.code === "search-retry-limited",
  );
  assert.throws(() => manager.retry(auth, started.id, "missing"), (error: unknown) =>
    error instanceof SearchError && error.code === "search-not-retryable",
  );
  manager.close();
});

test("only retryable states can be retried", async () => {
  const source = new FakeSource("one", "catalog");
  const { manager } = build(() => [source]);
  const auth = authority();
  const starting = manager.start(auth, request());
  source.respond(page([]));
  const started = await starting;
  assert.throws(() => manager.retry(auth, started.id, "one"), (error: unknown) =>
    error instanceof SearchError && error.status === 409 && error.code === "search-not-retryable",
  );
  manager.close();
});

test("a timeout is retryable and indexing waits for ready without client action", async () => {
  const timed = new FakeSource("timed", "catalog");
  const indexing = new FakeSource("indexing", "local");
  const { manager } = build(() => [timed, indexing]);
  const auth = authority();
  const starting = manager.start(auth, request());
  timed.fail(new SourceFailure("timeout"));
  indexing.respond({ records: [], exhausted: false, indexing: true });
  const started = await starting;
  let snapshot = await manager.poll(auth, started.id, 0);
  assert.equal(snapshot.changed && snapshot.snapshot.sources.find((source) => source.id === "timed")?.state, "timedOut");
  assert.equal(snapshot.changed && snapshot.snapshot.sources.find((source) => source.id === "timed")?.retryable, true);
  assert.equal(snapshot.changed && snapshot.snapshot.sources.find((source) => source.id === "indexing")?.state, "indexing");
  indexing.notifyReady();
  await flush();
  assert.equal(indexing.calls.length, 2);
  indexing.respond(page([catalogRecord("local:1", "Matrix", { imdb: "tt1" })]));
  await flush();
  snapshot = await manager.poll(auth, started.id, 0);
  assert.equal(snapshot.changed && snapshot.snapshot.sources.find((source) => source.id === "indexing")?.state, "exhausted");
  manager.close();
});

test("record capacity stops all paging at 1,200 records", async () => {
  const sources = Array.from({ length: 60 }, (_, index) => new FakeSource(`source-${index}`, "catalog"));
  const { manager, timers } = build(() => sources, { schedulerLimits: { jobsServerWide: 32 } });
  const auth = authority();
  const starting = manager.start(auth, request());
  for (let round = 0; round < 10; round += 1) {
    let answered = 0;
    for (const [sourceIndex, source] of sources.entries()) {
      while (source.pending.length > 0) {
        const records = Array.from({ length: 25 }, (_, index) =>
          catalogRecord(`item-${index}`, `Matrix ${sourceIndex}`, { imdb: `tt${sourceIndex * 100 + index + 1}` }),
        );
        source.respond(page(records, true));
        answered += 1;
      }
    }
    await flush();
    if (answered === 0) break;
  }
  timers.tick(300);
  const started = await starting;
  const calls = sources.reduce((total, source) => total + source.calls.length, 0);
  const loaded = started.snapshot.sources.reduce((total, source) => total + source.loaded, 0);
  assert.equal(loaded, 1200);
  manager.pageAll(auth, started.id);
  await flush();
  const capped = await manager.poll(auth, started.id, 0);
  assert.equal(capped.changed && capped.snapshot.limitReached, true);
  assert.equal(sources.reduce((total, source) => total + source.calls.length, 0), calls);
  manager.pageAll(auth, started.id);
  await flush();
  assert.equal(sources.reduce((total, source) => total + source.calls.length, 0), calls);
  manager.close();
});

test("source revocation removes its records in a changed poll", async () => {
  const source = new FakeSource("one", "catalog");
  const { manager } = build(() => [source]);
  const auth = authority();
  const starting = manager.start(auth, request());
  source.respond(page([catalogRecord("one", "Matrix", { imdb: "tt1" })]));
  const started = await starting;
  source.allowed = false;
  const changed = await manager.poll(auth, started.id, started.snapshot.revision);
  assert.equal(changed.changed, true);
  assert.equal(changed.changed && changed.snapshot.sources.length, 0);
  assert.equal(changed.changed && changed.snapshot.clusters.length, 0);
  manager.close();
});

test("an authority that is no longer current destroys the session", async () => {
  const source = new FakeSource("one", "catalog");
  const { manager } = build(() => [source]);
  const auth = authority();
  const starting = manager.start(auth, request());
  source.respond(page([]));
  const started = await starting;
  auth.current = false;
  await assert.rejects(manager.poll(auth, started.id, 0), (error: unknown) =>
    error instanceof SearchError && error.code === "search-restart-required",
  );
  assert.equal(manager.size(), 0);
  manager.close();
});

test("only one poll waits, a second returns immediately, and abort releases the waiter", async () => {
  const source = new FakeSource("one", "catalog");
  const { manager } = build(() => [source]);
  const auth = authority();
  const starting = manager.start(auth, request());
  source.respond(page([catalogRecord("one", "Matrix", { imdb: "tt1" })], false));
  const started = await starting;

  const controller = new AbortController();
  const waiting = manager.poll(auth, started.id, started.snapshot.revision, controller.signal);
  const immediate = await manager.poll(auth, started.id, started.snapshot.revision);
  assert.equal(immediate.changed, false);
  controller.abort();
  const released = await waiting;
  assert.equal(released.changed, false);

  const waking = manager.poll(auth, started.id, started.snapshot.revision);
  manager.pageAll(auth, started.id);
  source.respond(page([catalogRecord("two", "Matrix 2", { imdb: "tt2" })], true));
  await flush();
  const answer = await waking;
  assert.equal(answer.changed, true);
  manager.close();
});

test("idle sweep and explicit drop hooks destroy sessions", async () => {
  const make = (id: string) => {
    const source = new FakeSource(id, "catalog");
    queueMicrotask(() => source.respond(page([])));
    return source;
  };
  let discovery = 0;
  const { manager, timers } = build(() => [make("one")], {
    limits: { sessionsPerBrowserSession: 2 },
    discover: () => [make(`source-${++discovery}`)],
  });
  const first = await manager.start(authority("u1", "s1"), request("one", 0, "slot_11111"));
  const second = await manager.start(authority("u1", "s1"), request("two", 0, "slot_22222"));
  timers.tick(SEARCH_LIMITS.idleExpiryMs);
  assert.equal(manager.size(), 0);
  await assert.rejects(manager.poll(authority("u1", "s1"), first.id, 0), SearchError);

  const thirdSource = new FakeSource("three", "catalog");
  const fourthSource = new FakeSource("four", "catalog");
  let next = 0;
  const { manager: hooks } = build(() => [thirdSource], {
    limits: { sessionsPerBrowserSession: 2 },
    discover: () => [next++ === 0 ? thirdSource : fourthSource],
  });
  const thirdStart = hooks.start(authority("u2", "s2"), request("one", 0, "slot_11111"));
  thirdSource.respond(page([]));
  const third = await thirdStart;
  const fourthStart = hooks.start(authority("u2", "s2"), request("two", 0, "slot_22222"));
  fourthSource.respond(page([]));
  const fourth = await fourthStart;
  hooks.dropSession("s2");
  assert.equal(hooks.size(), 0);
  await assert.rejects(hooks.poll(authority("u2", "s2"), third.id, 0), SearchError);
  await assert.rejects(hooks.poll(authority("u2", "s2"), fourth.id, 0), SearchError);
  hooks.close();
  manager.close();
  assert.ok(second.id);
});

test("a late bridge keeps the surviving cluster position and emits an alias", async () => {
  const first = new FakeSource("first", "catalog");
  const second = new FakeSource("second", "catalog");
  const { manager } = build(() => [first, second]);
  const auth = authority();
  const starting = manager.start(auth, request());
  first.respond(page([catalogRecord("imdb", "Matrix", { imdb: "tt1" })], false));
  second.respond(page([catalogRecord("tmdb", "Matrix", { tmdb: "10" })]));
  const started = await starting;
  assert.equal(started.snapshot.clusters.length, 2);
  const firstKey = started.snapshot.clusters[0]!.key;
  manager.pageAll(auth, started.id);
  first.respond(page([
    catalogRecord("bridge", "Matrix", { imdb: "tt1", tmdb: "10" }),
  ]));
  await flush();
  const changed = await manager.poll(auth, started.id, started.snapshot.revision);
  assert.equal(changed.changed, true);
  if (!changed.changed) return;
  assert.equal(changed.snapshot.clusters.length, 1);
  assert.equal(changed.snapshot.clusters[0]?.key, firstKey);
  assert.equal(changed.snapshot.aliases.length, 1);
  manager.close();
});

test("episodes attach to a series and the member page lists both", async () => {
  const source = new FakeSource("one", "catalog");
  const { manager } = build(() => [source]);
  const auth = authority();
  const starting = manager.start(auth, request());
  source.respond(page([
    { ...catalogRecord("series", "Matrix", { imdb: "tt1" }), kind: "series", locator: { kind: "catalog", addonKey: "addon", type: "series", id: "tt1" } },
    {
      ...catalogRecord("episode", "Matrix Episode", {}),
      kind: "episode",
      parentRef: "series",
      parentIds: { imdb: "tt1" },
      season: 1,
      episode: 2,
    },
  ]));
  const started = await starting;
  const series = started.snapshot.clusters.find((cluster) => cluster.kind === "series");
  assert.ok(series);
  assert.equal(series.episodeCount, 1);
  assert.equal(started.snapshot.clusters.filter((cluster) => cluster.kind === "episode").length, 0);
  const members = manager.members(auth, started.id, series.primaryMemberKey, 0);
  assert.deepEqual(members.members.map((member) => member.kind), ["series", "episode"]);
  manager.close();
});

test("local and remote noise is dropped while a catalog record is always accepted", async () => {
  const remote = new FakeSource("remote", "remote");
  const catalog = new FakeSource("catalog", "catalog");
  const { manager } = build(() => [remote, catalog]);
  const auth = authority();
  const starting = manager.start(auth, request("matrix"));
  remote.respond(page([{
    ...catalogRecord("remote:noise", "Unrelated", { imdb: "tt9" }),
    locator: { kind: "remote", libraryId: "lib", itemId: "remote:noise", itemType: "movie" },
  }]));
  catalog.respond(page([catalogRecord("catalog:translated", "Unrelated", { imdb: "tt1" })]));
  const started = await starting;
  const remoteView = started.snapshot.sources.find((source) => source.id === "remote");
  assert.equal(remoteView?.loaded, 0);
  assert.equal(remoteView?.dropped, 1);
  assert.deepEqual(started.snapshot.clusters.map((cluster) => cluster.title), ["Unrelated"]);
  manager.close();
});

test("clusters are reordered by score instead of first arrival", async () => {
  const catalog = new FakeSource("catalog", "catalog");
  const { manager } = build(() => [catalog]);
  const auth = authority();
  const starting = manager.start(auth, request("yes minister"));
  catalog.respond(page([
    catalogRecord("weak", "Yessica Bunny", { imdb: "tt1" }, { sourcePosition: 0 }),
    catalogRecord("strong", "Yes Minister", { imdb: "tt2" }, { sourcePosition: 1 }),
  ]));
  const started = await starting;
  assert.deepEqual(started.snapshot.clusters.map((cluster) => cluster.title), ["Yes Minister", "Yessica Bunny"]);
  assert.ok(started.snapshot.clusters[0]!.score > started.snapshot.clusters[1]!.score);
  manager.close();
});

test("episodes with a parentRef attach to a series that has no provider ids", async () => {
  const catalog = new FakeSource("catalog", "catalog");
  const { manager } = build(() => [catalog]);
  const auth = authority();
  const starting = manager.start(auth, request("simpsonovi"));
  const seriesRecord: RawSearchRecord = {
    itemKey: "series",
    kind: "series",
    title: "Simpsonovi",
    locator: { kind: "catalog", addonKey: "addon", type: "series", id: "series" },
  };
  const episode = (index: number): RawSearchRecord => ({
    itemKey: `episode-${index}`,
    kind: "episode",
    title: `Homerland ${index}`,
    parentRef: "series",
    season: 25,
    episode: index,
    locator: { kind: "catalog", addonKey: "addon", type: "series", id: `episode-${index}` },
  });
  catalog.respond(page([seriesRecord, episode(1), episode(2), episode(3)]));
  const started = await starting;
  assert.equal(started.snapshot.clusters.length, 1);
  const series = started.snapshot.clusters[0]!;
  assert.equal(series.kind, "series");
  assert.equal(series.episodeCount, 3);
  assert.deepEqual(
    manager.members(auth, started.id, series.primaryMemberKey, 0).members.map((member) => member.kind),
    ["series", "episode", "episode", "episode"],
  );
  manager.close();
});

test("a series derived from its episodes never replaces the real series row", async () => {
  const catalog = new FakeSource("catalog", "catalog");
  const { manager } = build(() => [catalog]);
  const auth = authority();
  const starting = manager.start(auth, request("simpsonovi"));
  const real: RawSearchRecord = {
    itemKey: "series",
    kind: "series",
    title: "Simpsonovi",
    ids: { imdb: "tt0096697" },
    locator: { kind: "catalog", addonKey: "addon", type: "series", id: "tt0096697" },
  };
  const derived: RawSearchRecord = { ...real, ids: {}, derived: true };
  catalog.respond(page([real, derived]));
  const started = await starting;
  const member = manager.members(auth, started.id, started.snapshot.clusters[0]!.primaryMemberKey, 0);
  assert.equal(member.canonical?.id, "tt0096697", "the real row and its id are kept");
  manager.close();
});

test("an episode waits for its parent when the series arrives on a later page", async () => {
  const remote = new FakeSource("remote", "remote");
  const { manager } = build(() => [remote]);
  const auth = authority();
  const starting = manager.start(auth, request("simpsonovi"));
  remote.respond(page([{
    itemKey: "episode",
    kind: "episode",
    title: "Homerland",
    parentRef: "series",
    season: 25,
    episode: 1,
    locator: { kind: "remote", libraryId: "lib", itemId: "episode", itemType: "episode" },
  }], false, "next"));
  const started = await starting;
  assert.equal(started.snapshot.clusters.length, 0);
  manager.pageAll(auth, started.id);
  remote.respond(page([{
    itemKey: "series",
    kind: "series",
    title: "Simpsonovi",
    locator: { kind: "remote", libraryId: "lib", itemId: "series", itemType: "series" },
  }]));
  await flush();
  const snapshot = await manager.poll(auth, started.id, 0);
  assert.equal(snapshot.changed && snapshot.snapshot.clusters[0]?.episodeCount, 1);
  assert.equal(snapshot.changed && snapshot.snapshot.sources[0]?.dropped, undefined);
  manager.close();
});

test("canonical prefers an IMDb id carried by a remote member", async () => {
  const catalog = new FakeSource("catalog", "catalog");
  const remote = new FakeSource("remote", "remote");
  const { manager } = build(() => [catalog, remote]);
  const auth = authority();
  const starting = manager.start(auth, request("jistě, pane ministře"));
  catalog.respond(page([
    catalogRecord("catalog", "Jistě, pane ministře", { tmdb: "4549" }),
  ]));
  remote.respond(page([{
    ...catalogRecord("remote", "Jistě, pane ministře", { imdb: "tt0080306", tmdb: "4549" }),
    locator: { kind: "remote", libraryId: "lib", itemId: "remote", itemType: "movie" },
  }]));
  const started = await starting;
  const cluster = started.snapshot.clusters[0]!;
  assert.equal(cluster.memberCount, 2);
  assert.equal(manager.members(auth, started.id, cluster.primaryMemberKey, 0).canonical?.id, "tt0080306");
  manager.close();
});

test("top clusters expand local copies once and merge them by id", async () => {
  const local = new FakeSource("local", "local");
  const catalog = new FakeSource("catalog", "catalog");
  let expansions = 0;
  local.expand = async (ids) => {
    expansions += 1;
    assert.deepEqual(ids, { imdb: "tt1" });
    return [{
      itemKey: "local-yes-minister",
      kind: "movie",
      title: "Yes Minister",
      ids: { imdb: "tt1" },
      locator: { kind: "local", key: "lib_00000001/Yes Minister", libraryId: "lib_00000001", itemKind: "folder" },
    }];
  };
  const { manager } = build(() => [local, catalog]);
  const auth = authority();
  const starting = manager.start(auth, request("jistě, pane ministře"));
  local.respond(page([]));
  catalog.respond(page([
    catalogRecord("catalog", "Jistě, pane ministře", { imdb: "tt1" }),
  ], false, "next"));
  const started = await starting;
  await flush();
  let snapshot = await manager.poll(auth, started.id, 0);
  assert.equal(snapshot.changed, true);
  snapshot = await manager.poll(auth, started.id, 0);
  assert.equal(snapshot.changed, true);
  if (!snapshot.changed) return;
  assert.equal(snapshot.snapshot.clusters[0]?.memberCount, 2);
  assert.equal(expansions, 1);

  manager.pageAll(auth, started.id);
  catalog.respond(page([
    catalogRecord("catalog", "Jistě, pane ministře", { imdb: "tt1" }),
  ]));
  await flush();
  await manager.poll(auth, started.id, 0);
  assert.equal(expansions, 1);
  manager.close();
});

test("scope round-trips through start parsing and participates in idempotency", async () => {
  const catalog = new FakeSource("catalog", "catalog");
  const { manager } = build(() => [catalog]);
  const parsed = parseStartRequest({
    ...request("matrix"),
    scope: { addonKey: "alpha", catalogType: "movie", catalogId: "top" },
  });
  const auth = authority();
  const starting = manager.start(auth, parsed);
  catalog.respond(page([]));
  const started = await starting;
  const duplicate = await manager.start(auth, parseStartRequest({
    ...request("matrix"),
    scope: { addonKey: "alpha", catalogType: "movie", catalogId: "top" },
  }));
  assert.equal(duplicate.id, started.id);
  await assert.rejects(
    manager.start(auth, parseStartRequest({
      ...request("matrix"),
      scope: { addonKey: "beta", catalogType: "movie", catalogId: "top" },
    })),
    (error: unknown) => error instanceof SearchError && error.code === "search-generation-conflict",
  );
  manager.close();
});

test("member detail pages 250 members as 100, 100 and 50", async () => {
  const source = new FakeSource("one", "catalog");
  const { manager } = build(() => [source]);
  const auth = authority();
  const starting = manager.start(auth, request());
  const rows = Array.from({ length: 250 }, (_, index) =>
    catalogRecord(`item-${index}`, `Matrix ${index}`, { imdb: "tt1" }),
  );
  source.respond(page(rows));
  const started = await starting;
  const initial = await manager.poll(auth, started.id, 0);
  assert.equal(initial.changed, true);
  for (let pageIndex = 0; pageIndex < 12; pageIndex += 1) {
    manager.pageAll(auth, started.id);
    await flush();
  }
  const final = await manager.poll(auth, started.id, 0);
  assert.equal(final.changed, true);
  if (!final.changed) return;
  const cluster = final.snapshot.clusters[0]!;
  assert.equal(cluster.memberCount, 250);
  const first = manager.members(auth, started.id, cluster.primaryMemberKey, 0);
  const second = manager.members(auth, started.id, cluster.primaryMemberKey, first.nextFrom!);
  const third = manager.members(auth, started.id, cluster.primaryMemberKey, second.nextFrom!);
  assert.deepEqual([first.members.length, second.members.length, third.members.length], [100, 100, 50]);
  assert.deepEqual([first.nextFrom, second.nextFrom, third.nextFrom], [100, 200, undefined]);
  manager.close();
});

test("the query never appears in snapshots, member pages or search errors", async () => {
  const sentinel = "zz-sentinel-query";
  const source = new FakeSource("one", "catalog");
  const { manager } = build(() => [source], {
    discover: (_, incoming) => {
      if (incoming.query === sentinel && incoming.slotId === "slot_99999") {
        throw new SearchError("search-too-broad", 422, { catalog: 70 });
      }
      return [source];
    },
  });
  const auth = authority();
  const starting = manager.start(auth, request(sentinel));
  source.respond(page([catalogRecord("one", "Unrelated", { imdb: "tt1" })]));
  const started = await starting;
  const memberKey = started.snapshot.clusters[0]!.primaryMemberKey;
  assert.equal(JSON.stringify(started.snapshot).includes(sentinel), false);
  assert.equal(JSON.stringify(manager.members(auth, started.id, memberKey, 0)).includes(sentinel), false);
  try {
    await manager.start(auth, request(sentinel, 1, "slot_99999"));
    assert.fail("expected too broad");
  } catch (error) {
    assert.equal(JSON.stringify(error).includes(sentinel), false);
    assert.equal((error as Error).message.includes(sentinel), false);
  }
  manager.close();
});

test("close leaves queued and active scheduler work empty", async () => {
  const sources = Array.from({ length: 20 }, (_, index) => new FakeSource(`source-${index}`, "catalog"));
  const { manager, scheduler, timers } = build(() => sources, {
    schedulerLimits: { jobsServerWide: 4 },
  });
  const starting = manager.start(authority(), request());
  timers.tick(300);
  await starting;
  assert.ok(scheduler.stats().active > 0);
  manager.close();
  await flush();
  assert.deepEqual(scheduler.stats(), { active: 0, queued: 0 });
});

test("an IMDb title and a TMDB-only title meet by name with or without a local mapping", async () => {
  const matrix = (itemKey: string, ids: RawSearchRecord["ids"], id: string): RawSearchRecord => ({
    itemKey, kind: "movie", title: "Matrix", year: 1999, ids,
    locator: { kind: "catalog", addonKey: itemKey, type: "movie", id },
  });
  const run = async (knownIds?: (ids: { imdb?: string }) => { tmdb?: string }) => {
    const catalog = new FakeSource("catalog", "catalog");
    const { manager } = build(() => [catalog], knownIds === undefined ? {} : { knownIds });
    const starting = manager.start(authority(), request("matrix"));
    catalog.respond(page([matrix("cinemeta", { imdb: "tt0133093" }, "tt0133093"), matrix("czdabing", { tmdb: "603" }, "tmdb:603")]));
    const started = await starting;
    manager.close();
    return started.snapshot.clusters.length;
  };
  assert.equal(await run(), 1);
  assert.equal(await run((ids) => (ids.imdb === "tt0133093" ? { tmdb: "603" } : {})), 1);
});

test("an id-less Matrix joins the one exact name and year match", async () => {
  const imdb = new FakeSource("imdb", "catalog");
  const other = new FakeSource("other", "catalog");
  const { manager } = build(() => [imdb, other]);
  const starting = manager.start(authority(), request("matrix"));
  imdb.respond(page([
    catalogRecord("imdb-1999", "Matrix", { imdb: "tt0133093" }, { year: 1999 }),
  ]));
  other.respond(page([
    catalogRecord("idless-1999", "Matrix", {}, { year: 1999, opaque: "sosac:matrix:1999" }),
    catalogRecord("tmdb-1998", "Matrix", { tmdb: "12345" }, { year: 1998 }),
  ]));
  const started = await starting;
  assert.equal(started.snapshot.clusters.length, 2);
  assert.equal(started.snapshot.clusters.find((cluster) => cluster.year === 1999)?.memberCount, 2);
  assert.deepEqual(started.snapshot.unidentified, []);
  manager.close();
});

test("tenkrát v ranks the broadly listed title first and ignores opaque ratings", async () => {
  const names = [
    "cinemeta", "czdabing", "hbo", "netflix", "search", "sosac",
  ];
  const sources = names.map((name) => new FakeSource(name, "catalog", name));
  const { manager } = build(() => sources);
  const starting = manager.start(authority(), request("tenkrát v"));
  const byName = (name: string) => sources.find((source) => source.id === name)!;
  byName("cinemeta").respond(page([
    catalogRecord("cinemeta:hollywood", "Tenkrát v Hollywoodu", { imdb: "tt7131622" }, { year: 2019, rating: 7.6 }),
  ]));
  byName("czdabing").respond(page([
    catalogRecord("czdabing:hollywood", "Tenkrát v Hollywoodu", { imdb: "tt7131622" }, { year: 2019 }),
  ]));
  byName("hbo").respond(page([
    catalogRecord("hbo:hollywood", "Tenkrát v Hollywoodu", { imdb: "tt7131622" }, { year: 2019 }),
  ]));
  byName("netflix").respond(page([
    catalogRecord("netflix:hollywood", "Tenkrát v Hollywoodu", { imdb: "tt7131622" }, { year: 2019 }),
  ]));
  byName("search").respond(page([
    catalogRecord("search:hollywood", "Tenkrát v Hollywoodu", { tmdb: "466272" }, { year: 2019 }),
    catalogRecord("search:americe", "Tenkrát v Americe", { tmdb: "311" }, { year: 1984 }),
    catalogRecord("search:kalifornii", "Tenkrát v Kalifornii", { tmdb: "345915" }, { year: 2017 }),
    catalogRecord("search:cine", "Tenkrát v Číně", { tmdb: "10617" }, { year: 1991 }),
  ]));
  byName("sosac").respond(page([
    catalogRecord("sosac:hollywood", "Tenkrát v Hollywoodu", {}, {
      opaque: "sosac:hollywood", year: 2019, rating: 6,
    }),
    catalogRecord("sosac:americe", "Tenkrát v Americe", {}, {
      opaque: "sosac:americe", year: 1984, rating: 10,
    }),
    catalogRecord("sosac:kalifornii", "Tenkrát v Kalifornii", {}, {
      opaque: "sosac:kalifornii", year: 2017, rating: 8,
    }),
    catalogRecord("sosac:cine", "Tenkrát v Číně", {}, {
      opaque: "sosac:cine", year: 1991, rating: 2,
    }),
    catalogRecord("sosac:baskicku", "Tenkrát v Baskicku", {}, {
      opaque: "sosac:baskicku", year: 2021,
    }),
    catalogRecord("sosac:deadwoodu", "Tenkrát v Deadwoodu", {}, {
      opaque: "sosac:deadwoodu", year: 2019,
    }),
  ]));

  const started = await starting;
  assert.deepEqual(started.snapshot.clusters.map((cluster) => cluster.title), [
    "Tenkrát v Hollywoodu",
    "Tenkrát v Americe",
    "Tenkrát v Kalifornii",
    "Tenkrát v Číně",
    "Tenkrát v Baskicku",
    "Tenkrát v Deadwoodu",
  ]);
  const hollywood = started.snapshot.clusters[0]!;
  assert.equal(hollywood.memberCount, 6);
  assert.equal(hollywood.rating, 7.6);
  assert.equal(started.snapshot.clusters[1]!.rating, undefined);
  manager.close();
});

test("pán prstenů puts a broadly listed trilogy film before the exact single-source title", async () => {
  const catalogs = Array.from({ length: 6 }, (_, index) =>
    new FakeSource(`catalog-${index}`, "catalog", `catalog-${index}`));
  const sosac = new FakeSource("sosac", "catalog", "sosac");
  const { manager } = build(() => [...catalogs, sosac]);
  const starting = manager.start(authority(), request("pán prstenů"));
  for (const [index, source] of catalogs.entries()) {
    source.respond(page([
      catalogRecord(`fellowship-${index}`, "Pán prstenů: Společenstvo prstenu", { imdb: "tt0120737" }, {
        year: 2001,
        rating: 8.9,
      }),
    ]));
  }
  sosac.respond(page([
    catalogRecord("original", "Pán prstenů", {}, {
      opaque: "sosac:original", year: 1978, rating: 10,
    }),
  ]));

  const started = await starting;
  assert.deepEqual(started.snapshot.clusters.map((cluster) => cluster.title), [
    "Pán prstenů: Společenstvo prstenu",
    "Pán prstenů",
  ]);
  assert.equal(started.snapshot.clusters[1]!.rating, undefined);
  manager.close();
});

test("among widely listed titles the exact name comes before a sequel on more catalogs", async () => {
  const catalogs = Array.from({ length: 5 }, (_, index) =>
    new FakeSource(`catalog-${index}`, "catalog", `catalog-${index}`));
  const { manager } = build(() => catalogs);
  const starting = manager.start(authority(), request("terminator"));
  for (const [index, source] of catalogs.entries()) {
    source.respond(page([
      catalogRecord(`dark-${index}`, "Terminator: Dark Fate", { imdb: "tt6450804" }, { year: 2019 }),
      ...(index < 3 ? [catalogRecord(`first-${index}`, "Terminator", { imdb: "tt0088247" }, { year: 1984 })] : []),
    ]));
  }
  const started = await starting;
  assert.deepEqual(started.snapshot.clusters.map((cluster) => cluster.title), ["Terminator", "Terminator: Dark Fate"]);
  manager.close();
});

test("a typo-free word match beats a typo match listed by more catalogs", async () => {
  const exact = new FakeSource("exact", "catalog", "exact");
  const typo = Array.from({ length: 4 }, (_, index) =>
    new FakeSource(`typo-${index}`, "catalog", `typo-${index}`));
  const { manager } = build(() => [exact, ...typo]);
  const starting = manager.start(authority(), request("simpsonovi"));
  exact.respond(page([catalogRecord("exact:one", "Simpsonovi", { imdb: "tt1" })]));
  for (const [index, source] of typo.entries()) {
    source.respond(page([
      catalogRecord(`typo:${index}`, "Simpsnovi", { imdb: "tt2" }),
    ]));
  }

  const started = await starting;
  assert.deepEqual(started.snapshot.clusters.map((cluster) => cluster.title), [
    "Simpsonovi",
    "Simpsnovi",
  ]);
  manager.close();
});

test("a folder whose own name answers the query stands with the titles", async () => {
  const remote = new FakeSource("remote", "remote");
  const catalog = new FakeSource("catalog", "catalog");
  const { manager } = build(() => [remote, catalog]);
  const auth = authority();
  const starting = manager.start(auth, request("girlsdoporn"));
  remote.respond(page([
    {
      itemKey: "folder-1",
      kind: "folder",
      title: "GirlsDoPorn",
      itemCount: 818,
      locator: { kind: "remote", libraryId: "lib", itemId: "folder-1", itemType: "folder" },
    },
    {
      itemKey: "file-1",
      kind: "file",
      title: "818",
      searchText: { parentTitle: "GirlsDoPorn" },
      locator: { kind: "remote", libraryId: "lib", itemId: "file-1", itemType: "file" },
    },
  ]));
  catalog.respond(page([
    catalogRecord("cinemeta", "Nice Girls Don't Get the Corner Office", { imdb: "tt2" }),
  ]));
  const started = await starting;
  assert.equal(started.snapshot.clusters[0]?.title, "GirlsDoPorn");
  assert.equal(started.snapshot.clusters[0]?.itemCount, 818);
  assert.equal(started.snapshot.clusters[1]?.title, "Nice Girls Don't Get the Corner Office");
  assert.deepEqual(started.snapshot.unidentified.map((cluster) => cluster.title), ["818"]);
  manager.close();
});

test("a file joins the cards only when no title answers the query", async () => {
  const run = async (query: string, withTitle: boolean) => {
    const remote = new FakeSource("remote", "remote");
    const catalog = new FakeSource("catalog", "catalog");
    const { manager } = build(() => [remote, catalog]);
    const starting = manager.start(authority(), request(query));
    remote.respond(page([
      {
        itemKey: "file-1",
        kind: "file",
        title: "Vratne.Lahve.avi",
        locator: { kind: "remote", libraryId: "lib", itemId: "file-1", itemType: "file" },
      },
      {
        itemKey: "file-2",
        kind: "file",
        title: "2020-01-03-marcus-mora-mia-thomas",
        locator: { kind: "remote", libraryId: "lib", itemId: "file-2", itemType: "file" },
      },
    ]));
    catalog.respond(page(withTitle ? [catalogRecord("cinemeta", "Vratné lahve", { imdb: "tt0828154" })] : []));
    const started = await starting;
    manager.close();
    return {
      clusters: started.snapshot.clusters.map((cluster) => cluster.title),
      unidentified: started.snapshot.unidentified.map((cluster) => cluster.title),
    };
  };
  assert.deepEqual(await run("vratne lahve", true), { clusters: ["Vratné lahve"], unidentified: ["Vratne.Lahve.avi"] });
  assert.deepEqual(await run("marcus mora mia thomas", false), { clusters: ["2020-01-03-marcus-mora-mia-thomas"], unidentified: [] });
});

test("a folder that answers only part of the query stays unidentified", async () => {
  const remote = new FakeSource("remote", "remote");
  const { manager } = build(() => [remote]);
  const starting = manager.start(authority(), request("girls do porn"));
  remote.respond(page([{
    itemKey: "folder-1",
    kind: "folder",
    title: "Girls Do",
    locator: { kind: "remote", libraryId: "lib", itemId: "folder-1", itemType: "folder" },
  }]));
  const started = await starting;
  assert.deepEqual(started.snapshot.clusters, []);
  assert.deepEqual(started.snapshot.unidentified.map((cluster) => cluster.title), ["Girls Do"]);
  manager.close();
});

