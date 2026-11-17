import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { HLS_STALL_MS, isPlaylist, proxiedPlaylistInput } from "./downloads.js";
import { mediaResources } from "./media-resources.js";
import { queuedFile, tempQueue, waitFor } from "./downloads-test-support.js";

test("a playlist is told apart from a file, whatever the segments are named", () => {
  // The addresses that prompted this: the extension sits after another one, and
  // a query string follows it.
  assert.equal(isPlaylist("https://cdn.example/media/1080.mp4.m3u8"), true);
  assert.equal(isPlaylist("https://cdn.example/a/index.M3U8?token=x"), true);
  assert.equal(isPlaylist("https://cdn.example/video-1080p.mp4"), false);
  assert.equal(isPlaylist("https://cdn.example/clip.vid"), false);
  // A path that merely mentions it is still a file.
  assert.equal(isPlaylist("https://cdn.example/m3u8/clip.mp4"), false);
  assert.equal(isPlaylist("not a url"), false);
});

test("proxied playlist input allows only the loopback protocols in use", () => {
  assert.deepEqual(
    proxiedPlaylistInput("http://127.0.0.1:8080/api/media/id?token=x", ["-allowed_extensions", "ALL"]),
    ["-protocol_whitelist", "http,tcp,crypto", "-allowed_extensions", "ALL", "-i", "http://127.0.0.1:8080/api/media/id?token=x"],
  );
});

// The fake FFmpeg below is a #! script, which Windows cannot start.
const FAKE_FFMPEG_UNSUPPORTED = process.platform === "win32" ? "a #! script is not an executable on Windows" : false;

