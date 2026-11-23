import { readdir, readFile } from "node:fs/promises";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { log } from "./logger.js";

/** Bytes read and written since a counter started, as the kernel accounts them. */
export interface IoCounters {
  readBytes: number;
  writeBytes: number;
}

export interface IoDiagnostics {
  /** The server process (Linux `/proc/self/io`): what reached the storage layer. A finished
   *  FFmpeg run is added here when the server reaps it, so `process` + `children` is the total
   *  that only grows, and the figure to compare between two reads. */
  process?: IoCounters;
  /** FFmpeg and other children still running; a finished run moves over to `process`. */
  children?: IoCounters & { count: number };
  /** The whole container, summed over its devices (cgroup v2 `io.stat`, v1 `blkio`). On cgroup
   *  v1 (Synology DSM) buffered writes are charged to the root group when they reach the disk,
   *  so this undercounts there; on a stacked volume (RAID, LVM) a write may be counted once per
   *  layer. A cross-check, not the main figure. */
  container?: IoCounters & { source: "cgroup2" | "cgroup1" };
}

export interface EventLoopDiagnostics {
  /** When the figures below started to count: the server start, or the last `reset`. */
  since: string;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

/** `/proc/<pid>/io`. `write_bytes` is what the process handed to the block layer, which is the
 *  number a NAS disk cares about; `wchar` would also count sockets and pipes. */
export function parseProcIo(text: string): IoCounters | undefined {
  const fields = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(\w+):\s*(\d+)$/.exec(line.trim());
    if (match) fields.set(match[1]!, Number(match[2]));
  }
  const readBytes = fields.get("read_bytes");
  const writeBytes = fields.get("write_bytes");
  if (readBytes === undefined || writeBytes === undefined) return undefined;
  // `syscw` is left out on purpose: it counts every write call, a socket's too, so on a server
  // that streams video it reads as a flood of small disk writes that never happened.
  return { readBytes, writeBytes };
}

/** cgroup v2 `io.stat`: one line per device, `rbytes=` and `wbytes=` among the keys. */
export function parseCgroup2IoStat(text: string): IoCounters | undefined {
  let readBytes = 0;
  let writeBytes = 0;
  // An empty file is a container that has not touched a disk yet: zero, not unknown.
  let seen = text.trim() === "";
  for (const line of text.split("\n")) {
    const read = /\brbytes=(\d+)/.exec(line);
    const write = /\bwbytes=(\d+)/.exec(line);
    if (!read && !write) continue;
    seen = true;
    readBytes += Number(read?.[1] ?? 0);
    writeBytes += Number(write?.[1] ?? 0);
  }
  return seen ? { readBytes, writeBytes } : undefined;
}

/** cgroup v1 `blkio.throttle.io_service_bytes` (or `blkio.io_service_bytes`): `<dev> Read <n>`
 *  and `<dev> Write <n>` lines, plus a `Total` line that is skipped. */
export function parseCgroup1Blkio(text: string): IoCounters | undefined {
  let readBytes = 0;
  let writeBytes = 0;
  let seen = false;
  for (const line of text.split("\n")) {
    const match = /^\S+\s+(Read|Write)\s+(\d+)$/.exec(line.trim());
    if (!match) continue;
    seen = true;
    if (match[1] === "Read") readBytes += Number(match[2]);
    else writeBytes += Number(match[2]);
  }
  return seen ? { readBytes, writeBytes } : undefined;
}

const readText = (file: string) => readFile(file, "utf8").catch(() => undefined);

/** The pids whose parent is `parent`, from `/proc/<pid>/stat` (the field after the `(comm)`). */
async function childPids(parent: number, proc: string): Promise<number[]> {
  const entries = await readdir(proc).catch(() => [] as string[]);
  const found: number[] = [];
  await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map(async (entry) => {
    const stat = await readText(`${proc}/${entry}/stat`);
    const rest = stat?.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (rest && Number(rest[1]) === parent) found.push(Number(entry));
  }));
  return found;
}

/** Disk counters for the troubleshooting page. Each part is left out where the platform has no
 *  such file (macOS, Windows, a container without its cgroup mounted). Reads only. */
