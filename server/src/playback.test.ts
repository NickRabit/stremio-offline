import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { EventEmitter, once } from "node:events";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DOLBY_VISION_UNITS_FILTER, PlaybackManager, fitsQuality, SOURCE_UNREACHABLE, SerialOperations, clientCapabilities, describeFailure, hlsCanStart, hlsPlaylistFiles, isPlaylistSource, shortConversion, sourceReachable, nvencBusy } from "./playback.js";
import { mediaResources as registry, type ResourceOwner } from "./media-resources.js";
import { setFetchTransport } from "./security.js";
import { flushLog, initLogger, readLog, setLevel } from "./logger.js";

process.env.LOG_STDOUT = "0";
await initLogger(await mkdtemp(path.join(os.tmpdir(), "stremio-playback-log-")));
setLevel("INFO");

const runFfmpeg = promisify(execFile);
const hasX265 = await runFfmpeg("ffmpeg", ["-hide_banner", "-encoders"]).then(({ stdout }) => stdout.includes("libx265"), () => false);
const START_CODE = Buffer.from([0, 0, 1]);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake reader waits for the abort the server sends. The signal may already be aborted by the
 *  time the reader arrives, and `abort` fires only once, so a bare listener would never settle. */
const whenAborted = (signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) resolve();
  else signal.addEventListener("abort", () => resolve(), { once: true });
});

/** A path under the runner's own scratch directory. Nothing here is read back except the files
 *  the fake readers write, so the name only has to be somewhere a runner may write. */
const tmp = (name: string) => path.join(os.tmpdir(), name);

const loadPlaybackManager = async (manager: any) => {
  manager.readFfmpegVersion = async () => undefined;
  manager.checkVaapi = async () => {};
  manager.checkNvenc = async () => {};
  manager.checkVideotoolbox = async () => {};
  manager.checkMediaFoundation = async () => {};
  await manager.load();
};

test("PLAYBACK_DIR cleans and uses only its owned child", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "playback-data-"));
  const playbackParent = await mkdtemp(path.join(os.tmpdir(), "playback-parent-"));
  t.after(() => Promise.all([
    rm(dataDir, { recursive: true, force: true }),
    rm(playbackParent, { recursive: true, force: true }),
  ]));
  const previous = process.env.PLAYBACK_DIR;
  process.env.PLAYBACK_DIR = playbackParent;
  t.after(() => {
    if (previous === undefined) delete process.env.PLAYBACK_DIR;
    else process.env.PLAYBACK_DIR = previous;
  });

  const owned = path.join(playbackParent, "stremio-offline-playback");
  await mkdir(path.join(owned, "stale", "nested"), { recursive: true });
  await writeFile(path.join(owned, "stale", "nested", "old.m3u8"), "old");
  await writeFile(path.join(playbackParent, "unrelated.txt"), "keep");

  const manager = new PlaybackManager(dataDir) as any;
  await loadPlaybackManager(manager);

  assert.equal(manager.root, owned);
  assert.deepEqual(await readdir(owned), []);
  assert.equal(await readFile(path.join(playbackParent, "unrelated.txt"), "utf8"), "keep");
  if (process.platform !== "win32") assert.equal((await stat(owned)).mode & 0o777, 0o700);

  manager.inspect = async () => ({
    container: "matroska,webm", duration: 120,
    video: { codec: "h264" }, audio: { codec: "aac" },
    audioTracks: [{ index: 0, codec: "aac" }], subtitleTracks: [],
  });
  manager.run = async () => "/hls";
  const started = await manager.start({ url: "https://cdn.example/movie.mkv" });

  assert.notEqual(started.mode, "direct");
  assert.ok(existsSync(path.join(owned, started.id, String(manager.sessions.get(started.id).generation))));
});

test("a playback root that is a symbolic link is never emptied through", { skip: process.platform === "win32" }, async (t) => {
  const previous = process.env.PLAYBACK_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.PLAYBACK_DIR;
    else process.env.PLAYBACK_DIR = previous;
  });
  for (const configured of [true, false]) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "playback-link-data-"));
    const playbackParent = await mkdtemp(path.join(os.tmpdir(), "playback-link-parent-"));
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "playback-link-target-"));
    t.after(() => Promise.all([dataDir, playbackParent, elsewhere].map((dir) => rm(dir, { recursive: true, force: true }))));
    await writeFile(path.join(elsewhere, "precious.txt"), "keep");
    const root = configured ? path.join(playbackParent, "stremio-offline-playback") : path.join(dataDir, "playback");
    await symlink(elsewhere, root);
    if (configured) process.env.PLAYBACK_DIR = playbackParent;
    else delete process.env.PLAYBACK_DIR;

    const manager = new PlaybackManager(dataDir) as any;
    await loadPlaybackManager(manager);

    assert.equal(await readFile(path.join(elsewhere, "precious.txt"), "utf8"), "keep", `configured=${configured}`);
    const fallback = path.join(dataDir, "playback");
    assert.equal(manager.root, fallback, "a configured link is not used; the server's own root is");
    assert.equal((await lstat(fallback)).isDirectory(), true);
    assert.deepEqual(await readdir(fallback), []);
    // The owner's link in the configured folder is left where it was.
    if (configured) assert.equal((await lstat(root)).isSymbolicLink(), true);
  }
});

test("a file in place of the configured playback child is kept and the server falls back", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "playback-file-data-"));
  const playbackParent = await mkdtemp(path.join(os.tmpdir(), "playback-file-parent-"));
  t.after(() => Promise.all([rm(dataDir, { recursive: true, force: true }), rm(playbackParent, { recursive: true, force: true })]));
  const previous = process.env.PLAYBACK_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.PLAYBACK_DIR;
    else process.env.PLAYBACK_DIR = previous;
  });
  process.env.PLAYBACK_DIR = playbackParent;
  const child = path.join(playbackParent, "stremio-offline-playback");
  await writeFile(child, "the owner's data");

  const manager = new PlaybackManager(dataDir) as any;
  await loadPlaybackManager(manager);

  assert.equal(await readFile(child, "utf8"), "the owner's data");
  assert.equal(manager.root, path.join(dataDir, "playback"));
});

test("a fallback onto the configured folder itself removes nothing in it", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "playback-overlap-data-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const previous = process.env.PLAYBACK_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.PLAYBACK_DIR;
    else process.env.PLAYBACK_DIR = previous;
  });
  const configured = path.join(dataDir, "playback");
  await mkdir(configured, { recursive: true });
  await writeFile(path.join(configured, "stremio-offline-playback"), "the owner's data");
  await writeFile(path.join(configured, "keep.txt"), "keep");
  process.env.PLAYBACK_DIR = configured;

  const manager = new PlaybackManager(dataDir) as any;
  await loadPlaybackManager(manager);

  assert.equal(manager.root, configured);
  assert.equal(await readFile(path.join(configured, "stremio-offline-playback"), "utf8"), "the owner's data");
  assert.equal(await readFile(path.join(configured, "keep.txt"), "utf8"), "keep");
});

test("a relative PLAYBACK_DIR is resolved to an absolute root", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "playback-relative-data-"));
  const parent = await mkdtemp(path.join(os.tmpdir(), "playback-relative-"));
  t.after(() => Promise.all([rm(dataDir, { recursive: true, force: true }), rm(parent, { recursive: true, force: true })]));
  const previous = process.env.PLAYBACK_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.PLAYBACK_DIR;
    else process.env.PLAYBACK_DIR = previous;
  });
  process.env.PLAYBACK_DIR = path.relative(process.cwd(), parent);

  const manager = new PlaybackManager(dataDir) as any;
  await loadPlaybackManager(manager);

  assert.equal(path.isAbsolute(manager.root), true);
  assert.equal(manager.root, path.join(parent, "stremio-offline-playback"));
});

test("an unset PLAYBACK_DIR keeps the DATA_DIR/playback root", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "playback-default-data-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const previous = process.env.PLAYBACK_DIR;
  delete process.env.PLAYBACK_DIR;
  t.after(() => {
    if (previous !== undefined) process.env.PLAYBACK_DIR = previous;
  });

  const manager = new PlaybackManager(dataDir) as any;
  await loadPlaybackManager(manager);

  assert.equal(manager.root, path.join(dataDir, "playback"));
  assert.ok(existsSync(manager.root));
});

test("an unusable PLAYBACK_DIR logs an error and falls back", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "playback-fallback-data-"));
  const missing = path.join(await mkdtemp(path.join(os.tmpdir(), "playback-missing-parent-")), "missing");
  t.after(() => Promise.all([
    rm(dataDir, { recursive: true, force: true }),
    rm(path.dirname(missing), { recursive: true, force: true }),
  ]));
  const previous = process.env.PLAYBACK_DIR;
  process.env.PLAYBACK_DIR = missing;
  t.after(() => {
    if (previous === undefined) delete process.env.PLAYBACK_DIR;
    else process.env.PLAYBACK_DIR = previous;
  });

  const manager = new PlaybackManager(dataDir) as any;
  await loadPlaybackManager(manager);
  await flushLog();

  assert.equal(manager.root, path.join(dataDir, "playback"));
  // Other tests log the same error for their own folders; this one's names its own path.
  const line = (await readLog({ level: "ERROR", search: "Configured playback directory is unusable" }))
    .split("\n").filter(Boolean)
    .find((entry) => (JSON.parse(entry.slice(entry.indexOf("{"))) as { directory?: string }).directory === path.join(missing, "stremio-offline-playback"));
  assert.ok(line);
  const context = JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>;
  assert.equal(context.directory, path.join(missing, "stremio-offline-playback"));
});

test("operations of one playback session never overlap", async () => {
  const queue = new SerialOperations();
  const events: string[] = [];
  let active = 0;
  let maximum = 0;

  const operation = (name: string, delay: number) => queue.run(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    events.push(`${name}:start`);
    await pause(delay);
    events.push(`${name}:end`);
    active -= 1;
    return name;
  });

  const results = await Promise.all([operation("seek-1", 20), operation("track", 1), operation("seek-2", 1)]);
  assert.deepEqual(results, ["seek-1", "track", "seek-2"]);
  assert.equal(maximum, 1);
  assert.deepEqual(events, ["seek-1:start", "seek-1:end", "track:start", "track:end", "seek-2:start", "seek-2:end"]);
});

test("a failed operation does not block the seek after it", async () => {
  const queue = new SerialOperations();
  await assert.rejects(queue.run(async () => { throw new Error("transcode failure"); }), /transcode failure/);
  assert.equal(await queue.run(async () => "carrying on"), "carrying on");
  await queue.wait();
});

test("a Synology without VAAPI scaling decodes on the CPU and encodes on the GPU", () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  manager.vaapiDevice = "/dev/dri/renderD128";
  manager.vaapiScaling = false;
  manager.vaapiBitrate = false;
  const session = {
    stream: { url: "https://example.test/movie.mkv" },
    capabilities: { h264: true, eac3: true },
    info: {
      video: { codec: "h264" },
      audio: { codec: "eac3" },
      audioTracks: [{ codec: "eac3" }],
      subtitleTracks: [],
    },
    quality: 720,
    audioTrack: 0,
    subtitleTrack: null,
  };

  const args = manager.args(session, 0, tmp("output"), true) as string[];
  assert.deepEqual(args.slice(args.indexOf("-init_hw_device"), args.indexOf("-init_hw_device") + 4), [
    "-init_hw_device", "vaapi=va:/dev/dri/renderD128", "-filter_hw_device", "va",
  ]);
  assert.equal(args.includes("-hwaccel"), false);
  assert.equal(args[args.indexOf("-c:v") + 1], "h264_vaapi");
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  assert.equal(args[args.indexOf("-qp") + 1], "23");
});

test("VideoToolbox decodes, scales and encodes on the Mac without a single VAAPI flag", () => {
  const manager = new PlaybackManager(tmp("test-videotoolbox")) as any;
  manager.videotoolbox = true;
  const session = {
    stream: { url: "https://example.test/movie.mkv" },
    capabilities: { h264: true, aac: true },
    info: {
      video: { codec: "h264" },
      audio: { codec: "aac" },
      audioTracks: [{ codec: "aac" }],
      subtitleTracks: [],
    },
    quality: 720,
    audioTrack: 0,
    subtitleTrack: null,
  };

  const args = manager.args(session, 0, tmp("output"), true) as string[];
  const input = args.indexOf("-i");
  assert.ok(input > 0, "the input position is present");
  assert.deepEqual(args.slice(args.indexOf("-hwaccel"), args.indexOf("-hwaccel") + 2), ["-hwaccel", "videotoolbox"]);
  assert.ok(args.indexOf("-hwaccel") < input, "the GPU decoder applies to the input");
  // Frames come back in system memory, so the filter is an ordinary one, on the chosen height.
  assert.equal(args[args.indexOf("-vf") + 1], "scale=-2:min(720\\,ih),format=nv12");
  assert.equal(args[args.indexOf("-c:v") + 1], "h264_videotoolbox");
  assert.deepEqual(args.slice(args.indexOf("-b:v"), args.indexOf("-b:v") + 4), ["-b:v", "3M", "-maxrate", "3M"]);
  assert.equal(args[args.indexOf("-g") + 1], "48");
  assert.equal(args.includes("-init_hw_device"), false);
  assert.equal(args.join(" ").toLowerCase().includes("vaapi"), false);
});

test("VideoToolbox uses constant quality where it can and a plain bitrate on an Intel Mac", () => {
  const manager = new PlaybackManager(tmp("test-videotoolbox-quality")) as any;
  manager.videotoolbox = true;
  const session = {
    stream: { url: "https://example.test/movie.mkv" },
    capabilities: { h264: true, aac: true },
    info: {
      video: { codec: "mpeg4" },
      audio: { codec: "aac" },
      audioTracks: [{ codec: "aac" }],
      subtitleTracks: [],
    },
    quality: null,
    audioTrack: 0,
    subtitleTrack: null,
  };

  manager.videotoolboxQuality = true;
  const constant = manager.args(session, 0, tmp("output"), true) as string[];
  assert.equal(constant[constant.indexOf("-vf") + 1], "format=nv12");
  assert.equal(constant[constant.indexOf("-q:v") + 1], "60");

  process.env.VIDEOTOOLBOX_QUALITY = "70";
  try {
    const tuned = manager.args(session, 0, tmp("output"), true) as string[];
    assert.equal(tuned[tuned.indexOf("-q:v") + 1], "70");
  } finally {
    delete process.env.VIDEOTOOLBOX_QUALITY;
  }

  manager.videotoolboxQuality = false;
  const fixed = manager.args(session, 0, tmp("output"), true) as string[];
  assert.deepEqual(fixed.slice(fixed.indexOf("-b:v"), fixed.indexOf("-b:v") + 2), ["-b:v", "8M"]);
  assert.equal(fixed.includes("-q:v"), false);
});

test("the software fallback for a Mac stays libx264", () => {
  const manager = new PlaybackManager(tmp("test-videotoolbox-software")) as any;
  manager.videotoolbox = true;
  manager.videotoolboxQuality = true;
  const session = {
    stream: { url: "https://example.test/movie.mkv" },
    capabilities: { h264: true, aac: true },
    info: {
      video: { codec: "h264" },
      audio: { codec: "aac" },
      audioTracks: [{ codec: "aac" }],
      subtitleTracks: [],
    },
    quality: 720,
    audioTrack: 0,
    subtitleTrack: null,
  };

  const args = manager.args(session, 0, tmp("output"), false) as string[];
  assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
  assert.equal(args.includes("-hwaccel"), false);
  assert.equal(args.join(" ").includes("videotoolbox"), false);
});

test("VAAPI wins over VideoToolbox when a Mac carries both", () => {
  const manager = new PlaybackManager(tmp("test-videotoolbox-vaapi")) as any;
  manager.vaapiDevice = "/dev/dri/renderD128";
  manager.videotoolbox = true;
  const session = {
    stream: { url: "https://example.test/movie.mkv" },
    capabilities: { h264: true, aac: true },
    info: {
      video: { codec: "h264" },
      audio: { codec: "aac" },
      audioTracks: [{ codec: "aac" }],
      subtitleTracks: [],
    },
    quality: 720,
    audioTrack: 0,
    subtitleTrack: null,
  };

  const args = manager.args(session, 0, tmp("output"), true) as string[];
  assert.deepEqual(args.slice(args.indexOf("-hwaccel"), args.indexOf("-hwaccel") + 4), [
    "-hwaccel", "vaapi", "-hwaccel_device", "/dev/dri/renderD128",
  ]);
  assert.equal(args[args.indexOf("-c:v") + 1], "h264_vaapi");
  assert.equal(args.join(" ").includes("videotoolbox"), false);
});

test("a remux never touches VideoToolbox, whatever the accelerator", () => {
  const manager = new PlaybackManager(tmp("test-videotoolbox-remux")) as any;
  manager.videotoolbox = true;
  manager.videotoolboxQuality = true;
  const session = {
    stream: { url: "https://example.test/movie.mkv" },
    capabilities: { h264: true, aac: true },
    info: {
      video: { codec: "h264" },
      audio: { codec: "aac" },
      audioTracks: [{ codec: "aac" }],
      subtitleTracks: [],
    },
    quality: null,
    audioTrack: 0,
    subtitleTrack: null,
  };

  for (const hardware of [false, true]) {
    const args = manager.args(session, 0, tmp("output"), hardware) as string[];
    assert.equal(args[args.indexOf("-c:v") + 1], "copy");
    assert.equal(args.includes("-hwaccel"), false);
  }
});

/** A source that is always transcoded: no capability matches, so the video arguments are built. */
const transcodeSession = (video: Record<string, unknown>, capabilities: Record<string, unknown>, quality: number | null = null) => ({
  stream: { url: "https://example.test/movie.mkv" },
  capabilities,
  info: { video, audio: { codec: "aac" }, audioTracks: [{ codec: "aac" }], subtitleTracks: [] },
  quality,
  audioTrack: 0,
  subtitleTrack: null,
});

test("Media Foundation decodes on the GPU only for a heavy source with the hardware encoder", () => {
  const manager = new PlaybackManager(tmp("test-mediafoundation-decode")) as any;
  manager.mediafoundation = true;
  manager.mediafoundationHardware = true;
  manager.mediafoundationQuality = true;

  const hevc4k = manager.args(transcodeSession({ codec: "hevc", height: 2160 }, { aac: true }), 0, tmp("output"), true) as string[];
  assert.deepEqual(hevc4k.slice(hevc4k.indexOf("-hwaccel"), hevc4k.indexOf("-hwaccel") + 2), ["-hwaccel", "d3d11va"]);
  assert.ok(hevc4k.indexOf("-hwaccel") < hevc4k.indexOf("-i"), "the GPU decoder applies to the input");
  assert.equal(hevc4k.includes("-hwaccel_device"), false);
  assert.equal(hevc4k.includes("-hwaccel_output_format"), false);

  const tenBit = manager.args(transcodeSession({ codec: "h264", pixelFormat: "yuv420p10le" }, { h264: false, aac: true }), 0, tmp("output"), true) as string[];
  assert.deepEqual(tenBit.slice(tenBit.indexOf("-hwaccel"), tenBit.indexOf("-hwaccel") + 2), ["-hwaccel", "d3d11va"]);

  const plain1080 = manager.args(transcodeSession({ codec: "h264", height: 1080 }, { h264: false, aac: true }), 0, tmp("output"), true) as string[];
  assert.equal(plain1080.includes("-hwaccel"), false);
  assert.equal(plain1080[plain1080.indexOf("-c:v") + 1], "h264_mf");

  manager.mediafoundationHardware = false;
  const software = manager.args(transcodeSession({ codec: "hevc", height: 2160 }, { aac: true }), 0, tmp("output"), true) as string[];
  assert.equal(software.includes("-hwaccel"), false);
  assert.equal(software.includes("-hw_encoding"), false);
});

