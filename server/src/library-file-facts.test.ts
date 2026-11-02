import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createLibraryFileFacts, localCopySummary, type LibraryFileStamp } from "./library-file-facts.js";
import type { MediaInfo } from "./probe.js";

const temp = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const dir = await mkdtemp(path.join(tmpdir(), "file-facts-"));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
};

const info = (height = 1080): MediaInfo => ({
  container: "matroska,webm",
  duration: 1320,
  video: { codec: "hevc", width: 1920, height },
  audio: { codec: "eac3", channels: 6 },
  audioTracks: [
    { index: 0, codec: "eac3", language: "cs", channels: 6 },
    { index: 1, codec: "aac", language: "en", channels: 2 },
  ],
  subtitleTracks: [{ index: 0, codec: "subrip", language: "cs" }],
  variant: { video: 0, audio: 1 },
});

const stamp = (key: string, overrides: Partial<LibraryFileStamp> = {}): LibraryFileStamp =>
  ({ key, size: 100, modified: "2026-01-01T00:00:00.000Z", ...overrides });

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

test("a file is read once and answered from memory after that", async () => {
  const asked: string[] = [];
  const facts = createLibraryFileFacts({ probe: async (key) => { asked.push(key); return info(); } });
  const first = await facts.read([stamp("lib_1/a.mkv")]);
  const second = await facts.read([stamp("lib_1/a.mkv")]);
  assert.equal(first.get("lib_1/a.mkv")?.video?.height, 1080);
  assert.equal(second.get("lib_1/a.mkv")?.video?.height, 1080);
  assert.deepEqual(asked, ["lib_1/a.mkv"]);
  assert.equal(second.get("lib_1/a.mkv")?.variant, undefined, "a conversion's variant indexes are not kept");
});

test("a file that changed size or time is read again", async () => {
  let height = 720;
  let reads = 0;
  const facts = createLibraryFileFacts({ probe: async () => { reads += 1; return info(height); } });
  await facts.read([stamp("lib_1/a.mkv")]);
  height = 2160;
  assert.equal((await facts.read([stamp("lib_1/a.mkv", { size: 200 })])).get("lib_1/a.mkv")?.video?.height, 2160);
  assert.equal((await facts.read([stamp("lib_1/a.mkv", { size: 200, modified: "2026-02-01T00:00:00.000Z" })])).size, 1);
  assert.equal(reads, 3);
});

test("readings survive a restart through the data file", async (t) => {
  const file = path.join(await temp(t), "library", "file-facts.json");
  const first = createLibraryFileFacts({ file, probe: async () => info(), saveDelayMs: 0 });
  await first.read([stamp("lib_1/a.mkv")]);
  await first.flush();

  let reads = 0;
  const second = createLibraryFileFacts({ file, probe: async () => { reads += 1; return info(); } });
  assert.equal((await second.read([stamp("lib_1/a.mkv")])).get("lib_1/a.mkv")?.audioTracks.length, 2);
  assert.equal(reads, 0);
});

test("an unchanged reading does not rewrite the JSON file", async (t) => {
  const file = path.join(await temp(t), "library", "file-facts.json");
  let reads = 0;
  const facts = createLibraryFileFacts({
    file,
    probe: async () => { reads += 1; return info(); },
    saveDelayMs: 60_000,
  });
  await facts.read([stamp("lib_1/a.mkv")]);
  await facts.flush();
  await writeFile(file, "sentinel");

  await facts.read([stamp("lib_1/a.mkv")]);
  await facts.flush();

  assert.equal(reads, 1);
  assert.equal(await readFile(file, "utf8"), "sentinel");
});

test("a file ffprobe cannot read is not asked again until a day has passed", async () => {
  let clock = 0;
  let reads = 0;
  const facts = createLibraryFileFacts({ now: () => clock, probe: async () => { reads += 1; return undefined; } });
  assert.equal((await facts.read([stamp("lib_1/broken.mkv")])).size, 0);
  await facts.read([stamp("lib_1/broken.mkv")]);
  assert.equal(reads, 1);
  clock = 25 * 60 * 60 * 1000;
  await facts.read([stamp("lib_1/broken.mkv")]);
  assert.equal(reads, 2);
});

test("a probe that throws is asked again next time", async () => {
  let reads = 0;
  const facts = createLibraryFileFacts({ probe: async () => { reads += 1; throw new Error("library gone"); } });
  await facts.read([stamp("lib_1/a.mkv")]);
  await facts.read([stamp("lib_1/a.mkv")]);
  assert.equal(reads, 2);
});

test("a slow read does not hold the answer and lands for the next one", async () => {
  const gate = deferred<MediaInfo>();
  let reads = 0;
  const facts = createLibraryFileFacts({ probe: () => { reads += 1; return gate.promise; } });
  assert.equal((await facts.read([stamp("lib_1/a.mkv")], { waitMs: 10 })).size, 0);
  // The listing asked again while the first read still runs: it joins it.
  assert.equal((await facts.read([stamp("lib_1/a.mkv")], { waitMs: 10 })).size, 0);
  gate.resolve(info());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await facts.read([stamp("lib_1/a.mkv")], { waitMs: 10 })).size, 1);
  assert.equal(reads, 1);
});

test("only a few files are read at once", async () => {
  const gates = new Map<string, ReturnType<typeof deferred<MediaInfo>>>();
  let active = 0;
  let peak = 0;
  const facts = createLibraryFileFacts({
    concurrency: 2,
    probe: async (key) => {
      active += 1;
      peak = Math.max(peak, active);
      const gate = deferred<MediaInfo>();
      gates.set(key, gate);
      try { return await gate.promise; } finally { active -= 1; }
    },
  });
  const files = ["a", "b", "c", "d"].map((name) => stamp(`lib_1/${name}.mkv`));
  const reading = facts.read(files, { waitMs: 1000 });
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    for (const [key, gate] of gates) { gates.delete(key); gate.resolve(info()); }
  }
  assert.equal((await reading).size, 4);
  assert.equal(peak, 2);
});

test("the oldest readings make room once the limit is reached", async () => {
  let reads = 0;
  const facts = createLibraryFileFacts({ maxEntries: 2, probe: async () => { reads += 1; return info(); } });
  await facts.read([stamp("lib_1/a.mkv")]);
  await facts.read([stamp("lib_1/b.mkv")]);
  await facts.read([stamp("lib_1/c.mkv")]);
  await facts.read([stamp("lib_1/c.mkv"), stamp("lib_1/b.mkv")]);
  assert.equal(reads, 3);
  await facts.read([stamp("lib_1/a.mkv")]);
  assert.equal(reads, 4);
});

test("the row summary names the languages in the file and its main sound", () => {
  assert.deepEqual(localCopySummary(info(), ["en", undefined, "cs"]), {
    audioLanguages: ["cs", "en"],
    subtitleLanguages: ["cs", "en"],
    audioFacts: { codec: "eac3", channels: 6 },
  });
  const bare: MediaInfo = { container: "mp4", audio: { codec: "pcm_s16le" }, audioTracks: [{ index: 0, codec: "pcm_s16le" }], subtitleTracks: [] };
  assert.deepEqual(localCopySummary(bare, []), { audioLanguages: [], subtitleLanguages: [] });
});
