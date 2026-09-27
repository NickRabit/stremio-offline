// Launches the packaged app in its local-backend smoke mode: the app starts the staged
// server from inside the archive, waits for its ready message, lets it answer /api/status and
// stops it again. A non-zero exit or a missing marker fails the packaging workflow. The same
// script covers the macOS bundle and the Windows build, including its Media Foundation encoder.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
}