test("Media Foundation encodes at hardware constant quality without a chosen bitrate", () => {
  const manager = new PlaybackManager(tmp("test-mediafoundation-quality")) as any;
  manager.mediafoundation = true;
  manager.mediafoundationHardware = true;
  manager.mediafoundationQuality = true;
  const session = transcodeSession({ codec: "mpeg4" }, { aac: true });

  const args = manager.args(session, 0, tmp("output"), true) as string[];
  assert.equal(args[args.indexOf("-c:v") + 1], "h264_mf");
  assert.equal(args[args.indexOf("-vf") + 1], "format=nv12");
  assert.deepEqual(args.slice(args.indexOf("-rate_control"), args.indexOf("-rate_control") + 4), ["-rate_control", "quality", "-quality", "60"]);
  assert.equal(args[args.indexOf("-hw_encoding") + 1], "1");
  assert.equal(args[args.indexOf("-g") + 1], "48");
  assert.equal(args.join(" ").includes("libx264"), false);

  process.env.MEDIAFOUNDATION_QUALITY = "70";
  try {
    const tuned = manager.args(session, 0, tmp("output"), true) as string[];
    assert.equal(tuned[tuned.indexOf("-quality") + 1], "70");
  } finally {
    delete process.env.MEDIAFOUNDATION_QUALITY;
  }
});

test("Media Foundation targets a chosen quality with CBR and the hardware encoder", () => {
  const manager = new PlaybackManager(tmp("test-mediafoundation-bitrate")) as any;
  manager.mediafoundation = true;
  manager.mediafoundationHardware = true;
  manager.mediafoundationQuality = true;
  const session = transcodeSession({ codec: "mpeg4" }, { aac: true }, 720);

  const args = manager.args(session, 0, tmp("output"), true) as string[];
  assert.equal(args[args.indexOf("-vf") + 1], "scale=-2:min(720\\,ih),format=nv12");
  assert.deepEqual(args.slice(args.indexOf("-rate_control"), args.indexOf("-rate_control") + 6), ["-rate_control", "cbr", "-b:v", "3M", "-maxrate", "3M"]);
  assert.equal(args[args.indexOf("-hw_encoding") + 1], "1");
  assert.equal(args[args.indexOf("-force_key_frames") + 1], "expr:gte(t,n_forced*2)");
  assert.equal(args.includes("-quality"), false);
});

test("the software Media Foundation MFT gets no hardware flags", () => {
  const manager = new PlaybackManager(tmp("test-mediafoundation-software")) as any;
  manager.mediafoundation = true;
  manager.mediafoundationHardware = false;
  manager.mediafoundationQuality = false;

  const withBitrate = manager.args(transcodeSession({ codec: "mpeg4" }, { aac: true }, 720), 0, tmp("output"), true) as string[];
  assert.equal(withBitrate[withBitrate.indexOf("-c:v") + 1], "h264_mf");
  assert.deepEqual(withBitrate.slice(withBitrate.indexOf("-rate_control"), withBitrate.indexOf("-rate_control") + 6), ["-rate_control", "cbr", "-b:v", "3M", "-maxrate", "3M"]);
  assert.equal(withBitrate.includes("-hwaccel"), false);
  assert.equal(withBitrate.includes("-hw_encoding"), false);

  const fixed = manager.args(transcodeSession({ codec: "mpeg4" }, { aac: true }), 0, tmp("output"), true) as string[];
  assert.deepEqual(fixed.slice(fixed.indexOf("-b:v"), fixed.indexOf("-b:v") + 2), ["-b:v", "8M"]);
  assert.equal(fixed.includes("-rate_control"), false);
});

test("VAAPI wins over Media Foundation when a machine carries both", () => {
  const manager = new PlaybackManager(tmp("test-mediafoundation-vaapi")) as any;
  manager.vaapiDevice = "/dev/dri/renderD128";
  manager.mediafoundation = true;
  manager.mediafoundationHardware = true;
  manager.mediafoundationQuality = true;

  const args = manager.args(transcodeSession({ codec: "mpeg4" }, { aac: true }), 0, tmp("output"), true) as string[];
  assert.deepEqual(args.slice(args.indexOf("-hwaccel"), args.indexOf("-hwaccel") + 4), [
    "-hwaccel", "vaapi", "-hwaccel_device", "/dev/dri/renderD128",
  ]);
  assert.equal(args[args.indexOf("-c:v") + 1], "h264_vaapi");
  assert.equal(args.join(" ").includes("h264_mf"), false);
});

test("the Media Foundation probe follows the platform and MEDIAFOUNDATION", async () => {
  const manager = new PlaybackManager(tmp("test-mediafoundation-gate")) as any;
  manager.readFfmpegVersion = async () => undefined;
  let probes = 0;
  manager.checkMediaFoundation = async () => { probes += 1; };

  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  const loadOn = async (platform: string, off: boolean) => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    if (off) process.env.MEDIAFOUNDATION = "0"; else delete process.env.MEDIAFOUNDATION;
    try { await manager.load(); } finally { delete process.env.MEDIAFOUNDATION; }
  };
  try {
    await loadOn("linux", false);
    await loadOn("win32", true);
    assert.equal(probes, 0);
    await loadOn("win32", false);
    assert.equal(probes, 1);
  } finally {
    Object.defineProperty(process, "platform", original);
  }
});

test("NVENC encodes at constant quality without a chosen bitrate", () => {
  const manager = new PlaybackManager(tmp("test-nvenc-quality")) as any;
  manager.nvenc = true;
  const session = transcodeSession({ codec: "mpeg4" }, { aac: true });

  const args = manager.args(session, 0, tmp("output"), true) as string[];
  assert.equal(args[args.indexOf("-c:v") + 1], "h264_nvenc");
  assert.equal(args[args.indexOf("-vf") + 1], "format=nv12");
  assert.deepEqual(args.slice(args.indexOf("-preset"), args.indexOf("-preset") + 4), ["-preset", "p4", "-tune", "ll"]);
  assert.deepEqual(args.slice(args.indexOf("-rc"), args.indexOf("-rc") + 4), ["-rc", "vbr", "-cq", "23"]);
  assert.equal(args[args.indexOf("-b:v") + 1], "0", "without -b:v 0 NVENC keeps its 2 Mb/s default as the target");
  assert.equal(args[args.indexOf("-g") + 1], "48");
  assert.equal(args[args.indexOf("-forced-idr") + 1], "1");
  assert.equal(args.includes("-hwaccel"), false);
  assert.equal(args.join(" ").includes("libx264"), false);

  process.env.NVENC_CQ = "28";
  try {
    const tuned = manager.args(session, 0, tmp("output"), true) as string[];
    assert.equal(tuned[tuned.indexOf("-cq") + 1], "28");
  } finally {
    delete process.env.NVENC_CQ;
  }
});

test("NVENC targets a chosen quality with VBR and forced IDRs", () => {
  const manager = new PlaybackManager(tmp("test-nvenc-bitrate")) as any;
  manager.nvenc = true;
  const session = transcodeSession({ codec: "mpeg4" }, { aac: true }, 720);

  const args = manager.args(session, 0, tmp("output"), true) as string[];
  assert.equal(args[args.indexOf("-vf") + 1], "scale=-2:min(720\\,ih),format=nv12");
  assert.deepEqual(args.slice(args.indexOf("-rc"), args.indexOf("-rc") + 6), ["-rc", "vbr", "-b:v", "3M", "-maxrate", "3M"]);
  assert.equal(args[args.indexOf("-forced-idr") + 1], "1");
  assert.equal(args[args.indexOf("-force_key_frames") + 1], "expr:gte(t,n_forced*2)");
  assert.equal(args.includes("-cq"), false);
  assert.equal(args.includes("-hwaccel"), false);
});

test("VAAPI wins over NVENC when a machine carries both", () => {
  const manager = new PlaybackManager(tmp("test-nvenc-vaapi")) as any;
  manager.vaapiDevice = "/dev/dri/renderD128";
  manager.nvenc = true;

  const args = manager.args(transcodeSession({ codec: "mpeg4" }, { aac: true }), 0, tmp("output"), true) as string[];
  assert.deepEqual(args.slice(args.indexOf("-hwaccel"), args.indexOf("-hwaccel") + 4), [
    "-hwaccel", "vaapi", "-hwaccel_device", "/dev/dri/renderD128",
  ]);
  assert.equal(args[args.indexOf("-c:v") + 1], "h264_vaapi");
  assert.equal(args.join(" ").includes("h264_nvenc"), false);
});

test("NVENC wins over Media Foundation when a Windows machine carries both", () => {
  const manager = new PlaybackManager(tmp("test-nvenc-mediafoundation")) as any;
  manager.nvenc = true;
  manager.mediafoundation = true;
  manager.mediafoundationHardware = true;
  manager.mediafoundationQuality = true;

  const args = manager.args(transcodeSession({ codec: "mpeg4" }, { aac: true }), 0, tmp("output"), true) as string[];
  assert.equal(args[args.indexOf("-c:v") + 1], "h264_nvenc");
  assert.equal(args.join(" ").includes("h264_mf"), false);
  assert.equal(args.includes("-hw_encoding"), false);
});

test("the NVENC probe follows NVENC and stands down for VAAPI", { skip: process.platform === "darwin" ? "a Mac has no NVIDIA encoder, so NVENC is never probed there" : false }, async () => {
  const manager = new PlaybackManager(tmp("test-nvenc-gate")) as any;
  manager.readFfmpegVersion = async () => undefined;
  let probes = 0;
  manager.checkNvenc = async () => { probes += 1; };

  const loadWith = async (off: boolean, vaapi: string | undefined) => {
    if (off) process.env.NVENC = "0"; else delete process.env.NVENC;
    manager.vaapiDevice = vaapi;
    try { await manager.load(); } finally { delete process.env.NVENC; manager.vaapiDevice = undefined; }
  };
  await loadWith(false, undefined);
  assert.equal(probes, 1);
  await loadWith(true, undefined);
  assert.equal(probes, 1);
  await loadWith(false, "/dev/dri/renderD128");
  assert.equal(probes, 1);
});

test("a Mac never probes NVENC", { skip: process.platform !== "darwin" ? "only a Mac skips the probe" : false }, async () => {
  const manager = new PlaybackManager(tmp("test-nvenc-mac")) as any;
  manager.readFfmpegVersion = async () => undefined;
  manager.checkVideotoolbox = async () => undefined;
  let probes = 0;
  manager.checkNvenc = async () => { probes += 1; };
  await manager.load();
  assert.equal(probes, 0);
});

test("a remux still copies compatible video and audio", () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const session = {
    stream: { url: "https://example.test/movie.mkv" },
    capabilities: { h264: true, eac3: true },
    info: {
      video: { codec: "h264" },
      audio: { codec: "eac3" },
      audioTracks: [{ codec: "eac3" }],
      subtitleTracks: [],
    },
    quality: null,
    audioTrack: 0,
    subtitleTrack: null,
  };

  const args = manager.args(session, 0, tmp("output"), false) as string[];
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.equal(args[args.indexOf("-c:a") + 1], "copy");
});

test("Dolby Vision is read as it comes but never announced to the browser", () => {
  const manager = new PlaybackManager(tmp("test-dolby-vision")) as any;
  const session = {
    capabilities: { hevc: true, hevc10: true, aac: true },
    info: { container: "matroska", duration: 6520,
      video: { codec: "hevc", profile: "Main 10", pixelFormat: "yuv420p10le", dolbyVisionEnhancementLayer: true },
      audio: { codec: "ac3" }, audioTracks: [{ index: 0, codec: "ac3" }], subtitleTracks: [] },
    audioTrack: 0, quality: null, id: "s", stream: { url: "https://cdn.example/dolby.mkv" },
    mode: "remux", generation: 1, offset: 0, hardware: false, subtitleTrack: null,
    startedAt: Date.now(), lastAccess: Date.now(), operations: new SerialOperations(), stopped: false, claimed: false,
  };
  const args: string[] = manager.args(session, 0, tmp("gen"), false);
  const input = args.indexOf("-i");
  assert.equal(manager.plan(session).copyVideo, true, "the picture is copied; it is ordinary HEVC underneath");
  // Reading it needs the unofficial mapping, or FFmpeg refuses the file outright.
  assert.ok(args.slice(0, input).join(" ").includes("-strict unofficial"), "the input side keeps it");
  // Writing the Dolby Vision configuration into the segments is what the browser refuses with
  // "SourceBuffer error", so the output side must not ask for it.
  assert.ok(!args.slice(input).join(" ").includes("-strict unofficial"), "the output side must not");
  assert.ok(args.slice(input).join(" ").includes("-tag:v hvc1"));
  // The RPU and enhancement layer units stay in the bitstream otherwise, and Safari stops on
  // them with "Media failed to decode" a few seconds in.
  assert.equal(args[args.indexOf("-bsf:v") + 1], "filter_units=remove_types=62|63");
  assert.ok(args.indexOf("-bsf:v") > input, "the filter applies to the copied output");
});

test("an HEVC copy is handed over without the Dolby Vision units even when the probe saw none", () => {
  const manager = new PlaybackManager(tmp("test-dolby-vision-rpu")) as any;
  const session = {
    capabilities: { hevc: true, hevc10: true, aac: true },
    info: { container: "matroska", duration: 7200,
      video: { codec: "hevc", profile: "Main 10", pixelFormat: "yuv420p10le" },
      audio: { codec: "eac3" }, audioTracks: [{ index: 0, codec: "eac3" }], subtitleTracks: [] },
    audioTrack: 0, quality: null, id: "s", stream: { url: "https://cdn.example/film.mkv" },
    mode: "remux", generation: 1, offset: 2114, hardware: false, subtitleTrack: null,
    startedAt: Date.now(), lastAccess: Date.now(), operations: new SerialOperations(), stopped: false, claimed: false,
  };
  const args: string[] = manager.args(session, 2114, tmp("gen"), false);
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.equal(args[args.indexOf("-bsf:v") + 1], DOLBY_VISION_UNITS_FILTER);
});

test("an H.264 copy and a transcode leave the video bitstream filters alone", () => {
  const manager = new PlaybackManager(tmp("test-dolby-vision-h264")) as any;
  const base = {
    capabilities: { aac: true },
    audioTrack: 0, quality: null, id: "s", stream: { url: "https://cdn.example/film.mkv" },
    mode: "remux", generation: 1, offset: 0, hardware: false, subtitleTrack: null,
    startedAt: Date.now(), lastAccess: Date.now(), operations: new SerialOperations(), stopped: false, claimed: false,
  };
  const h264 = { ...base, info: { container: "matroska", video: { codec: "h264", pixelFormat: "yuv420p" },
    audio: { codec: "aac" }, audioTracks: [{ index: 0, codec: "aac" }], subtitleTracks: [] } };
  assert.ok(!manager.args(h264, 0, tmp("gen"), false).includes("-bsf:v"));
  const hevc = { ...base, mode: "transcode", info: { container: "matroska", video: { codec: "hevc", pixelFormat: "yuv420p10le" },
    audio: { codec: "aac" }, audioTracks: [{ index: 0, codec: "aac" }], subtitleTracks: [] } };
  const transcode: string[] = manager.args(hevc, 0, tmp("gen"), false);
  assert.notEqual(transcode[transcode.indexOf("-c:v") + 1], "copy");
  assert.ok(!transcode.includes("-bsf:v"));
});

test("the Dolby Vision filter strips NAL 62 and 63 from a real HEVC copy into fMP4 HLS", { skip: !hasX265 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dv-units-"));
  try {
    const plain = path.join(dir, "plain.hevc");
    await runFfmpeg("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-t", "4",
      "-c:v", "libx265", "-x265-params", "log-level=0:keyint=24", "-f", "hevc", plain]);
    // After every slice, an RPU and an enhancement layer unit, as a profile 7 Blu-ray rip carries them.
    const data = await readFile(plain);
    const starts: number[] = [];
    for (let at = data.indexOf(START_CODE); at >= 0; at = data.indexOf(START_CODE, at + 3)) starts.push(at);
    starts.push(data.length);
    const units: Buffer[] = [];
    for (let i = 0; i < starts.length - 1; i++) {
      const nal = data.subarray(starts[i] + 3, starts[i + 1]);
      units.push(Buffer.from([0, 0, 0, 1]), nal);
      if (((nal[0] >> 1) & 0x3f) < 32) for (const type of [62, 63]) units.push(Buffer.from([0, 0, 0, 1, type << 1, 1]), Buffer.alloc(32, 0x55));
    }
    await writeFile(path.join(dir, "dv.hevc"), Buffer.concat(units));
    const source = path.join(dir, "dv.mkv");
    await runFfmpeg("ffmpeg", ["-v", "error", "-f", "hevc", "-framerate", "24", "-i", path.join(dir, "dv.hevc"), "-c", "copy", "-bsf:v", "setts=ts=N", path.join(dir, "dv.mp4")]);
    await runFfmpeg("ffmpeg", ["-v", "error", "-i", path.join(dir, "dv.mp4"), "-c", "copy", source]);
    const count = async (input: string) => {
      const { stderr } = await runFfmpeg("ffmpeg", ["-v", "trace", "-i", input, "-c:v", "copy", "-bsf:v", "trace_headers", "-f", "null", "-"], { maxBuffer: 64 * 1024 * 1024 });
      return stderr.split("\n").filter((line) => line.includes("trace_headers") && /UNSPEC6[23]/.test(line)).length;
    };
    assert.ok(await count(source) > 0, "the source carries the units");
    const out = path.join(dir, "hls");
    await mkdir(out);
    await runFfmpeg("ffmpeg", ["-v", "error", "-strict", "unofficial", "-ss", "1", "-i", source, "-map", "0:v:0", "-avoid_negative_ts", "make_zero",
      "-c:v", "copy", "-tag:v", "hvc1", "-bsf:v", DOLBY_VISION_UNITS_FILTER,
      "-f", "hls", "-hls_time", "2", "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4", path.join(out, "index.m3u8")]);
    assert.equal(await count(path.join(out, "index.m3u8")), 0, "no Dolby Vision unit reaches the player");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("ordinary HEVC Main 10 still copies when the client supports it", () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const session = {
    stream: { url: "https://example.test/movie.mkv" },
    capabilities: { hevc: true, hevc10: true, eac3: true },
    info: {
      container: "matroska,webm",
      video: { codec: "hevc", profile: "Main 10", pixelFormat: "yuv420p10le" },
      audio: { codec: "eac3" },
      audioTracks: [{ index: 0, codec: "eac3" }],
      subtitleTracks: [],
    },
    quality: null,
    audioTrack: 0,
    subtitleTrack: null,
  };

  assert.equal(manager.plan(session).copyVideo, true);
});

test("copied AAC is rewritten out of ADTS, which fMP4 will not take", () => {
  // Without it the muxer refuses every packet and FFmpeg dies before writing the
  // master playlist's stream line, leaving the client a master with no CODECS.
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const session = {
    stream: { url: "https://example.test/master.m3u8" },
    capabilities: { h264: true, aac: true },
    info: {
      container: "hls,applehttp",
      video: { codec: "h264" },
      audio: { codec: "aac" },
      audioTracks: [{ codec: "aac" }],
      subtitleTracks: [],
    },
    quality: null,
    audioTrack: 0,
    subtitleTrack: null,
  };

  const args = manager.args(session, 0, tmp("output"), false) as string[];
  assert.equal(args[args.indexOf("-c:a") + 1], "copy");
  assert.equal(args[args.indexOf("-bsf:a") + 1], "aac_adtstoasc");
});

test("copied AAC from a file is left alone, ADTS only comes from a playlist", () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const session = {
    stream: { url: "https://example.test/movie.mkv" },
    capabilities: { h264: true, aac: true },
    info: {
      container: "matroska,webm",
      video: { codec: "h264" },
      audio: { codec: "aac" },
      audioTracks: [{ codec: "aac" }],
      subtitleTracks: [],
    },
    quality: null,
    audioTrack: 0,
    subtitleTrack: null,
  };

  const args = manager.args(session, 0, tmp("output"), false) as string[];
  assert.equal(args[args.indexOf("-c:a") + 1], "copy");
  assert.equal(args.includes("-bsf:a"), false);
});

