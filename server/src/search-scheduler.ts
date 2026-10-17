import {
  SEARCH_LIMITS,
  type SearchSourceClass,
} from "./search-contracts.js";

export interface SchedulerJob {
  sessionId: string;
  sourceClass: SearchSourceClass;
  poolKey: string;
  order: number;
  run(signal: AbortSignal): Promise<void>;
}

type SchedulerResult = "ok" | "error" | "cancelled" | "hardLimit";

interface TimerApi {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface Entry {
  id: number;
  job: SchedulerJob;
  queueOrder: number;
  state: "queued" | "active" | "done";
  resultSettled: boolean;
  resolve: (result: SchedulerResult) => void;
  controller?: AbortController;
  timer?: unknown;
  cancelRequested: boolean;
}

type SchedulerLimits = {
  jobsServerWide: number;
  catalogJobsPerSession: number;
  localJobsPerSession: number;
  remoteJobsPerSession: number;
  remoteJobsPerPool: number;
  sourceHardLimitMs: number;
};

const CLASSES: SearchSourceClass[] = ["catalog", "local", "remote"];
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const nextAfter = <T>(items: T[], last: T | undefined): T[] => {
  if (items.length === 0) return [];
  if (last === undefined) return items;
  const index = items.indexOf(last);
  if (index < 0) return items;
  return [...items.slice(index + 1), ...items.slice(0, index + 1)];
};

export class SearchScheduler {
  private readonly limits: SchedulerLimits;
  private readonly timers: TimerApi;
  private readonly entries = new Map<number, Entry>();
  private queued: Entry[] = [];
  private active = new Set<Entry>();
  private readonly sessionClassActive = new Map<string, number>();
  private readonly poolActive = new Map<string, number>();
  private nextEntryId = 1;
  private nextQueueOrder = 1;
  private lastSession: string | undefined;
  private readonly lastClass = new Map<string, SearchSourceClass>();
  private readonly lastPool = new Map<string, string>();

  constructor(
    limits: Partial<{
      jobsServerWide: number;
      catalogJobsPerSession: number;
      localJobsPerSession: number;
      remoteJobsPerSession: number;
      remoteJobsPerPool: number;
      sourceHardLimitMs: number;
    }> = {},
    _now: () => number = Date.now,
    timers?: TimerApi,
  ) {
    this.limits = { ...SEARCH_LIMITS, ...limits };
    this.timers = timers ?? {
      setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
    };
  }

  enqueue(job: SchedulerJob): {
    cancel(): void;
    done: Promise<SchedulerResult>;
  } {
    let resolve!: (result: SchedulerResult) => void;
    const done = new Promise<SchedulerResult>((finish) => { resolve = finish; });
    const entry: Entry = {
      id: this.nextEntryId++,
      job,
      queueOrder: this.nextQueueOrder++,
      state: "queued",
      resultSettled: false,
      resolve,
      cancelRequested: false,
    };
    this.entries.set(entry.id, entry);
    this.queued.push(entry);
    this.pump();
    return {
      cancel: () => this.cancelEntry(entry),
      done,
    };
  }

