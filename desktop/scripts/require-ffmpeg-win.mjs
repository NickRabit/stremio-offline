// Guards the Windows packaging script: the cross-built LGPL FFmpeg is not built here, it is
// taken from the `ffmpeg-windows` CI artifact. Without it the exe would ship without an encoder.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ffmpegWinDir = path.join(desktopDir, "ffmpeg-win");
const missing = ["ffmpeg.exe", "ffprobe.exe"].filter((name) => !existsSync(path.join(ffmpegWinDir, name)));

if (missing.length > 0) {
  process.stderr.write(
    `require-ffmpeg-win: desktop/ffmpeg-win is missing ${missing.join(", ")}.\n` +
      "Run desktop/scripts/build-ffmpeg-win.sh, or download the ffmpeg-windows artifact from\n" +
      "the Desktop package workflow into desktop/ffmpeg-win. Packaging never builds FFmpeg itself.\n",
  );
  process.exit(1);
}

process.stdout.write("require-ffmpeg-win: desktop/ffmpeg-win is in place\n");
