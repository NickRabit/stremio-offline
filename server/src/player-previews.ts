import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ffmpegPath } from "./media-tools.js";

export class PlayerPreviews {
  private cache = new Map<string, Buffer>();
  private pending = new Map<string, AbortController>();

  async frame(id: string, source: string, time: number, signal: AbortSignal): Promise<Buffer | undefined> {
    const key = `${id}:${Math.floor(time / 5)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (this.pending.has(id) || this.pending.size >= 2) return undefined;
    const controller = new AbortController();
    this.pending.set(id, controller);
    try {
      const { stdout } = await promisify(execFile)(ffmpegPath(), [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-filter_threads", "1", "-ss", String(Math.floor(time / 5) * 5),
        "-i", source, "-an", "-sn", "-frames:v", "1", "-vf", "scale=320:-2", "-threads", "1", "-c:v", "mjpeg", "-f", "image2pipe", "pipe:1",
      ], { encoding: "buffer", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024, signal: AbortSignal.any([signal, controller.signal]) });
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
