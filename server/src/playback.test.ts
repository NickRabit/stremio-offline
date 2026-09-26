import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { PlaybackManager, SOURCE_UNREACHABLE, SerialOperations, describeFailure, hlsCanStart, hlsPlaylistFiles, isPlaylistSource, sourceReachable } from "./playback.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const manager = new PlaybackManager("/tmp/test-playback") as any;
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

  const args = manager.args(session, 0, "/tmp/output", true) as string[];
  assert.deepEqual(args.slice(args.indexOf("-init_hw_device"), args.indexOf("-init_hw_device") + 4), [
    "-init_hw_device", "vaapi=va:/dev/dri/renderD128", "-filter_hw_device", "va",
  ]);
  assert.equal(args.includes("-hwaccel"), false);
  assert.equal(args[args.indexOf("-c:v") + 1], "h264_vaapi");
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  assert.equal(args[args.indexOf("-qp") + 1], "23");
});

test("VideoToolbox decodes, scales and encodes on the Mac without a single VAAPI flag", () => {
  const manager = new PlaybackManager("/tmp/test-videotoolbox") as any;
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

  const args = manager.args(session, 0, "/tmp/output", true) as string[];
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
  const manager = new PlaybackManager("/tmp/test-videotoolbox-quality") as any;
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
  const constant = manager.args(session, 0, "/tmp/output", true) as string[];
  assert.equal(constant[constant.indexOf("-vf") + 1], "format=nv12");
  assert.equal(constant[constant.indexOf("-q:v") + 1], "60");

  process.env.VIDEOTOOLBOX_QUALITY = "70";
  try {
    const tuned = manager.args(session, 0, "/tmp/output", true) as string[];
    assert.equal(tuned[tuned.indexOf("-q:v") + 1], "70");
  } finally {
    delete process.env.VIDEOTOOLBOX_QUALITY;
  }

  manager.videotoolboxQuality = false;
  const fixed = manager.args(session, 0, "/tmp/output", true) as string[];
  assert.deepEqual(fixed.slice(fixed.indexOf("-b:v"), fixed.indexOf("-b:v") + 2), ["-b:v", "8M"]);
  assert.equal(fixed.includes("-q:v"), false);
});

test("the software fallback for a Mac stays libx264", () => {
  const manager = new PlaybackManager("/tmp/test-videotoolbox-software") as any;
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

  const args = manager.args(session, 0, "/tmp/output", false) as string[];
  assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
  assert.equal(args.includes("-hwaccel"), false);
  assert.equal(args.join(" ").includes("videotoolbox"), false);
});

test("VAAPI wins over VideoToolbox when a Mac carries both", () => {
  const manager = new PlaybackManager("/tmp/test-videotoolbox-vaapi") as any;
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

  const args = manager.args(session, 0, "/tmp/output", true) as string[];
  assert.deepEqual(args.slice(args.indexOf("-hwaccel"), args.indexOf("-hwaccel") + 4), [
    "-hwaccel", "vaapi", "-hwaccel_device", "/dev/dri/renderD128",
  ]);
  assert.equal(args[args.indexOf("-c:v") + 1], "h264_vaapi");
  assert.equal(args.join(" ").includes("videotoolbox"), false);
});

test("a remux never touches VideoToolbox, whatever the accelerator", () => {
  const manager = new PlaybackManager("/tmp/test-videotoolbox-remux") as any;
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
    const args = manager.args(session, 0, "/tmp/output", hardware) as string[];
    assert.equal(args[args.indexOf("-c:v") + 1], "copy");
    assert.equal(args.includes("-hwaccel"), false);
  }
});

test("a remux still copies compatible video and audio", () => {
  const manager = new PlaybackManager("/tmp/test-playback") as any;
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

  const args = manager.args(session, 0, "/tmp/output", false) as string[];
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.equal(args[args.indexOf("-c:a") + 1], "copy");
});

