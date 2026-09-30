// Guards the Linux packaging script: the LGPL FFmpeg is not built here, it is taken from the
// `ffmpeg-linux` CI artifact. Without it the app would ship without an encoder.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ffmpegLinuxDir = path.join(desktopDir, "ffmpeg-linux");
const missing = ["ffmpeg", "ffprobe"].filter((name) => !existsSync(path.join(ffmpegLinuxDir, name)));

if (missing.length > 0) {
  process.stderr.write(
    `require-ffmpeg-linux: desktop/ffmpeg-linux is missing ${missing.join(", ")}.\n` +
      "Run desktop/scripts/build-ffmpeg-linux.sh, or download the ffmpeg-linux artifact from\n" +
      "the Desktop package workflow into desktop/ffmpeg-linux. Packaging never builds FFmpeg itself.\n",
  );
  process.exit(1);
}

process.stdout.write("require-ffmpeg-linux: desktop/ffmpeg-linux is in place\n");