  cancelSession(sessionId: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.job.sessionId === sessionId) this.cancelEntry(entry);
    }
  }

  stats(): { active: number; queued: number } {
    return { active: this.active.size, queued: this.queued.length };
  }

  private cancelEntry(entry: Entry): void {
    if (entry.state === "queued") {
      this.queued = this.queued.filter((queued) => queued !== entry);
      entry.state = "done";
      this.entries.delete(entry.id);
      this.settle(entry, "cancelled");
      return;
    }
    if (entry.state !== "active") return;
    entry.cancelRequested = true;
    this.settle(entry, "cancelled");
    entry.controller?.abort();
  }

  private classLimit(sourceClass: SearchSourceClass): number {
    if (sourceClass === "catalog") return this.limits.catalogJobsPerSession;
    if (sourceClass === "local") return this.limits.localJobsPerSession;
    return this.limits.remoteJobsPerSession;
  }

  private sessionClassKey(sessionId: string, sourceClass: SearchSourceClass): string {
    return `${sessionId}\0${sourceClass}`;
  }

  private canRun(entry: Entry): boolean {
    if (
      (this.sessionClassActive.get(this.sessionClassKey(entry.job.sessionId, entry.job.sourceClass)) ?? 0)
      >= this.classLimit(entry.job.sourceClass)
    ) {
      return false;
    }
    return entry.job.sourceClass !== "remote"
      || (this.poolActive.get(entry.job.poolKey) ?? 0) < this.limits.remoteJobsPerPool;
  }

  private chooseForSession(sessionId: string): Entry | undefined {
    const classes = nextAfter(CLASSES, this.lastClass.get(sessionId));
    for (const sourceClass of classes) {
      const candidates = this.queued
        .filter((entry) => entry.job.sessionId === sessionId && entry.job.sourceClass === sourceClass)
        .sort((left, right) =>
          compareText(left.job.poolKey, right.job.poolKey)
          || left.job.order - right.job.order
          || left.queueOrder - right.queueOrder,
        );
      if (candidates.length === 0) continue;
      const pools = [...new Set(candidates.map((entry) => entry.job.poolKey))].sort();
      for (const poolKey of nextAfter(pools, this.lastPool.get(this.sessionClassKey(sessionId, sourceClass)))) {
        const entry = candidates.find((candidate) =>
          candidate.job.poolKey === poolKey && this.canRun(candidate),
        );
        if (entry !== undefined) return entry;
      }
    }
    return undefined;
  }

  private choose(): Entry | undefined {
    const sessions = [...new Set(this.queued.map((entry) => entry.job.sessionId))].sort();
    for (const sessionId of nextAfter(sessions, this.lastSession)) {
      const entry = this.chooseForSession(sessionId);
      if (entry !== undefined) return entry;
    }
    return undefined;
  }

  private pump(): void {
    while (this.active.size < this.limits.jobsServerWide) {
      const entry = this.choose();
      if (entry === undefined) return;
      this.admit(entry);
    }
  }

  private admit(entry: Entry): void {
    this.queued = this.queued.filter((queued) => queued !== entry);
    entry.state = "active";
    entry.controller = new AbortController();
    this.active.add(entry);
    this.lastSession = entry.job.sessionId;
    this.lastClass.set(entry.job.sessionId, entry.job.sourceClass);
    this.lastPool.set(
      this.sessionClassKey(entry.job.sessionId, entry.job.sourceClass),
      entry.job.poolKey,
    );
    const classKey = this.sessionClassKey(entry.job.sessionId, entry.job.sourceClass);
    this.sessionClassActive.set(classKey, (this.sessionClassActive.get(classKey) ?? 0) + 1);
    if (entry.job.sourceClass === "remote") {
      this.poolActive.set(entry.job.poolKey, (this.poolActive.get(entry.job.poolKey) ?? 0) + 1);
    }

    entry.timer = this.timers.setTimeout(() => this.hardLimit(entry), this.limits.sourceHardLimitMs);
    const timer = entry.timer as { unref?: () => void } | undefined;
    timer?.unref?.();

    let running: Promise<void>;
    try {
      running = entry.job.run(entry.controller.signal);
    } catch {
      this.finish(entry, "error");
      return;
    }
    Promise.resolve(running).then(
      () => this.finish(entry, "ok"),
      () => this.finish(entry, "error"),
    );
  }

  private hardLimit(entry: Entry): void {
    if (entry.state !== "active") return;
    entry.controller?.abort();
    this.settle(entry, "hardLimit");
    this.release(entry);
  }

  private finish(entry: Entry, result: "ok" | "error"): void {
    if (entry.state !== "active") return;
    this.settle(entry, result);
    this.release(entry);
  }

  private settle(entry: Entry, result: SchedulerResult): void {
    if (entry.resultSettled) return;
    entry.resultSettled = true;
    entry.resolve(entry.cancelRequested ? "cancelled" : result);
  }

  private release(entry: Entry): void {
    if (entry.state !== "active") return;
    entry.state = "done";
    if (entry.timer !== undefined) this.timers.clearTimeout(entry.timer);
    this.active.delete(entry);
    this.entries.delete(entry.id);
    const classKey = this.sessionClassKey(entry.job.sessionId, entry.job.sourceClass);
    const classCount = (this.sessionClassActive.get(classKey) ?? 0) - 1;
    if (classCount <= 0) this.sessionClassActive.delete(classKey);
    else this.sessionClassActive.set(classKey, classCount);
    if (entry.job.sourceClass === "remote") {
      const poolCount = (this.poolActive.get(entry.job.poolKey) ?? 0) - 1;
      if (poolCount <= 0) this.poolActive.delete(entry.job.poolKey);
      else this.poolActive.set(entry.job.poolKey, poolCount);
    }
    this.pump();
  }
}