test("Dolby Vision is read as it comes but never announced to the browser", () => {
  const manager = new PlaybackManager("/tmp/test-dolby-vision") as any;
  const session = {
    capabilities: { hevc: true, hevc10: true, aac: true },
    info: { container: "matroska", duration: 6520,
      video: { codec: "hevc", profile: "Main 10", pixelFormat: "yuv420p10le", dolbyVisionEnhancementLayer: true },
      audio: { codec: "ac3" }, audioTracks: [{ index: 0, codec: "ac3" }], subtitleTracks: [] },
    audioTrack: 0, quality: null, id: "s", stream: { url: "https://cdn.example/dolby.mkv" },
    mode: "remux", generation: 1, offset: 0, hardware: false, subtitleTrack: null,
    startedAt: Date.now(), lastAccess: Date.now(), operations: new SerialOperations(), stopped: false, claimed: false,
  };
  const args: string[] = manager.args(session, 0, "/tmp/gen", false);
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
  const manager = new PlaybackManager("/tmp/test-playback") as any;
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
  const manager = new PlaybackManager("/tmp/test-playback") as any;
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

  const args = manager.args(session, 0, "/tmp/output", false) as string[];
  assert.equal(args[args.indexOf("-c:a") + 1], "copy");
  assert.equal(args[args.indexOf("-bsf:a") + 1], "aac_adtstoasc");
});

test("copied AAC from a file is left alone, ADTS only comes from a playlist", () => {
  const manager = new PlaybackManager("/tmp/test-playback") as any;
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

  const args = manager.args(session, 0, "/tmp/output", false) as string[];
  assert.equal(args[args.indexOf("-c:a") + 1], "copy");
  assert.equal(args.includes("-bsf:a"), false);
});

test("audio that is not AAC is copied without the AAC filter", () => {
  const manager = new PlaybackManager("/tmp/test-playback") as any;
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

  const args = manager.args(session, 0, "/tmp/output", false) as string[];
  assert.equal(args[args.indexOf("-c:a") + 1], "copy");
  assert.equal(args.includes("-bsf:a"), false);
});

test("a transcoded track is re-encoded to AAC, so it needs no filter", () => {
  const manager = new PlaybackManager("/tmp/test-playback") as any;
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

  const args = manager.args(session, 0, "/tmp/output", false) as string[];
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  assert.equal(args.includes("-bsf:a"), false);
});

test("text subtitles behind a filtered-out PGS track use the real index", () => {
  const manager = new PlaybackManager("/tmp/test-playback") as any;
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
  const args = manager.args(session, 0, "/tmp/output", false) as string[];
  // WebVTT in the fMP4 mux dies with "timescale not set"; the track is extracted as a sidecar.
  assert.equal(args.includes("0:s:1?"), false);
  assert.equal(args.includes("webvtt"), false);
  assert.equal(args[args.indexOf("-var_stream_map") + 1], "v:0,a:0");
});

test("a seek with copied AC3 audio converts it to AAC for the fMP4 init segment", () => {
  const manager = new PlaybackManager("/tmp/test-playback") as any;
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

  const initial = manager.args(session, 0, "/tmp/output", false) as string[];
  assert.equal(initial[initial.indexOf("-c:a") + 1], "copy");
  const seeked = manager.args(session, 2369, "/tmp/output", false) as string[];
  const audio = seeked.indexOf("-c:a");
  assert.deepEqual(seeked.slice(audio, audio + 6), ["-c:a", "aac", "-ac", "2", "-b:a", "160k"]);
});

test("a conversion reconnects when a remote source drops the stream", () => {
  const manager = new PlaybackManager("/tmp/test-playback-reconnect") as any;
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

  const args = manager.args(session, 3949, "/tmp/output", false) as string[];
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
  const manager = new PlaybackManager("/tmp/test-playback") as any;
  const session = {
    id: "s1", mode: "remux", generation: 3, directory: "/tmp/test-playback/s1/3",
    lastAccess: 0, claimed: false,
    retired: { generation: 2, directory: "/tmp/test-playback/s1/2", until: Date.now() + 5_000 },
  };
  manager.sessions.set("s1", session);

  assert.equal(manager.directory("s1", "3"), "/tmp/test-playback/s1/3");
  assert.equal(manager.directory("s1", "2"), "/tmp/test-playback/s1/2");
  assert.equal(session.claimed, true);
  assert.equal(manager.directory("s1", "1"), undefined);

  session.retired.until = Date.now() - 1;
  assert.equal(manager.directory("s1", "2"), undefined);
});

