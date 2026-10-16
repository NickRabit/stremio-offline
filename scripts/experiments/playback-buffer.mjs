import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

// Run only in the disposable Linux container documented in playback-buffer-spec.md.
assert.equal(process.platform, "linux");
assert.match(await readFile("/proc/mounts", "utf8"), /\S+ \/lab tmpfs /);
const run = promisify(execFile);
const root = await mkdtemp("/lab/buffer-");
const ffmpeg = async (args) => run("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { timeout: 20_000 });
const output = { ffmpeg: (await run("ffmpeg", ["-version"])).stdout.split("\n")[0], cases: [] };
const children = new Set();

async function snapshot(dir) {
  const text = await readFile(path.join(dir, "index.m3u8"), "utf8").catch(() => "");
  const files = await readdir(dir);
  return {
    sequence: Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)?.[1] ?? 0),
    listed: text.split("\n").filter((line) => line.endsWith(".m4s")),
    durations: [...text.matchAll(/#EXTINF:([\d.]+)/g)].map((match) => Number(match[1])),
    segmentsOnDisk: files.filter((name) => name.endsWith(".m4s")).length,
    bytes: (await Promise.all(files.map((name) => stat(path.join(dir, name)).then((s) => s.size, () => 0)))).reduce((a, b) => a + b, 0),
    event: text.includes("#EXT-X-PLAYLIST-TYPE:EVENT"),
    ended: text.includes("#EXT-X-ENDLIST"),
  };
}

function args(source, dir, extra) {
  return ["-i", source, "-map", "0:v:0", "-c:v", "copy", "-an", "-f", "hls", "-hls_time", "2",
    "-hls_segment_type", "fmp4", "-hls_flags", "independent_segments+temp_file+delete_segments",
    "-hls_delete_threshold", "1", "-hls_segment_filename", path.join(dir, "seg-%06d.m4s"),
    ...extra, path.join(dir, "index.m3u8")];
}

try {
  const sources = {};
  for (const [name, gop] of [["short", 20], ["long", 100]]) {
    const source = path.join(root, `${name}.mp4`);
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-t", "40", "-c:v", "libx264",
      "-preset", "ultrafast", "-g", String(gop), "-keyint_min", String(gop), "-sc_threshold", "0", "-an", source]);
    sources[name] = source;
  }
  for (const [name, source, extra] of [
    ["event-with-delete", sources.short, ["-hls_playlist_type", "event", "-hls_list_size", "3"]],
    ["sliding", sources.short, ["-hls_list_size", "3"]],
    ["sliding-long-gop", sources.long, ["-hls_list_size", "3"]],
  ]) {
    const dir = path.join(root, name);
    await mkdir(dir);
    await ffmpeg(args(source, dir, extra));
    const result = await snapshot(dir);
    output.cases.push({ name, ...result });
    if (name === "event-with-delete") {
      assert.equal(result.segmentsOnDisk, 20);
      assert.equal(result.listed.length, 20);
      assert.equal(result.sequence, 0);
    } else if (name === "sliding") {
      assert.equal(result.listed.length, 3);
      assert.equal(result.sequence, 17);
      assert.equal(result.segmentsOnDisk, 4);
      output.pausedReader = {
        requested: "seg-000000.m4s", existsAfterProducerFinishes: (await readdir(dir)).includes("seg-000000.m4s"),
        retainedStartSeconds: result.sequence * 2,
      };
      assert.equal(output.pausedReader.existsAfterProducerFinishes, false);
    } else {
      assert.equal(result.listed.length, 3);
      assert.equal(result.durations.length, 3);
      assert.ok(result.durations.every((duration) => duration === 10));
    }
  }

  const dir = path.join(root, "pause");
  await mkdir(dir);
  const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-readrate", "5",
    ...args(sources.short, dir, ["-hls_playlist_type", "event", "-hls_list_size", "0"])], { stdio: ["ignore", "ignore", "pipe"] });
  children.add(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const ended = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => { children.delete(child); resolve(code); });
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const deadline = Date.now() + 5000;
    while ((await snapshot(dir)).listed.length < 2) {
      assert.ok(Date.now() < deadline, "FFmpeg must publish two segments");
      await delay(25);
    }
    assert.ok(child.kill("SIGSTOP"));
    await delay(100);
    const before = await snapshot(dir);
    await delay(500);
    const after = await snapshot(dir);
    assert.deepEqual(after, before);
    assert.ok(child.kill("SIGCONT"));
    assert.equal(await ended, 0, stderr);
    const final = await snapshot(dir);
    assert.equal(final.listed.length, 20);
    assert.ok(final.ended);
    await ffmpeg(["-i", path.join(dir, "index.m3u8"), "-f", "null", "-"]);
    output.pause = { stableForMs: 500, segmentsWhilePaused: before.listed.length, finalSegments: final.listed.length, decodedToEnd: true };
  } finally {
    clearTimeout(timeout);
  }

  await rm(root, { recursive: true });
  let mountRootRemoval;
  try { await rmdir("/lab"); }
  catch (error) { mountRootRemoval = error.code; }
  assert.equal(mountRootRemoval, "EBUSY");
  output.mountRootRemoval = mountRootRemoval;
  console.log(JSON.stringify(output, null, 2));
} finally {
  for (const child of children) child.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
}