test("audio that is not AAC is copied without the AAC filter", () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const session = {
    stream: { url: "https://example.test/movie.mkv" },
    capabilities: { h264: true, eac3: true },
    info: {
      video: { codec: "h264" },
      audio: { codec: "eac3" },
      audioTracks: [{ codec: "eac3" }],
      subtitleTracks: [],
    },
    quality: null,
    audioTrack: 0,
    subtitleTrack: null,
  };

  const args = manager.args(session, 0, tmp("output"), false) as string[];
  assert.equal(args[args.indexOf("-c:a") + 1], "copy");
  assert.equal(args.includes("-bsf:a"), false);
});

test("a transcoded track is re-encoded to AAC, so it needs no filter", () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const session = {
    stream: { url: "https://example.test/master.m3u8" },
    capabilities: { h264: false, aac: true },
    info: {
      container: "hls,applehttp",
      video: { codec: "hevc" },
      audio: { codec: "aac" },
      audioTracks: [{ codec: "aac" }],
      subtitleTracks: [],
    },
    quality: null,
    audioTrack: 0,
    subtitleTrack: null,
  };

  const args = manager.args(session, 0, tmp("output"), false) as string[];
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  assert.equal(args.includes("-bsf:a"), false);
});

test("text subtitles behind a filtered-out PGS track use the real index", () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const session = {
    stream: { url: "https://example.test/movie.mkv" },
    capabilities: { h264: true, aac: true },
    info: {
      video: { codec: "h264" },
      audio: { codec: "aac" },
      audioTracks: [{ index: 0, codec: "aac" }],
      // 0:s:0 was PGS and probe() filtered it out. The surviving text track is 0:s:1.
      subtitleTracks: [{ index: 1, codec: "subrip", language: "cs" }],
    },
    quality: null,
    audioTrack: 0,
    subtitleTrack: 1,
  };

  assert.equal(manager.preferredSubtitle(session.info.subtitleTracks, "cs"), 1);
  const args = manager.args(session, 0, tmp("output"), false) as string[];
  // WebVTT in the fMP4 mux dies with "timescale not set"; the track is extracted as a sidecar.
  assert.equal(args.includes("0:s:1?"), false);
  assert.equal(args.includes("webvtt"), false);
  assert.equal(args[args.indexOf("-var_stream_map") + 1], "v:0,a:0");
});

test("a seek with copied AC3 audio converts it to AAC for the fMP4 init segment", () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const session = {
    stream: { url: "https://example.test/movie.mkv" },
    capabilities: { hevc: true, ac3: true },
    info: {
      video: { codec: "hevc" },
      audio: { codec: "ac3" },
      audioTracks: [{ index: 0, codec: "ac3" }],
      subtitleTracks: [],
    },
    quality: null,
    audioTrack: 0,
    subtitleTrack: null,
  };

  const initial = manager.args(session, 0, tmp("output"), false) as string[];
  assert.equal(initial[initial.indexOf("-c:a") + 1], "copy");
  const seeked = manager.args(session, 2369, tmp("output"), false) as string[];
  const audio = seeked.indexOf("-c:a");
  assert.deepEqual(seeked.slice(audio, audio + 6), ["-c:a", "aac", "-ac", "2", "-b:a", "160k"]);
});

test("a conversion reconnects when a remote source drops the stream", () => {
  const manager = new PlaybackManager(tmp("test-playback-reconnect")) as any;
  const session = {
    stream: { url: "https://example.test/large.mkv" },
    capabilities: { hevc: true, ac3: true },
    info: {
      video: { codec: "hevc" },
      audio: { codec: "ac3" },
      audioTracks: [{ index: 0, codec: "ac3" }],
      subtitleTracks: [],
    },
    quality: null,
    audioTrack: 0,
    subtitleTrack: null,
  };

  const args = manager.args(session, 3949, tmp("output"), false) as string[];
  const input = args.indexOf("-i");
  assert.ok(input > 0, "the input position is present");
  assert.deepEqual(args.slice(args.indexOf("-reconnect"), args.indexOf("-reconnect") + 8), [
    "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "10",
  ]);
  assert.ok(args.indexOf("-reconnect") < input, "reconnect options apply to the input, not the output");
  assert.ok(args.indexOf("-strict") < input, "HEVC copies ask the input demuxer for non-strict handling");
  const tag = args.indexOf("-tag:v");
  assert.equal(args[tag + 1], "hvc1");
  // The Dolby Vision configuration is deliberately left out of the segments: a browser handed
  // one answers every append with "SourceBuffer error" and shows nothing.
  assert.deepEqual(args.slice(tag + 2, tag + 6), ["-bsf:v", DOLBY_VISION_UNITS_FILTER, "-c:a", "aac"]);
});

test("a trailing request for the previous generation still gets its directory for a while", () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const session = {
    id: "s1", mode: "remux", generation: 3, directory: tmp("test-playback/s1/3"),
    lastAccess: 0, claimed: false,
    retired: { generation: 2, directory: tmp("test-playback/s1/2"), until: Date.now() + 5_000 },
  };
  manager.sessions.set("s1", session);

  assert.equal(manager.directory("s1", "3"), tmp("test-playback/s1/3"));
  assert.equal(manager.directory("s1", "2"), tmp("test-playback/s1/2"));
  assert.equal(session.claimed, true);
  assert.equal(manager.directory("s1", "1"), undefined);

  session.retired.until = Date.now() - 1;
  assert.equal(manager.directory("s1", "2"), undefined);
});

test("a session no client claimed is closed by the sweep sooner than an idle one", async () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const stopped: string[] = [];
  manager.stop = async (id: string) => { stopped.push(id); manager.sessions.delete(id); };
  const base = { mode: "transcode", operations: new SerialOperations(), stopped: false };
  manager.sessions.set("neprevzata", { ...base, id: "neprevzata", claimed: false, lastAccess: Date.now() - 60_000 });
  manager.sessions.set("hraje", { ...base, id: "hraje", claimed: true, lastAccess: Date.now() - 60_000 });
  manager.sessions.set("primo", { ...base, id: "primo", mode: "direct", claimed: false, lastAccess: Date.now() - 60_000 });

  manager.reap();

  assert.deepEqual(stopped, ["neprevzata"]);
});

test("concurrent inspect of the same URL runs ffprobe once", async () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  let calls = 0;
  manager.probeSource = async () => {
    calls += 1;
    await pause(30);
    return { video: { codec: "h264" }, duration: 120, audioTracks: [{ codec: "aac" }], subtitleTracks: [] };
  };
  const stream = { url: "https://cdn.example/movie.mkv" };
  const [first, second] = await Promise.all([manager.inspect(stream), manager.inspect(stream)]);
  assert.equal(calls, 1);
  assert.equal(first, second);
  await manager.inspect(stream);
  assert.equal(calls, 1);
});

test("sourceReachable answers from a one-byte range request", async (t) => {
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  t.after(() => { delete process.env.ALLOW_PRIVATE_ADDONS; });
  setFetchTransport(async () => new Response(null, { status: 206 }));
  t.after(() => setFetchTransport());
  assert.equal(await sourceReachable({ url: "https://cdn.example/movie.mkv" }), true);
});

test("sourceReachable is false for a connection the source refuses", async (t) => {
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  t.after(() => { delete process.env.ALLOW_PRIVATE_ADDONS; });
  setFetchTransport(async () => { throw new Error("connect ECONNREFUSED"); });
  t.after(() => setFetchTransport());
  assert.equal(await sourceReachable({ url: "https://cdn.example/movie.mkv" }), false);
});

test("sourceReachable skips the check for a local file", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }));
  assert.equal(await sourceReachable({ url: "file:///downloads/movie.mkv" }), true);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("an unreachable source is never handed to ffprobe", async (t) => {
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  t.after(() => { delete process.env.ALLOW_PRIVATE_ADDONS; });
  setFetchTransport(async () => { throw new Error("connect ETIMEDOUT"); });
  t.after(() => setFetchTransport());
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const info = await manager.inspect({ url: "https://cdn.example/movie.mkv" });
  assert.equal(info, undefined);
});

test("inspect of different URLs is not coalesced", async () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const seen: string[] = [];
  manager.probeSource = async (stream: { url: string }) => {
    seen.push(stream.url);
    await pause(10);
    return { video: { codec: "h264" }, duration: 60, audioTracks: [], subtitleTracks: [] };
  };
  await Promise.all([
    manager.inspect({ url: "https://cdn.example/a.mkv" }),
    manager.inspect({ url: "https://cdn.example/b.mkv" }),
  ]);
  assert.deepEqual(seen.sort(), ["https://cdn.example/a.mkv", "https://cdn.example/b.mkv"]);
});

const aborted = (error: unknown) => (error as Error)?.name === "AbortError";
const cancelableInfo = { container: "matroska", duration: 120, video: { codec: "h264" }, audioTracks: [], subtitleTracks: [] };
const later = () => Date.now() + 3_600_000;

