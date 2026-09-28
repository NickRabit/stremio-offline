// Launches the packaged app in its local-backend smoke mode: the app starts the staged
// server from inside the archive, waits for its ready message, lets it answer /api/status and
// stops it again. A non-zero exit or a missing marker fails the packaging workflow. The same
// script covers the macOS bundle and the Windows build, including its Media Foundation encoder.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const releaseDir = path.join(desktopDir, "release");
const READY = "local-backend-smoke: ready";
const TIMEOUT_MS = 180_000;
const isWindows = process.platform === "win32";

const fail = (message) => {
  process.stderr.write(`smoke-packaged: ${message}\n`);
  process.exit(1);
};

const findMacBinary = async () => {
  const architectures = await readdir(releaseDir, { withFileTypes: true }).catch(() => []);
  for (const entry of architectures) {
    if (!entry.isDirectory() || !entry.name.startsWith("mac")) continue;
    const archDir = path.join(releaseDir, entry.name);
    for (const candidate of await readdir(archDir, { withFileTypes: true })) {
      if (!candidate.isDirectory() || !candidate.name.endsWith(".app")) continue;
      const macosDir = path.join(archDir, candidate.name, "Contents", "MacOS");
      for (const binary of await readdir(macosDir, { withFileTypes: true })) {
        if (binary.isFile()) return path.join(macosDir, binary.name);
      }
    }
  }
  return null;
};

const findWindowsBinary = async () => {
  const unpackedDir = path.join(releaseDir, "win-unpacked");
  const entries = await readdir(unpackedDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".exe")) continue;
    if (entry.name.startsWith("Uninstall")) continue;
    return path.join(unpackedDir, entry.name);
  }
  return null;
};

const binary = await (isWindows ? findWindowsBinary() : findMacBinary());
if (binary === null) fail(`no packaged app under ${path.relative(desktopDir, releaseDir)}; the packaging script has to run first`);
process.stdout.write(`smoke-packaged: ${path.relative(desktopDir, binary)}\n`);

const child = spawn(binary, ["--smoke-local-backend"], { stdio: ["ignore", "pipe", "pipe"] });
let output = "";
for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output += chunk;
    target.write(chunk);
  });
}

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  // Windows has no signals; kill() ends the process there too.
  child.kill("SIGKILL");
}, TIMEOUT_MS);
const code = await new Promise((resolve) => child.on("close", resolve));
clearTimeout(timer);
if (timedOut) fail("the packaged app did not finish the smoke in time");
if (code !== 0) fail(`the packaged app exited with ${code}`);
if (!output.includes(READY)) fail("the packaged app never reported a ready local backend");

// The app carries its own LGPL FFmpeg. It has to be there, say it is LGPL, and be the one the
// backend ran: only that build lacks libx264, and the server logs it when it starts.
const resources = isWindows
  ? path.join(path.dirname(binary), "resources")
  : path.join(path.dirname(path.dirname(binary)), "Resources");
const tools = isWindows ? { ffmpeg: "ffmpeg.exe", ffprobe: "ffprobe.exe" } : { ffmpeg: "ffmpeg", ffprobe: "ffprobe" };
const ffmpeg = path.join(resources, "ffmpeg", tools.ffmpeg);
const licence = spawnSync(ffmpeg, ["-hide_banner", "-L"], { encoding: "utf8" });
if (licence.status !== 0) fail(`the bundled FFmpeg did not run (${ffmpeg})`);
if (!licence.stdout.includes("Lesser General Public License")) fail("the bundled FFmpeg is not an LGPL build");
const expected = [tools.ffprobe, "BUILDINFO.txt", "licenses/COPYING.LGPLv3", "licenses/COPYING.GPLv3"];
// The Windows build uses schannel instead of OpenSSL, so it carries no OpenSSL notice.
if (!isWindows) expected.push("licenses/OPENSSL-LICENSE.txt");
expected.push("licenses/FFMPEG-THIRD-PARTY-NOTICES.txt");
for (const file of expected) {
  if (!existsSync(path.join(resources, "ffmpeg", file))) fail(`the bundled FFmpeg is missing ${file}`);
}
if (!output.includes("This FFmpeg has no libx264")) fail("the local backend did not run the FFmpeg the app carries");
process.stdout.write("smoke-packaged: the bundled LGPL FFmpeg is in place and in use\n");