test("an HLS download hands FFmpeg only an internal proxied URL and releases its claim", { skip: FAKE_FFMPEG_UNSUPPORTED }, async () => {
  const { directory, queue, downloads } = await tempQueue();
  const ffmpeg = path.join(directory, "ffmpeg");
  const logFile = path.join(directory, "ffmpeg-args.jsonl");
  await writeFile(ffmpeg, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_FFMPEG_LOG, JSON.stringify(args) + "\\n");
if (args.includes("-h")) process.stdout.write("extension_picky");
const output = args.indexOf("-y");
if (output >= 0) writeFileSync(args[output + 1], "assembled");
`, { mode: 0o755 });
  const previousFfmpeg = process.env.FFMPEG_PATH;
  const previousLog = process.env.FAKE_FFMPEG_LOG;
  process.env.FFMPEG_PATH = ffmpeg;
  process.env.FAKE_FFMPEG_LOG = logFile;
  try {
    const stream = {
      url: "https://addon.test/private/master.m3u8?token=addon-secret",
      behaviorHints: { proxyHeaders: { request: { Authorization: "Bearer addon-secret" } } },
    };
    await queue.add("HLS", stream);
    await waitFor(queue, () => ["completed", "failed"].includes(queue.list()[0]?.status), 15_000);
    assert.equal(queue.list()[0]?.status, "completed", queue.list()[0]?.error);

    const invocations = (await readFile(logFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const args = invocations.find((item) => item.includes("-i"));
    assert.ok(args);
    const input = args[args.indexOf("-i") + 1]!;
    assert.match(input, /^http:\/\/127\.0\.0\.1:\d+\/api\/media\/[A-Za-z0-9_-]{43}\?token=[a-f0-9]+$/);
    assert.equal(input.includes("addon.test"), false);
    assert.equal(input.includes("addon-secret"), false);
    assert.equal(args.includes("-headers"), false);
    assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "http,tcp,crypto");

    const resourceId = new URL(input).pathname.split("/").pop()!;
    assert.throws(() => mediaResources.get(resourceId, undefined, "media", true), { status: 404 });
    assert.ok(existsSync(queuedFile(downloads, queue.list()[0]!.target)));
  } finally {
    await queue.stop();
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousFfmpeg;
    if (previousLog === undefined) delete process.env.FAKE_FFMPEG_LOG; else process.env.FAKE_FFMPEG_LOG = previousLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stalled HLS assembly is killed and fails the job", { skip: FAKE_FFMPEG_UNSUPPORTED }, async () => {
  let clock = Date.now();
  const { directory, queue } = await tempQueue({ now: () => clock });
  const ffmpeg = path.join(directory, "ffmpeg");
  const logFile = path.join(directory, "ffmpeg-args.jsonl");
  const pidFile = path.join(directory, "ffmpeg.pid");
  await writeFile(ffmpeg, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_FFMPEG_LOG, JSON.stringify(args) + "\\n");
if (args.includes("-h")) {
  process.stdout.write("extension_picky");
  process.exit(0);
}
writeFileSync(process.env.FAKE_FFMPEG_PID, String(process.pid));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const previousFfmpeg = process.env.FFMPEG_PATH;
  const previousLog = process.env.FAKE_FFMPEG_LOG;
  const previousPid = process.env.FAKE_FFMPEG_PID;
  process.env.FFMPEG_PATH = ffmpeg;
  process.env.FAKE_FFMPEG_LOG = logFile;
  process.env.FAKE_FFMPEG_PID = pidFile;
  try {
    await queue.add("HLS", { url: "https://addon.test/private/master.m3u8?token=addon-secret" });
    await waitFor(queue, () => existsSync(pidFile), 5_000);
    const childPid = Number(await readFile(pidFile, "utf8"));
    clock += HLS_STALL_MS;
    await waitFor(queue, () => queue.list()[0]?.status === "failed", 5_000);

    assert.match(queue.list()[0]!.error ?? "", /^The playlist stopped delivering data\.$/);
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });

    const invocations = (await readFile(logFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const args = invocations.find((item) => item.includes("-i"));
    assert.ok(args);
    const resourceId = new URL(args[args.indexOf("-i") + 1]!).pathname.split("/").pop()!;
    assert.throws(() => mediaResources.get(resourceId, undefined, "media", true), { status: 404 });
  } finally {
    await queue.stop();
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousFfmpeg;
    if (previousLog === undefined) delete process.env.FAKE_FFMPEG_LOG; else process.env.FAKE_FFMPEG_LOG = previousLog;
    if (previousPid === undefined) delete process.env.FAKE_FFMPEG_PID; else process.env.FAKE_FFMPEG_PID = previousPid;
    await rm(directory, { recursive: true, force: true });
  }
});

test("an HLS assembly is killed at the overall cap even while it keeps growing", { skip: FAKE_FFMPEG_UNSUPPORTED }, async () => {
  let clock = Date.now();
  const { directory, queue } = await tempQueue({ now: () => clock });
  const ffmpeg = path.join(directory, "ffmpeg");
  const logFile = path.join(directory, "ffmpeg-args.jsonl");
  const pidFile = path.join(directory, "ffmpeg.pid");
  await writeFile(ffmpeg, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_FFMPEG_LOG, JSON.stringify(args) + "\\n");
if (args.includes("-h")) {
  process.stdout.write("extension_picky");
  process.exit(0);
}
writeFileSync(args.at(-1), "assembled");
writeFileSync(process.env.FAKE_FFMPEG_PID, String(process.pid));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const previousFfmpeg = process.env.FFMPEG_PATH;
  const previousLog = process.env.FAKE_FFMPEG_LOG;
  const previousPid = process.env.FAKE_FFMPEG_PID;
  process.env.FFMPEG_PATH = ffmpeg;
  process.env.FAKE_FFMPEG_LOG = logFile;
  process.env.FAKE_FFMPEG_PID = pidFile;
  try {
    await queue.add("HLS", { url: "https://addon.test/private/master.m3u8?token=addon-secret" });
    await waitFor(queue, () => existsSync(pidFile), 5_000);
    const childPid = Number(await readFile(pidFile, "utf8"));
    clock += 12 * 60 * 60_000;
    await waitFor(queue, () => queue.list()[0]?.status === "failed", 5_000);

    assert.match(queue.list()[0]!.error ?? "", /^The playlist assembly took too long\.$/);
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });

    const invocations = (await readFile(logFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const args = invocations.find((item) => item.includes("-i"));
    assert.ok(args);
    const resourceId = new URL(args[args.indexOf("-i") + 1]!).pathname.split("/").pop()!;
    assert.throws(() => mediaResources.get(resourceId, undefined, "media", true), { status: 404 });
  } finally {
    await queue.stop();
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousFfmpeg;
    if (previousLog === undefined) delete process.env.FAKE_FFMPEG_LOG; else process.env.FAKE_FFMPEG_LOG = previousLog;
    if (previousPid === undefined) delete process.env.FAKE_FFMPEG_PID; else process.env.FAKE_FFMPEG_PID = previousPid;
    await rm(directory, { recursive: true, force: true });
  }
});

test("an HLS assembly error never exposes the internal proxy URL", { skip: FAKE_FFMPEG_UNSUPPORTED }, async () => {
  const { directory, queue } = await tempQueue();
  const ffmpeg = path.join(directory, "ffmpeg");
  await writeFile(ffmpeg, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("-h")) {
  process.stdout.write("extension_picky");
  process.exit(0);
}
process.stderr.write("http://127.0.0.1:1/api/media/x?token=SECRET\\n");
process.exit(1);
`, { mode: 0o755 });
  const previousFfmpeg = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = ffmpeg;
  try {
    await queue.add("HLS", { url: "https://addon.test/private/master.m3u8?token=addon-secret" });
    await waitFor(queue, () => queue.list()[0]?.status === "failed", 15_000);
    const error = queue.list()[0]?.error ?? "";
    assert.match(error, /The playlist could not be assembled/);
    assert.equal(error.includes("SECRET"), false);
    assert.equal(error.includes("127.0.0.1"), false);
  } finally {
    await queue.stop();
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousFfmpeg;
    await rm(directory, { recursive: true, force: true });
  }
});
