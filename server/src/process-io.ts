import { readdir, readFile } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";

/** Bytes read and written since a counter started, as the kernel accounts them. */
export interface IoCounters {
  readBytes: number;
  writeBytes: number;
}

export interface IoDiagnostics {
  /** The server process alone (Linux `/proc/self/io`): what reached the storage layer. */
  process?: IoCounters & { writeCalls: number };
  /** FFmpeg and other children still running; a finished child's bytes are not in here. */
  children?: IoCounters & { count: number };
  /** The whole container, finished FFmpeg runs included (cgroup v2 `io.stat`, v1 `blkio`). */
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
export function parseProcIo(text: string): (IoCounters & { writeCalls: number }) | undefined {
  const fields = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(\w+):\s*(\d+)$/.exec(line.trim());
    if (match) fields.set(match[1]!, Number(match[2]));
  }
  const readBytes = fields.get("read_bytes");
  const writeBytes = fields.get("write_bytes");
  if (readBytes === undefined || writeBytes === undefined) return undefined;
  return { readBytes, writeBytes, writeCalls: fields.get("syscw") ?? 0 };
}

/** cgroup v2 `io.stat`: one line per device, `rbytes=` and `wbytes=` among the keys. */
export function parseCgroup2IoStat(text: string): IoCounters | undefined {
  let readBytes = 0;
  let writeBytes = 0;
  let seen = false;
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
      if (container1) { result.container = { ...container1, source: "cgroup1" }; break; }
    }
  }
  return result;
}

const toMs = (nanoseconds: number) => Math.round(nanoseconds / 1e5) / 10;

/** How late the server answers timers: a long wait means something held the one JavaScript
 *  thread (a big sort, a synchronous read) and every request waited with it. */
export class EventLoopDelay {
  private histogram = monitorEventLoopDelay({ resolution: 20 });
  private since = new Date();

  constructor() {
    this.histogram.enable();
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
  }
}
