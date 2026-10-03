import { readFile } from "node:fs/promises";
import os from "node:os";
import { log } from "./logger.js";

/** When a conversion falls behind, the log used to say only that the player stalled. Whether the
 *  source was sending too slowly or FFmpeg could not keep up takes both ends of the pipe: how
 *  fast FFmpeg produces the film, and on which side the proxy feeding it spends its time. */

export interface PaceTotals {
  /** Time the proxy spent waiting for the source to send the next piece. */
  sourceMs: number;
  /** Time it spent waiting for the reader to take what it had already got. */
  readerMs: number;
  bytes: number;
}

export class SourcePace {
  private totals = new Map<string, PaceTotals>();

  note(key: string, sourceMs: number, readerMs: number, bytes: number) {
    const entry = this.totals.get(key) ?? { sourceMs: 0, readerMs: 0, bytes: 0 };
    entry.sourceMs += sourceMs; entry.readerMs += readerMs; entry.bytes += bytes;
    this.totals.set(key, entry);
  }

  read(key: string): PaceTotals { return { ...(this.totals.get(key) ?? { sourceMs: 0, readerMs: 0, bytes: 0 }) }; }

  forget(key: string) { this.totals.delete(key); }
}

export const sourcePace = new SourcePace();

export interface Progress { outTime: number; ended: boolean }

/** Reads FFmpeg's `-progress` stream: key=value lines, each block closed by `progress=`. */
export class ProgressReader {
  latest?: Progress;
  private rest = "";
  private outTime?: number;

  push(chunk: string) {
    const lines = `${this.rest}${chunk}`.split("\n");
    this.rest = lines.pop() ?? "";
    for (const line of lines) {
      const [key, value = ""] = line.trim().split("=", 2);
      // out_time_us is N/A until the first packet is written, and briefly negative after a copied seek.
      if (key === "out_time_us" && /^-?\d+$/.test(value)) this.outTime = Math.max(0, Number(value) / 1e6);
      if (key === "progress" && this.outTime !== undefined) this.latest = { outTime: this.outTime, ended: value === "end" };
    }
  }
}

export type Cause = "source" | "ffmpeg" | "unclear" | "keeping up";

/** Which side the proxy waited on. A proxy that waits for the source is starving FFmpeg; one
 *  waiting for FFmpeg to read means FFmpeg is busy -- encoding, or writing segments to a slow disk. */
export const likelyCause = (sourceMs: number, readerMs: number): Cause => {
  const total = sourceMs + readerMs;
  if (total < 1000) return "unclear";
  const share = sourceMs / total;
  return share >= 0.6 ? "source" : share <= 0.4 ? "ffmpeg" : "unclear";
};

/** CPU seconds a process has used, from /proc. Elsewhere there is no cheap way to ask. */
export const processCpuSeconds = async (pid: number | undefined): Promise<number | undefined> => {
  if (!pid || process.platform !== "linux") return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // The command name may hold spaces and parentheses; the fields that follow its last ")" do not.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // utime and stime are fields 14 and 15, counted in clock ticks of 1/100 s on every Linux we run on.
    return (Number(fields[11]) + Number(fields[12])) / 100;
  } catch { return undefined; }
};

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
const share = (part: number, whole: number) => whole > 0 ? Math.round((part / whole) * 100) : undefined;
const megabytes = (bytes: number, seconds: number) => seconds > 0 ? round(bytes / 1e6 / seconds, 1) : undefined;

/** Below this the player drains its buffer faster than the conversion refills it. */
const BEHIND = 0.95;
const REPEAT_MS = 60_000;

interface Reading { at: number; outTime: number; source: PaceTotals; cpu?: number }

export interface PaceSnapshot {
  /** Seconds of film produced per second of wall time over the last check. */
  pace?: number;
  /** Position in the film the conversion has reached. */
  position?: number;
  sourceMBps?: number;
  waitingOnSource?: number;
  ffmpegCpu?: number;
  load?: number;
  likelyCause: Cause;
}

export interface MonitorOptions {
  id: string; generation: number; offset: number; mode: string; hardware: boolean;
  pid?: number;
  source: () => PaceTotals;
  intervalMs?: number;
  now?: () => number;
  cpu?: (pid: number | undefined) => Promise<number | undefined>;
}