/** A probe that honours the caller's signal the way the real one does, so a cancel lands promptly. */
const cancelableProbe = (manager: any) => {
  const started: Array<{ url: string; path: string; signal?: AbortSignal }> = [];
  manager.probeSource = (stream: { url: string }, signal?: AbortSignal) => new Promise((resolve, reject) => {
    started.push({ url: stream.url, path: manager.proxyPath(stream), signal });
    const timer = setTimeout(() => resolve(cancelableInfo), 60);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
  return started;
};

test("a reachability check whose caller already aborted asks the source nothing", async (t) => {
  let asked = 0;
  setFetchTransport(async () => { asked += 1; return new Response(null, { status: 206 }); });
  t.after(() => setFetchTransport());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sourceReachable({ url: "https://cdn.example/movie.mkv" }, 8_000, controller.signal), aborted);
  assert.equal(asked, 0, "the abort is not turned into an ordinary reachability answer");
});

test("an inspection whose caller already aborted reaches neither the source nor ffprobe", async (t) => {
  let asked = 0;
  setFetchTransport(async () => { asked += 1; return new Response(null, { status: 206 }); });
  t.after(() => setFetchTransport());
  const manager = new PlaybackManager(tmp("test-preabort-inspect")) as any;
  const controller = new AbortController();
  controller.abort();
  // The real probeSource runs, so this fails unless both guards hold: the reachability range
  // request is never sent, and the ffprobe process (covered in probe.test.ts) never starts.
  await assert.rejects(manager.inspect({ url: "https://cdn.example/movie.mkv" }, controller.signal), aborted);
  assert.equal(asked, 0);
});

test("two requests inspecting the same source at once share one probe", async (t) => {
  const manager = new PlaybackManager(tmp("test-cancelable-inspect")) as any;
  const started = cancelableProbe(manager);
  const url = "https://cdn.example/shared.mkv";
  const owner = (sid: string): ResourceOwner => ({ userId: "usr_00000001", sid, expiresAt: later() });
  const one = registry.mediaStream({ url }, owner("sid-one"));
  const two = registry.mediaStream({ url }, owner("sid-two"));
  t.after(() => { registry.remove(one.resourceId); registry.remove(two.resourceId); });
  assert.notEqual(manager.proxyPath(one.stream), manager.proxyPath(two.stream), "each request holds its own private resource");

  const first = new AbortController();
  const second = new AbortController();
  const canceled = manager.inspect(one.stream, first.signal);
  const kept = manager.inspect(two.stream, second.signal);
  assert.equal(started.length, 1, "both requests joined the same cold probe");

  const [firstResult, secondResult] = await Promise.all([canceled, kept]);
  assert.equal(firstResult?.duration, 120);
  assert.equal(secondResult?.duration, 120);
});

test("the probe outlives the request it started through", async (t) => {
  const manager = new PlaybackManager(tmp("test-cancelable-restart")) as any;
  const started = cancelableProbe(manager);
  const url = "https://cdn.example/restart.mkv";
  const owner = (sid: string): ResourceOwner => ({ userId: "usr_00000001", sid, expiresAt: later() });
  const one = registry.mediaStream({ url }, owner("sid-one"));
  const two = registry.mediaStream({ url }, owner("sid-two"));
  t.after(() => { registry.remove(one.resourceId); registry.remove(two.resourceId); });

  const first = new AbortController();
  const second = new AbortController();
  const canceled = manager.inspect(one.stream, first.signal);
  const kept = manager.inspect(two.stream, second.signal);
  assert.equal(started.length, 1);
  assert.equal(started[0].path, manager.proxyPath(one.stream), "the first request started the probe");

  first.abort();
  await assert.rejects(canceled, aborted);
  assert.equal(started.length, 2, "the probe restarted through the remaining request");
  assert.equal(started[1].path, manager.proxyPath(two.stream), "the restart used the second request's path");
  assert.equal((await kept)?.duration, 120);
});

test("the probe stops when every request has left", async (t) => {
  const manager = new PlaybackManager(tmp("test-cancelable-empty")) as any;
  const started = cancelableProbe(manager);
  const url = "https://cdn.example/empty.mkv";
  const owner = (sid: string): ResourceOwner => ({ userId: "usr_00000001", sid, expiresAt: later() });
  const one = registry.mediaStream({ url }, owner("sid-one"));
  const two = registry.mediaStream({ url }, owner("sid-two"));
  t.after(() => { registry.remove(one.resourceId); registry.remove(two.resourceId); });

  const first = new AbortController();
  const second = new AbortController();
  const canceled = manager.inspect(one.stream, first.signal);
  const kept = manager.inspect(two.stream, second.signal);
  first.abort();
  await assert.rejects(canceled, aborted);
  second.abort();
  await assert.rejects(kept, aborted);

  assert.equal(started.at(-1)?.signal?.aborted, true, "the running probe was cancelled");
  assert.equal(manager.cancelableInspecting.size, 0, "the empty entry was removed");
  assert.equal(manager.inspected.has(manager.inspectionKey(one.stream)), false, "the aborted probe cached nothing");

  const retry = manager.inspect(one.stream, new AbortController().signal);
  assert.equal((await retry)?.duration, 120);
  assert.equal(started.length, 3, "the later request probed again");
});

test("a request that left is not answered later", async (t) => {
  const manager = new PlaybackManager(tmp("test-cancelable-left")) as any;
  const started = cancelableProbe(manager);
  const url = "https://cdn.example/left.mkv";
  const owner = (sid: string): ResourceOwner => ({ userId: "usr_00000001", sid, expiresAt: later() });
  const one = registry.mediaStream({ url }, owner("sid-one"));
  const two = registry.mediaStream({ url }, owner("sid-two"));
  t.after(() => { registry.remove(one.resourceId); registry.remove(two.resourceId); });

  const first = new AbortController();
  const second = new AbortController();
  const kept = manager.inspect(one.stream, first.signal);
  let answered = false;
  const canceled = manager.inspect(two.stream, second.signal).then((info: typeof cancelableInfo | undefined) => { answered = true; return info; });
  assert.equal(started.length, 1);

  second.abort();
  await assert.rejects(canceled, aborted);
  assert.equal((await kept)?.duration, 120);
  assert.equal(answered, false, "the shared completion did not answer the request that left");
});

test("a cancelled inspection caches nothing and a retry really probes", async () => {
  const manager = new PlaybackManager(tmp("test-cancelable-retry")) as any;
  const started = cancelableProbe(manager);
  const stream = { url: "https://cdn.example/retry.mkv" };
  const first = new AbortController();
  const canceled = manager.inspect(stream, first.signal);
  first.abort();
  await assert.rejects(canceled, aborted);
  assert.equal(manager.cancelableInspecting.size, 0, "the aborted entry was dropped");

  const retry = new AbortController();
  assert.equal((await manager.inspect(stream, retry.signal))?.duration, 120, "the retry probed for real");
  assert.equal(started.length, 2);
  assert.equal((await manager.inspect(stream, new AbortController().signal))?.duration, 120, "a finished probe is shared from the cache");
  assert.equal(started.length, 2, "a cache hit probes nothing");
});

test("a cancelled inspection does not delete another request's in-flight probe", async (t) => {
  const manager = new PlaybackManager(tmp("test-cancelable-shared")) as any;
  const started = cancelableProbe(manager);
  const url = "https://cdn.example/also-shared.mkv";
  const resource = registry.mediaStream({ url }, { userId: "usr_00000001", sid: "sid-shared", expiresAt: later() });
  t.after(() => registry.remove(resource.resourceId));

  const plain = manager.inspect({ url });
  const controller = new AbortController();
  const canceled = manager.inspect(resource.stream, controller.signal);
  assert.equal(started.length, 2, "the shared map and the cancelable map do not share a cold probe");

  controller.abort();
  await assert.rejects(canceled, aborted);
  // The no-signal probe is still running: asking again must join it, not start a third one.
  const joined = manager.inspect({ url });
  assert.equal(started.length, 2, "the cancelled completion left the other pending probe in place");
  assert.equal((await joined)?.duration, 120);
  assert.equal((await plain)?.duration, 120);
});

test("a start canceled before any work opens no session", async () => {
  const manager = new PlaybackManager(tmp("test-preabort-start")) as any;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(manager.start({ url: "https://cdn.example/movie.mkv" }, {}, {}, controller.signal), aborted);
  assert.equal(manager.sessions.size, 0);
});

test("a start canceled while the source is being inspected creates no session", async () => {
  const manager = new PlaybackManager(tmp("test-cancel-start-inspect")) as any;
  manager.inspect = (_stream: unknown, signal?: AbortSignal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(cancelableInfo), 5_000);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
  const controller = new AbortController();
  const started = manager.start({ url: "https://cdn.example/movie.mkv" }, {}, {}, controller.signal);
  await pause(20);
  controller.abort();
  await assert.rejects(started, aborted);
  assert.equal(manager.sessions.size, 0, "nothing was registered");
});

test("a start canceled while the conversion opens leaves no session, converter or sidecar", async () => {
  const manager = new PlaybackManager(tmp("test-cancel-start-open")) as any;
  manager.inspect = async () => ({
    container: "matroska,webm", duration: 3600,
    video: { codec: "hevc" }, audio: { codec: "aac" },
    audioTracks: [{ index: 0, codec: "aac" }], subtitleTracks: [],
  });
  const converter = { exitCode: null, signalCode: null };
  const killed: unknown[] = [];
  let releaseKill!: () => void;
  const killGate = new Promise<void>((resolve) => { releaseKill = resolve; });
  manager.killChild = async (child?: unknown) => { if (child) { killed.push(child); await killGate; } };
  const purged: string[] = [];
  manager.purgeNow = async (directory: string) => { purged.push(directory); };
  const sidecarStops: string[] = [];
  let ensured = 0;
  manager.sidecars = { stop: async (id: string) => { sidecarStops.push(id); }, ensure: () => { ensured += 1; } };
  manager.spawnAt = async (session: any) => {
    session.process = converter;
    session.directory = tmp("test-cancel-start-open/1");
    while (!session.stopped) await pause(5);
    throw new Error("The playback session no longer exists.");
  };

  const controller = new AbortController();
  const started = manager.start({ url: "https://cdn.example/large.mkv" }, {}, {}, controller.signal);
  await pause(30);
  assert.equal(manager.sessions.size, 1, "the session exists while the conversion is opening");

  let settled = false;
  void started.then(() => { settled = true; }, () => { settled = true; });
  controller.abort();
  try {
    await pause(20);
    assert.equal(manager.sessions.size, 0, "the session is removed while cleanup is still pending");
    assert.equal(settled, false, "start waits for the first asynchronous stop, even after the session was removed");
  } finally { releaseKill(); }
  await assert.rejects(started, /no longer exists/);
  assert.equal(manager.sessions.size, 0, "no session is left behind");
  assert.deepEqual(killed, [converter], "the converter was stopped exactly once");
  assert.equal(sidecarStops.length, 1, "the sidecars were stopped with the session");
  assert.equal(ensured, 0, "no sidecar reader was started");
  assert.equal(purged.length, 1, "the session's directory was cleaned up");
});

const playCaps = {
  h264: true, hevc: true, hevc10: true, vp8: true, vp9: true, av1: true,
  aac: true, mp3: true, opus: true, vorbis: true,
};

const nativeCaps = {
  h264: true, hevc: true, hevc10: true,
  containers: ["mp4", "mkv"],
  audioDecode: ["aac", "ac3", "eac3"],
  audioPassthrough: ["dts"],
  subtitles: ["subrip", "hdmv_pgs_subtitle"],
};

const fourKInfo = {
  container: "matroska,webm",
  duration: 3600,
  video: {
    codec: "hevc", width: 3840, height: 2160, profile: "Main 10",
    pixelFormat: "yuv420p10le", transfer: "smpte2084",
  },
  audio: { codec: "eac3", channels: 6 },
  audioTracks: [{ index: 0, codec: "eac3", channels: 6 }],
  subtitleTracks: [],
  chapters: [
    { start: 0, end: 60, title: "Opening on cdn.example" },
    { start: 60, end: 120, title: "Part one" },
  ],
};
const safeChapters = [
  { start: 0, end: 60, title: "Opening on [redacted]" },
  { start: 60, end: 120, title: "Part one" },
];

test("a direct HDR source reports its chapters and the streams the player receives", async () => {
  const manager = new PlaybackManager(tmp("test-playback-facts-direct")) as any;
  manager.inspect = async () => fourKInfo;
  manager.spawnAt = async () => { throw new Error("direct play must not spawn a conversion"); };

  const started = await manager.start({ url: "https://cdn.example/movie.mkv" }, nativeCaps);

  assert.equal(started.mode, "direct");
  assert.deepEqual(started.playing, {
    resolution: 2160,
    hdr: "hdr10",
    videoCodec: "hevc",
    audioCodec: "eac3",
    audioChannels: 6,
  });
  assert.deepEqual(started.chapters, safeChapters);
});

test("a 720p transcode reports the scaled SDR H.264 and stereo AAC output", async () => {
  const manager = new PlaybackManager(tmp("test-playback-facts-transcode")) as any;
  manager.inspect = async () => fourKInfo;
  manager.spawnAt = async (session: any, time: number) => {
    session.offset = time;
    session.mode = manager.plan(session).copyVideo ? "remux" : "transcode";
    return "/hls";
  };

  const started = await manager.start({ url: "https://cdn.example/movie.mkv" }, playCaps, { quality: 720 });

  assert.equal(started.mode, "transcode");
  assert.deepEqual(started.playing, {
    resolution: 720,
    videoCodec: "h264",
    audioCodec: "aac",
    audioChannels: 2,
  });
  assert.deepEqual(started.chapters, safeChapters);
});

test("an AC-3 remux reports copied 5.1 at the start and stereo AAC after a seek", async () => {
  const manager = new PlaybackManager(tmp("test-playback-facts-ac3")) as any;
  manager.inspect = async () => ({
    container: "matroska,webm",
    duration: 3600,
    video: { codec: "h264", pixelFormat: "yuv420p" },
    audio: { codec: "ac3", channels: 6 },
    audioTracks: [{ index: 0, codec: "ac3", channels: 6 }],
    subtitleTracks: [],
  });
  manager.spawnAt = async (session: any, time: number) => {
    session.offset = time;
    session.mode = manager.plan(session).copyVideo ? "remux" : "transcode";
    return "/hls";
  };

  const started = await manager.start({ url: "https://cdn.example/movie.mkv" }, { h264: true, ac3: true });
  const session = manager.sessions.get(started.id);

  assert.deepEqual(started.copy, { video: true, audio: true });
  assert.equal(started.playing?.audioCodec, "ac3");
  assert.equal(started.playing?.audioChannels, 6);
  const initialArgs = manager.args(session, 0, tmp("output"), false) as string[];
  assert.equal(initialArgs[initialArgs.indexOf("-c:a") + 1], "copy");

  const seeked = await manager.seek(started.id, 600);
  assert.deepEqual(seeked.copy, { video: true, audio: false });
  assert.equal(seeked.playing?.audioCodec, "aac");
  assert.equal(seeked.playing?.audioChannels, 2);
  const seekedArgs = manager.args(session, 600, tmp("output"), false) as string[];
  assert.deepEqual(seekedArgs.slice(seekedArgs.indexOf("-c:a"), seekedArgs.indexOf("-c:a") + 5), [
    "-c:a", "aac", "-ac", "2", "-b:a",
  ]);
});

test("a seek converts copied E-AC-3 but still copies AAC 5.1", async () => {
  const startRemux = async (codec: "eac3" | "aac") => {
    const manager = new PlaybackManager(tmp(`test-playback-facts-${codec}`)) as any;
    manager.inspect = async () => ({
      container: "matroska,webm",
      duration: 3600,
      video: { codec: "h264", pixelFormat: "yuv420p" },
      audio: { codec, channels: 6 },
      audioTracks: [{ index: 0, codec, channels: 6 }],
      subtitleTracks: [],
    });
    manager.spawnAt = async (session: any, time: number) => {
      session.offset = time;
      session.mode = manager.plan(session).copyVideo ? "remux" : "transcode";
      return "/hls";
    };
    const started = await manager.start({ url: "https://cdn.example/movie.mkv" }, { h264: true, [codec]: true });
    const seeked = await manager.seek(started.id, 600);
    return { manager, session: manager.sessions.get(started.id), seeked };
  };

  const eac3 = await startRemux("eac3");
  assert.deepEqual(eac3.seeked.copy, { video: true, audio: false });
  assert.equal(eac3.seeked.playing?.audioCodec, "aac");
  assert.equal(eac3.seeked.playing?.audioChannels, 2);
  const eac3Args = eac3.manager.args(eac3.session, 600, tmp("output"), false) as string[];
  assert.equal(eac3Args[eac3Args.indexOf("-c:a") + 1], "aac");

  const aac = await startRemux("aac");
  assert.deepEqual(aac.seeked.copy, { video: true, audio: true });
  assert.equal(aac.seeked.playing?.audioCodec, "aac");
  assert.equal(aac.seeked.playing?.audioChannels, 6);
  const aacArgs = aac.manager.args(aac.session, 600, tmp("output"), false) as string[];
  assert.equal(aacArgs[aacArgs.indexOf("-c:a") + 1], "copy");
});

test("a transcode with AC-3 audio reports stereo AAC", async () => {
  const manager = new PlaybackManager(tmp("test-playback-facts-ac3-transcode")) as any;
  manager.inspect = async () => ({
    container: "matroska,webm",
    duration: 3600,
    video: { codec: "hevc", profile: "Main 10", pixelFormat: "yuv420p10le" },
    audio: { codec: "ac3", channels: 6 },
    audioTracks: [{ index: 0, codec: "ac3", channels: 6 }],
    subtitleTracks: [],
  });
  manager.spawnAt = async (session: any, time: number) => {
    session.offset = time;
    session.mode = manager.plan(session).copyVideo ? "remux" : "transcode";
    return "/hls";
  };

  const started = await manager.start({ url: "https://cdn.example/movie.mkv" }, { hevc: true, hevc10: false, ac3: true });
  const session = manager.sessions.get(started.id);

  assert.equal(started.mode, "transcode");
  assert.deepEqual(started.copy, { video: false, audio: false });
  assert.equal(started.playing?.audioCodec, "aac");
  assert.equal(started.playing?.audioChannels, 2);
  const args = manager.args(session, 0, tmp("output"), false) as string[];
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  assert.equal(args[args.indexOf("-ac") + 1], "2");
});

test("hlsCanStart waits for the segments asked for unless the playlist has ended", () => {
  const head = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n";
  const one = `${head}#EXTINF:2.000,\nseg-0-000000.m4s\n`;
  const two = `${one}#EXTINF:2.000,\nseg-0-000001.m4s\n`;
  assert.equal(hlsCanStart(one, 2), false);
  assert.equal(hlsCanStart(two, 2), true);
  // A clip shorter than two segments ends with one; waiting for a second would never end.
  assert.equal(hlsCanStart(`${one}#EXT-X-ENDLIST\n`, 2), true);
  assert.equal(hlsCanStart(`#EXTM3U\n#EXTINF:2.000,\nseg-0-000000.m4s\n#EXTINF:2.000,\nseg-0-000001.m4s\n`, 2), false, "the init must still be named");
});

test("hlsCanStart accepts one segment or a finished playlist", () => {
  assert.equal(hlsCanStart("#EXTM3U\n#EXT-X-VERSION:7\n"), false);
  // A segment without EXT-X-MAP is the race that hands Safari a truncated init.mp4.
  assert.equal(hlsCanStart("#EXTM3U\n#EXTINF:2.000,\nseg-0-000000.m4s\n"), false);
  assert.equal(hlsCanStart("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2.000,\nseg-0-000000.m4s\n"), true);
  assert.equal(hlsCanStart("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2.000,\na.m4s\n#EXTINF:2.000,\nb.m4s\n"), true);
  assert.equal(hlsCanStart("#EXTM3U\n#EXT-X-ENDLIST\n"), true);
  assert.deepEqual(
    hlsPlaylistFiles("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2.000,\nseg-0-000000.m4s\n"),
    ["init.mp4", "seg-0-000000.m4s"],
  );
  assert.deepEqual(hlsPlaylistFiles("#EXTM3U\n#EXT-X-MAP:URI=\"../escape.mp4\"\nseg-0-000000.m4s\n"), ["seg-0-000000.m4s"]);
});

test("direct play follows the probed container, not a misleading filename", () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const mp4 = { container: "mov,mp4,m4a,3gp,3g2,mj2", video: { codec: "h264" }, audio: { codec: "aac" } };
  assert.equal(manager.directPlay({ url: "https://cdn.example/a", behaviorHints: { filename: "Movie.mkv" } }, mp4, playCaps).ok, true);
  const mkv = { container: "matroska,webm", video: { codec: "h264" }, audio: { codec: "aac" } };
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mkv", behaviorHints: { filename: "Movie.mkv" } }, mkv, playCaps).ok, false);
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mp4", behaviorHints: { filename: "Movie.mp4" } }, mkv, playCaps).ok, false);
});

test("direct play still uses the extension when ffprobe omitted the format name", () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const info = { container: "", video: { codec: "h264" }, audio: { codec: "aac" } };
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mp4", behaviorHints: { filename: "Movie.mp4" } }, info, playCaps).ok, true);
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mkv", behaviorHints: { filename: "Movie.mkv" } }, info, playCaps).ok, false);
});

test("webm codecs inside matroska,webm play directly; h264 in that container does not", () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const webm = { container: "matroska,webm", video: { codec: "vp9" }, audio: { codec: "opus" } };
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mkv" }, webm, playCaps).ok, true);
  const mkv = { container: "matroska,webm", video: { codec: "h264" }, audio: { codec: "aac" } };
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.webm" }, mkv, playCaps).ok, false);
});

test("incompatible codecs, HLS and notWebReady still force a conversion", () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const mp4 = { container: "mov,mp4,m4a,3gp,3g2,mj2", video: { codec: "h264" }, audio: { codec: "aac" } };
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mp4", behaviorHints: { notWebReady: true } }, mp4, playCaps).ok, false);
  const ac3 = { container: "mov,mp4,m4a,3gp,3g2,mj2", video: { codec: "h264" }, audio: { codec: "ac3" } };
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mp4" }, ac3, playCaps).ok, false);
  const hevc10 = { container: "mov,mp4,m4a,3gp,3g2,mj2", video: { codec: "hevc", profile: "Main 10", pixelFormat: "yuv420p10le" }, audio: { codec: "aac" } };
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mp4" }, hevc10, { ...playCaps, hevc10: false }).ok, false);
  const hls = { container: "hls,applehttp", video: { codec: "h264" }, audio: { codec: "aac" } };
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.m3u8" }, hls, playCaps).ok, false);
  // The probe wins over a filename the addon made up for the playlist.
  assert.equal(manager.directPlay({ url: "https://cdn.example/master.m3u8", behaviorHints: { filename: "Film.mp4" } }, { container: "hls", video: { codec: "h264" }, audio: { codec: "aac" } }, playCaps).ok, false);
  const avi = { container: "avi", video: { codec: "mpeg4" }, audio: { codec: "mp3" } };
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.avi" }, avi, playCaps).ok, false);
});

test("hevc tagged hev1 is remuxed for the browser, hvc1 or untagged plays directly", () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const mp4 = (codecTag?: string) => ({ container: "mov,mp4,m4a,3gp,3g2,mj2", video: { codec: "hevc", codecTag, profile: "Main", pixelFormat: "yuv420p" }, audio: { codec: "aac" } });
  const refused = manager.directPlay({ url: "https://cdn.example/a.mp4" }, mp4("hev1"), playCaps);
  assert.deepEqual(refused, { ok: false, reason: "hevc tagged hev1 needs the hvc1 tag" });
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mp4" }, mp4("hvc1"), playCaps).ok, true);
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mp4" }, mp4(), playCaps).ok, true);
  // The remux copies the picture and only rewrites the tag; no real transcode.
  const session = { capabilities: playCaps, info: mp4("hev1"), quality: null, audioTrack: 0 };
  assert.equal(manager.plan(session).copyVideo, true);
});

test("a playable mp4 with a preferred subtitle stays on direct play", async () => {
  const manager = new PlaybackManager(tmp("test-playback-sidecar")) as any;
  manager.inspect = async () => ({
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    video: { codec: "h264" }, audio: { codec: "aac" }, duration: 120,
    audioTracks: [{ index: 0, codec: "aac", language: "en" }],
    subtitleTracks: [{ index: 0, codec: "subrip", language: "cs" }],
  });
  let spawned = false;
  manager.spawnAt = async () => { spawned = true; return "/nope"; };
  let extracted = 0;
  manager.sidecars.run = async (_args: string[], _file: string, _append: boolean, signal: AbortSignal) => {
    extracted += 1;
    await whenAborted(signal);
  };
  const started = await manager.start({ url: "https://cdn.example/movie.mp4" }, playCaps, { subtitleLanguage: "cs" });
  assert.equal(spawned, false);
  assert.equal(started.mode, "direct");
  assert.equal(started.subtitleTrack, 0);
  assert.match(started.sidecarUrl ?? "", /sidecar\.vtt\?revision=/);
  while (!extracted) await pause(5);
  assert.equal(extracted, 1);
  await manager.sidecars.stop(started.id);
});

test("mkv with subtitles still remuxes", async () => {
  const manager = new PlaybackManager(tmp("test-playback-sidecar-mkv")) as any;
  manager.inspect = async () => ({
    container: "matroska,webm",
    video: { codec: "h264" }, audio: { codec: "aac" }, duration: 120,
    audioTracks: [{ index: 0, codec: "aac", language: "en" }],
    subtitleTracks: [{ index: 0, codec: "subrip", language: "cs" }],
  });
  let spawned = false;
  manager.spawnAt = async (session: { mode: string; offset: number }, time: number) => {
    spawned = true;
    session.offset = time;
    return "/hls";
  };
  let extracted = 0;
  manager.sidecars.run = async (_args: string[], _file: string, _append: boolean, signal: AbortSignal) => {
    extracted += 1;
    await whenAborted(signal);
  };
  const started = await manager.start({ url: "https://cdn.example/movie.mkv" }, playCaps, { subtitleLanguage: "cs" });
  assert.equal(spawned, true);
  assert.equal(started.mode, "remux");
  assert.match(started.sidecarUrl ?? "", /sidecar\.vtt\?revision=/);
  while (!extracted) await pause(5);
  assert.equal(extracted, 1);
  await manager.sidecars.stop(started.id);
});

test("a refused direct play logs its real reason when an embedded subtitle is chosen", async () => {
  const manager = new PlaybackManager(tmp("test-playback-reason")) as any;
  manager.inspect = async () => ({
    container: "matroska,webm",
    video: { codec: "h264", pixelFormat: "yuv420p" },
    audio: { codec: "ac3" },
    audioTracks: [{ index: 0, codec: "ac3", language: "en" }],
    subtitleTracks: [{ index: 0, codec: "subrip", language: "en" }],
  });
  manager.spawnAt = async (session: any, time: number) => {
    session.offset = time;
    session.mode = manager.plan(session).copyVideo ? "remux" : "transcode";
    return "/hls";
  };
  manager.extractSidecar = () => {};

  const started = await manager.start(
    { url: "https://cdn.example/movie.mkv" },
    { ...nativeCaps, audioDecode: ["aac"], audioPassthrough: [] },
    { subtitleTrack: 0 },
  );
  await flushLog();

  assert.equal(started.audioTrack, 0);
  assert.equal(started.subtitleTrack, 0);
  assert.equal(started.quality, null);
  const line = (await readLog({ search: `"id":"${started.id}"` }))
    .split("\n").find((entry) => entry.includes("Conversion started"));
  assert.ok(line);
  const context = JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>;
  assert.equal(context.reason, "client cannot play audio codec ac3");
});

test("clientCapabilities keeps only the shapes it declares", () => {
  assert.deepEqual(clientCapabilities(undefined), {});
  assert.deepEqual(clientCapabilities("native"), {});
  assert.deepEqual(clientCapabilities(42), {});
  assert.deepEqual(clientCapabilities(null), {});
  assert.deepEqual(clientCapabilities({ containers: "mkv" }), {});
  assert.deepEqual(clientCapabilities({ containers: ["MKV", "mkv", "a b", 7, "webm"], h264: "yes", airplay: true }), { containers: ["mkv", "webm"] });
  assert.deepEqual(clientCapabilities({ h264: "yes" }), {});
  assert.deepEqual(clientCapabilities({ h264: true, unknown: 1 }), { h264: true });
  const many = Array.from({ length: 40 }, (_, index) => `c${index}`);
  assert.equal(clientCapabilities({ containers: many }).containers?.length, 32);
});

const nativeInfo = (overrides: Record<string, unknown> = {}) => ({
  container: "matroska,webm", duration: 120,
  video: { codec: "h264", pixelFormat: "yuv420p" }, audio: { codec: "ac3" },
  audioTracks: [{ index: 0, codec: "ac3", language: "en" }], subtitleTracks: [],
  ...overrides,
});

test("a native client plays a declared mkv with ac3 audio directly", async () => {
  const manager = new PlaybackManager(tmp("test-native-direct")) as any;
  manager.inspect = async () => nativeInfo();
  let spawned = false;
  manager.spawnAt = async () => { spawned = true; return "/hls"; };

  const started = await manager.start({ url: "https://cdn.example/movie.mkv" }, nativeCaps);

  assert.equal(spawned, false);
  assert.equal(started.mode, "direct");
  assert.equal(started.copy, undefined);
});

test("a native client passes dts through to the receiver and stays direct", async () => {
  const manager = new PlaybackManager(tmp("test-native-dts")) as any;
  manager.inspect = async () => nativeInfo({ audio: { codec: "dts" }, audioTracks: [{ index: 0, codec: "dts", language: "en" }] });
  let spawned = false;
  manager.spawnAt = async () => { spawned = true; return "/hls"; };

  const started = await manager.start({ url: "https://cdn.example/movie.mkv" }, nativeCaps);

  assert.equal(spawned, false);
  assert.equal(started.mode, "direct");
});

