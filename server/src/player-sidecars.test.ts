import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PlayerSidecars, SIDECAR_AHEAD_S, SIDECAR_LEAD_S, SIDECAR_RETRY_MS } from "./player-sidecars.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const cue = (from: number, to: number, text: string) => {
  const stamp = (v: number) => `${String(Math.floor(v / 3600)).padStart(2, "0")}:${String(Math.floor((v % 3600) / 60)).padStart(2, "0")}:${(v % 60).toFixed(3).padStart(6, "0")}`;
  return `${stamp(from)} --> ${stamp(to)}\n${text}`;
};

test("a seek past everything the reader has written starts one at the new position", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-ahead-"));
  const starts: number[] = [];
  const sidecars = new PlayerSidecars(async (args, file, _append, signal) => {
    starts.push(Number(args[args.indexOf("-ss") + 1] ?? 0));
    await writeFile(file, `WEBVTT\n\n${cue(3100, 3400, "line")}\n\n`);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  try {
    const args = async (start: number) => (start > 0 ? ["-ss", start.toFixed(3)] : []);
    sidecars.ensure("session", directory, 2, 3000, args);
    const revision = sidecars.revision("session");
    while (!(await sidecars.read("session", revision, 3000))) await tick();
    // Still inside what the reader has found, so it keeps going.
    sidecars.ensure("session", directory, 2, 3200, args);
    assert.equal(sidecars.revision("session"), revision);
    // An hour further on it would have to read the whole film to get there.
    sidecars.ensure("session", directory, 2, 6600, args);
    assert.notEqual(sidecars.revision("session"), revision);
    while (starts.length < 2) await tick();
    assert.deepEqual(starts, [3000, 6600]);
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

test("seeking forward keeps the reader that is already writing those cues", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-forward-"));
  const starts: number[] = [];
  const sidecars = new PlayerSidecars(async (args, file, _append) => {
    starts.push(Number(args[args.indexOf("-ss") + 1] ?? 0));
    await writeFile(file, `WEBVTT\n\n${cue(3300, 5200, "line")}\n\n`);
  });
  try {
    const args = async (start: number) => (start > 0 ? ["-ss", start.toFixed(3)] : []);
    sidecars.ensure("session", directory, 2, 3000, args);
    const revision = sidecars.revision("session");
    while (!(await sidecars.read("session", revision, 3000))) await tick();
    sidecars.ensure("session", directory, 2, 3200, args);
    sidecars.ensure("session", directory, 2, 5000, args);
    assert.equal(sidecars.revision("session"), revision);
    assert.deepEqual(starts, [3000]);
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

test("a reader that replaces another is started once, not once per caller", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-once-"));
  const starts: number[] = [];
  const open = new Set<string>();
  let overlapped = false;
  const sidecars = new PlayerSidecars(async (args, file, _append, signal) => {
    if (open.has(file)) overlapped = true;
    open.add(file);
    starts.push(Number(args[args.indexOf("-ss") + 1] ?? 0));
    await writeFile(file, `WEBVTT\n\n${cue(3000, 3100, "line")}\n\n`);
    try { await new Promise<void>((resolve) => signal.addEventListener("abort", () => setTimeout(resolve, 20), { once: true })); }
    finally { open.delete(file); }
  });
  try {
    const args = async (start: number) => (start > 0 ? ["-ss", start.toFixed(3)] : []);
    sidecars.ensure("session", directory, 2, 100, args);
    // A seek away from where the first reader began replaces it, and the replacement waits
    // for the old FFmpeg to let go of the source before it starts.
    sidecars.ensure("session", directory, 2, 500, args);
    // The player asks for the position it has just moved to while that wait is still on.
    sidecars.ensure("session", directory, 2, 500, args);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(starts.filter((start) => start === 500).length, 1, "the new position is read once");
    assert.equal(overlapped, false, "two readers never write the same file");
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

test("a jump back before the reader's start, or another track, begins a new one", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-back-"));
  const starts: number[] = [];
  const sidecars = new PlayerSidecars(async (args, file, _append) => {
    starts.push(Number(args[args.indexOf("-ss") + 1] ?? 0));
    await writeFile(file, `WEBVTT\n\n${cue(120, 125, "line")}\n\n`);
  });
  try {
    const args = async (start: number) => (start > 0 ? ["-ss", start.toFixed(3)] : []);
    sidecars.ensure("session", directory, 2, 3000, args);
    const first = sidecars.revision("session");
    while (starts.length < 1) await tick();
    sidecars.ensure("session", directory, 2, 100, args);
    const second = sidecars.revision("session");
    assert.notEqual(second, first);
    while (starts.length < 2) await tick();
    sidecars.ensure("session", directory, 3, 100, args);
    assert.notEqual(sidecars.revision("session"), second);
    while (!(await sidecars.read("session", sidecars.revision("session"), 100))) await tick();
    assert.deepEqual(starts, [3000, 100, 100], "each reader is asked for the position it was started at");
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

// The reader is held open on purpose, twice: once with a cue the picture has already passed and
// once with the cue that is ahead. The test waits for the first burst to reach its gate rather
// than guessing how many ticks that takes -- under load a tick was not enough, `finish` was a
// no-op when it was called, and the reader waited on a promise nobody would ever resolve.
test("cues are held back until they reach past the playhead, then shifted to it", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-lead-"));
  let finish = () => {};
  let burstWritten = () => {};
  const atRest = new Promise<void>((resolve) => { burstWritten = resolve; });
  const sidecars = new PlayerSidecars(async (_args, file, _append, signal) => {
    // Only a cue that is already over: nothing the picture has not passed.
    await writeFile(file, `WEBVTT\n\n${cue(2990, 2996, "just said")}\n\n`);
    await new Promise<void>((resolve) => {
      finish = resolve;
      signal.addEventListener("abort", () => resolve(), { once: true });
      burstWritten();
    });
    await writeFile(file, `WEBVTT\n\n${cue(2990, 2996, "just said")}\n\n${cue(3000 + SIDECAR_LEAD_S + 5, 3000 + SIDECAR_LEAD_S + 9, "ahead")}\n\n`);
  });
  try {
    sidecars.ensure("session", directory, 0, 3000, async () => []);
    const revision = sidecars.revision("session");
    await atRest;
    assert.equal(await sidecars.read("session", revision, 3000), undefined, "a cue the picture has already passed is nothing to attach");
    finish();
    // The cues can be readable a moment before the reader has finished with the film.
    let cues;
    while (!(cues = await sidecars.read("session", revision, 3000)) || !cues.complete) await tick();
    assert.match(cues.text, /00:00:10\.000 --> 00:00:14\.000\nahead/);
    assert.equal(await sidecars.read("session", "someone-elses-revision", 3000), undefined);
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});
test("a partly written cue is never handed to the player", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-partial-"));
  const sidecars = new PlayerSidecars(async (args, file, _append, signal) => {
    await writeFile(file, `WEBVTT\n\n${cue(3100, 3200, "complete")}\n\n00:53:30.000 --> `);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  try {
    sidecars.ensure("session", directory, 0, 3000, async () => []);
    const revision = sidecars.revision("session");
    let cues;
    while (!(cues = await sidecars.read("session", revision, 3000))) await tick();
    assert.equal(cues.complete, false);
    assert.match(cues.text, /00:01:40\.000 --> 00:03:20\.000\ncomplete/);
    assert.doesNotMatch(cues.text, /00:53:30/);
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

test("closing playback waits for the subtitle reader to stop", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-stop-"));
  let active = false;
  const sidecars = new PlayerSidecars(async (_args, _file, _append, signal) => {
    active = true;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => setTimeout(resolve, 20), { once: true }));
    active = false;
  });
  try {
    sidecars.ensure("session", directory, 0, 0, async () => []);
    while (!active) await tick();
    await sidecars.stop("session");
    assert.equal(active, false);
    assert.equal(sidecars.revision("session"), undefined);
    assert.equal(await sidecars.read("session", undefined, 0), undefined);
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

test("the default extractor waits for the actual child exit after cancellation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-process-"));
  const originalPath = process.env.PATH;
  const sidecars = new PlayerSidecars();
  try {
    const executable = path.join(directory, "ffmpeg");
    await writeFile(executable, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.PID_MARKER, String(process.pid));\nprocess.stdout.write("WEBVTT\\n\\n");\nsetInterval(() => {}, 1000);\n');
    await chmod(executable, 0o755);
    process.env.PATH = `${directory}${path.delimiter}${originalPath}`;
    const marker = path.join(directory, "reader.pid");
    process.env.PID_MARKER = marker;
    sidecars.ensure("session", directory, 0, 0, async () => []);
    let pid = 0;
    while (!pid) { pid = Number(await readFile(marker, "utf8").catch(() => "0")); await tick(); }
    // FFmpeg keeps a file it writes itself buffered until it exits, so the cues come
    // through its stdout: whatever it has written must be readable while it still runs.
    const file = path.join(directory, `sidecar-${sidecars.revision("session")}.vtt`);
    let written = "";
    while (!written) { written = await readFile(file, "utf8").catch(() => ""); await tick(); }
    assert.match(written, /WEBVTT/);
    await sidecars.stop("session");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await sidecars.stop("session");
    process.env.PATH = originalPath;
    delete process.env.PID_MARKER;
    await rm(directory, { recursive: true, force: true });
  }
});

test("the reader lets go of the source once it is far enough ahead, and picks it up again", { timeout: 5000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-bursts-"));
  const runs: { from: number; append: boolean }[] = [];
  let running = false;
  const sidecars = new PlayerSidecars(async (args, file, append, signal) => {
    runs.push({ from: Number(args[args.indexOf("-ss") + 1] ?? 0), append });
    running = true;
    const reach = 100 + SIDECAR_AHEAD_S + runs.length * 50;
    await writeFile(file, `WEBVTT\n\n${cue(reach - 5, reach, `line ${runs.length}`)}\n\n`, append ? { flag: "a" } : {});
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    running = false;
  });
  try {
    sidecars.ensure("session", directory, 0, 100, async (start) => ["-ss", start.toFixed(3)]);
    const revision = sidecars.revision("session");
    // Reading past the playhead by more than the lead, so the reader is released.
    while (!(await sidecars.read("session", revision, 100))) await tick();
    while (running) await tick();
    assert.equal(runs.length, 1, "one burst was enough to get ahead of the picture");

    // The picture catches up with the cues, so the reader is asked for more, from where it stopped.
    const later = 100 + SIDECAR_AHEAD_S;
    await sidecars.read("session", revision, 100, 0, later);
    while (!running) await tick();
    assert.equal(runs.length, 2);
    assert.equal(runs[1].append, true, "the cues found so far are kept");
    assert.ok(runs[1].from > 100, "reading picks up where it stopped, not at the start");
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

test("a conversion that needs the source gets it: release stops the reader but keeps the cues", { timeout: 5000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-release-"));
  let running = false;
  const sidecars = new PlayerSidecars(async (_args, file, _append, signal) => {
    running = true;
    await writeFile(file, `WEBVTT\n\n${cue(300, 400, "spoken")}\n\n`);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => setTimeout(resolve, 15), { once: true }));
    running = false;
  });
  try {
    sidecars.ensure("session", directory, 0, 0, async () => []);
    while (!running) await tick();
    await sidecars.release("session");
    assert.equal(running, false, "FFmpeg is gone before the conversion opens the source");
    const cues = await sidecars.read("session", sidecars.revision("session"), 0);
    assert.match(cues!.text, /spoken/, "what it had read is still served");
    assert.equal(cues!.complete, false);
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

test("the viewer's own correction holds the cues back, or brings them forward", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-delay-"));
  const sidecars = new PlayerSidecars(async (_args, file, _append, signal) => {
    await writeFile(file, `WEBVTT\n\n${cue(3100, 3200, "spoken")}\n\n`);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  try {
    sidecars.ensure("session", directory, 0, 3000, async () => []);
    const revision = sidecars.revision("session");
    while (!(await sidecars.read("session", revision, 3000))) await tick();
    const plain = await sidecars.read("session", revision, 3000);
    assert.match(plain!.text, /00:01:40\.000 --> 00:03:20\.000/);
    // Half a second later on the picture, and a quarter of a second earlier.
    const later = await sidecars.read("session", revision, 3000, 0.5);
    assert.match(later!.text, /00:01:40\.500 --> 00:03:20\.500/);
    const earlier = await sidecars.read("session", revision, 3000, -0.25);
    assert.match(earlier!.text, /00:01:39\.750 --> 00:03:19\.750/);
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

test("a reader on a slow source hands over what it has instead of holding it back", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-slow-"));
  // What a NAS manages in the first seconds after a seek: a cue or two past the picture,
  // nowhere near the couple of minutes a fast link produces.
  const sidecars = new PlayerSidecars(async (_args, file, _append, signal) => {
    await writeFile(file, `WEBVTT\n\n${cue(1402, 1408, "first words")}\n\n`);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  try {
    sidecars.ensure("session", directory, 1, 1401, async () => []);
    const revision = sidecars.revision("session");
    let cues;
    while (!(cues = await sidecars.read("session", revision, 1401))) await tick();
    assert.match(cues.text, /00:00:01\.000 --> 00:00:07\.000\nfirst words/);
    assert.equal(Math.round(cues.coverage), 1408);
    assert.ok(SIDECAR_LEAD_S < 10, "the wait before the first cues is seconds, not minutes");
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

test("a read that lands after the session closed does not leave a reader behind", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-orphan-"));
  let started = 0;
  const sidecars = new PlayerSidecars(async (_args, file, _append, signal) => {
    started += 1;
    await writeFile(file, `WEBVTT\n\n${cue(10, 20, "line")}\n\n`);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  try {
    sidecars.ensure("session", directory, 0, 0, async () => []);
    while (!started) await tick();
    const closing = sidecars.stop("session");
    // The player's poll was already in flight when the viewer closed the film.
    await sidecars.read("session", undefined, 0);
    await closing;
    await tick();
    assert.equal(started, 1, "no second FFmpeg was started for a session that is gone");
    assert.equal(sidecars.revision("session"), undefined);
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

test("a reader that the source refused waits before asking for another connection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-backoff-"));
  let attempts = 0;
  const sidecars = new PlayerSidecars(async () => { attempts += 1; throw new Error("ffmpeg exited with 8"); }, () => {});
  try {
    sidecars.ensure("session", directory, 0, 100, async () => []);
    while (!attempts) await tick();
    // The player keeps asking for its cues; the reader must not answer that with a connection a second.
    for (let poll = 0; poll < 20; poll++) { await sidecars.read("session", sidecars.revision("session"), 100); await tick(); }
    assert.equal(attempts, 1, "one refusal, one attempt -- the source is left alone until the wait is over");
    assert.ok(SIDECAR_RETRY_MS >= 1000, "the wait is seconds, not milliseconds");
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

test("asking for the same position again keeps the reader that is already on it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-same-"));
  const starts: number[] = [];
  const sidecars = new PlayerSidecars(async (args, _file, _append, signal) => {
    starts.push(Number(args[args.indexOf("-ss") + 1] ?? 0));
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  try {
    const args = async (start: number) => ["-ss", start.toFixed(3)];
    sidecars.ensure("session", directory, 1, 933, args);
    const revision = sidecars.revision("session");
    while (!starts.length) await tick();
    // What a restart and the track switch behind it do: ask again while the first cue is still missing.
    sidecars.ensure("session", directory, 1, 933, args);
    sidecars.ensure("session", directory, 1, 933, args);
    await tick();
    assert.deepEqual(starts, [933], "the reader that is already reading that position is left to work");
    sidecars.ensure("session", directory, 1, 933.4, args);
    await tick();
    assert.deepEqual(starts, [933], "and a hair of difference in the position is the same position");
    assert.equal(sidecars.revision("session"), revision, "and the player keeps the address it is polling");
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

test("subtitle polls cannot reopen the source while repeated seeks hold it released", { timeout: 5000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-seek-polls-"));
  let starts = 0;
  let running = 0;
  const sidecars = new PlayerSidecars(async (_args, file, _append, signal) => {
    starts++;
    await writeFile(file, `WEBVTT\n\n${cue(10, 20, "spoken")}\n\n`);
    running++;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    running--;
  });
  try {
    sidecars.ensure("session", directory, 0, 0, async () => []);
    while (!running) await tick();
    const revision = sidecars.revision("session");
    for (let seek = 0; seek < 4; seek++) {
      await sidecars.release("session");
      const before = starts;
      for (let poll = 0; poll < 4; poll++) {
        const result = await sidecars.read("session", revision, 0, 0.5, 19);
        assert.match(result!.text, /00:00:10.500 --> 00:00:20.500/);
        await tick();
      }
      assert.equal(starts, before, "polling existing cues must not compete with the new video connection");
      assert.equal(running, 0);
      sidecars.ensure("session", directory, 0, 0, async () => []);
      while (!running) await tick();
      assert.equal(starts, before + 1, "reading resumes only when the conversion releases the source");
      assert.equal(sidecars.revision("session"), revision);
    }
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});