test("a session no client claimed is closed by the sweep sooner than an idle one", async () => {
  const manager = new PlaybackManager("/tmp/test-playback") as any;
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
  const manager = new PlaybackManager("/tmp/test-playback") as any;
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
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 206 }));
  assert.equal(await sourceReachable({ url: "https://cdn.example/movie.mkv" }), true);
});

test("sourceReachable is false for a connection the source refuses", async (t) => {
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  t.after(() => { delete process.env.ALLOW_PRIVATE_ADDONS; });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("connect ECONNREFUSED"); });
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
  t.mock.method(globalThis, "fetch", async () => { throw new Error("connect ETIMEDOUT"); });
  const manager = new PlaybackManager("/tmp/test-playback") as any;
  const info = await manager.inspect({ url: "https://cdn.example/movie.mkv" });
  assert.equal(info, undefined);
});

test("inspect of different URLs is not coalesced", async () => {
  const manager = new PlaybackManager("/tmp/test-playback") as any;
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
  const manager = new PlaybackManager("/tmp/test-playback") as any;
  const mp4 = { container: "mov,mp4,m4a,3gp,3g2,mj2", video: { codec: "h264" }, audio: { codec: "aac" } };
  assert.equal(manager.directPlay({ url: "https://cdn.example/a", behaviorHints: { filename: "Movie.mkv" } }, mp4, playCaps).ok, true);
  const mkv = { container: "matroska,webm", video: { codec: "h264" }, audio: { codec: "aac" } };
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mkv", behaviorHints: { filename: "Movie.mkv" } }, mkv, playCaps).ok, false);
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mp4", behaviorHints: { filename: "Movie.mp4" } }, mkv, playCaps).ok, false);
});

test("direct play still uses the extension when ffprobe omitted the format name", () => {
  const manager = new PlaybackManager("/tmp/test-playback") as any;
  const info = { container: "", video: { codec: "h264" }, audio: { codec: "aac" } };
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mp4", behaviorHints: { filename: "Movie.mp4" } }, info, playCaps).ok, true);
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mkv", behaviorHints: { filename: "Movie.mkv" } }, info, playCaps).ok, false);
});

test("webm codecs inside matroska,webm play directly; h264 in that container does not", () => {
  const manager = new PlaybackManager("/tmp/test-playback") as any;
  const webm = { container: "matroska,webm", video: { codec: "vp9" }, audio: { codec: "opus" } };
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mkv" }, webm, playCaps).ok, true);
  const mkv = { container: "matroska,webm", video: { codec: "h264" }, audio: { codec: "aac" } };
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.webm" }, mkv, playCaps).ok, false);
});

test("incompatible codecs, HLS and notWebReady still force a conversion", () => {
  const manager = new PlaybackManager("/tmp/test-playback") as any;
  const mp4 = { container: "mov,mp4,m4a,3gp,3g2,mj2", video: { codec: "h264" }, audio: { codec: "aac" } };
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mp4", behaviorHints: { notWebReady: true } }, mp4, playCaps).ok, false);
  const ac3 = { container: "mov,mp4,m4a,3gp,3g2,mj2", video: { codec: "h264" }, audio: { codec: "ac3" } };
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mp4" }, ac3, playCaps).ok, false);
  const hevc10 = { container: "mov,mp4,m4a,3gp,3g2,mj2", video: { codec: "hevc", profile: "Main 10", pixelFormat: "yuv420p10le" }, audio: { codec: "aac" } };
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.mp4" }, hevc10, { ...playCaps, hevc10: false }).ok, false);
  const hls = { container: "hls,applehttp", video: { codec: "h264" }, audio: { codec: "aac" } };
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.m3u8" }, hls, playCaps).ok, false);
  const avi = { container: "avi", video: { codec: "mpeg4" }, audio: { codec: "mp3" } };
  assert.equal(manager.directPlay({ url: "https://cdn.example/a.avi" }, avi, playCaps).ok, false);
});