test("a native client that cannot play the audio remuxes and copies only the video", async () => {
  const manager = new PlaybackManager(tmp("test-native-dts-remux")) as any;
  manager.inspect = async () => nativeInfo({ audio: { codec: "dts" }, audioTracks: [{ index: 0, codec: "dts", language: "en" }] });
  manager.spawnAt = async (session: any, time: number) => { session.offset = time; return "/hls"; };

  const started = await manager.start({ url: "https://cdn.example/movie.mkv" }, { ...nativeCaps, audioPassthrough: [] });

  assert.equal(started.mode, "remux");
  assert.deepEqual(started.copy, { video: true, audio: false });
});

test("a native client's declared second audio track still plays directly", async () => {
  const manager = new PlaybackManager(tmp("test-native-audio-track")) as any;
  manager.inspect = async () => nativeInfo({
    audioTracks: [{ index: 0, codec: "ac3", language: "en" }, { index: 1, codec: "ac3", language: "cs" }],
  });
  let spawned = false;
  manager.spawnAt = async () => { spawned = true; return "/hls"; };

  const started = await manager.start({ url: "https://cdn.example/movie.mkv" }, nativeCaps, { audioLanguage: "cs" });

  assert.equal(spawned, false);
  assert.equal(started.mode, "direct");
  assert.equal(started.audioTrack, 1);
});

test("a native client without hevc10 does not play Main 10 directly", async () => {
  const manager = new PlaybackManager(tmp("test-native-hevc10")) as any;
  manager.inspect = async () => nativeInfo({ video: { codec: "hevc", profile: "Main 10", pixelFormat: "yuv420p10le" } });
  manager.spawnAt = async (session: any, time: number) => { session.offset = time; return "/hls"; };

  const started = await manager.start({ url: "https://cdn.example/movie.mkv" }, { ...nativeCaps, hevc10: false });

  assert.notEqual(started.mode, "direct");
});

test("a native client gets a ten-bit H.264, VP9 or AV1 directly only when it declares deep colour", () => {
  const manager = new PlaybackManager(tmp("test-native-deep")) as any;
  const mkv = (video: Record<string, string>) => ({ container: "matroska,webm", video, audio: { codec: "aac" }, audioTracks: [{ index: 0, codec: "aac" }], subtitleTracks: [] });
  const caps = { ...nativeCaps, vp9: true, av1: true, containers: ["mkv", "webm"] };
  const hi10 = mkv({ codec: "h264", profile: "High 10", pixelFormat: "yuv420p10le" });
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mkv" }, hi10, caps).ok, false);
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mkv" }, hi10, { ...caps, deepColor: ["h264"] }).ok, true);
  const vp9 = mkv({ codec: "vp9", profile: "Profile 2", pixelFormat: "yuv420p10le" });
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mkv" }, vp9, caps).ok, false);
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mkv" }, vp9, { ...caps, deepColor: ["vp9"] }).ok, true);
  const av1 = mkv({ codec: "av1", profile: "Main", pixelFormat: "yuv420p" });
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mkv" }, av1, caps).ok, true);
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mkv" }, mkv({ codec: "av1", profile: "Main", pixelFormat: "yuv420p10le" }), caps).ok, false);
});

test("a native client gets nothing directly that the probe cannot show to be 4:2:0 at 8, 10 or 12 bits", () => {
  const manager = new PlaybackManager(tmp("test-native-unknown-format")) as any;
  const caps = { ...nativeCaps, vp9: true, av1: true, deepColor: ["h264", "hevc", "vp9", "av1"], containers: ["mkv", "webm"] };
  const mkv = (video: Record<string, string>) => ({ container: "matroska,webm", video, audio: { codec: "aac" }, audioTracks: [{ index: 0, codec: "aac" }], subtitleTracks: [] });
  for (const codec of ["h264", "hevc", "av1"]) {
    assert.equal(manager.directPlay({ url: "https://cdn.example/a.mkv" }, mkv({ codec }), caps).ok, false, `${codec} without a pixel format`);
  }
  for (const pixelFormat of ["yuv420p9le", "yuv420p14le", "yuv420p16le", "gray"]) {
    assert.equal(manager.directPlay({ url: "https://cdn.example/a.mkv" }, mkv({ codec: "hevc", profile: "Rext", pixelFormat }), caps).ok, false, pixelFormat);
  }
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mkv" }, mkv({ codec: "vp9", profile: "Profile 1" }), caps).ok, false);
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mkv" }, mkv({ codec: "vp9", profile: "Profile 1", pixelFormat: "yuv420p" }), caps).ok, false);
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mkv" }, mkv({ codec: "hevc", profile: "Main 10", pixelFormat: "yuv420p" }), { ...caps, deepColor: [], hevc10: false }).ok, false);
  for (const pixelFormat of ["yuv420p", "yuvj420p", "nv12", "yuv420p10le", "yuv420p10", "p010le", "p012le"]) {
    assert.equal(manager.directPlay({ url: "https://cdn.example/a.mkv" }, mkv({ codec: "hevc", profile: "Main", pixelFormat }), caps).ok, true, pixelFormat);
  }
});

test("a native client never gets 4:2:2 or 4:4:4 video directly, nor copied into a remux", async () => {
  const manager = new PlaybackManager(tmp("test-native-chroma")) as any;
  const caps = { ...nativeCaps, deepColor: ["h264"] };
  manager.inspect = async () => nativeInfo({ video: { codec: "h264", profile: "High 4:2:2", pixelFormat: "yuv422p10le" } });
  manager.spawnAt = async (session: any, time: number) => { session.offset = time; session.mode = manager.plan(session).copyVideo ? "remux" : "transcode"; return "/hls"; };

  const started = await manager.start({ url: "https://cdn.example/movie.mkv" }, caps);

  assert.equal(started.mode, "transcode");
  assert.equal(started.copy?.video, false);
});

test("a native client that does not declare mkv does not play an mkv directly", async () => {
  const manager = new PlaybackManager(tmp("test-native-container")) as any;
  manager.inspect = async () => nativeInfo();
  manager.spawnAt = async (session: any, time: number) => { session.offset = time; return "/hls"; };

  const started = await manager.start({ url: "https://cdn.example/movie.mkv" }, { ...nativeCaps, containers: ["mp4"] });

  assert.notEqual(started.mode, "direct");
});

test("notWebReady blocks the browser but not a native client", () => {
  const manager = new PlaybackManager(tmp("test-native-notwebready")) as any;
  const info = nativeInfo();
  const stream = { url: "https://cdn.example/movie.mkv", behaviorHints: { notWebReady: true } };

  assert.equal(manager.directPlay(stream, info, nativeCaps).ok, true);
  assert.equal(manager.directPlay(stream, info, playCaps).ok, false);
});

test("an hls source never plays directly, native or browser", () => {
  const manager = new PlaybackManager(tmp("test-native-hls")) as any;
  const info = { container: "hls,applehttp", video: { codec: "h264" }, audio: { codec: "aac" } };

  assert.equal(manager.directPlay({ url: "https://cdn.example/master.m3u8" }, info, nativeCaps).ok, false);
  assert.equal(manager.directPlay({ url: "https://cdn.example/master.m3u8" }, info, playCaps).ok, false);
});

test("subtitles a native client renders are not extracted as a sidecar", async () => {
  const manager = new PlaybackManager(tmp("test-native-subtitles")) as any;
  manager.inspect = async () => nativeInfo({ subtitleTracks: [{ index: 0, codec: "hdmv_pgs_subtitle", language: "cs" }] });
  let spawned = false;
  manager.spawnAt = async () => { spawned = true; return "/hls"; };
  let extracted = 0;
  manager.sidecars.run = async (_args: string[], _file: string, _append: boolean, signal: AbortSignal) => { extracted += 1; await whenAborted(signal); };

  const started = await manager.start({ url: "https://cdn.example/movie.mkv" }, nativeCaps, { subtitleLanguage: "cs" });

  assert.equal(spawned, false);
  assert.equal(started.mode, "direct");
  assert.equal(started.subtitleTrack, 0);
  assert.equal(started.sidecarUrl, undefined);
  await pause(20);
  assert.equal(extracted, 0);
});

test("a subtitle codec the native client does not render is still extracted", async () => {
  const manager = new PlaybackManager(tmp("test-native-subtitles-other")) as any;
  manager.inspect = async () => nativeInfo({ subtitleTracks: [{ index: 0, codec: "ass", language: "cs" }] });
  let spawned = false;
  manager.spawnAt = async () => { spawned = true; return "/hls"; };
  let extracted = 0;
  manager.sidecars.run = async (_args: string[], _file: string, _append: boolean, signal: AbortSignal) => { extracted += 1; await whenAborted(signal); };

  const started = await manager.start({ url: "https://cdn.example/movie.mkv" }, nativeCaps, { subtitleLanguage: "cs" });

  assert.equal(spawned, false);
  assert.equal(started.mode, "direct");
  assert.match(started.sidecarUrl ?? "", /sidecar\.vtt\?revision=/);
  while (!extracted) await pause(5);
  assert.equal(extracted, 1);
  await manager.sidecars.stop(started.id);
});

test("a chosen quality forces a conversion for a native client too", async () => {
  const manager = new PlaybackManager(tmp("test-native-quality")) as any;
  manager.inspect = async () => nativeInfo();
  manager.spawnAt = async (session: any, time: number) => { session.offset = time; return "/hls"; };

  const started = await manager.start({ url: "https://cdn.example/movie.mkv" }, nativeCaps, { quality: 720 });

  assert.notEqual(started.mode, "direct");
});

test("a native direct session switches to another playable audio track without restarting", async () => {
  const manager = new PlaybackManager(tmp("test-native-track")) as any;
  manager.inspect = async () => nativeInfo({
    audioTracks: [{ index: 0, codec: "ac3", language: "en" }, { index: 1, codec: "ac3", language: "cs" }],
  });
  const spawns: number[] = [];
  manager.spawnAt = async (session: any, offset: number) => {
    spawns.push(offset); session.offset = offset; session.generation += 1;
    return `/api/playback/${session.id}/${session.generation}/master.m3u8`;
  };

  const started = await manager.start({ url: "https://cdn.example/movie.mkv" }, nativeCaps);
  assert.equal(started.mode, "direct");

  const switched = await manager.track(started.id, { audio: 1, time: 0 });

  assert.equal(switched.mode, "direct");
  assert.equal(switched.audioTrack, 1);
  assert.deepEqual(spawns, []);
});

const remuxSession = (manager: any, overrides: Record<string, unknown> = {}) => {
  const session: Record<string, any> = {
    id: "escalated", stream: { url: "https://cdn.example/movie.mkv" },
    capabilities: { h264: true, aac: true },
    info: {
      container: "matroska,webm", duration: 3600,
      video: { codec: "h264" }, audio: { codec: "aac" },
      audioTracks: [{ index: 0, codec: "aac" }], subtitleTracks: [],
    },
    mode: "remux", generation: 1, offset: 0, hardware: false,
    audioTrack: 0, subtitleTrack: null, quality: null,
    lastAccess: Date.now(), operations: new SerialOperations(), stopped: false, claimed: true,
    ...overrides,
  };
  manager.sessions.set(session.id, session);
  return session;
};

const FAKE_FFMPEG_SKIP = process.platform === "win32" ? "Windows cannot run a script as the FFmpeg binary" : false;

const leadDurations = Array.from({ length: 220 }, (_, index) => index < 100 ? 2 : 10);

