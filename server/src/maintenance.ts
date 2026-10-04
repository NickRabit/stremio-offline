import { log } from "./logger.js";

export interface MaintenanceTask { name: string; run(signal: AbortSignal): Promise<void> }
export interface Maintenance {
  /** Runs every task once, in order. A pass already running is returned instead of starting another. */
  run(): Promise<void>;
  /** Schedules the first pass after `firstDelayMs`, then one per `intervalMs`. Idempotent. */
  start(): void;
  /** Stops scheduling, aborts the signal, and waits for the running pass for at most `graceMs`. */
  stop(graceMs?: number): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_FIRST_DELAY_MS = 5_000;
const DEFAULT_GRACE_MS = 2_000;

/** A pass that runs itself: the caches and the thumbnail sweep are maintained shortly after
 *  start and then on an interval, without a request having to drive them. */
export function createMaintenance(options: {
  tasks: MaintenanceTask[];
  intervalMs?: number;
  firstDelayMs?: number;
}): Maintenance {
  const { tasks } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const firstDelayMs = options.firstDelayMs ?? DEFAULT_FIRST_DELAY_MS;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let started = false;
  let stopped = false;

  const run = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      for (const task of tasks) {
        if (controller.signal.aborted) return;
        try { await task.run(controller.signal); }
        catch (error) { log("WARN", "A maintenance task failed", { task: task.name, reason: String(error).slice(0, 200) }); }
      }
    })().finally(() => { running = undefined; });
    return running;
  };

  // The next pass is armed only once this one has finished, so a slow pass never stacks.
  const arm = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      // `run` never rejects, but the schedule must not depend on that.
      void run().catch(() => undefined).finally(() => arm(intervalMs));
    }, ms);
    timer.unref?.();
  };

  return {
    run,
    start: () => {
      if (started) return;
      started = true;
      arm(firstDelayMs);
    },
    stop: async (graceMs = DEFAULT_GRACE_MS) => {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = undefined; }
      controller.abort();
      const current = running;
      if (!current) return;
      await new Promise<void>((resolve) => {
        const waiter = setTimeout(resolve, graceMs);
        waiter.unref?.();
        const done = () => { clearTimeout(waiter); resolve(); };
        current.then(done, done);
      });
    },
  };
}
