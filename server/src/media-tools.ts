import type { ChildProcess } from "node:child_process";

/** The executable named by the variable, or the bare name that `PATH` resolves. Read per call,
 *  so a test or a container can set the variable after the module was imported. */
const executable = (env: NodeJS.ProcessEnv, variable: string, fallback: string) => {
  const value = env[variable];
  return value !== undefined && value.trim().length > 0 ? value.trim() : fallback;
};

/** The ffmpeg executable: FFMPEG_PATH when set and non-empty, otherwise "ffmpeg" found on PATH. Read per call. */
export function ffmpegPath(env: NodeJS.ProcessEnv = process.env): string {
  return executable(env, "FFMPEG_PATH", "ffmpeg");
}

/** The same for ffprobe and FFPROBE_PATH. */
export function ffprobePath(env: NodeJS.ProcessEnv = process.env): string {
  return executable(env, "FFPROBE_PATH", "ffprobe");
}

const running = new Set<ChildProcess>();
let stopping = false;

/** Whether the server is on its way out, so an FFmpeg that died is not a failure to record. */
export const mediaStopping = () => stopping;

/** A long-lived FFmpeg the shutdown has to take down with it. Nothing ends a child when its parent
 *  exits, so without this a conversion outlived the desktop's local backend by minutes. */
export function trackMedia<T extends ChildProcess>(child: T): T {
  if (child.exitCode !== null || child.signalCode !== null) return child;
  // A queue or a retry that starts another one during the shutdown would leave it behind.
  if (stopping) { child.kill("SIGKILL"); return child; }
  running.add(child);
  child.once("exit", () => running.delete(child));
  return child;
}

/** Kills every tracked FFmpeg and answers how many were still running. */
export function killRunningMedia(): number {
  stopping = true;
  const count = running.size;
  for (const child of running) child.kill("SIGKILL");
  running.clear();
  return count;
}
