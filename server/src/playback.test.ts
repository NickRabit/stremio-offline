import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PlaybackManager, SOURCE_UNREACHABLE, SerialOperations, clientCapabilities, describeFailure, hlsCanStart, hlsPlaylistFiles, isPlaylistSource, sourceReachable, nvencBusy } from "./playback.js";
import { setFetchTransport } from "./security.js";

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
  assert.deepEqual(args.slice(tag + 2, tag + 4), ["-c:a", "aac"]);
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
    if (refuse) throw new Error("The source could not be opened: it did not answer, or it refused the connection.");
    session.offset = offset; session.generation += 1; session.process = alive;
    session.directory = tmp(`test-seek-keeps-playing/${session.generation}`);
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
  const failing = remuxSession(manager, { id: "failing", mode: "transcode", process: { exitCode: null, signalCode: null } });
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