const leadCapFixture = async (t: TestContext, high: string | undefined, id: string) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "playback-lead-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "playback-lead-root-"));
  const fake = path.join(directory, "ffmpeg");
  const control = path.join(directory, "control.json");
  const durations = leadDurations;
  const segment = (index: number) => `#EXTINF:${durations[index]!.toFixed(3)},\nseg-0-${String(index).padStart(6, "0")}.m4s\n`;
  const playlist = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:3\n#EXT-X-MAP:URI="init.mp4"\n${durations.map((_, index) => segment(index)).join("")}`;
  await writeFile(fake, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const control = ${JSON.stringify(control)};
const output = path.dirname(process.argv[process.argv.length - 1]);
const playlist = ${JSON.stringify(playlist)};
fs.writeFileSync(path.join(output, "init.mp4"), "init");
for (let index = 0; index < ${durations.length}; index += 1) {
  fs.writeFileSync(path.join(output, "seg-0-" + String(index).padStart(6, "0") + ".m4s"), "segment-" + index);
}
fs.writeFileSync(path.join(output, "index-0.m3u8"), playlist);
fs.writeFileSync(path.join(output, "master.m3u8"), "#EXTM3U\\n");
process.stdout.write("out_time_us=2000000\\nprogress=continue\\n");
process.on("SIGUSR1", () => {
  const command = JSON.parse(fs.readFileSync(control, "utf8"));
  const ended = command.end === true ? "end" : "continue";
  process.stdout.write("out_time_us=" + Math.round(command.outTime * 1000000) + "\\nprogress=" + ended + "\\n", () => {
    if (command.end === true) process.exit(0);
  });
});
setInterval(() => {}, 1000);
`);
  await chmod(fake, 0o755);

  const originalBinary = process.env.FFMPEG_PATH;
  const originalCap = process.env.PLAYBACK_LEAD_CAP_SECONDS;
  process.env.FFMPEG_PATH = fake;
  if (high === undefined) delete process.env.PLAYBACK_LEAD_CAP_SECONDS;
  else process.env.PLAYBACK_LEAD_CAP_SECONDS = high;
  const manager = new PlaybackManager(root) as any;
  manager.softwareEncoder = true;
  const session = remuxSession(manager, {
    id,
    generation: 0,
    info: {
      container: "matroska,webm", duration: durations.reduce((sum, value) => sum + value, 0),
      video: { codec: "h264" }, audio: { codec: "aac" },
      audioTracks: [{ index: 0, codec: "aac" }], subtitleTracks: [],
    },
  });
  await manager.spawnAt(session, 0);
  const signals: string[] = [];
  const signalEvents = new EventEmitter();
  const originalKill = session.process.kill.bind(session.process);
  session.process.kill = (signal?: NodeJS.Signals | number) => {
    if (signal !== undefined) {
      signals.push(String(signal));
      signalEvents.emit("signal", String(signal));
    }
    return originalKill(signal);
  };

  const nextSignal = () => new Promise<string>((resolve) => signalEvents.once("signal", resolve));
  const produce = async (outTime: number, end = false, output?: ReturnType<typeof once>) => {
    await writeFile(control, JSON.stringify({ outTime, end }));
    process.kill(session.process.pid!, "SIGUSR1");
    if (output) await output;
  };

  t.after(async () => {
    try { session.process?.kill("SIGKILL"); } catch { /* already gone */ }
    if (originalBinary === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = originalBinary;
    if (originalCap === undefined) delete process.env.PLAYBACK_LEAD_CAP_SECONDS;
    else process.env.PLAYBACK_LEAD_CAP_SECONDS = originalCap;
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(root, { recursive: true, force: true }),
    ]);
  });
  return { manager, session, signals, nextSignal, produce };
};

const waitForLedger = async (session: any, condition: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) await flushPlayback();
  assert.equal(condition(), true, "the ledger read settled");
};

test("the lead cap suspends at the high mark, resumes at the low mark, and stops a resume burst", { timeout: 20_000, skip: FAKE_FFMPEG_SKIP }, async (t) => {
  const { manager, session, signals, nextSignal, produce } = await leadCapFixture(t, "300", "lead-cap");
  manager.fetched(session.id, String(session.generation), "seg-0-000000.m4s");
  await waitForLedger(session, () => session.ledger.generations.get(session.generation)?.fetchedSeconds === 2);

  const suspended = nextSignal();
  await produce(362);
  assert.equal(await suspended, "SIGSTOP");
  assert.equal(manager.status(session.id).conversion, "running");
  assert.equal(await manager.usableFallback(session), true, "a suspended process is still a usable fallback");
  assert.equal(session.suspendedSince !== undefined, true);

  const resumed = nextSignal();
  manager.fetched(session.id, String(session.generation), "seg-0-000180.m4s");
  assert.equal(await resumed, "SIGCONT");
  assert.equal(session.ledger.generations.get(session.generation).fetchedSeconds, 1010,
    "playlist durations are summed instead of multiplying the segment index");

  const suspendedAgain = nextSignal();
  await produce(1400);
  assert.equal(await suspendedAgain, "SIGSTOP");

  const finalResume = nextSignal();
  manager.fetched(session.id, String(session.generation), "seg-0-000219.m4s");
  await waitForLedger(session, () => (session.ledger.generations.get(session.generation)?.fetchedSeconds ?? 0) > 1010);
  assert.equal(await finalResume, "SIGCONT");
  assert.equal(session.ledger.generations.get(session.generation).fetchedSeconds, 1400);

  const closed = once(session.process, "close");
  await produce(1400, true);
  await closed;
  assert.equal(manager.status(session.id).conversion, "complete");
  assert.deepEqual(signals, ["SIGSTOP", "SIGCONT", "SIGSTOP", "SIGCONT"]);

  session.suspendedMs = 12_400;
  await manager.stop(session.id);
  const summary = await conversionSummary(session.id);
  assert.equal(summary.suspendedSeconds, 12);
});

test("the lead cap never suspends before the first segment of the generation is fetched", { timeout: 20_000, skip: FAKE_FFMPEG_SKIP }, async (t) => {
  const { manager, session, signals, nextSignal, produce } = await leadCapFixture(t, "300", "lead-first-segment");
  const output = once(session.process.stdout!, "data");
  await produce(900, false, output);
  assert.equal(signals.includes("SIGSTOP"), false);

  const stopped = nextSignal();
  manager.fetched(session.id, String(session.generation), "seg-0-000000.m4s");
  await waitForLedger(session, () => session.ledger.generations.get(session.generation)?.fetchedSeconds === 2);
  assert.equal(await stopped, "SIGSTOP", "the existing production is evaluated after the first fetch");

  const resumed = nextSignal();
  manager.fetched(session.id, String(session.generation), "seg-0-000219.m4s");
  assert.equal(await resumed, "SIGCONT");
  const closed = once(session.process, "close");
  await produce(1400, true);
  await closed;
  await manager.stop(session.id);
});

for (const row of [
  { name: "unset", high: undefined },
  { name: "zero", high: "0" },
] as const) {
  test(`the lead cap stays off when ${row.name}`, { timeout: 20_000, skip: FAKE_FFMPEG_SKIP }, async (t) => {
    const { manager, session, signals, produce } = await leadCapFixture(t, row.high, `lead-off-${row.name}`);
    const output = once(session.process.stdout!, "data");
    await produce(900, false, output);
    manager.fetched(session.id, String(session.generation), "seg-0-000180.m4s");
    await waitForLedger(session, () => session.ledger.generations.get(session.generation)?.furthestSegment === 180);
    assert.equal(session.ledger.generations.get(session.generation).fetchedSeconds, undefined, "the playlist is not read while the cap is off");
    await flushPlayback();

    const closed = once(session.process, "close");
    await produce(1400, true);
    await closed;
    assert.deepEqual(signals, []);
    await manager.stop(session.id);
  });
}

test("a failure to start a seek resumes and re-evaluates the restored generation", { timeout: 20_000, skip: FAKE_FFMPEG_SKIP }, async (t) => {
  const { manager, session, signals, nextSignal, produce } = await leadCapFixture(t, "300", "lead-failed-seek");
  manager.fetched(session.id, String(session.generation), "seg-0-000000.m4s");
  await waitForLedger(session, () => session.ledger.generations.get(session.generation)?.fetchedSeconds === 2);
  const suspended = nextSignal();
  await produce(900);
  assert.equal(await suspended, "SIGSTOP");
  const previousGeneration = session.generation;
  const resumed = nextSignal();
  manager.fetched(session.id, String(session.generation), "seg-0-000219.m4s");

  manager.spawnAt = async () => { throw new Error("The source could not be opened"); };
  const result = await manager.seek(session.id, 1200);

  assert.equal(await resumed, "SIGCONT");
  assert.equal(result.seekRestored, true);
  assert.equal(manager.status(session.id).conversion, "running");
  assert.equal(session.generation, previousGeneration);
  assert.deepEqual(signals, ["SIGSTOP", "SIGCONT"], "the restored generation stays running at the client's edge");
  await manager.stop(session.id);
});

for (const operation of ["stop", "seek", "track", "escalate"] as const) {
  test(`${operation} while suspended resumes before terminating and removes the old generation`, { timeout: 25_000, skip: FAKE_FFMPEG_SKIP }, async (t) => {
    const { manager, session, signals, nextSignal, produce } = await leadCapFixture(t, "300", `lead-${operation}`);
    manager.fetched(session.id, String(session.generation), "seg-0-000000.m4s");
    await waitForLedger(session, () => session.ledger.generations.get(session.generation)?.fetchedSeconds === 2);
    const suspended = nextSignal();
    await produce(900);
    assert.equal(await suspended, "SIGSTOP");

    const oldProcess = session.process;
    const oldDirectory = session.directory;
    const oldGeneration = session.generation;
    if (operation === "stop") {
      const closed = once(oldProcess, "close");
      await manager.stop(session.id);
      await closed;
      assert.deepEqual(signals, ["SIGSTOP", "SIGCONT", "SIGTERM"]);
      assert.equal(existsSync(oldDirectory), false);
      return;
    }

    const nextDirectory = path.join(manager.root, session.id, String(oldGeneration + 1));
    await mkdir(nextDirectory, { recursive: true });
    await writeFile(path.join(nextDirectory, "init.mp4"), "init");
    await writeFile(path.join(nextDirectory, "seg-0-000000.m4s"), "segment-0");
    await writeFile(path.join(nextDirectory, "seg-0-000001.m4s"), "segment-1");
    await writeFile(path.join(nextDirectory, "index-0.m3u8"),
      "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2.000,\nseg-0-000000.m4s\n#EXTINF:2.000,\nseg-0-000001.m4s\n");
    await writeFile(path.join(nextDirectory, "master.m3u8"), "#EXTM3U\n");
    const purged: string[] = [];
    const purge = manager.purge.bind(manager);
    manager.purge = async (directory: string, why?: string) => { purged.push(directory); return purge(directory, why); };
    const purgedNow: string[] = [];
    const purgeNow = manager.purgeNow.bind(manager);
    let purgeSettled: Promise<void> | undefined;
    manager.purgeNow = (directory: string) => {
      purgedNow.push(directory);
      purgeSettled = purgeNow(directory);
      return purgeSettled;
    };
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const closed = once(oldProcess, "close");
    if (operation === "seek") await manager.seek(session.id, 1200);
    else if (operation === "track") await manager.track(session.id, { audio: 0, time: 1200 });
    else await manager.escalate(session.id, 1200);
    await closed;

    assert.deepEqual(signals.slice(0, 3), ["SIGSTOP", "SIGCONT", "SIGTERM"]);
    assert.ok(session.generation > oldGeneration, "the new generation starts");
    assert.notEqual(session.process, oldProcess);
    assert.equal(oldProcess.exitCode !== null || oldProcess.signalCode !== null, true);
    for (let attempt = 0; attempt < 100 && !purgedNow.includes(oldDirectory); attempt += 1) {
      await flushPlayback();
      t.mock.timers.tick(1_000);
    }
    assert.deepEqual(purged, [oldDirectory]);
    await purgeSettled;
    assert.equal(existsSync(oldDirectory), false);
    t.mock.timers.reset();
    await manager.stop(session.id);
  });
}

test("the lead cap is off on Windows and warns once when configured", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const originalCap = process.env.PLAYBACK_LEAD_CAP_SECONDS;
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  process.env.PLAYBACK_LEAD_CAP_SECONDS = "300";
  t.after(() => {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
    if (originalCap === undefined) delete process.env.PLAYBACK_LEAD_CAP_SECONDS;
    else process.env.PLAYBACK_LEAD_CAP_SECONDS = originalCap;
  });

  const manager = new PlaybackManager(tmp("test-lead-windows")) as any;
  assert.equal(manager.leadCapHigh, 0);
  await flushLog();
  const lines = (await readLog({ level: "WARN", search: "The conversion lead cap needs SIGSTOP" }))
    .split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
});

const runToCleanExit = async (
  t: TestContext,
  duration: number | undefined,
  outTimeSeconds: number,
  exitCode = 0,
  options: { id?: string; segments?: number } = {},
) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "playback-clean-exit-"));
  const fake = path.join(directory, "ffmpeg");
  const segments = options.segments ?? 2;
  const durations = Array.from({ length: segments }, () => 2);
  const contents = Array.from({ length: segments }, (_, index) => `segment-${index}`);
  await writeFile(fake, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const output = process.argv[process.argv.length - 1];
const folder = path.dirname(output);
const durations = ${JSON.stringify(durations)};
const contents = ${JSON.stringify(contents)};
const segment = (n) => "#EXTINF:" + durations[n].toFixed(3) + ",\\nseg-0-" + String(n).padStart(6, "0") + ".m4s\\n";
fs.writeFileSync(path.join(folder, "init.mp4"), "init");
let playlist = '#EXTM3U\\n#EXT-X-VERSION:7\\n#EXT-X-TARGETDURATION:2\\n#EXT-X-MAP:URI="init.mp4"\\n';
for (let n = 0; n < durations.length; n += 1) {
  fs.writeFileSync(path.join(folder, "seg-0-" + String(n).padStart(6, "0") + ".m4s"), contents[n]);
  playlist += segment(n);
}
fs.writeFileSync(path.join(folder, "index-0.m3u8"), playlist);
process.stdout.write("out_time_us=${Math.round(outTimeSeconds * 1_000_000)}\\nprogress=end\\n");
process.exitCode = ${exitCode};
`);
  await chmod(fake, 0o755);
  const originalBinary = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = fake;
  t.after(() => {
    if (originalBinary === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = originalBinary;
  });

  const root = await mkdtemp(path.join(os.tmpdir(), "playback-clean-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new PlaybackManager(root) as any;
  const session = remuxSession(manager, {
    id: options.id ?? `clean-${outTimeSeconds}-${exitCode}`,
    generation: 0,
    info: {
      container: "matroska,webm", duration,
      video: { codec: "h264" }, audio: { codec: "aac" },
      audioTracks: [{ index: 0, codec: "aac" }], subtitleTracks: [],
    },
  });
  await manager.spawnAt(session, 0);
  if (session.process.exitCode === null) await once(session.process, "close");
  return { manager, session, status: manager.status(session.id) };
};

const directoryBytes = async (directory: string) => {
  const names = await readdir(directory);
  const sizes = await Promise.all(names.map((name) => stat(path.join(directory, name)).then((value) => value.size, () => 0)));
  return sizes.reduce((sum, size) => sum + size, 0);
};

const conversionSummaries = async (id: string) => {
  await flushLog();
  const written = await readLog({ level: "INFO", search: "Conversion summary" });
  return written.split("\n").filter((line) => line.includes(`"id":"${id}"`)).map((line) => JSON.parse(line.slice(line.indexOf("{"))));
};

const conversionSummary = async (id: string) => {
  const summaries = await conversionSummaries(id);
  assert.equal(summaries.length, 1, "a converted session writes exactly one summary");
  return summaries[0];
};

test("shortConversion uses the larger of thirty seconds and two percent", () => {
  assert.equal(shortConversion(3540, 3600), false);
  assert.equal(shortConversion(3500, 3600), true);
  assert.equal(shortConversion(575, 600), false);
  assert.equal(shortConversion(560, 600), true);
  assert.equal(shortConversion(60, undefined), false);
  assert.equal(shortConversion(60, 0), false);
  assert.equal(shortConversion(60, Number.NaN), false);
  assert.equal(shortConversion(undefined, 120), false);
});

test("a clean conversion that stopped during the film is reported as short", { skip: FAKE_FFMPEG_SKIP }, async (t) => {
  const { manager, session } = await runToCleanExit(t, 120, 60);
  assert.deepEqual(manager.status(session.id), {
    generation: session.generation,
    conversion: "short",
    reached: 60,
  });
  await flushLog();
  assert.match(await readLog({ level: "WARN", search: "The conversion stopped before the end of the film" }), /WARN/);
});

test("a clean conversion near the end is complete", { skip: FAKE_FFMPEG_SKIP }, async (t) => {
  const { manager, session } = await runToCleanExit(t, 120, 119);
  assert.equal(manager.status(session.id).conversion, "complete");
});

test("a clean conversion without a known duration is complete", { skip: FAKE_FFMPEG_SKIP }, async (t) => {
  const { manager, session } = await runToCleanExit(t, undefined, 60);
  assert.equal(manager.status(session.id).conversion, "complete");
});

test("a failed conversion that stopped during the film is reported as failed", { skip: FAKE_FFMPEG_SKIP }, async (t) => {
  const { manager, session } = await runToCleanExit(t, 120, 60, 1);
  assert.deepEqual(manager.status(session.id), {
    generation: session.generation,
    conversion: "failed",
    reached: 60,
  });
});

test("a failed conversion that reached the end is complete", { skip: FAKE_FFMPEG_SKIP }, async (t) => {
  const { manager, session } = await runToCleanExit(t, 120, 119, 1);
  assert.equal(manager.status(session.id).conversion, "complete");
});

test("a conversion that fails without a known duration is not judged and ends as before", { skip: FAKE_FFMPEG_SKIP }, async (t) => {
  const { manager, session } = await runToCleanExit(t, undefined, 60, 1);
  assert.equal(manager.status(session.id).conversion, "complete");
});

test("conversion summary reports what was produced and fetched", { skip: FAKE_FFMPEG_SKIP }, async (t) => {
  const { manager, session } = await runToCleanExit(t, undefined, 60, 0, { id: "summary-fetched", segments: 5 });
  const bytesWritten = await directoryBytes(session.directory);
  for (let index = 0; index <= 2; index += 1) {
    manager.fetched(session.id, String(session.generation), `seg-0-${String(index).padStart(6, "0")}.m4s`);
  }

  await manager.stop(session.id);

  assert.deepEqual(await conversionSummary(session.id), {
    id: session.id,
    mode: "remux",
    generations: 1,
    producedSeconds: 10,
    fetchedSeconds: 6,
    unfetchedSeconds: 4,
    bytesWritten,
    ended: "closed",
    suspendedSeconds: 0,
  });
});

test("conversion summary counts a retired generation before it is purged", { skip: FAKE_FFMPEG_SKIP }, async (t) => {
  const { manager, session } = await runToCleanExit(t, undefined, 60, 0, { id: "summary-seek", segments: 5 });
  manager.fetched(session.id, String(session.generation), "seg-0-000002.m4s");
  const firstDirectory = session.directory;
  const firstBytes = await directoryBytes(firstDirectory);

  const settledAtPurge: Array<number | undefined> = [];
  const purgeNow = manager.purgeNow.bind(manager);
  manager.purgeNow = async (directory: string) => {
    if (directory === firstDirectory) {
      settledAtPurge.push(session.ledger.generations.get(1)?.producedSeconds);
    }
    await purgeNow(directory);
  };
  manager.run = async (target: any, _offset: number, directory: string) => {
    let playlist = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI="init.mp4"\n';
    await writeFile(path.join(directory, "init.mp4"), "init");
    for (let index = 0; index < 5; index += 1) {
      const name = `seg-0-${String(index).padStart(6, "0")}.m4s`;
      await writeFile(path.join(directory, name), `segment-${index}`);
      playlist += `#EXTINF:2.000,\n${name}\n`;
    }
    await writeFile(path.join(directory, "index-0.m3u8"), playlist);
    target.process = { exitCode: 0, signalCode: null };
    return `/api/playback/${target.id}/${target.generation}/master.m3u8`;
  };

  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  await manager.seek(session.id, 60);
  const secondDirectory = session.directory;
  for (let index = 0; index < 5; index += 1) {
    manager.fetched(session.id, String(session.generation), `seg-0-${String(index).padStart(6, "0")}.m4s`);
  }
  const secondBytes = await directoryBytes(secondDirectory);

  for (let attempt = 0; attempt < 50 && settledAtPurge.length === 0; attempt += 1) {
    await flushPlayback();
    t.mock.timers.tick(1_000);
  }
  assert.deepEqual(settledAtPurge, [10], "the retired playlist was read before its directory was removed");

  await manager.stop(session.id);
  assert.deepEqual(await conversionSummary(session.id), {
    id: session.id,
    mode: "remux",
    generations: 2,
    producedSeconds: 20,
    fetchedSeconds: 16,
    unfetchedSeconds: 4,
    bytesWritten: firstBytes + secondBytes,
    ended: "closed",
    suspendedSeconds: 0,
  });
});

test("a reaped orphan records that it was orphaned", { skip: FAKE_FFMPEG_SKIP }, async (t) => {
  const { manager, session } = await runToCleanExit(t, undefined, 60, 0, { id: "summary-orphan" });
  session.claimed = true;
  session.clientAt = Date.now() - 91_000;

  manager.reap();
  let summaries: Array<Record<string, unknown>> = [];
  for (let attempt = 0; attempt < 100 && summaries.length === 0; attempt += 1) {
    await pause(5);
    summaries = await conversionSummaries(session.id);
  }

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].ended, "orphaned");
});

test("a direct session writes no conversion summary", async (t) => {
  const manager = new PlaybackManager(tmp("test-summary-direct")) as any;
  const session = remuxSession(manager, { id: "summary-direct", mode: "direct" });

  await manager.stop(session.id);

  assert.deepEqual(await conversionSummaries(session.id), []);
});

test("fetched ignores names FFmpeg does not write as video segments", { skip: FAKE_FFMPEG_SKIP }, async (t) => {
  const { manager, session } = await runToCleanExit(t, undefined, 60, 0, { id: "summary-fetched-filters", segments: 5 });
  const generation = String(session.generation);
  manager.fetched(session.id, generation, "seg-0-000001.m4s");
  for (const file of ["init.mp4", "master.m3u8", "index-0.m3u8", "seg-1-000004.m4s", "seg-0-4.m4s", "other-0-000004.m4s"]) {
    manager.fetched(session.id, generation, file);
  }

  await manager.stop(session.id);

  assert.equal((await conversionSummary(session.id)).fetchedSeconds, 4);
});

test("a new generation is running while the previous generation ended short", { skip: FAKE_FFMPEG_SKIP }, async (t) => {
  const { manager, session } = await runToCleanExit(t, 120, 60);
  manager.run = async (target: any) => {
    target.process = { exitCode: null, signalCode: null };
    return "/new-generation";
  };

  await manager.seek(session.id, 60);

  assert.deepEqual(manager.status(session.id), {
    generation: session.generation,
    conversion: "running",
  });
});

/** The real spawnAt settles the mode from the current plan; the stub has to do the same. */
const stubSpawn = (manager: any, session: Record<string, any>, spawned: number[] = []) => {
  manager.spawnAt = async (target: Record<string, any>, time: number) => {
    spawned.push(time);
    target.mode = manager.plan(session).copyVideo ? "remux" : "transcode";
    target.offset = time;
    return "/hls";
  };
  return spawned;
};

test("a chosen quality the file already fits is copied, not transcoded", () => {
  const manager = new PlaybackManager(tmp("test-quality-fits")) as any;
  const info = (height: number, bitrate?: number) => ({
    container: "matroska,webm", bitrate, video: { codec: "h264", height }, audio: { codec: "aac" },
    audioTracks: [{ index: 0, codec: "aac" }], subtitleTracks: [],
  });
  const session = remuxSession(manager, { quality: 1080, info: info(720, 2_500_000) });

  assert.equal(manager.plan(session).copyVideo, true, "a 720p file at 2.5 Mb/s already is 1080p quality");
  const args = manager.args(session, 0, tmp("output-fits"), false) as string[];
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.equal(args.some((arg) => arg.startsWith("scale")), false, "nothing is rescaled");

  session.info = info(1080, 2_500_000); session.quality = 720;
  assert.equal(manager.plan(session).copyVideo, false, "a taller picture is scaled down");
  session.info = info(720, 9_000_000); session.quality = 1080;
  assert.equal(manager.plan(session).copyVideo, false, "a bitrate over the cap is brought down");
  session.info = info(720); session.quality = 1080;
  assert.equal(manager.plan(session).copyVideo, false, "an unknown bitrate is not taken on trust");
});

test("fitsQuality wants an average well under the cap, read in bits per second", () => {
  const info = (height: number, bitrate: number) => ({ container: "mp4", bitrate, video: { codec: "h264", height }, audioTracks: [], subtitleTracks: [] });
  assert.equal(fitsQuality(info(480, 1_125_000), 480), true, "three quarters of 1500k");
  assert.equal(fitsQuality(info(480, 1_125_001), 480), false);
  assert.equal(fitsQuality(info(1080, 4_500_000), 1080), true, "three quarters of 6M");
  assert.equal(fitsQuality(info(1080, 5_900_000), 1080), false, "an average just under the cap leaves its peaks above it");
  assert.equal(fitsQuality(undefined, 1080), false);
});

test("a copy the browser refused is transcoded instead, video and audio both", () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const session = remuxSession(manager, { capabilities: { h264: true, ac3: true }, info: {
    container: "matroska,webm", video: { codec: "h264" }, audio: { codec: "ac3" },
    audioTracks: [{ index: 0, codec: "ac3" }], subtitleTracks: [],
  } });

  assert.deepEqual(manager.plan(session), { copyVideo: true, copyAudio: true });
  session.copyRejected = true;
  assert.deepEqual(manager.plan(session), { copyVideo: false, copyAudio: false });

  const args = manager.args(session, 0, tmp("output"), false) as string[];
  assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
});

test("escalate marks the session and restarts the conversion at the same spot", async () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const session = remuxSession(manager);
  const spawned = stubSpawn(manager, session);

  const restarted = await manager.escalate("escalated", 612);

  assert.equal(session.copyRejected, true);
  assert.equal(restarted.mode, "transcode");
  assert.deepEqual(spawned, [612]);
});

test("escalate from direct play converts instead of handing the file over again", async () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const session = remuxSession(manager, { mode: "direct" });
  stubSpawn(manager, session);

  const restarted = await manager.escalate("escalated", 0);

  assert.equal(restarted.mode, "transcode");
  assert.equal(session.mode, "transcode");
});

test("escalate on a native direct session converts instead of handing the file over again", async () => {
  const manager = new PlaybackManager(tmp("test-native-escalate")) as any;
  const session = remuxSession(manager, { capabilities: nativeCaps, mode: "direct" });
  const spawned = stubSpawn(manager, session);

  const restarted = await manager.escalate("escalated", 0);

  assert.equal(restarted.mode, "transcode");
  assert.equal(session.mode, "transcode");
  assert.deepEqual(spawned, [0]);
});

test("a session that already transcodes is not escalated twice, only restarted", async () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const session = remuxSession(manager, { mode: "transcode", copyRejected: true });
  const restarts = stubSpawn(manager, session);

  await manager.escalate("escalated", 100);

  assert.deepEqual(restarts, [100]);
  assert.equal(session.mode, "transcode");
});

