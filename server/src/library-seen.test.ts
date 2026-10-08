import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LibrarySeenStore } from "./library-seen.js";

const file = (relative: string, size: number, modified: string) => ({ relative, size, modified });
const seenFile = (dataDir: string) => path.join(dataDir, "library-seen.json");

async function withStore(run: (store: LibrarySeenStore, dataDir: string) => Promise<void>) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "seen-store-"));
  try {
    const store = new LibrarySeenStore(dataDir);
    await store.load();
    await run(store, dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("the first complete walk is the baseline and never reaches the row", async () => {
  await withStore(async (store) => {
    store.observe("lib_a", [file("Films/Heat.mkv", 10, "2025-12-01T00:00:00.000Z")], new Date("2026-01-01T00:00:00.000Z"));
    assert.deepEqual(store.recent(["lib_a"], 60), []);
  });
});

test("a file that arrives on a later walk is stamped", async () => {
  await withStore(async (store) => {
    store.observe("lib_a", [], new Date("2026-01-01T00:00:00.000Z"));
    store.observe("lib_a", [file("Films/New.mkv", 20, "2026-02-01T00:00:00.000Z")], new Date("2026-02-02T00:00:00.000Z"));
    assert.deepEqual(store.recent(["lib_a"], 60), [{ libraryId: "lib_a", relative: "Films/New.mkv", at: "2026-02-02T00:00:00.000Z" }]);
  });
});

test("a vanished path that reappears with the same fingerprint keeps its first-seen stamp", async () => {
  await withStore(async (store) => {
    store.observe("lib_a", [], new Date("2026-01-01T00:00:00.000Z"));
    store.observe("lib_a", [file("Films/Ep1.mkv", 100, "2026-01-05T00:00:00.000Z")], new Date("2026-02-01T00:00:00.000Z"));
    store.observe("lib_a", [file("Show/S01/Ep1.mkv", 100, "2026-01-05T00:00:00.000Z")], new Date("2026-03-01T00:00:00.000Z"));
    assert.deepEqual(store.recent(["lib_a"], 60), [{ libraryId: "lib_a", relative: "Show/S01/Ep1.mkv", at: "2026-02-01T00:00:00.000Z" }]);
  });
});

test("a moved baseline file stays out of the row", async () => {
  await withStore(async (store) => {
    store.observe("lib_a", [file("Films/Old.mkv", 100, "2025-12-01T00:00:00.000Z")], new Date("2026-01-01T00:00:00.000Z"));
    store.observe("lib_a", [file("Films/New.mkv", 100, "2025-12-01T00:00:00.000Z")], new Date("2026-02-01T00:00:00.000Z"));
    assert.deepEqual(store.recent(["lib_a"], 60), []);
  });
});

test("a fingerprint shared by two vanished paths is ambiguous, so the new file is stamped", async () => {
  await withStore(async (store) => {
    store.observe("lib_a", [], new Date("2026-01-01T00:00:00.000Z"));
    store.observe("lib_a", [
      file("A.mkv", 100, "2026-01-05T00:00:00.000Z"),
      file("B.mkv", 100, "2026-01-05T00:00:00.000Z"),
    ], new Date("2026-02-01T00:00:00.000Z"));
    store.observe("lib_a", [file("C.mkv", 100, "2026-01-05T00:00:00.000Z")], new Date("2026-03-01T00:00:00.000Z"));
    assert.deepEqual(store.recent(["lib_a"], 60), [{ libraryId: "lib_a", relative: "C.mkv", at: "2026-03-01T00:00:00.000Z" }]);
  });
});

test("a file missing from a complete walk is dropped", async () => {
  await withStore(async (store) => {
    store.observe("lib_a", [], new Date("2026-01-01T00:00:00.000Z"));
    store.observe("lib_a", [
      file("A.mkv", 1, "2026-01-05T00:00:00.000Z"),
      file("B.mkv", 2, "2026-01-05T00:00:00.000Z"),
    ], new Date("2026-02-01T00:00:00.000Z"));
    store.observe("lib_a", [file("A.mkv", 1, "2026-01-05T00:00:00.000Z")], new Date("2026-03-01T00:00:00.000Z"));
    assert.deepEqual(store.recent(["lib_a"], 60).map((entry) => entry.relative), ["A.mkv"]);
  });
});

test("add before a baseline is a no-op", async () => {
  await withStore(async (store) => {
    store.add("lib_a", "A.mkv", 7, 1234, new Date("2026-01-01T00:00:00.000Z"));
    assert.deepEqual(store.recent(["lib_a"], 60), []);
  });
});

test("add stamps one new file once the library has a baseline and never overwrites a known one", async () => {
  await withStore(async (store) => {
    store.observe("lib_a", [], new Date("2026-01-01T00:00:00.000Z"));
    store.add("lib_a", "A.mkv", 7, 1234, new Date("2026-01-02T00:00:00.000Z"));
    store.add("lib_a", "A.mkv", 9, 9999, new Date("2026-01-03T00:00:00.000Z"));
    assert.deepEqual(store.recent(["lib_a"], 60), [{ libraryId: "lib_a", relative: "A.mkv", at: "2026-01-02T00:00:00.000Z" }]);
  });
});

test("recent is newest first, ties go by path, and the limit bounds it", async () => {
  await withStore(async (store) => {
    store.observe("lib_a", [], new Date("2026-01-01T00:00:00.000Z"));
    store.observe("lib_a", [file("B.mkv", 1, "2026-01-04T00:00:00.000Z")], new Date("2026-02-01T00:00:00.000Z"));
    store.observe("lib_a", [
      file("B.mkv", 1, "2026-01-04T00:00:00.000Z"),
      file("A.mkv", 2, "2026-01-05T00:00:00.000Z"),
    ], new Date("2026-02-02T00:00:00.000Z"));
    store.observe("lib_a", [
      file("B.mkv", 1, "2026-01-04T00:00:00.000Z"),
      file("A.mkv", 2, "2026-01-05T00:00:00.000Z"),
      file("C.mkv", 3, "2026-01-06T00:00:00.000Z"),
    ], new Date("2026-02-02T00:00:00.000Z"));
    assert.deepEqual(store.recent(["lib_a"], 60).map((entry) => entry.relative), ["A.mkv", "C.mkv", "B.mkv"]);
    assert.deepEqual(store.recent(["lib_a"], 2).map((entry) => entry.relative), ["A.mkv", "C.mkv"]);
  });
});

test("forget drops one library's data and leaves the others", async () => {
  await withStore(async (store) => {
    store.observe("lib_a", [], new Date("2026-01-01T00:00:00.000Z"));
    store.observe("lib_b", [], new Date("2026-01-01T00:00:00.000Z"));
    store.observe("lib_a", [file("A.mkv", 1, "2026-01-04T00:00:00.000Z")], new Date("2026-02-01T00:00:00.000Z"));
    store.observe("lib_b", [file("B.mkv", 1, "2026-01-04T00:00:00.000Z")], new Date("2026-02-01T00:00:00.000Z"));
    await store.forget("lib_a");
    assert.deepEqual(store.recent(["lib_a", "lib_b"], 60).map((entry) => entry.relative), ["B.mkv"]);
  });
});

test("a damaged file is copied aside and the store starts empty", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "seen-store-"));
  try {
    await writeFile(seenFile(dataDir), "{ not json");
    const store = new LibrarySeenStore(dataDir);
    await store.load();
    assert.deepEqual(store.recent(["lib_a"], 60), []);
    const preserved = (await readdir(dataDir)).filter((name) => name.startsWith("library-seen.json.damaged-"));
    assert.equal(preserved.length, 1);
    assert.equal(await readFile(path.join(dataDir, preserved[0]!), "utf8"), "{ not json");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a foreign-version file is copied aside and the store starts empty", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "seen-store-"));
  try {
    await writeFile(seenFile(dataDir), JSON.stringify({ version: 2, libraries: {} }));
    const store = new LibrarySeenStore(dataDir);
    await store.load();
    assert.deepEqual(store.recent(["lib_a"], 60), []);
    assert.equal((await readdir(dataDir)).filter((name) => name.startsWith("library-seen.json.damaged-")).length, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the index round-trips through its file", async () => {
  await withStore(async (store, dataDir) => {
    store.observe("lib_a", [], new Date("2026-01-01T00:00:00.000Z"));
    store.observe("lib_a", [file("Films/New.mkv", 20, "2026-01-05T00:00:00.000Z")], new Date("2026-02-02T00:00:00.000Z"));
    await store.flush();

    const raw = JSON.parse(await readFile(seenFile(dataDir), "utf8")) as { version: number; libraries: Record<string, { baselineAt: string; files: Record<string, { at: string }> }> };
    assert.equal(raw.version, 1);
    assert.equal(raw.libraries.lib_a!.baselineAt, "2026-01-01T00:00:00.000Z");
    assert.equal(raw.libraries.lib_a!.files["Films/New.mkv"]!.at, "2026-02-02T00:00:00.000Z");

    const reloaded = new LibrarySeenStore(dataDir);
    await reloaded.load();
    assert.deepEqual(reloaded.recent(["lib_a"], 60), [{ libraryId: "lib_a", relative: "Films/New.mkv", at: "2026-02-02T00:00:00.000Z" }]);
  });
});
