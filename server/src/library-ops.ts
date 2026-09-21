import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { messageKeyOf } from "./errors.js";
import { log } from "./logger.js";

/** Who asked for the operation. A job is carried out long after the request that queued it,
 *  and two of these write to somebody's own rows -- the star and the forgotten progress --
 *  so the job has to remember whose they are rather than fall back to whoever is first in
 *  the list. */
export interface LibraryOpActor { ownerUserId?: string }

export type LibraryOp = LibraryOpActor & (
  | { op: "move"; items: string[]; target: string; confirmTypeMismatch?: boolean }
  | { op: "copy"; items: string[]; target: string; confirmTypeMismatch?: boolean }
  | { op: "reroot"; items: string[]; libraryId: string; from: string; to: string }
  | { op: "delete"; items: string[] }
  | { op: "favorite"; items: string[]; favorite: boolean }
  | { op: "match"; items: string[]; type: string; id: string }
  | { op: "unmatch"; items: string[] }
  | { op: "skipLookup"; items: string[]; skipLookup: boolean }
  | { op: "mosaic"; items: string[]; mosaic: boolean }
  | { op: "artwork"; items: string[] }
  | { op: "forget"; items: string[] });

export type OpsStatus = "running" | "paused" | "completed" | "failed" | "cancelled";

export interface OpsResult {
  path: string;
  ok: boolean;
  to?: string;
  error?: string;
  errorKey?: string;
}

export interface OpsState {
  id: string;
  op: LibraryOp["op"];
  status: OpsStatus;
  total: number;
  done: number;
  failed: number;
  bytes: number;
  bytesTotal: number;
  current?: string;
  pauseReason?: "queue" | "playback" | "download" | "library";
  startedAt: string;
  finishedAt?: string;
  results: OpsResult[];
}

interface StoredJob extends OpsState {
  operation: LibraryOp;
  cancelRequested?: boolean;
  /** Set at enqueue and cleared once `finished` has run, so a job that went terminal
   *  without its hook (a crash in between) is picked up again by the next `load()`. */
  notifyPending?: boolean;
}

interface StoredState { version: 1; jobs: StoredJob[] }

export interface LibraryOpsOptions {
  file: string;
  execute: (operation: LibraryOp, item: string, progress: (bytes: number, total?: number) => void) => Promise<{ to?: string }>;
  pause?: (operation: LibraryOp, item: string) => Promise<OpsState["pauseReason"] | undefined> | OpsState["pauseReason"] | undefined;
  /** Called once when a job reaches a terminal state, after the state is saved.
   *  A throw is logged by the caller and never fails the job. */
  finished?: (job: OpsState, operation: LibraryOp) => Promise<void> | void;
  retryMs?: number;
}

const publicJob = ({ operation: _operation, cancelRequested: _cancelRequested, notifyPending: _notifyPending, ...job }: StoredJob): OpsState => structuredClone(job);

const isTerminal = (status: OpsStatus) => status === "completed" || status === "failed" || status === "cancelled";

export class LibraryOps {
  private jobs: StoredJob[] = [];
  private pumping = false;
  private saveTail = Promise.resolve();
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private pumped: Promise<void> = Promise.resolve();
  private notified = new Set<string>();

  constructor(private readonly options: LibraryOpsOptions) {}

  async load() {
    const saved = await readFile(this.options.file, "utf8").then((value) => {
      try { return JSON.parse(value) as StoredState; } catch { return undefined; }
    }, () => undefined);
    if (saved?.version === 1 && Array.isArray(saved.jobs)) {
      this.jobs = saved.jobs.filter((job) => Array.isArray(job.operation?.items) && typeof job.id === "string")
        .map((job) => job.status === "running" || (job.status === "paused" && job.pauseReason !== "queue")
        ? { ...job, status: "paused", pauseReason: "queue", current: undefined }
        : job);
    }
    await this.save();
    // A job that ended while the process was going down still carries the flag: its hook
    // never ran, and a terminal job never reaches the pump again. Run it before the pump.
    for (const job of this.jobs) {
      if (job.notifyPending && isTerminal(job.status)) await this.finish(job);
    }
    this.pump();
  }

  snapshot() {
    return { jobs: this.jobs.map(publicJob) };
  }

  async flush() { await this.saveTail; }

  async enqueue(operation: LibraryOp) {
    const now = new Date().toISOString();
    const job: StoredJob = {
      id: randomUUID(), operation, op: operation.op, status: "paused", pauseReason: "queue",
      total: operation.items.length, done: 0, failed: 0, bytes: 0, bytesTotal: 0,
      startedAt: now, results: [], notifyPending: true,
    };
    this.jobs.push(job);
    await this.save();
    this.pump();
    return publicJob(job);
  }