test("a playable mp4 with a preferred subtitle stays on direct play", async () => {
  const manager = new PlaybackManager("/tmp/test-playback-sidecar") as any;
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
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
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
  const manager = new PlaybackManager("/tmp/test-playback-sidecar-mkv") as any;
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
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  const started = await manager.start({ url: "https://cdn.example/movie.mkv" }, playCaps, { subtitleLanguage: "cs" });
  assert.equal(spawned, true);
  assert.equal(started.mode, "remux");
  assert.match(started.sidecarUrl ?? "", /sidecar\.vtt\?revision=/);
  while (!extracted) await pause(5);
  assert.equal(extracted, 1);
  await manager.sidecars.stop(started.id);
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
  const manager = new PlaybackManager("/tmp/test-playback") as any;
  const session = remuxSession(manager, { capabilities: { h264: true, ac3: true }, info: {
    container: "matroska,webm", video: { codec: "h264" }, audio: { codec: "ac3" },
    audioTracks: [{ index: 0, codec: "ac3" }], subtitleTracks: [],
  } });

  assert.deepEqual(manager.plan(session), { copyVideo: true, copyAudio: true });
  session.copyRejected = true;
  assert.deepEqual(manager.plan(session), { copyVideo: false, copyAudio: false });

  const args = manager.args(session, 0, "/tmp/output", false) as string[];
  assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
});

test("escalate marks the session and restarts the conversion at the same spot", async () => {
  const manager = new PlaybackManager("/tmp/test-playback") as any;
  const session = remuxSession(manager);
  const spawned = stubSpawn(manager, session);

  const restarted = await manager.escalate("escalated", 612);

  assert.equal(session.copyRejected, true);
  assert.equal(restarted.mode, "transcode");
  assert.deepEqual(spawned, [612]);
});

test("escalate from direct play converts instead of handing the file over again", async () => {
  const manager = new PlaybackManager("/tmp/test-playback") as any;
  const session = remuxSession(manager, { mode: "direct" });
  stubSpawn(manager, session);

  const restarted = await manager.escalate("escalated", 0);

  assert.equal(restarted.mode, "transcode");
  assert.equal(session.mode, "transcode");
});

test("a session that already transcodes is not escalated twice, only restarted", async () => {
  const manager = new PlaybackManager("/tmp/test-playback") as any;
  const session = remuxSession(manager, { mode: "transcode", copyRejected: true });
  const restarts = stubSpawn(manager, session);

  await manager.escalate("escalated", 100);

  assert.deepEqual(restarts, [100]);
  assert.equal(session.mode, "transcode");
});