test("a track switch does not fall back to direct play the browser has already refused", async () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const session = remuxSession(manager, {
    copyRejected: true, audioTrack: 1,
    stream: { url: "https://cdn.example/movie.mp4" },
    info: {
      container: "mov,mp4,m4a,3gp,3g2,mj2", duration: 3600,
      video: { codec: "h264" }, audio: { codec: "aac" },
      audioTracks: [{ index: 0, codec: "aac" }, { index: 1, codec: "aac" }], subtitleTracks: [],
    },
  });
  stubSpawn(manager, session);

  const switched = await manager.track("escalated", { audio: 0, time: 30 });

  assert.equal(switched.mode, "transcode");
  assert.equal(session.mode, "transcode");
});

test("a source that answers 404 is not handed to FFmpeg a second time", async () => {
  const manager = new PlaybackManager(tmp("test-playback-source")) as any;
  manager.vaapiDevice = "/dev/dri/renderD128";
  const session = remuxSession(manager, { mode: "transcode", copyRejected: true });
  let attempts = 0;
  manager.run = async () => {
    attempts += 1;
    session.error = SOURCE_UNREACHABLE;
    return undefined;
  };

  await assert.rejects(manager.spawnAt(session, 0), new RegExp(SOURCE_UNREACHABLE));
  assert.equal(attempts, 1);
});

test("a conversion FFmpeg could not open is told apart from one the viewer walked away from", () => {
  assert.equal(describeFailure("[http @ 0x1] HTTP error 404 Not Found\nError opening input: Server returned 404 Not Found\n", 8), SOURCE_UNREACHABLE);
  assert.match(describeFailure("[libx264 @ 0x1] height not divisible by 2\n", 1), /height not divisible by 2/);
});

test("probe caching separates credentials for the same source URL", async () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  let probes = 0;
  manager.probeSource = async () => { probes++; return { video: { codec: "h264" }, audioTracks: [], subtitleTracks: [] }; };
  for (const authorization of ["first", "second", "first"]) {
    await manager.inspect({ url: "https://provider.test/media", behaviorHints: { proxyHeaders: { request: { authorization } } } });
  }
  assert.equal(probes, 2);
});

test("a playlist source is recognised by its address or by the probe", () => {
  // The filename says .mp4 because that is what a download of it should be
  // called; it must not decide this.
  assert.equal(isPlaylistSource({ url: "https://cdn.example/a/1080.mp4.m3u8", behaviorHints: { filename: "Film.mp4" } }), true);
  assert.equal(isPlaylistSource({ url: "https://cdn.example/opaque" }, { container: "hls,applehttp", audioTracks: [], subtitleTracks: [] }), true);
  assert.equal(isPlaylistSource({ url: "https://cdn.example/video-1080p.mp4" }, { container: "mov,mp4,m4a", audioTracks: [], subtitleTracks: [] }), false);
  assert.equal(isPlaylistSource({ url: "" }), false);
});

test("the playlist demuxer flags reach the conversion, ahead of the input", () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const session = {
    stream: { url: "https://example.test/master.m3u8" },
    capabilities: { h264: true, aac: true },
    info: {
      video: { codec: "h264" },
      audio: { codec: "aac" },
      audioTracks: [{ codec: "aac" }],
      subtitleTracks: [],
    },
    quality: 1080,
    audioTrack: 0,
    subtitleTrack: null,
  };

  const flags = ["-allowed_extensions", "ALL"];
  const args = manager.args(session, 0, tmp("output"), false, flags) as string[];


  // An option after -i applies to the output, where the HLS demuxer never sees it.
  assert.ok(args.indexOf("-allowed_extensions") > -1, "the flags are missing");
  assert.ok(args.indexOf("-allowed_extensions") < args.indexOf("-i"), "the flags land after the input");

  // Without them, every playlist entry our proxy rewrites to /api/media/<id> is refused for
  // having no file ending, and an HLS source probes fine and then will not convert.
  const bare = manager.args(session, 0, tmp("output"), false) as string[];
  assert.equal(bare.includes("-allowed_extensions"), false);
});

test("the playlist flags are left out for a source that is not a playlist", () => {
  // They are HLS demuxer options. FFmpeg does not ignore them on an ordinary
  // file, it refuses to start: "Option not found".
  assert.equal(isPlaylistSource({ url: "https://example.test/movie.mkv" }, { container: "matroska,webm" } as any), false);
  assert.equal(isPlaylistSource({ url: "https://example.test/master.m3u8" }, undefined), true);

  // A proxy address carries no ending, so the probe's own reading decides.
  assert.equal(isPlaylistSource({ url: "https://example.test/api/media/abc" }, { container: "hls,applehttp" } as any), true);
  assert.equal(isPlaylistSource({ url: "https://example.test/api/media/abc" }, { container: "mov,mp4,m4a" } as any), false);
});

test("seeking re-reads the same subtitles instead of starting FFmpeg again", async () => {
  const manager = new PlaybackManager(tmp("test-seek-sidecars")) as any;
  manager.inspect = async () => ({ container: "matroska", duration: 7000,
    video: { codec: "hevc" }, audio: { codec: "ac3" },
    audioTracks: [{ index: 0, codec: "ac3" }], subtitleTracks: [{ index: 2, codec: "subrip", language: "cs" }],
  });
  const events: string[] = [];
  const readers: number[] = [];
  const sidecarArgs: string[][] = [];
  manager.spawnAt = async (session: any, offset: number) => { session.offset = offset; events.push(`video:${offset}`); return "/hls"; };
  manager.sidecars.run = async (args: string[], file: string, _append: boolean, signal: AbortSignal) => {
    readers.push(Number(args[args.indexOf("-ss") + 1] ?? 0));
    sidecarArgs.push(args);
    // What FFmpeg would have written by then: cues with the source's own timestamps.
    await writeFile(file, "WEBVTT\n\n01:27:30.000 --> 01:40:00.000\nspoken\n\n");
    await whenAborted(signal);
  };
  const started = await manager.start({ url: "https://cdn.example/large.mkv" }, { hevc: true }, { startTime: 5245, subtitleLanguage: "cs" });
  while (!readers.length) await pause(5);
  // The player asks for the cues, which is also how the reader's progress becomes known.
  let cues;
  while (!(cues = await manager.sidecar(started.id, revisionOf(started.sidecarUrl), 5245))) await pause(5);
  assert.match(cues.text, /00:00:05\.000 --> 00:12:35\.000\nspoken/, "the cues are shifted to the generation being played");
  const resumed = await manager.seek(started.id, 5400);
  const back = await manager.seek(started.id, 900);
  assert.deepEqual(events, ["video:5245", "video:5400", "video:900"]);
  while (readers.length < 2) await pause(5);
  // Only the jump behind the reader needed another FFmpeg; the seek it already covers did not.
  assert.deepEqual(readers, [5245, 900]);
  for (const args of sidecarArgs) {
    const input = args.indexOf("-i");
    assert.ok(input > 0, "the sidecar input position is present");
    assert.deepEqual(args.slice(args.indexOf("-reconnect"), args.indexOf("-reconnect") + 8), [
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "10",
    ]);
    assert.ok(args.indexOf("-reconnect") < input, "sidecar reconnect options apply to the input");
  }
  assert.match(started.sidecarUrl ?? "", /\?revision=[0-9a-f-]+&offset=5245\.000$/);
  assert.match(resumed.sidecarUrl ?? "", /&offset=5400\.000$/);
  assert.equal(revisionOf(started.sidecarUrl), revisionOf(resumed.sidecarUrl));
  assert.notEqual(revisionOf(resumed.sidecarUrl), revisionOf(back.sidecarUrl));
  await manager.sidecars.stop(started.id);
});
const revisionOf = (url?: string) => /revision=([0-9a-f-]+)/.exec(url ?? "")?.[1];

test("stop terminates media and subtitle readers before revoking their source", async () => {
  let mediaRunning = true;
  let subtitlesRunning = true;
  let revoked = false;
  const manager = new PlaybackManager(tmp("test-seek-stop"), () => {
    assert.equal(mediaRunning, false);
    assert.equal(subtitlesRunning, false);
    revoked = true;
  }) as any;
  const session = remuxSession(manager);
  manager.kill = async () => { await pause(10); mediaRunning = false; };
  manager.sidecars.stop = async () => { await pause(20); subtitlesRunning = false; };
  manager.purge = async () => {};
  await manager.stop(session.id);
  assert.equal(revoked, true);
});

test("switching subtitles changes the reader, not the conversion", async () => {
  const manager = new PlaybackManager(tmp("test-subtitle-switch")) as any;
  manager.inspect = async () => ({ container: "matroska", duration: 7000,
    video: { codec: "hevc" }, audio: { codec: "ac3" },
    audioTracks: [{ index: 0, codec: "ac3" }],
    subtitleTracks: [{ index: 0, codec: "subrip", language: "en" }, { index: 1, codec: "subrip", language: "cs" }],
  });
  const spawns: number[] = [];
  const readers: number[] = [];
  manager.spawnAt = async (session: any, offset: number) => { session.offset = offset; session.generation += 1; spawns.push(offset); return `/api/playback/${session.id}/${session.generation}/master.m3u8`; };
  manager.sidecars.run = async (_args: string[], _file: string, _append: boolean, signal: AbortSignal) => {
    await whenAborted(signal);
  };
  const started = await manager.start({ url: "https://cdn.example/large.mkv" }, { hevc: true }, { startTime: 900, subtitleLanguage: "cs" });
  assert.deepEqual(spawns, [900]);

  const switched = await manager.track(started.id, { subtitle: 0, time: 950 });
  // No second FFmpeg for the picture, and the player keeps the generation it is already playing.
  assert.deepEqual(spawns, [900], "the conversion was left alone");
  assert.equal(switched.subtitleTrack, 0);
  assert.equal(switched.url, started.url);
  assert.notEqual(/revision=([0-9a-f-]+)/.exec(switched.sidecarUrl)?.[1], /revision=([0-9a-f-]+)/.exec(started.sidecarUrl)?.[1]);

  const off = await manager.track(started.id, { subtitle: null, time: 950 });
  assert.deepEqual(spawns, [900]);
  assert.equal(off.sidecarUrl, undefined);

  // Audio still needs the conversion, so that one does restart.
  await manager.track(started.id, { audio: 0, subtitle: 1, time: 960 });
  assert.deepEqual(spawns, [900, 960]);
  void readers;
  await manager.sidecars.stop(started.id);
});

test("a position the source will not open costs the seek, not the film", async () => {
  const manager = new PlaybackManager(tmp("test-seek-keeps-playing")) as any;
  manager.inspect = async () => ({ container: "matroska", duration: 7000,
    video: { codec: "hevc" }, audio: { codec: "ac3" },
    audioTracks: [{ index: 0, codec: "ac3" }], subtitleTracks: [],
  });
  const alive = { exitCode: null, signalCode: null, kill: () => {}, once: () => {} };
  let refuse = false;
  manager.spawnAt = async (session: any, offset: number) => {
    session.generation += 1;
    session.directory = tmp(`test-seek-keeps-playing/${session.generation}`);
    session.offset = offset;
    if (refuse) throw new Error("The source could not be opened: it did not answer, or it refused the connection.");
    session.process = alive;
    return `/api/playback/${session.id}/${session.generation}/master.m3u8`;
  };
  manager.killChild = async () => {};
  const started = await manager.start({ url: "https://cdn.example/large.mkv" }, { hevc: true }, { startTime: 900 });
  const playing = { generation: (manager.sessions.get(started.id) as any).generation, url: started.url };

  refuse = true;
  const restored = await manager.seek(started.id, 4000);
  assert.equal(restored.seekRestored, true);
  assert.equal(restored.url, started.url);
  assert.equal(restored.offset, 900);
  const session = manager.sessions.get(started.id) as any;
  // The film is where it was, on the generation that is still running and still has its connection.
  assert.equal(session.offset, 900);
  assert.equal(session.generation, playing.generation);
  assert.equal(session.process, alive);
  assert.equal(session.stopped, false);

  // And the viewer can try again once the source is willing.
  refuse = false;
  const moved = await manager.seek(started.id, 4000);
  assert.equal(moved.offset, 4000);
  assert.notEqual(moved.url, playing.url);
});

test("a failed audio change keeps the old track in the session and conversion", async () => {
  const manager = new PlaybackManager(tmp("test-failed-audio-switch")) as any;
  const session = remuxSession(manager, {
    info: {
      container: "matroska,webm", duration: 3600,
      video: { codec: "h264" }, audio: { codec: "aac" },
      audioTracks: [{ index: 0, codec: "aac", language: "en" }, { index: 1, codec: "aac", language: "cs" }],
      subtitleTracks: [],
    },
  });
  manager.killChild = async () => {};
  let fail = true;
  const audioMaps: string[] = [];
  manager.spawnAt = async (target: any, offset: number) => {
    target.generation += 1;
    target.directory = path.join(manager.root, target.id, String(target.generation));
    target.offset = offset;
    if (fail) throw new Error("The source could not be opened");
    const args = manager.args(target, offset, target.directory, false) as string[];
    audioMaps.push(...args.filter((arg) => /^0:a:\d+\?$/.test(arg)));
    return `/api/playback/${target.id}/${target.generation}/master.m3u8`;
  };

  await assert.rejects(manager.track(session.id, { audio: 1, time: 100 }), /could not be opened/);
  assert.equal(session.audioTrack, 0);

  fail = false;
  const seek = await manager.seek(session.id, 200);
  assert.equal(seek.audioTrack, 0);
  assert.deepEqual(audioMaps, ["0:a:0?"]);
});

test("a failed quality change keeps the old quality in the session and conversion", async () => {
  const manager = new PlaybackManager(tmp("test-failed-quality-switch")) as any;
  const session = remuxSession(manager, {
    info: {
      container: "matroska,webm", duration: 3600,
      video: { codec: "h264", width: 1920, height: 1080 }, audio: { codec: "aac" }, bitrate: 10_000_000,
      audioTracks: [{ index: 0, codec: "aac" }], subtitleTracks: [],
    },
  });
  manager.killChild = async () => {};
  let fail = true;
  let laterArgs: string[] = [];
  manager.spawnAt = async (target: any, offset: number) => {
    target.generation += 1;
    target.directory = path.join(manager.root, target.id, String(target.generation));
    target.offset = offset;
    if (fail) throw new Error("The source could not be opened");
    laterArgs = manager.args(target, offset, target.directory, false) as string[];
    return `/api/playback/${target.id}/${target.generation}/master.m3u8`;
  };

  await assert.rejects(manager.track(session.id, { quality: 720, time: 100 }), /could not be opened/);
  assert.equal(session.quality, null);

  fail = false;
  const seek = await manager.seek(session.id, 200);
  assert.equal(seek.quality, null);
  assert.equal(laterArgs.includes("-maxrate"), false);
});

test("a failed subtitle-only change keeps the old subtitle track", async () => {
  const manager = new PlaybackManager(tmp("test-failed-subtitle-switch")) as any;
  const session = remuxSession(manager, {
    info: {
      container: "matroska,webm", duration: 3600,
      video: { codec: "h264" }, audio: { codec: "aac" },
      audioTracks: [{ index: 0, codec: "aac" }],
      subtitleTracks: [{ index: 0, codec: "subrip", language: "en" }, { index: 1, codec: "subrip", language: "cs" }],
    },
    subtitleTrack: 0,
  });
  manager.sidecars.stop = async () => { throw new Error("The subtitle reader could not be stopped"); };

  await assert.rejects(manager.track(session.id, { subtitle: null, time: 100 }), /could not be stopped/);
  assert.equal(session.subtitleTrack, 0);
});

for (const row of [
  { name: "running old process", exitCode: null, operation: "seek", keepsFilm: true },
  { name: "cleanly finished old process", exitCode: 0, operation: "seek", keepsFilm: true },
  { name: "clean finish without a master playlist", exitCode: 0, operation: "seek", keepsFilm: false, removeMaster: true },
  { name: "old process that died", exitCode: 1, operation: "seek", keepsFilm: false },
  { name: "cleanly finished old process during a track change", exitCode: 0, operation: "track", keepsFilm: true },
  { name: "cleanly finished old process during an escalate", exitCode: 0, operation: "escalate", keepsFilm: true },
] as const) {
  test(`a failed restart with a ${row.name} ${row.keepsFilm ? "keeps the film" : "cannot keep the film"}`, async (t) => {
    const oldDirectory = await mkdtemp(path.join(os.tmpdir(), "playback-restart-fallback-"));
    t.after(() => rm(oldDirectory, { recursive: true, force: true }));
    const master = path.join(oldDirectory, "master.m3u8");
    await writeFile(master, "#EXTM3U\n");
    if ("removeMaster" in row) await rm(master);

    const manager = new PlaybackManager(tmp(`test-restart-fallback-${row.operation}`)) as any;
    const oldGeneration = 7;
    const oldOffset = 300;
    const session = remuxSession(manager, {
      generation: oldGeneration,
      directory: oldDirectory,
      offset: oldOffset,
      process: { exitCode: row.exitCode, signalCode: null },
    });
    manager.killChild = async () => {};
    let attempts = 0;
    manager.spawnAt = async (target: any, offset: number) => {
      attempts += 1;
      target.generation += 1;
      target.directory = path.join(manager.root, target.id, String(target.generation));
      target.offset = offset;
      throw new Error("The source could not be opened: it did not answer, or it refused the connection.");
    };

    const invoke = () => row.operation === "seek"
      ? manager.seek(session.id, 1200)
      : row.operation === "track"
        ? manager.track(session.id, { audio: 0, time: 1200 })
        : manager.escalate(session.id, 1200);
    const rejected = row.operation !== "seek" || !row.keepsFilm;
    if (rejected) await assert.rejects(invoke(), /could not be opened/);
    else {
      const result = await invoke();
      assert.equal(result.seekRestored, true);
    }

    assert.equal(attempts, 2);
    assert.equal(manager.directory(session.id, String(oldGeneration)), row.keepsFilm ? oldDirectory : undefined);
    if (row.keepsFilm) {
      assert.equal(session.generation, oldGeneration);
      assert.equal(session.offset, oldOffset);
    }
  });
}

test("cleanup never deletes the generation a conversion is writing into", async () => {
  const manager = new PlaybackManager(tmp("test-purge-guard")) as any;
  const deleted: string[] = [];
  manager.purgeNow = async (directory: string) => { deleted.push(directory); };
  const session = remuxSession(manager);
  session.directory = tmp("test-purge-guard/session/2");
  session.process = { exitCode: null, signalCode: null };

  await manager.purge(session.directory, "a generation that was replaced");
  assert.deepEqual(deleted, [], "the film is playing out of it, whoever asked");

  // The same directory is fair game once nothing is writing there, which is what the retry
  // after a failed hardware attempt relies on.
  session.process = { exitCode: 1, signalCode: null };
  await manager.purge(session.directory, "a conversion attempt that failed");
  assert.deepEqual(deleted, [session.directory]);
});

test("a session no player is watching is closed, however busy FFmpeg is", async () => {
  const manager = new PlaybackManager(tmp("test-orphan")) as any;
  const stopped: string[] = [];
  manager.stop = async (id: string) => { stopped.push(id); manager.sessions.delete(id); };
  const session = remuxSession(manager);
  session.claimed = true;
  session.clientAt = Date.now();

  manager.reap();
  assert.deepEqual(stopped, [], "the player asked for something a moment ago");

  // FFmpeg reading the source keeps this fresh; it says nothing about anybody watching.
  session.clientAt = Date.now() - 91_000;
  session.lastAccess = Date.now();
  manager.reap();
  assert.deepEqual(stopped, [session.id]);
});

test("the player asking for a segment is what counts as watching", () => {
  const manager = new PlaybackManager(tmp("test-attended")) as any;
  const session = remuxSession(manager);
  session.clientAt = undefined;
  manager.touch(session.id);
  assert.equal(session.clientAt, undefined, "the proxy serving FFmpeg is not the player");
  manager.attended(session.id);
  assert.ok(session.clientAt !== undefined && Date.now() - session.clientAt < 1000);
});

