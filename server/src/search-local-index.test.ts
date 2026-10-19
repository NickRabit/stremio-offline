import assert from "node:assert/strict";
import { test } from "node:test";
import type { LibraryEntry } from "./library.js";
import { LocalSearchIndex } from "./search-local-index.js";
import { SourceFailure } from "./search-session.js";

class ManualTimers {
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; callback: () => void }>();
  now = 0;

  setTimeout = (callback: () => void, milliseconds: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + milliseconds, callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };

  tick(milliseconds: number): void {
    const target = this.now + milliseconds;
    for (;;) {
      let next: { id: number; at: number; callback: () => void } | undefined;
      for (const [id, task] of this.tasks) {
        if (task.at <= target && (next === undefined || task.at < next.at || (task.at === next.at && id < next.id))) {
          next = { id, ...task };
        }
      }
      if (next === undefined) break;
      this.now = next.at;
      this.tasks.delete(next.id);
      next.callback();
    }
    this.now = target;
  }
}

const defer = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const until = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await flush();
  }
};

const entry = (
  key: string,
  title: string,
  over: Partial<LibraryEntry> = {},
): LibraryEntry => {
  const relative = key.split("/").slice(1).join("/");
  return {
    key,
    kind: "movie",
    title,
    files: [{ path: relative, label: title, season: null, episode: null, size: 1, modified: "2026-01-01T00:00:00.000Z" }],
    size: 1,
    modified: "2026-01-01T00:00:00.000Z",
    ...over,
  };
};

const movie = (key: string, title: string, id = "tt1"): LibraryEntry => entry(key, title, {
  meta: { type: "movie", id, name: title },
});

const series = (key: string, title: string, id = "tt2"): LibraryEntry => entry(key, title, {
  kind: "series",
  meta: { type: "series", id, name: title },
});

test("a cold index is not ready and a finished build publishes a generation", async () => {
  const source = defer<LibraryEntry[]>();
  const index = new LocalSearchIndex({ entries: () => source.promise });
  assert.deepEqual(index.state(), { generation: 0, ready: false, stale: false, building: false, failed: false });
  let ready = 0;
  index.onReady(() => { ready += 1; });

  index.start();
  assert.equal(index.state().building, true);
  assert.equal(index.state().ready, false);
  source.resolve([movie("lib_00000001/Alien", "Alien")]);
  await flush();

  assert.deepEqual(index.state(), { generation: 1, ready: true, stale: false, building: false, failed: false });
  assert.equal(ready, 1);
  const found = await index.search("lib_00000001", "alien", "all");
  assert.equal(found.generation, 1);
  assert.deepEqual(found.entries.map((item) => item.key), ["lib_00000001/Alien"]);
});

test("markDirty marks the published generation stale until the debounced rebuild lands", async () => {
  const timers = new ManualTimers();
  let calls = 0;
  const index = new LocalSearchIndex({
    entries: async () => {
      calls += 1;
      return [movie(`lib_00000001/Title ${calls}`, `Title ${calls}`, `tt${calls}`)];
    },
    timers,
    debounceMs: 2_000,
  });
  index.start();
  await until(() => index.state().ready);
  assert.equal(calls, 1);

  index.markDirty();
  assert.equal(index.state().stale, true);
  assert.equal(index.state().generation, 1);
  assert.equal(calls, 1, "a dirty mark alone starts no build");
  timers.tick(2_000);
  await until(() => index.state().generation === 2);
  assert.equal(calls, 2);
  assert.equal(index.state().stale, false);
});

test("a build invalidated while it runs is discarded and rerun once", async () => {
  const timers = new ManualTimers();
  const first = defer<LibraryEntry[]>();
  const second = defer<LibraryEntry[]>();
  let calls = 0;
  const index = new LocalSearchIndex({
    entries: () => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    },
    timers,
    debounceMs: 2_000,
  });
  index.start();
  index.markDirty();
  first.resolve([movie("lib_00000001/First", "First", "tt1")]);
  await flush();
  assert.equal(index.state().generation, 0);
  assert.equal(index.state().ready, false);
  assert.equal(index.state().stale, true);

  timers.tick(2_000);
  await flush();
  assert.equal(calls, 2);
  second.resolve([movie("lib_00000001/Second", "Second", "tt2")]);
  await until(() => index.state().ready);
  assert.equal(index.state().generation, 1);
  const found = await index.search("lib_00000001", "second", "all");
  assert.deepEqual(found.entries.map((item) => item.key), ["lib_00000001/Second"]);
});

test("a failed rebuild keeps the previous generation and records the failure", async () => {
  const timers = new ManualTimers();
  let calls = 0;
  const index = new LocalSearchIndex({
    entries: async () => {
      calls += 1;
      if (calls === 2) throw new Error("the disk went away");
      return [movie("lib_00000001/Kept", "Kept", "tt1")];
    },
    timers,
    debounceMs: 2_000,
  });
  index.start();
  await until(() => index.state().ready);
  index.markDirty();
  timers.tick(2_000);
  await until(() => index.state().failed);
  assert.equal(index.state().generation, 1);
  assert.equal(index.state().ready, true);
  assert.equal(index.state().stale, true);
  assert.deepEqual((await index.search("lib_00000001", "kept", "all")).entries.map((item) => item.key), ["lib_00000001/Kept"]);
});

test("ranking follows relevance and then a stable key order", async () => {
  const index = new LocalSearchIndex({
    entries: async () => [
      entry("lib_00000001/Misc", "Misc"),
      entry("lib_00000001/Aliens.1979.mkv", "Misc name"),
      movie("lib_00000001/My Alien", "My Alien"),
      movie("lib_00000001/Alien Nation", "Alien Nation"),
      movie("lib_00000001/Alien", "Alien"),
    ],
  });
  index.start();
  await until(() => index.state().ready);
  const found = await index.search("lib_00000001", "alien", "all");
  assert.deepEqual(found.entries.map((item) => item.key), [
    "lib_00000001/Alien",
    "lib_00000001/Alien Nation",
    "lib_00000001/My Alien",
    "lib_00000001/Aliens.1979.mkv",
  ]);
});

