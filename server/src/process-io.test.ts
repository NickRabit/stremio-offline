import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { flushLog, initLogger, readLog } from "./logger.js";
import { EventLoopDelay, ioDiagnostics, parseCgroup1Blkio, parseCgroup2IoStat, parseProcIo } from "./process-io.js";

const procIo = (write: number, read = 10) => `rchar: 999\nwchar: 888\nsyscr: 5\nsyscw: 7\nread_bytes: ${read}\nwrite_bytes: ${write}\ncancelled_write_bytes: 0\n`;

test("parseProcIo takes the block-layer bytes, not the character counts", () => {
  assert.deepEqual(parseProcIo(procIo(4096, 512)), { readBytes: 512, writeBytes: 4096 });
  assert.equal(parseProcIo("rchar: 1\n"), undefined);
});

test("parseCgroup2IoStat adds up every device", () => {
  const text = "8:0 rbytes=100 wbytes=200 rios=1 wios=2 dbytes=0 dios=0\n253:1 rbytes=5 wbytes=7 rios=1 wios=1\n";
  assert.deepEqual(parseCgroup2IoStat(text), { readBytes: 105, writeBytes: 207 });
  assert.deepEqual(parseCgroup2IoStat(""), { readBytes: 0, writeBytes: 0 }, "no disk touched yet");
  assert.equal(parseCgroup2IoStat("8:0 rios=1\n"), undefined);
});

test("parseCgroup1Blkio skips the Total line", () => {
  const text = "8:0 Read 100\n8:0 Write 200\n8:0 Sync 50\n8:0 Async 250\n8:0 Total 300\n8:16 Write 1\nTotal 301\n";
  assert.deepEqual(parseCgroup1Blkio(text), { readBytes: 100, writeBytes: 201 });
});

test("ioDiagnostics reads the process, its running children and the container", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "process-io-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proc = path.join(root, "proc");
  const cgroup = path.join(root, "cgroup");
  const entry = async (name: string, files: Record<string, string>) => {
    await mkdir(path.join(proc, name), { recursive: true });
    for (const [file, text] of Object.entries(files)) await writeFile(path.join(proc, name, file), text);
  };
  await entry("self", { io: procIo(1000) });
  // A comm with spaces and a parenthesis must not shift the parent field.
  await entry("200", { stat: "200 (ffmpeg (x) y) S 100 200 200 0", io: procIo(300) });
  await entry("201", { stat: "201 (ffmpeg) S 100 201 201 0", io: procIo(20) });
  await entry("300", { stat: "300 (other) S 1 300 300 0", io: procIo(999_999) });
  await mkdir(path.join(cgroup, "blkio"), { recursive: true });
  await writeFile(path.join(cgroup, "blkio", "blkio.throttle.io_service_bytes"), "8:0 Read 1\n8:0 Write 5000\n8:0 Total 5001\n");

  const io = await ioDiagnostics({ proc, cgroup, pid: 100 });
  assert.deepEqual(io.process, { readBytes: 10, writeBytes: 1000 });
  assert.deepEqual(io.children, { count: 2, readBytes: 20, writeBytes: 320 });
  assert.deepEqual(io.container, { readBytes: 1, writeBytes: 5000, source: "cgroup1" });

  // A throttle file of zeros falls through to the other v1 file.
  await writeFile(path.join(cgroup, "blkio", "blkio.throttle.io_service_bytes"), "8:0 Read 0\n8:0 Write 0\nTotal 0\n");
  await writeFile(path.join(cgroup, "blkio", "blkio.io_service_bytes"), "8:0 Read 3\n8:0 Write 40\n");
  assert.deepEqual((await ioDiagnostics({ proc, cgroup, pid: 100 })).container, { readBytes: 3, writeBytes: 40, source: "cgroup1" });

  await writeFile(path.join(cgroup, "io.stat"), "8:0 rbytes=2 wbytes=9\n");
  assert.deepEqual((await ioDiagnostics({ proc, cgroup, pid: 100 })).container, { readBytes: 2, writeBytes: 9, source: "cgroup2" });
});

test("ioDiagnostics leaves out what the platform does not have", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "process-io-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await ioDiagnostics({ proc: path.join(root, "none"), cgroup: path.join(root, "none") }), {});
});

test("EventLoopDelay reports a blocked loop and starts over on reset", async () => {
  const delay = new EventLoopDelay();
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    const until = Date.now() + 120;
    while (Date.now() < until) { /* hold the loop */ }
    await new Promise((resolve) => setTimeout(resolve, 60));
    const before = delay.snapshot();
    assert.ok(before.maxMs >= 60, `max ${before.maxMs} ms`);
    assert.ok(before.p50Ms < 15, `an idle median reads near zero, not the sampling interval: ${before.p50Ms}`);
    delay.reset();
    const after = delay.snapshot();
    assert.ok(after.maxMs < before.maxMs);
    assert.ok(Date.parse(after.since) >= Date.parse(before.since));
  } finally {
    delay.stop();
  }
});

test("a stall over the threshold is written to the log, and a run of them only once per quiet time", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "process-io-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.LOG_STDOUT;
  process.env.LOG_STDOUT = "0";
  t.after(() => { if (previous === undefined) delete process.env.LOG_STDOUT; else process.env.LOG_STDOUT = previous; });
  await initLogger(dir);
  const delay = new EventLoopDelay({ logStallsOverMs: 150 });
  t.after(() => delay.stop());
  const hold = (ms: number) => { const until = Date.now() + ms; while (Date.now() < until) { /* hold the thread */ } };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 250));
  await tick();
  hold(300);
  await tick();
  hold(400);
  await tick();
  await flushLog();
  const lines = (await readLog({})).split("\n").filter((line) => line.includes("The server was blocked"));
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0]!, /"ms":(1[5-9]\d|[23]\d\d)/, "the first stall, about 300 ms less the part of a tick it fell in");
});

test("figures are rounded to a tenth of a millisecond", () => {
  const delay = new EventLoopDelay();
  try {
    for (const value of Object.values(delay.snapshot()).filter((item) => typeof item === "number")) {
      assert.equal(Math.round((value as number) * 10) / 10, value);
    }
  } finally {
    delay.stop();
  }
});