/** Watches one FFmpeg run and says in the log when, and probably why, it is slower than playback. */
export class ConversionMonitor {
  readonly progress = new ProgressReader();
  private first?: Reading;
  private last?: Reading;
  private window?: PaceSnapshot;
  private timer?: NodeJS.Timeout;
  private slowChecks = 0;
  private starting = false;
  private warnedAt?: number;
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly cpu: (pid: number | undefined) => Promise<number | undefined>;

  constructor(private options: MonitorOptions) {
    this.now = options.now ?? Date.now;
    this.cpu = options.cpu ?? processCpuSeconds;
    this.startedAt = this.now();
  }

  push(chunk: string) {
    this.progress.push(chunk);
    // The window starts at the first thing written, so a stall reported early already has one to show.
    if (!this.starting && !this.last && this.progress.latest) { this.starting = true; void this.check(); }
  }

  start() {
    this.timer = setInterval(() => void this.check(), this.options.intervalMs ?? 10_000);
    this.timer.unref();
  }

  private async read(): Promise<Reading | undefined> {
    const progress = this.progress.latest;
    if (!progress) return undefined;
    return { at: this.now(), outTime: progress.outTime, source: this.options.source(), cpu: await this.cpu(this.options.pid) };
  }

  /** The first reading is taken once FFmpeg has written something, so opening the source and
   *  seeking in it do not count against the pace. */
  async check() {
    const reading = await this.read();
    if (!reading || this.progress.latest?.ended) return;
    const previous = this.last;
    this.last = reading;
    if (!previous) { this.first = reading; return; }
    const seconds = (reading.at - previous.at) / 1000;
    if (seconds <= 0) return;
    this.window = this.describe(previous, reading);
    if ((this.window.pace ?? 1) >= BEHIND) return;
    this.slowChecks += 1;
    const at = this.now();
    if (this.warnedAt !== undefined && at - this.warnedAt < REPEAT_MS) return;
    this.warnedAt = at;
    log("WARN", "The conversion is falling behind playback", {
      id: this.options.id, generation: this.options.generation, mode: this.options.mode, hardware: this.options.hardware,
      ...this.window, slowChecks: this.slowChecks,
    });
  }

  private describe(from: Reading, to: Reading): PaceSnapshot {
    const seconds = (to.at - from.at) / 1000;
    const sourceMs = to.source.sourceMs - from.source.sourceMs;
    const readerMs = to.source.readerMs - from.source.readerMs;
    const cpu = from.cpu !== undefined && to.cpu !== undefined ? Math.round(((to.cpu - from.cpu) / seconds) * 100) : undefined;
    const pace = round((to.outTime - from.outTime) / seconds);
    return {
      pace,
      position: Math.round(this.options.offset + to.outTime),
      sourceMBps: megabytes(to.source.bytes - from.source.bytes, seconds),
      waitingOnSource: share(sourceMs, sourceMs + readerMs),
      ffmpegCpu: cpu,
      load: round(os.loadavg()[0] / Math.max(1, os.cpus().length)),
      // A conversion running ahead waits on the source by design: the read rate limit holds it back.
      likelyCause: pace >= BEHIND ? "keeping up" : likelyCause(sourceMs, readerMs),
    };
  }

  /** The last window measured, for a player that reports a stall. */
  snapshot(): PaceSnapshot | undefined { return this.window; }

  /** One line per run that fell behind; a run that kept up is only worth a debug line.
   *  Summed up from the last periodic reading: once FFmpeg has exited its CPU time is gone from /proc. */
  finish(outcome: string) {
    clearInterval(this.timer);
    const { first, last } = this;
    const summary = first && last && last.at > first.at ? this.describe(first, last) : undefined;
    log(this.slowChecks > 0 ? "INFO" : "DEBUG", "Conversion ended", {
      id: this.options.id, generation: this.options.generation, outcome,
      ranSeconds: Math.round((this.now() - this.startedAt) / 1000),
      produced: Math.round(this.progress.latest?.outTime ?? 0),
      ...(summary ? { averagePace: summary.pace, sourceMBps: summary.sourceMBps, waitingOnSource: summary.waitingOnSource, ffmpegCpu: summary.ffmpegCpu, likelyCause: summary.likelyCause } : {}),
      slowChecks: this.slowChecks,
    });
  }
}
