import test from "node:test";
import assert from "node:assert/strict";
import { ConversionMonitor, likelyCause, ProgressReader, SourcePace } from "./conversion-pace.js";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { flushLog, initLogger, readLog, setLevel } from "./logger.js";

process.env.LOG_STDOUT = "0";
await initLogger(await mkdtemp(path.join(os.tmpdir(), "stremio-pace-")));
setLevel("DEBUG");

const entries = async (id: string) => {
  await flushLog();
  return (await readLog({ search: `"id":"${id}"` })).split("\n").filter(Boolean).map((line) => ({
    level: / (DEBUG|INFO|WARN|ERROR) /.exec(line)?.[1],
    message: / (?:DEBUG|INFO|WARN|ERROR) (.*?) \{/.exec(line)?.[1],
    context: JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  }));
};

test("progress is read from whole blocks, split wherever the pipe cuts them", () => {
  const reader = new ProgressReader();
  reader.push("out_time_us=N/A\nspeed=N/A\nprogress=continue\n");
  assert.equal(reader.latest, undefined);
  reader.push("out_time_us=4500");
  reader.push("000\nspeed=0.3x\nprogr");
  assert.equal(reader.latest, undefined);
  reader.push("ess=continue\n");
  assert.deepEqual(reader.latest, { outTime: 4.5, ended: false });
  reader.push("out_time_us=-80000\nprogress=end\n");
  assert.deepEqual(reader.latest, { outTime: 0, ended: true });
});

test("the side the proxy waits on names the likely cause", () => {
  assert.equal(likelyCause(9000, 1000), "source");
  assert.equal(likelyCause(1000, 9000), "ffmpeg");
  assert.equal(likelyCause(5000, 5000), "unclear");
  assert.equal(likelyCause(300, 200), "unclear");
});

const monitorAt = (clock: { now: number }, pace: SourcePace) => new ConversionMonitor({
  id: "s1", generation: 2, offset: 3341, mode: "remux", hardware: false,
  source: () => pace.read("s1"), now: () => clock.now, cpu: async () => undefined,
});

test("a conversion slower than playback is reported with the source as the likely cause", async () => {
  const clock = { now: 1_000_000 };
  const pace = new SourcePace();
  const monitor = monitorAt(clock, pace);
  monitor.push("out_time_us=1000000\nprogress=continue\n");
  await monitor.check();
  clock.now += 10_000;
  pace.note("s1", 9000, 500, 30_000_000);
  monitor.push("out_time_us=4000000\nprogress=continue\n");
  await monitor.check();

  const snapshot = monitor.snapshot();
  assert.equal(snapshot?.pace, 0.3);
  assert.equal(snapshot?.position, 3345);
  assert.equal(snapshot?.sourceMBps, 3);
  assert.equal(snapshot?.waitingOnSource, 95);
  assert.equal(snapshot?.likelyCause, "source");
  const warning = (await entries("s1")).find((entry) => entry.message === "The conversion is falling behind playback");
  assert.ok(warning);

  monitor.finish("stopped");
  const ended = (await entries("s1")).find((entry) => entry.message === "Conversion ended");
  assert.equal(ended?.level, "INFO");
  assert.equal(ended?.context?.likelyCause, "source");
});

test("a conversion that keeps up stays quiet", async () => {
  const clock = { now: 2_000_000 };
  const pace = new SourcePace();
  const monitor = new ConversionMonitor({
    id: "s2", generation: 1, offset: 0, mode: "remux", hardware: false,
    source: () => pace.read("s2"), now: () => clock.now, cpu: async () => undefined,
  });
  monitor.push("out_time_us=0\nprogress=continue\n");
  await monitor.check();
  clock.now += 10_000;
  pace.note("s2", 1000, 9000, 90_000_000);
  monitor.push("out_time_us=30000000\nprogress=continue\n");
  await monitor.check();
  assert.equal(monitor.snapshot()?.pace, 3);
  assert.equal(monitor.snapshot()?.likelyCause, "keeping up");
  monitor.finish("finished");
  const lines = await entries("s2");
  assert.equal(lines.some((entry) => entry.message === "The conversion is falling behind playback"), false);
  assert.equal(lines.find((entry) => entry.message === "Conversion ended")?.level, "DEBUG");
});