test("a track switch does not fall back to direct play the browser has already refused", async () => {
  const manager = new PlaybackManager("/tmp/test-playback") as any;
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
  const manager = new PlaybackManager("/tmp/test-playback-source") as any;
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
  const manager = new PlaybackManager("/tmp/test-playback") as any;
  let probes = 0;
  manager.probeSource = async () => { probes++; return undefined; };
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
  const manager = new PlaybackManager("/tmp/test-playback") as any;
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
  const args = manager.args(session, 0, "/tmp/output", false, flags) as string[];


  // An option after -i applies to the output, where the HLS demuxer never sees it.
  assert.ok(args.indexOf("-allowed_extensions") > -1, "the flags are missing");
  assert.ok(args.indexOf("-allowed_extensions") < args.indexOf("-i"), "the flags land after the input");

  // Without them, every playlist entry our proxy rewrites to /api/media/<id> is refused for
  // having no file ending, and an HLS source probes fine and then will not convert.
  const bare = manager.args(session, 0, "/tmp/output", false) as string[];
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
  const manager = new PlaybackManager("/tmp/test-seek-sidecars") as any;
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
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
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
  const manager = new PlaybackManager("/tmp/test-seek-stop", () => {
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
  const manager = new PlaybackManager("/tmp/test-subtitle-switch") as any;
  manager.inspect = async () => ({ container: "matroska", duration: 7000,
    video: { codec: "hevc" }, audio: { codec: "ac3" },
    audioTracks: [{ index: 0, codec: "ac3" }],
    subtitleTracks: [{ index: 0, codec: "subrip", language: "en" }, { index: 1, codec: "subrip", language: "cs" }],
  });
  const spawns: number[] = [];
  const readers: number[] = [];
  manager.spawnAt = async (session: any, offset: number) => { session.offset = offset; session.generation += 1; spawns.push(offset); return `/api/playback/${session.id}/${session.generation}/master.m3u8`; };
  manager.sidecars.run = async (_args: string[], _file: string, _append: boolean, signal: AbortSignal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
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
  const manager = new PlaybackManager("/tmp/test-seek-keeps-playing") as any;
  manager.inspect = async () => ({ container: "matroska", duration: 7000,
    video: { codec: "hevc" }, audio: { codec: "ac3" },
    audioTracks: [{ index: 0, codec: "ac3" }], subtitleTracks: [],
  });
  const alive = { exitCode: null, signalCode: null, kill: () => {}, once: () => {} };
  let refuse = false;
  manager.spawnAt = async (session: any, offset: number) => {
    if (refuse) throw new Error("The source could not be opened: it did not answer, or it refused the connection.");
    session.offset = offset; session.generation += 1; session.process = alive;
    session.directory = `/tmp/test-seek-keeps-playing/${session.generation}`;
    return `/api/playback/${session.id}/${session.generation}/master.m3u8`;
  };
  manager.killChild = async () => {};
  const started = await manager.start({ url: "https://cdn.example/large.mkv" }, { hevc: true }, { startTime: 900 });
  const playing = { generation: (manager.sessions.get(started.id) as any).generation, url: started.url };

  refuse = true;
  await assert.rejects(() => manager.seek(started.id, 4000), /could not be opened/);
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
  const manager = new PlaybackManager("/tmp/test-purge-guard") as any;
  const deleted: string[] = [];
  manager.purgeNow = async (directory: string) => { deleted.push(directory); };
  const session = remuxSession(manager);
  session.directory = "/tmp/test-purge-guard/session/2";
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
  const manager = new PlaybackManager("/tmp/test-orphan") as any;
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
  const manager = new PlaybackManager("/tmp/test-attended") as any;
  const session = remuxSession(manager);
  session.clientAt = undefined;
  manager.touch(session.id);
  assert.equal(session.clientAt, undefined, "the proxy serving FFmpeg is not the player");
  manager.attended(session.id);
  assert.ok(session.clientAt !== undefined && Date.now() - session.clientAt < 1000);
});

/** The rule the tracks are chosen by, spelled out once and exercised four ways. */
const subtitlePick = async (name: string, subtitleTracks: any[], options: Record<string, unknown>) => {
  const manager = new PlaybackManager(`/tmp/test-playback-${name}`) as any;
  manager.inspect = async () => ({
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    video: { codec: "h264" }, audio: { codec: "aac" }, duration: 120,
    audioTracks: [{ index: 0, codec: "aac", language: "cs" }, { index: 1, codec: "aac", language: "en" }],
    subtitleTracks,
  });
  manager.spawnAt = async () => "/nope";
  manager.sidecars.run = async (_args: string[], _file: string, _append: boolean, signal: AbortSignal) =>
    new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
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
  const manager = new PlaybackManager("/tmp/test-playback") as any;
  const session = {
    stream: { url: "https://example.test/movie.mkv" },
    capabilities: { h264: true },
    info: { video: { codec: "hevc" }, audio: { codec: "aac" }, audioTracks: [{ codec: "aac" }], subtitleTracks: [] },
    quality: null, audioTrack: 0, subtitleTrack: null,
  };
  const args = manager.args(session, 0, "/tmp/output", true) as string[];
  assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
  assert.equal(args.includes("-hwaccel"), false);
  assert.equal(args.some((arg) => arg.includes("vaapi")), false);
});