test("the kind filter applies to identified entries and leaves unidentified ones visible", async () => {
  const index = new LocalSearchIndex({
    entries: async () => [
      movie("lib_00000001/Alien Movie", "Alien Movie", "tt1"),
      series("lib_00000001/Alien Series", "Alien Series", "tt2"),
      entry("lib_00000001/Alien Folder", "Alien Folder", {
        kind: "collection",
        files: [
          { path: "Alien Folder/a.mkv", label: "a", season: null, episode: null, size: 1, modified: "" },
          { path: "Alien Folder/b.mkv", label: "b", season: null, episode: null, size: 1, modified: "" },
        ],
      }),
    ],
  });
  index.start();
  await until(() => index.state().ready);
  assert.deepEqual((await index.search("lib_00000001", "alien", "movie")).entries.map((item) => item.key), [
    "lib_00000001/Alien Folder",
    "lib_00000001/Alien Movie",
  ]);
  assert.deepEqual((await index.search("lib_00000001", "alien", "series")).entries.map((item) => item.key), [
    "lib_00000001/Alien Folder",
    "lib_00000001/Alien Series",
  ]);
});

test("a folder name finds an episode file whose own name is only a marker", async () => {
  const index = new LocalSearchIndex({
    entries: async () => [
      movie("lib_00000001/Jistě pane ministře/S01E03.mkv", "S01E03"),
    ],
  });
  index.start();
  await until(() => index.state().ready);
  const found = await index.search("lib_00000001", "jistě pane ministře", "all");
  assert.deepEqual(found.entries.map((item) => item.key), [
    "lib_00000001/Jistě pane ministře/S01E03.mkv",
  ]);
});

test("byIds returns matching movie or series entries of the requested library", async () => {
  const index = new LocalSearchIndex({
    entries: async () => [
      movie("lib_00000001/Yes Minister", "Yes Minister", "tt0080306"),
      series("lib_00000002/Yes Minister", "Yes Minister", "tmdb:4549"),
      movie("lib_00000001/Other", "Other", "tmdb:4549"),
    ],
  });
  index.start();
  await until(() => index.state().ready);
  assert.deepEqual(
    index.byIds("lib_00000001", { imdb: "tt0080306", tmdb: "4549" }, "movie").map((item) => item.key),
    ["lib_00000001/Yes Minister", "lib_00000001/Other"],
  );
  assert.deepEqual(index.byIds("lib_00000002", { tmdb: "4549" }, "movie"), []);
  assert.deepEqual(
    index.byIds("lib_00000002", { tmdb: "4549" }, "series").map((item) => item.key),
    ["lib_00000002/Yes Minister"],
  );
});

test("100,000 entries search under a second and yield between chunks", async () => {
  const entries: LibraryEntry[] = [];
  for (let index = 0; index < 99_999; index += 1) {
    entries.push(entry(`lib_00000001/Show ${index}`, `Show ${index}`));
  }
  entries.push(entry("lib_00000001/Needle", "Needle"));
  const index = new LocalSearchIndex({ entries: async () => entries });
  index.start();
  await until(() => index.state().ready, 20_000);

  const order: string[] = [];
  setImmediate(() => order.push("immediate"));
  const started = performance.now();
  const found = await index.search("lib_00000001", "needle", "all");
  const elapsed = performance.now() - started;
  assert.deepEqual(found.entries.map((item) => item.key), ["lib_00000001/Needle"]);
  assert.deepEqual(order, ["immediate"], "a queued immediate ran before the scan finished");
  assert.ok(elapsed < 1_000, `search took ${elapsed.toFixed(1)} ms`);
});

test("an aborted search throws the session's cancelled failure", async () => {
  const entries: LibraryEntry[] = [];
  for (let index = 0; index < 20_000; index += 1) {
    entries.push(entry(`lib_00000001/Title ${index}`, `Title ${index}`));
  }
  const index = new LocalSearchIndex({ entries: async () => entries });
  index.start();
  await until(() => index.state().ready);
  const controller = new AbortController();
  const search = index.search("lib_00000001", "title", "all", controller.signal);
  controller.abort();
  await assert.rejects(search, (error: unknown) =>
    error instanceof SourceFailure && error.code === "cancelled",
  );
});

test("a file inside a folder answers by its own name, unless the folder already answered", async () => {
  const file = (relative: string, label: string) => ({ path: relative, label, season: null, episode: null, size: 1, modified: "2026-01-01T00:00:00.000Z" });
  const folder = entry("lib_00000001/Hledacka/Hloubka/Treti", "Treti", {
    files: [
      file("Hledacka/Hloubka/Treti/Hluboky soubor.mp4", "Hluboky soubor"),
      file("Hledacka/Hloubka/Treti/Jiny.mp4", "Jiny"),
    ],
  });
  const index = new LocalSearchIndex({ entries: async () => [folder] });
  index.start();
  await flush();

  const byFile = await index.search("lib_00000001", "hluboky", "all");
  assert.deepEqual(byFile.entries.map((item) => item.key), ["lib_00000001/Hledacka/Hloubka/Treti/Hluboky soubor.mp4"]);
  assert.equal(byFile.entries[0]!.files.length, 1);

  const byFolder = await index.search("lib_00000001", "treti", "all");
  assert.deepEqual(byFolder.entries.map((item) => item.key), ["lib_00000001/Hledacka/Hloubka/Treti"]);
});
