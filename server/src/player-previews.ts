import { execFile } from "node:child_process";
import { ffmpegPath, trackMedia } from "./media-tools.js";

const PREVIEW_TIMEOUT_MS = 10_000;

type Grab = (args: string[], signal: AbortSignal) => Promise<Buffer>;

/** Aborting execFile through `signal` sends SIGTERM, which an FFmpeg stuck on a silent source
 *  ignores: the promise settles, the process lives on with its connections to the source, and
 *  the next preview starts beside it. So the kill is SIGKILL, and the grab settles only once the
 *  process is really gone. */
export const grabFrame = (args: string[], signal: AbortSignal, binary = ffmpegPath()) => new Promise<Buffer>((resolve, reject) => {
  // Tracked so a shutdown's killRunningMedia() reaches a preview, not only the timeout below.
  const child = trackMedia(execFile(binary, args, { encoding: "buffer", maxBuffer: 256 * 1024 }, (error, stdout) => {
    clearTimeout(timer);
    signal.removeEventListener("abort", kill);
    if (error) reject(error); else resolve(stdout);
  }));
  const kill = () => { child.kill("SIGKILL"); };
  const timer = setTimeout(kill, PREVIEW_TIMEOUT_MS);
  if (signal.aborted) kill(); else signal.addEventListener("abort", kill, { once: true });
});

export class PlayerPreviews {
  private cache = new Map<string, Buffer>();
  private pending = new Map<string, AbortController>();

  constructor(private grab: Grab = grabFrame) {}

  async frame(id: string, source: string, time: number, signal: AbortSignal): Promise<Buffer | undefined> {
    const key = `${id}:${Math.floor(time / 5)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (this.pending.has(id) || this.pending.size >= 2) return undefined;
    const controller = new AbortController();
    this.pending.set(id, controller);
    try {
      const stdout = await this.grab([
        "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-filter_threads", "1", "-ss", String(Math.floor(time / 5) * 5),
        "-i", source, "-an", "-sn", "-frames:v", "1", "-vf", "scale=320:-2", "-threads", "1", "-c:v", "mjpeg", "-f", "image2pipe", "pipe:1",
      ], AbortSignal.any([signal, controller.signal]));
      if (signal.aborted || controller.signal.aborted || !stdout.length) return undefined;
      this.cache.set(key, stdout);
      while (this.cache.size > 48 || [...this.cache.values()].reduce((sum, value) => sum + value.length, 0) > 2 * 1024 * 1024) this.cache.delete(this.cache.keys().next().value!);
      return stdout;
    } catch { return undefined; }
    finally { if (this.pending.get(id) === controller) this.pending.delete(id); }
  }

  stop(id: string) {
    this.pending.get(id)?.abort();
    for (const key of this.cache.keys()) if (key.startsWith(`${id}:`)) this.cache.delete(key);
  }
}
