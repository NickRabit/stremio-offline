import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { messageKeyOf } from "./errors.js";

export type LibraryOp =
  | { op: "move"; items: string[]; target: string }
  | { op: "copy"; items: string[]; target: string }
  | { op: "delete"; items: string[] }
  | { op: "favorite"; items: string[]; favorite: boolean }
  | { op: "match"; items: string[]; type: string; id: string }
  | { op: "unmatch"; items: string[] }
  | { op: "skipLookup"; items: string[]; skipLookup: boolean }
  | { op: "artwork"; items: string[] }
  | { op: "forget"; items: string[] };

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
}

interface StoredState { version: 1; jobs: StoredJob[] }

export interface LibraryOpsOptions {
  file: string;
  execute: (operation: LibraryOp, item: string, progress: (bytes: number, total?: number) => void) => Promise<{ to?: string }>;
  pause?: (operation: LibraryOp, item: string) => Promise<OpsState["pauseReason"] | undefined> | OpsState["pauseReason"] | undefined;
  retryMs?: number;
}

const publicJob = ({ operation: _operation, cancelRequested: _cancelRequested, ...job }: StoredJob): OpsState => structuredClone(job);

export class LibraryOps {
  private jobs: StoredJob[] = [];
  private pumping = false;
  private saveTail = Promise.resolve();
  private wakeTimer?: ReturnType<typeof setTimeout>;

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
      startedAt: now, results: [],
    };
    this.jobs.push(job);
    await this.save();
    this.pump();
    return publicJob(job);
  }

  async cancel(id: string) {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job || job.status === "completed" || job.status === "failed" || job.status === "cancelled") return false;
    if (job.status === "running") job.cancelRequested = true;
    else {
      job.status = "cancelled";
      job.pauseReason = undefined;
      job.finishedAt = new Date().toISOString();
    }
    await this.save();
    return true;
  }

  private pump() {
    if (this.pumping) return;
    this.pumping = true;
    void this.run().finally(() => { this.pumping = false; });
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
        await this.save();
        continue;
      }
      const reason = await this.options.pause?.(job.operation, item);
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
      } else if (job.done + job.failed >= job.total) {
        job.status = job.failed === job.total ? "failed" : "completed";
        job.finishedAt = new Date().toISOString();
      } else {
        job.status = "paused";
        job.pauseReason = "queue";
      }
      await this.save();
    }
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