// The runner has no GPU, so these probes also exercise Microsoft's software H.264 encoder.
// win-transcode probes the same two command lines at start-up; one of them has to work.
if (isWindows) {
  const probes = [
    {
      name: "quality",
      args: ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", "nullsrc=s=256x144:d=0.1", "-vf", "format=nv12", "-c:v", "h264_mf", "-hw_encoding", "1", "-rate_control", "quality", "-quality", "60", "-f", "null", "-"],
    },
    {
      name: "cbr",
      args: ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", "nullsrc=s=256x144:d=0.1", "-vf", "format=nv12", "-c:v", "h264_mf", "-rate_control", "cbr", "-b:v", "1M", "-f", "null", "-"],
    },
  ];
  let working = null;
  for (const probe of probes) {
    const result = spawnSync(ffmpeg, probe.args, { encoding: "utf8", timeout: 60_000 });
    if (result.status === 0) {
      working = probe.name;
      break;
    }
    const reason = (result.stderr || result.error?.message || "").trim().split("\n")[0] ?? "";
    process.stdout.write(`smoke-packaged: the Media Foundation ${probe.name} probe did not work: ${reason}\n`);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (working === null) fail("neither Media Foundation h264_mf probe worked");
  process.stdout.write(`smoke-packaged: the Media Foundation ${working} probe worked\n`);

  // The server remuxes into fMP4 HLS in a folder named by an absolute Windows path. Do exactly
  // that on a short generated clip and check the playlist the server waits for comes out whole.
  const work = mkdtempSync(path.join(tmpdir(), "stremio-offline-hls-"));
  const source = path.join(work, "source.mkv");
  const made = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=8:r=24",
    "-f", "lavfi", "-i", "sine=d=8", "-c:v", "h264_mf", "-rate_control", "cbr", "-b:v", "1M", "-g", "48", "-c:a", "aac", "-shortest", source],
    { encoding: "utf8", timeout: 120_000 });
  if (made.status !== 0) fail(`could not make the HLS test clip: ${(made.stderr ?? "").trim().split("\n")[0]}`);
  const out = path.join(work, "gen-0");
  mkdirSync(out);
  const hls = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "warning", "-nostdin", "-i", source,
    "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-c:a", "aac", "-ac", "2", "-b:a", "160k",
    "-f", "hls", "-hls_time", "2", "-hls_list_size", "0", "-hls_playlist_type", "event",
    "-hls_segment_type", "fmp4", "-hls_flags", "independent_segments+temp_file", "-hls_fmp4_init_filename", "init.mp4",
    "-master_pl_name", "master.m3u8", "-var_stream_map", "v:0,a:0",
    "-hls_segment_filename", path.join(out, "seg-%v-%06d.m4s"), path.join(out, "index-%v.m3u8")],
    // The server runs this FFmpeg in the output folder, which is where a Windows build puts init.mp4.
    { cwd: out, encoding: "utf8", timeout: 120_000 });
  process.stdout.write(`smoke-packaged: HLS remux exited ${hls.status}; ${out} holds: ${readdirSync(out).join(", ")}\n`);
  if (hls.stderr) process.stdout.write(hls.stderr);
  const playlistFile = path.join(out, "index-0.m3u8");
  if (!existsSync(playlistFile)) fail("the HLS remux wrote no index-0.m3u8 where the server looks for it");
  const playlist = readFileSync(playlistFile, "utf8");
  process.stdout.write(`smoke-packaged: index-0.m3u8:\n${playlist}\n`);
  if (!/#EXT-X-MAP:URI="init\.mp4"/.test(playlist)) fail("the HLS playlist does not name init.mp4 by a plain name");
  if (!/^seg-0-\d+\.m4s$/m.test(playlist)) fail("the HLS playlist does not name its segments by plain names");
  // What the server waits for before it hands the stream over: every file the playlist names.
  const named = [...playlist.matchAll(/#EXT-X-MAP:URI="([^"]+)"/g)].map((match) => match[1])
    .concat(playlist.split(/\r?\n/).filter((line) => line && !line.startsWith("#")));
  const missing = named.filter((name) => !existsSync(path.join(out, name)));
  if (missing.length) fail(`the HLS playlist names files that are not in its folder: ${missing.join(", ")}`);
  process.stdout.write("smoke-packaged: an fMP4 HLS remux into an absolute Windows path works\n");
}