  async cancel(id: string) {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job || job.status === "completed" || job.status === "failed" || job.status === "cancelled") return false;
    // Both branches ask for the item to stop. The running branch leaves the item that is
    // already under way to finish; the paused branch ends the job outright, and the flag
    // is what tells `run`, still awaiting the pause hook, not to start anything.
    job.cancelRequested = true;
    if (job.status === "running") {
      await this.save();
    } else {
      job.status = "cancelled";
      job.pauseReason = undefined;
      job.finishedAt = new Date().toISOString();
      await this.finish(job);
    }
    return true;
  }

  private pump() {
    if (this.pumping) return;
    this.pumping = true;
    this.pumped = this.run().finally(() => { this.pumping = false; });
    void this.pumped.catch(() => undefined);
  }

  /** Resolves once nothing is in flight: the pump has stopped walking items and every write
   *  it asked for is on disk. `flush()` only waits for the writes, which is what shutdown
   *  wants; this waits for the work, which is what a caller taking the directory away
   *  afterwards needs. */
  async settled() {
    await this.pumped.catch(() => undefined);
    await this.saveTail.catch(() => undefined);
  }

  private async run() {
    while (true) {
      const job = this.jobs.find((candidate) => candidate.status === "paused" && candidate.pauseReason === "queue");
      if (!job) return;
      const item = job.operation.items[job.done + job.failed];
      if (!item) {
        job.status = job.failed === job.total ? "failed" : "completed";
        job.pauseReason = undefined;
        job.finishedAt = new Date().toISOString();
        await this.finish(job);
        continue;
      }
      const reason = await this.options.pause?.(job.operation, item);
      // The hook is slow on purpose and a `cancel` landing inside it has already ended the
      // job: `finish` ran, so the item is dropped without touching the status or the hook.
      if (isTerminal(job.status)) continue;
      if (reason) {
        job.pauseReason = reason;
        await this.save();
        this.wakeTimer = setTimeout(() => {
          if (job.status === "paused") job.pauseReason = "queue";
          this.pump();
        }, this.options.retryMs ?? 1_000);
        this.wakeTimer.unref();
        return;
      }
      job.status = "running";
      job.pauseReason = undefined;
      job.current = item;
      const baseBytes = job.bytes;
      const baseTotal = job.bytesTotal;
      await this.save();
      // A `cancel` landing while that write was in flight has asked for the item to stop and
      // it has not started yet, so it never reaches the executor. `finish` has not run for
      // this job, so this is the call that reports it.
      if (job.cancelRequested) {
        job.current = undefined;
        job.status = "cancelled";
        job.finishedAt = new Date().toISOString();
        await this.finish(job);
        continue;
      }
      try {
        const result = await this.options.execute(job.operation, item, (bytes, total = bytes) => {
          job.bytes = baseBytes + Math.max(0, bytes);
          job.bytesTotal = Math.max(baseTotal, baseBytes + Math.max(0, total));
        });
        job.done += 1;
        job.results.push({ path: item, ok: true, ...result });
      } catch (error) {
        job.failed += 1;
        job.results.push({ path: item, ok: false, error: error instanceof Error ? error.message : String(error), errorKey: messageKeyOf(error) });
      }
      job.current = undefined;
      if (job.cancelRequested) {
        job.status = "cancelled";
        job.finishedAt = new Date().toISOString();
        await this.finish(job);
      } else if (job.done + job.failed >= job.total) {
        job.status = job.failed === job.total ? "failed" : "completed";
        job.finishedAt = new Date().toISOString();
        await this.finish(job);
      } else {
        job.status = "paused";
        job.pauseReason = "queue";
        await this.save();
      }
    }
  }

  /** A job that will never run another item: the state is saved first, then whoever asked
   *  hears about it -- once per job, and a hook that throws is reported instead of being
   *  allowed to stop the pump. The flag only comes off once the hook is through, so a
   *  crash between the two saves is repaired by `load()`. */
  private async finish(job: StoredJob) {
    await this.save();
    if (this.notified.has(job.id)) return;
    this.notified.add(job.id);
    try {
      await this.options.finished?.(publicJob(job), job.operation);
    } catch (error) {
      log("WARN", "A finished library operation hook threw", {
        job: job.id, op: job.operation.op, reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    job.notifyPending = false;
    await this.save();
  }

  private save() {
    const active = this.jobs.filter((job) => job.status === "running" || job.status === "paused");
    const finished = this.jobs.filter((job) => job.status !== "running" && job.status !== "paused").slice(-20);
    const state: StoredState = { version: 1, jobs: [...active, ...finished].sort((a, b) => a.startedAt.localeCompare(b.startedAt)) };
    const serialized = JSON.stringify(state, null, 2);
    this.saveTail = this.saveTail.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.options.file), { recursive: true });
      const temporary = `${this.options.file}.tmp`;
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, this.options.file);
    });
    return this.saveTail;
  }
}