export async function ioDiagnostics(options: { proc?: string; cgroup?: string; pid?: number } = {}): Promise<IoDiagnostics> {
  const proc = options.proc ?? "/proc";
  const cgroup = options.cgroup ?? "/sys/fs/cgroup";
  const pid = options.pid ?? process.pid;
  const result: IoDiagnostics = {};

  const own = await readText(`${proc}/self/io`);
  const parsed = own === undefined ? undefined : parseProcIo(own);
  if (parsed) result.process = parsed;

  if (parsed) {
    const pids = await childPids(pid, proc);
    const counters = (await Promise.all(pids.map(async (child) => {
      const text = await readText(`${proc}/${child}/io`);
      return text === undefined ? undefined : parseProcIo(text);
    }))).filter((counter) => counter !== undefined);
    result.children = {
      count: counters.length,
      readBytes: counters.reduce((sum, counter) => sum + counter.readBytes, 0),
      writeBytes: counters.reduce((sum, counter) => sum + counter.writeBytes, 0),
    };
  }

  const v2 = await readText(`${cgroup}/io.stat`);
  const container2 = v2 === undefined ? undefined : parseCgroup2IoStat(v2);
  if (container2) {
    result.container = { ...container2, source: "cgroup2" };
  } else {
    for (const file of ["blkio/blkio.throttle.io_service_bytes", "blkio/blkio.io_service_bytes"]) {
      const text = await readText(`${cgroup}/${file}`);
      const container1 = text === undefined ? undefined : parseCgroup1Blkio(text);
      // The throttle file lists the devices with zeros when the counting happens in the other.
      if (container1 && (container1.readBytes || container1.writeBytes)) { result.container = { ...container1, source: "cgroup1" }; break; }
      if (container1) result.container ??= { ...container1, source: "cgroup1" };
    }
  }
  return result;
}

const RESOLUTION_MS = 20;
/** The histogram counts its own sampling interval as delay; an idle server reads 0, not 20. */
export const toMs = (nanoseconds: number) => Math.max(0, Math.round(nanoseconds / 1e5 - RESOLUTION_MS * 10) / 10);

/** How often the stall watch looks at the clock, and how seldom it may write to the log: a NAS
 *  that keeps stalling must not also keep writing the log. Stalls inside the quiet time are
 *  counted and reported with the next line. */
const STALL_TICK_MS = 100;
const STALL_LOG_QUIET_MS = 10_000;

/** How late the server answers timers: a long wait means something held the one JavaScript
 *  thread (a big sort, a synchronous read) and every request waited with it. */
export class EventLoopDelay {
  private histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  private since = new Date();
  private watch?: NodeJS.Timeout;

  /** `logStallsOverMs` writes a WARN line, with its time, whenever the thread was held about
   *  that long: the lines around it in the log tell what the server was doing. At most one line
   *  per quiet time; stalls inside it are summed up in one line as soon as it ends, with the time
   *  of the longest. A paused container or a NAS that gave the process no CPU reads the same as
   *  blocked JavaScript. Only the server's own monitor sets it. */
  constructor(options: { logStallsOverMs?: number; quietMs?: number } = {}) {
    this.histogram.enable();
    const threshold = options.logStallsOverMs;
    if (!threshold) return;
    const quietMs = options.quietMs ?? STALL_LOG_QUIET_MS;
    let last = performance.now();
    let quietUntil = 0;
    let held = 0;
    let longest = 0;
    let longestAt = "";
    this.watch = setInterval(() => {
      const at = performance.now();
      // A stall that began partway through a tick is measured up to one tick short, so the
      // line stands for "about the threshold or more", never for a stall that was missed.
      const stalled = at - last - STALL_TICK_MS;
      last = at;
      if (stalled >= threshold - STALL_TICK_MS) {
        if (at >= quietUntil && !held) {
          log("WARN", "The server was blocked or not scheduled", { ms: Math.round(stalled) });
          quietUntil = at + quietMs;
          return;
        }
        held += 1;
        if (stalled > longest) { longest = stalled; longestAt = new Date().toISOString(); }
      }
      if (held && at >= quietUntil) {
        log("WARN", "The server was blocked or not scheduled again", { times: held, longestMs: Math.round(longest), longestAt });
        quietUntil = at + quietMs;
        held = 0;
        longest = 0;
      }
    }, STALL_TICK_MS);
    this.watch.unref();
  }

  snapshot(): EventLoopDiagnostics {
    const count = this.histogram.count;
    return {
      since: this.since.toISOString(),
      p50Ms: count ? toMs(this.histogram.percentile(50)) : 0,
      p99Ms: count ? toMs(this.histogram.percentile(99)) : 0,
      maxMs: count ? toMs(this.histogram.max) : 0,
    };
  }

  /** Starts a new measuring window, so a test run is not mixed with the start-up. */
  reset(): void {
    this.histogram.reset();
    this.since = new Date();
  }

  stop(): void {
    this.histogram.disable();
    clearInterval(this.watch);
  }
}
