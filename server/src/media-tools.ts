import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

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
const suspended = new WeakSet<ChildProcess>();
let stopping = false;

/** Whether the server is on its way out, so an FFmpeg that died is not a failure to record. */
export const mediaStopping = () => stopping;

export function suspendMediaChild(child: ChildProcess): boolean {
  try {
    if (!child.kill("SIGSTOP")) return false;
    suspended.add(child);
    return true;
  } catch {
    return false;
  }
}

export const mediaChildSuspended = (child: ChildProcess) => suspended.has(child);

export function resumeMediaChild(child: ChildProcess): boolean {
  if (!suspended.delete(child)) return false;
  try { child.kill("SIGCONT"); } catch { /* the process may have exited while stopped */ }
  return true;
}

export function killMediaChild(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): boolean {
  resumeMediaChild(child);
  try { return child.kill(signal); }
  catch { return false; }
}

/** A long-lived FFmpeg the shutdown has to take down with it. Nothing ends a child when its parent
 *  exits, so without this a conversion outlived the desktop's local backend by minutes. */
export function trackMedia<T extends ChildProcess>(child: T): T {
  if (child.exitCode !== null || child.signalCode !== null) return child;
  // A queue or a retry that starts another one during the shutdown would leave it behind.
  if (stopping) { killMediaChild(child); return child; }
  running.add(child);
  child.once("exit", () => running.delete(child));
  return child;
}

const execFileAsync = promisify(execFile);

/** `promisify(execFile)` for FFmpeg and ffprobe, with the child tracked: a thumbnail, a mosaic or a
 *  probe still running when the server stops would otherwise keep writing into the data folder
 *  after it, until its own timeout. */
export const runMedia = ((...args: Parameters<typeof execFileAsync>) => {
  const pending = execFileAsync(...args);
  trackMedia(pending.child);
  return pending;
}) as typeof execFileAsync;

/** Kills every tracked FFmpeg and answers how many were still running. */
export function killRunningMedia(): number {
  stopping = true;
  const count = running.size;
  for (const child of running) killMediaChild(child);
  running.clear();
  return count;
}
