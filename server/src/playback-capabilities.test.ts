import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { flushLog, initLogger, readLog, setLevel } from "./logger.js";
import { killRunningMedia } from "./media-tools.js";
import { PlaybackManager, type ClientCapabilities } from "./playback.js";
import { createShutdown } from "./server-shutdown.js";

process.env.LOG_STDOUT = "0";
await initLogger(await mkdtemp(path.join(os.tmpdir(), "stremio-playback-capabilities-log-")));
setLevel("INFO");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const until = async (condition: () => boolean, message: string, timeout = 5_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(10);
  }
  throw new Error(message);
};

const useEnv = (t: TestContext, values: Record<string, string | undefined>) => {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
};

const workDir = async (t: TestContext, prefix: string) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

const writeFakeFfmpeg = async (directory: string, options: {
  versionDelay?: number;
  /** The version probe answers only once this file exists: the test decides when, not a timer. */
  versionGate?: string;
  versionOutput?: string;
  versionCount?: string;
  versionComplete?: string;
  vaapi?: boolean;
}) => {
  const fake = path.join(directory, "ffmpeg");
  const count = options.versionCount ?? path.join(directory, "version-count");
  const complete = options.versionComplete ?? path.join(directory, "version-complete");
  const version = options.versionOutput ?? "ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers\n--enable-libx264\n";
  const encoderExit = options.vaapi ? 0 : 1;
  await writeFile(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("-version")) {
  fs.appendFileSync(${JSON.stringify(count)}, "version\\n");
  const answer = () => {
    fs.writeFileSync(${JSON.stringify(complete)}, "done");
    process.stdout.write(${JSON.stringify(version)});
  };
  const gate = ${JSON.stringify(options.versionGate ?? null)};
  if (gate) {
    // Gone with the test's folder: nobody will release it, so it stops waiting.
    const wait = () => fs.existsSync(gate) ? answer() : !fs.existsSync(require("node:path").dirname(gate)) ? process.exit(1) : setTimeout(wait, 20);
    wait();
  } else setTimeout(answer, ${options.versionDelay ?? 0});
} else {
  if (args.includes("h264_vaapi") && ${encoderExit} === 0) process.exit(0);
  process.stderr.write("encoder probe failed\\n");
  process.exit(${encoderExit});
}
`);
  await chmod(fake, 0o755);
  return { fake, count, complete };
};

const directInfo = {
  container: "mp4",
  duration: 120,
  video: { codec: "h264" },
  audio: { codec: "aac" },
  audioTracks: [{ index: 0, codec: "aac" }],
  subtitleTracks: [],
};

const directStream = { url: "https://cdn.example/movie.mp4" };
const browserCapabilities: ClientCapabilities = { h264: true, aac: true };

test("load returns before the capability probe and reports it pending", { skip: process.platform === "win32" }, async (t) => {
  const directory = await workDir(t, "playback-capabilities-load-");
  const { fake, count } = await writeFakeFfmpeg(directory, { versionDelay: 2_000 });
  useEnv(t, { FFMPEG_PATH: fake, VIDEOTOOLBOX: "0", VAAPI_DEVICE: undefined });
  const manager = new PlaybackManager(path.join(directory, "data"));

  await manager.load();
  assert.equal(existsSync(count), false, "load does not ask for the FFmpeg version");
  assert.equal(manager.diagnostics().capabilities, "pending");

  const probing = manager.probeCapabilities();
  await until(() => existsSync(count), "the capability probe never started");
  assert.equal(manager.diagnostics().capabilities, "pending");
  await probing;
  assert.equal(manager.diagnostics().capabilities, "ready");
});

test("concurrent probes and a racing start share the FFmpeg version probe", { skip: process.platform === "win32" }, async (t) => {
  const directory = await workDir(t, "playback-capabilities-shared-");
  const { fake, count } = await writeFakeFfmpeg(directory, { versionDelay: 300 });
  useEnv(t, { FFMPEG_PATH: fake, VIDEOTOOLBOX: "0", VAAPI_DEVICE: undefined });
  const manager = new PlaybackManager(path.join(directory, "data")) as any;
  await manager.load();
  manager.inspect = async () => directInfo;

  const first = manager.probeCapabilities();
  const second = manager.probeCapabilities();
  const started = manager.start(directStream, browserCapabilities);
  const [session] = await Promise.all([started, first, second]);

  assert.equal(session.mode, "direct");
  assert.equal((await readFile(count, "utf8")).trim().split("\n").length, 1);
  assert.equal(manager.diagnostics().capabilities, "ready");
});

test("missing FFmpeg is a completed probe with the existing defaults", async (t) => {
  const directory = await workDir(t, "playback-capabilities-missing-");
  useEnv(t, {
    FFMPEG_PATH: path.join(directory, "missing-ffmpeg"),
    VAAPI_DEVICE: undefined,
    NVENC: "0",
    VIDEOTOOLBOX: "0",
    MEDIAFOUNDATION: "0",
  });
  const manager = new PlaybackManager(path.join(directory, "data")) as any;
  await manager.load();

  await manager.probeCapabilities();

  assert.equal(manager.diagnostics().capabilities, "ready");
  assert.equal(manager.ffmpegVersion, undefined);
  assert.equal(manager.initialBurst, false);
  assert.equal(manager.softwareEncoder, true);
});

test("a failed hardware probe leaves that accelerator off and completes", { skip: process.platform === "win32" }, async (t) => {
  const directory = await workDir(t, "playback-capabilities-hardware-");
  const { fake } = await writeFakeFfmpeg(directory, { vaapi: false });
  const device = path.join(directory, "renderD128");
  await writeFile(device, "");
  useEnv(t, { FFMPEG_PATH: fake, VAAPI_DEVICE: device, VIDEOTOOLBOX: "0" });
  const manager = new PlaybackManager(path.join(directory, "data")) as any;
  await manager.load();

  await manager.probeCapabilities();

  assert.equal(manager.diagnostics().capabilities, "ready");
  assert.equal(manager.diagnostics().vaapi.device, undefined);
});

test("a direct start answers while the probe is still pending", { skip: process.platform === "win32" }, async (t) => {
  const directory = await workDir(t, "playback-capabilities-start-");
  const gate = path.join(directory, "release-version");
  t.after(() => writeFile(gate, "").catch(() => undefined));
  const { fake, count } = await writeFakeFfmpeg(directory, { versionGate: gate });
  useEnv(t, { FFMPEG_PATH: fake, VIDEOTOOLBOX: "0", VAAPI_DEVICE: undefined });
  const manager = new PlaybackManager(path.join(directory, "data")) as any;
  await manager.load();
  manager.inspect = async () => directInfo;

  const probing = manager.probeCapabilities();
  await until(() => existsSync(count), "the capability probe never started");
  const session = await manager.start(directStream, browserCapabilities);
  assert.equal(session.mode, "direct");
  assert.equal(manager.diagnostics().capabilities, "pending", "direct play did not wait for the probe");

  await writeFile(gate, "");
  await probing;
  assert.equal(manager.diagnostics().capabilities, "ready");
});

test("a start that has to convert waits for the probe before choosing an encoder", { skip: process.platform === "win32" }, async (t) => {
  const directory = await workDir(t, "playback-capabilities-convert-");
  const gate = path.join(directory, "release-version");
  t.after(() => writeFile(gate, "").catch(() => undefined));
  const { fake, count } = await writeFakeFfmpeg(directory, { versionGate: gate });
  useEnv(t, { FFMPEG_PATH: fake, VIDEOTOOLBOX: "0", VAAPI_DEVICE: undefined });
  const manager = new PlaybackManager(path.join(directory, "data")) as any;
  await manager.load();
  manager.inspect = async () => ({ ...directInfo, container: "matroska,webm", video: { codec: "hevc" } });
  const accelerator = manager.accelerator.bind(manager);
  let encoderChosen = false;
  manager.accelerator = () => { encoderChosen = true; return accelerator(); };

  const probing = manager.probeCapabilities();
  await until(() => existsSync(count), "the capability probe never started");
  const starting = manager.start({ url: "https://cdn.example/movie.mkv" }, browserCapabilities).catch(() => undefined);
  await sleep(100);
  assert.equal(encoderChosen, false, "no encoder is chosen while the probe is pending");

  await writeFile(gate, "");
  await probing;
  await starting;
  assert.equal(encoderChosen, true, "the conversion went on once the probe settled");
});

test("a version probe that timed out at start is asked again later and turns the fast start on", { skip: process.platform === "win32" }, async (t) => {
  const directory = await workDir(t, "playback-capabilities-retry-");
  const gate = path.join(directory, "release-version");
  t.after(() => writeFile(gate, "").catch(() => undefined));
  // FFmpeg does not answer until the gate opens: a cold NAS that keeps the first exec waiting.
  // A build without libx264, so the late answer visibly changes what was assumed meanwhile.
  const { fake } = await writeFakeFfmpeg(directory, { versionGate: gate, versionOutput: "ffmpeg version 7.1.1 Copyright (c) 2000-2025\n--enable-gpl\n" });
  useEnv(t, { FFMPEG_PATH: fake, VIDEOTOOLBOX: "0", VAAPI_DEVICE: undefined });
  const manager = new PlaybackManager(path.join(directory, "data")) as any;
  manager.versionTimeoutsMs = [200, 200];
  manager.versionRetryMs = [100];
  await manager.load();

  await manager.probeCapabilities();
  assert.equal(manager.diagnostics().capabilities, "ready");
  assert.equal(manager.diagnostics().ffmpeg.version, undefined);
  assert.equal(manager.diagnostics().ffmpeg.initialBurst, false);
  assert.equal(manager.diagnostics().ffmpeg.softwareEncoder, true, "assumed until FFmpeg says otherwise");

  await writeFile(gate, "");
  await until(() => manager.diagnostics().ffmpeg.version !== undefined, "the version was never asked again");
  assert.equal(manager.diagnostics().ffmpeg.version, "7.1.1");
  assert.equal(manager.diagnostics().ffmpeg.initialBurst, true);
  assert.equal(manager.diagnostics().ffmpeg.softwareEncoder, false);
  await flushLog();
  assert.match(await readLog({}), /no answer in 0\.2 s/);
  assert.match(await readLog({}), /FFmpeg version read on a later try/);
});

test("shutdown kills a probe that is stuck, and the manager stops", { skip: process.platform === "win32" }, async (t) => {
  const directory = await workDir(t, "playback-capabilities-shutdown-");
  // Never released: only the shutdown's media cleanup can end this version probe.
  const gate = path.join(directory, "never-released");
  const { fake, count, complete } = await writeFakeFfmpeg(directory, { versionGate: gate });
  useEnv(t, { FFMPEG_PATH: fake, VAAPI_DEVICE: undefined });
  const manager = new PlaybackManager(path.join(directory, "data")) as any;
  await manager.load();
  const probing = manager.probeCapabilities();
  await until(() => existsSync(count), "the capability probe never started");

  const shutdown = createShutdown({
    inFlight: { active: () => 0, drained: async () => true },
    maintenance: { stop: async () => {} },
    followService: { stop: async () => {} },
    killRunningMedia,
    flushes: [],
    lateFlushes: [],
    store: { flush: async () => {} },
    closeStorage: async () => {},
    flushLog,
    log: () => {},
    now: Date.now,
    setTimer: (callback, ms) => setTimeout(callback, ms),
  });
  await shutdown("SIGTERM");
  await manager.stop("not-playing", "shutdown");
  await Promise.race([
    probing,
    sleep(5_000).then(() => { throw new Error("the capability probe did not finish after shutdown"); }),
  ]);

  assert.equal(existsSync(complete), false, "the stuck probe was killed, not left to answer");
  assert.equal(manager.diagnostics().capabilities, "ready");
  await flushLog();
  assert.equal(await readLog({ level: "ERROR", search: "FFmpeg capabilities" }), "");
});