/** The rule the tracks are chosen by, spelled out once and exercised four ways. */
const subtitlePick = async (name: string, subtitleTracks: any[], options: Record<string, unknown>) => {
  const manager = new PlaybackManager(tmp(`test-playback-${name}`)) as any;
  manager.inspect = async () => ({
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    video: { codec: "h264" }, audio: { codec: "aac" }, duration: 120,
    audioTracks: [{ index: 0, codec: "aac", language: "cs" }, { index: 1, codec: "aac", language: "en" }],
    subtitleTracks,
  });
  manager.spawnAt = async () => "/nope";
  manager.sidecars.run = async (_args: string[], _file: string, _append: boolean, signal: AbortSignal) =>
    whenAborted(signal);
  const started = await manager.start({ url: "https://cdn.example/movie.mp4" }, playCaps, options);
  await manager.stop(started.id);
  return started.subtitleTrack;
};

const czechForced = { index: 0, codec: "subrip", language: "cs", title: "CZ forced", forced: true };
const czech = { index: 1, codec: "subrip", language: "cs", title: "CZ" };
const english = { index: 2, codec: "subrip", language: "en" };

test("a viewer who understands the audio is given the forced lines and nothing else", async () => {
  assert.equal(await subtitlePick("forced", [czechForced, czech, english], { audioLanguage: "cs", subtitleLanguage: "cs" }), 0);
});

test("understood audio with no forced track leaves the subtitles off", async () => {
  assert.equal(await subtitlePick("forced-none", [czech, english], { audioLanguage: "cs", subtitleLanguage: "cs" }), null);
});

test("audio in a language the viewer did not ask for brings the whole film subtitled", async () => {
  assert.equal(await subtitlePick("full", [czechForced, czech, english], { audioLanguage: "de", subtitleLanguage: "cs" }), 1);
});

test("subtitles the viewer's language does not have fall back to English", async () => {
  assert.equal(await subtitlePick("fallback", [english], { audioLanguage: "de", subtitleLanguage: "cs" }), 2);
});

test("a hardware attempt whose path was switched off meanwhile gets the software arguments", () => {
  const manager = new PlaybackManager(tmp("test-playback")) as any;
  const session = {
    stream: { url: "https://example.test/movie.mkv" },
    capabilities: { h264: true },
    info: { video: { codec: "hevc" }, audio: { codec: "aac" }, audioTracks: [{ codec: "aac" }], subtitleTracks: [] },
    quality: null, audioTrack: 0, subtitleTrack: null,
  };
  const args = manager.args(session, 0, tmp("output"), true) as string[];
  assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
  assert.equal(args.includes("-hwaccel"), false);
  assert.equal(args.some((arg) => arg.includes("vaapi")), false);
});

test("a build without libx264 is recognised from its configure line", async () => {
  const { hasSoftwareEncoder } = await import("./playback.js");
  assert.equal(hasSoftwareEncoder("ffmpeg version 7.1.5\nconfiguration: --enable-gpl --enable-libx264 --enable-libx265"), true);
  assert.equal(hasSoftwareEncoder("ffmpeg version 9.0.2\nconfiguration: --disable-autodetect --enable-version3 --enable-openssl --enable-videotoolbox"), false);
  assert.equal(hasSoftwareEncoder("configuration: --enable-libx264rgb"), false);
});

test("without a software encoder a transcode tries hardware only, and a remux never needs either", async () => {
  const { conversionAttempts } = await import("./playback.js");
  assert.deepEqual(conversionAttempts(false, true, true), [true, false]);
  assert.deepEqual(conversionAttempts(false, true, false), [true]);
  assert.deepEqual(conversionAttempts(false, false, true), [false]);
  assert.deepEqual(conversionAttempts(true, true, false), [false]);
});

test("a failed inspection is retried and a successful retry is cached", async () => {
  const manager = new PlaybackManager(tmp("test-probe-retry")) as any;
  let calls = 0;
  const info = { video: { codec: "h264" }, duration: 6107, audioTracks: [], subtitleTracks: [] };
  manager.probeSource = async () => ++calls === 1 ? undefined : info;
  const stream = { url: "https://cdn.example/recovered.mkv" };
  assert.equal(await manager.inspect(stream), undefined);
  assert.equal(await manager.inspect(stream), info);
  assert.equal(await manager.inspect(stream), info);
  assert.equal(calls, 2);
});

test("a busy NVIDIA card does not count against NVENC", () => {
  assert.equal(nvencBusy("[h264_nvenc @ 0x1] OpenEncodeSessionEx failed: out of memory (10)"), true);
  assert.equal(nvencBusy("[h264_nvenc @ 0x1] No capable devices found"), true);
  assert.equal(nvencBusy("[h264_nvenc @ 0x1] Cannot load libcuda.so.1"), false);
  assert.equal(nvencBusy(undefined), false);
});


const flushPlayback = () => new Promise<void>((resolve) => setImmediate(resolve));

const retirementFixture = () => {
  const manager = new PlaybackManager(tmp("test-seek-retirement")) as any;
  const previous = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null });
  const session = remuxSession(manager, {
    directory: tmp("test-seek-retirement/escalated/1"), process: previous,
    pendingKill: Promise.resolve(),
  });
  const deleted: string[] = [];
  manager.purgeNow = async (directory: string) => { deleted.push(directory); };
  manager.killChild = async () => {};
  return { manager, session, previous, deleted, oldDirectory: session.directory };
};

test("a slow seek serves its fallback until success and then grants a full retirement window", async (t) => {
  const { manager, session, previous, deleted, oldDirectory } = retirementFixture();
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => { ready = resolve; });
  let finish!: () => void;
  manager.run = async () => {
    session.process = { exitCode: null, signalCode: null };
    ready();
    await new Promise<void>((resolve) => { finish = resolve; });
    return "/new-playlist";
  };
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const seek = manager.seek(session.id, 1200);
  await entered;
  t.mock.timers.tick(30_000);
  await flushPlayback();
  assert.equal(manager.directory(session.id, "1"), oldDirectory);
  assert.deepEqual(deleted, []);
  finish();
  await seek;
  previous.exitCode = 0;
  previous.emit("exit", 0, null);
  await flushPlayback();
  t.mock.timers.tick(14_999);
  await flushPlayback();
  assert.equal(manager.directory(session.id, "1"), oldDirectory);
  assert.deepEqual(deleted, []);
  t.mock.timers.tick(1);
  await flushPlayback();
  assert.equal(manager.directory(session.id, "1"), undefined);
  assert.deepEqual(deleted, [oldDirectory]);
});

test("retirement never deletes output before its own writer exits", async (t) => {
  const { manager, session, previous, deleted, oldDirectory } = retirementFixture();
  manager.run = async () => { session.process = { exitCode: null, signalCode: null }; return "/new"; };
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  await manager.seek(session.id, 1200);
  t.mock.timers.tick(20_000);
  await flushPlayback();
  assert.deepEqual(deleted, []);
  previous.exitCode = 0;
  previous.emit("exit", 0, null);
  await flushPlayback();
  t.mock.timers.tick(1);
  await flushPlayback();
  assert.deepEqual(deleted, [oldDirectory]);
});

test("failed seek retries preserve the fallback without accumulating retirement listeners or reusing output", async (t) => {
  const { manager, session, previous, deleted, oldDirectory } = retirementFixture();
  const generations: number[] = [];
  let refusing = true;
  manager.run = async () => {
    generations.push(session.generation);
    assert.equal(manager.directory(session.id, "1"), oldDirectory, "also served during the second attempt");
    session.process = { exitCode: refusing ? 1 : null, signalCode: null };
    session.hardware = true;
    session.error = refusing ? "attempt failed" : undefined;
    return refusing ? undefined : "/new";
  };
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (let attempt = 0; attempt < 12; attempt++) {
    let done = false;
    const failed = manager.seek(session.id, 1200).then((result: any) => {
      assert.equal(result.seekRestored, true);
      assert.equal(result.offset, 0);
      assert.equal(result.hardware, false);
      assert.equal(session.error, undefined);
    }).finally(() => { done = true; });
    while (!done) { await flushPlayback(); t.mock.timers.tick(1000); }
    await failed;
    assert.equal(manager.directory(session.id, "1"), oldDirectory);
    assert.equal(previous.listenerCount("exit"), 0);
    assert.equal(deleted.includes(oldDirectory), false);
  }
  assert.equal(deleted.length, 24, "partial output from both failed attempts is cleaned up");
  refusing = false;
  await manager.seek(session.id, 1300);
  assert.equal(new Set(generations).size, generations.length, "failed generation directories are never reused");
  assert.equal(previous.listenerCount("exit"), 1);
  previous.exitCode = 0;
  previous.emit("exit", 0, null);
  await flushPlayback();
  t.mock.timers.tick(14_999);
  await flushPlayback();
  assert.equal(manager.directory(session.id, "1"), oldDirectory);
  assert.equal(deleted.includes(oldDirectory), false, "no stale timer from a failed seek shortens the new grace period");
  t.mock.timers.tick(1);
  await flushPlayback();
  assert.equal(deleted.filter((directory) => directory === oldDirectory).length, 1);
});

test("closing during a seek also stops the preserved fallback conversion", async () => {
  const manager = new PlaybackManager(tmp("test-close-pending-seek")) as any;
  const previous = { exitCode: null, signalCode: null };
  const replacement = { exitCode: null, signalCode: null };
  const session = remuxSession(manager, { process: previous });
  const killed: unknown[] = [];
  manager.killChild = async (child: unknown) => { killed.push(child); };
  manager.spawnAt = async () => {
    session.process = replacement;
    session.stopped = true;
    throw new Error("closed while opening the new source");
  };
  await assert.rejects(manager.seek(session.id, 1200), /no longer exists/);
  assert.ok(killed.includes(previous), "the fallback process must not outlive a closed player");
});

test("a player closed during a hardware seek does not count against the GPU", async () => {
  const manager = new PlaybackManager(tmp("test-close-hardware-seek")) as any;
  manager.vaapiDevice = "/dev/dri/renderD128";
  manager.softwareEncoder = true;
  manager.plan = () => ({ copyVideo: false, copyAudio: false });
  manager.killChild = async () => {};
  manager.purgeNow = async () => {};
  let close = true;
  let closing: Promise<void> | undefined;
  manager.run = async (session: any) => {
    session.process = { exitCode: null, signalCode: null };
    if (close) { closing = manager.stop(session.id); return undefined; }
    session.error = "Failed to initialise VAAPI connection";
    return undefined;
  };
  for (const id of ["first", "second"]) {
    const session = remuxSession(manager, { id, mode: "transcode", process: { exitCode: null, signalCode: null } });
    await assert.rejects(manager.seek(session.id, 1200), /no longer exists/);
    await closing;
  }
  assert.equal(manager.vaapiFailures, 0);
  assert.equal(manager.vaapiDevice, "/dev/dri/renderD128");

  // A seek whose hardware attempts really failed, once and once more on the retry, still switches it off.
  close = false;
  const failing = remuxSession(manager, {
    id: "failing",
    mode: "transcode",
    directory: tmp("test-close-hardware-seek/failing"),
    process: { exitCode: null, signalCode: null },
  });
  assert.equal((await manager.seek(failing.id, 1200)).seekRestored, true);
  assert.equal(manager.vaapiFailures, 2);
  assert.equal(manager.vaapiDevice, undefined);
});

test("a GPU failure, then a success, then another failure leaves the accelerator on", async () => {
  const manager = new PlaybackManager(tmp("test-hardware-streak")) as any;
  manager.vaapiDevice = "/dev/dri/renderD128";
  manager.softwareEncoder = true;
  manager.plan = () => ({ copyVideo: false, copyAudio: false });
  manager.killChild = async () => {};
  manager.purgeNow = async () => {};
  // The software pass only runs when the hardware one fails, and always opens the film.
  let gpuWorks = false;
  manager.run = async (session: any, _offset: number, _directory: string, hardware: boolean) => {
    session.process = { exitCode: hardware && !gpuWorks ? 1 : 0, signalCode: null };
    if (hardware && !gpuWorks) { session.error = "Failed to initialise VAAPI connection"; return undefined; }
    return "/hls";
  };
  const play = (id: string) => manager.spawnAt(remuxSession(manager, { id, mode: "transcode", generation: 0 }), 0);

  await play("first");             // one bad file: the GPU fails once, software carries it
  assert.equal(manager.vaapiFailures, 1);
  gpuWorks = true;
  await play("second");            // a GPU pass that opens the film resets the streak
  assert.equal(manager.vaapiFailures, 0);
  gpuWorks = false;
  await play("third");             // one further failure is not a streak, so the GPU stays on
  assert.equal(manager.vaapiFailures, 1);
  assert.equal(manager.vaapiDevice, "/dev/dri/renderD128");
});

test("two consecutive GPU failures still switch the accelerator off", async () => {
  const manager = new PlaybackManager(tmp("test-hardware-off")) as any;
  manager.vaapiDevice = "/dev/dri/renderD128";
  manager.softwareEncoder = true;
  manager.plan = () => ({ copyVideo: false, copyAudio: false });
  manager.killChild = async () => {};
  manager.purgeNow = async () => {};
  manager.run = async (session: any, _offset: number, _directory: string, hardware: boolean) => {
    session.process = { exitCode: hardware ? 1 : 0, signalCode: null };
    if (hardware) { session.error = "Failed to initialise VAAPI connection"; return undefined; }
    return "/hls";
  };
  const play = (id: string) => manager.spawnAt(remuxSession(manager, { id, mode: "transcode", generation: 0 }), 0);

  await play("first");
  await play("second");
  assert.equal(manager.vaapiFailures, 2);
  assert.equal(manager.vaapiDevice, undefined);
});

test("a timed-out hardware pass is dead before the retry purges its directory", { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "playback-retry-"));
  const fake = path.join(directory, "ffmpeg");
  // A conversion that started and then stopped producing output, standing in for a timed-out pass.
  await writeFile(fake, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n");
  await chmod(fake, 0o755);
  const originalBinary = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = fake;
  t.after(() => { if (originalBinary === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = originalBinary; });

  const root = await mkdtemp(path.join(os.tmpdir(), "playback-retry-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new PlaybackManager(root) as any;
  manager.vaapiDevice = "/dev/dri/renderD128";
  manager.softwareEncoder = true;
  // copyRejected forces a real transcode, so the first pass is the hardware one.
  const session = remuxSession(manager, { id: "retry", mode: "transcode", generation: 0, copyRejected: true });
  // What the failed hardware pass left behind; the software retry must not inherit it.
  const generation = path.join(root, "playback", session.id, "1");
  await mkdir(generation, { recursive: true });
  await writeFile(path.join(generation, "index-0.m3u8"), "#EXTM3U\n#EXT-X-VERSION:7\n");

  const seen: { hardware: boolean; playlist: boolean }[] = [];
  const realArgs = manager.args.bind(manager);
  manager.args = (target: any, offset: number, folder: string, hardware: boolean, playlist: string[]) => {
    seen.push({ hardware, playlist: existsSync(path.join(folder, "index-0.m3u8")) });
    return realArgs(target, offset, folder, hardware, playlist);
  };

  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let done = false;
  const failed = manager.spawnAt(session, 0).catch(() => undefined).finally(() => { done = true; });
  while (!done) { await flushPlayback(); t.mock.timers.tick(100); }
  await failed;
  assert.deepEqual(seen.map((pass) => pass.hardware), [true, false], "a hardware pass, then a software retry");
  assert.equal(seen[0].playlist, true, "the failed pass's playlist is in the directory to begin with");
  assert.equal(seen[1].playlist, false, "the retry purged it before the software pass started");
});

for (const copy of [false, true]) {
  const kind = copy ? "remux" : "transcode";
  // The fake FFmpeg is a node script run through its shebang, which Windows cannot execute; the
  // handover itself is the same on every platform and hlsCanStart's own test runs there.
  const skip = process.platform === "win32" ? "Windows cannot run a script as the FFmpeg binary" : false;
  test(`a ${kind} is handed to the player once ${copy ? "one segment is" : "two segments are"} listed`, { timeout: 20_000, skip }, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "playback-handover-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    // Publishes one 2 s segment at once and the second only later, the way FFmpeg's first
    // segments land a moment apart; then keeps running like a live conversion.
    const fake = path.join(directory, "ffmpeg");
    const head = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="init.mp4"\n';
    await writeFile(fake, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const out = path.dirname(process.argv[process.argv.length - 1]);
const head = ${JSON.stringify(head)};
const seg = (n) => "#EXTINF:2.000,\\nseg-0-00000" + n + ".m4s\\n";
fs.writeFileSync(path.join(out, "init.mp4"), "init");
fs.writeFileSync(path.join(out, "seg-0-000000.m4s"), "zero");
fs.writeFileSync(path.join(out, "index-0.m3u8"), head + seg(0));
setTimeout(() => {
  fs.writeFileSync(path.join(out, "seg-0-000001.m4s"), "one");
  fs.writeFileSync(path.join(out, "index-0.m3u8"), head + seg(0) + seg(1));
}, 600);
setInterval(() => {}, 1000);
`);
    await chmod(fake, 0o755);
    const originalBinary = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = fake;
    t.after(() => { if (originalBinary === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = originalBinary; });

    const root = await mkdtemp(path.join(os.tmpdir(), "playback-handover-root-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const manager = new PlaybackManager(root) as any;
    manager.vaapiDevice = undefined;
    manager.softwareEncoder = true;
    const session = remuxSession(manager, { id: `handover-${kind}`, mode: kind, generation: 0, copyRejected: !copy });
    t.after(() => { try { session.process?.kill("SIGKILL"); } catch { /* already gone */ } });

    assert.ok(await manager.spawnAt(session, 0));
    assert.equal(session.mode, kind);
    const second = existsSync(path.join(session.directory, "seg-0-000001.m4s"));
    assert.equal(second, !copy, copy
      ? "a remux starts on its first segment"
      : "a transcode waits for the second segment, so hls.js's first 2 s reload finds more to play");
  });
}

for (const scenario of ["dead fallback", "decode recovery"] as const) {
  test(`a failed restart does not report a recoverable seek for ${scenario}`, async (t) => {
    const { manager, session, previous } = retirementFixture();
    if (scenario === "dead fallback") previous.exitCode = 1;
    manager.run = async () => { session.process = { exitCode: 1, signalCode: null }; return undefined; };
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let done = false;
    const rejected = assert.rejects(scenario === "dead fallback"
      ? manager.seek(session.id, 1200)
      : manager.escalate(session.id, 1200), /conversion could not be started/)
      .finally(() => { done = true; });
    while (!done) { await flushPlayback(); t.mock.timers.tick(1000); }
    await rejected;
  });
}

test("a conversion of an HLS master maps the chosen rendition, not the first one listed", () => {
  const manager = new PlaybackManager(tmp("test-variant-map")) as any;
  const session = {
    id: "v", stream: { url: "https://cdn.example/master.m3u8" }, capabilities: { h264: true, aac: true },
    info: { container: "hls", video: { codec: "h264" }, audio: { codec: "aac" }, audioTracks: [{ index: 0, codec: "aac" }], subtitleTracks: [], variant: { video: 12, audio: 13 } },
    mode: "remux", generation: 1, offset: 0, hardware: false, audioTrack: 0, subtitleTrack: null, quality: null,
  };
  const args: string[] = manager.args(session, 0, "/tmp/out", false);
  const maps = args.flatMap((value, index) => value === "-map" ? [args[index + 1]] : []);
  assert.deepEqual(maps.slice(0, 2), ["0:12", "0:13"]);
});
