import type { FollowService } from "./follows.js";
import type { InFlight } from "./in-flight.js";
import type { LogLevel } from "./logger.js";
import type { Maintenance } from "./maintenance.js";

const SHUTDOWN_QUIET_MS = 250;
/** The drain, together with the one-second wait for the follow service, has to fit the
 *  desktop shell's five seconds before it kills the process, and Docker's ten. */
const SHUTDOWN_DRAIN_MS = 3_000;
/** How long a step that can hang is given before the sequence moves on without it. */
const SHUTDOWN_STEP_MS = 1_000;

/** Everything the shutdown sequence touches, so the sequence can run against fakes in a test. */
export interface ShutdownDeps {
  inFlight: Pick<InFlight, "active" | "drained">;
  maintenance: Pick<Maintenance, "stop">;
  followService: Pick<FollowService, "stop">;
  killRunningMedia(): number;
  /** The stores written back before the process goes, bar `store`, which is flushed again once
   *  the late requests have queued their saves. A rejection is contained so one store cannot
   *  hold back the rest. */
  flushes: ReadonlyArray<() => Promise<unknown>>;
  store: { flush(): Promise<void> };
  flushLog(): Promise<void>;
  log(level: LogLevel, message: string, context?: Record<string, unknown>): void;
  /** The clock the drain budget is measured on, injected so a test can hold it still. */
  now(): number;
  /** Schedules the bounded waits, injected so a test can fire them instead of waiting. */
  setTimer(callback: () => void, ms: number): { unref?(): void };
}

/** A step that hangs must not eat the drain, so it is raced against a timer. */
const bounded = (deps: ShutdownDeps, ms: number): Promise<void> =>
  new Promise((resolve) => deps.setTimer(resolve, ms).unref?.());

/**
 * The whole shutdown, from the first signal to the last line written: the requests already on
 * their way are answered, the background work stops, the media is killed, the stores and the
 * log are written, and only then does the caller exit.
 */
export function createShutdown(deps: ShutdownDeps): (signal: NodeJS.Signals) => Promise<void> {
  return async (signal) => {
    deps.log("INFO", "Shutting down", { signal });
    const deadline = deps.now() + SHUTDOWN_DRAIN_MS;
    // A request already on its way, such as the position a closing player sends, is answered
    // and its state written before the process goes. A stream that never ends is cut at the limit.
    await deps.inFlight.drained(SHUTDOWN_QUIET_MS, SHUTDOWN_DRAIN_MS);
    await deps.maintenance.stop(SHUTDOWN_STEP_MS);
    // A check already asking the addons is given a moment to write what it found; one stuck
    // on a slow provider is not allowed to eat the whole drain.
    await Promise.race([deps.followService.stop(), bounded(deps, SHUTDOWN_STEP_MS)]);
    // The download queue is not stopped: an aborted transfer reads as a dropped connection and
    // would spend a retry, or move a lazy job off its source and drop its `.part`. Left running,
    // it ends with the process and resumes from the `.part` on the next start.
    // A conversion or an assembly nobody is reading any more would run on without its parent.
    const killed = deps.killRunningMedia();
    if (killed) deps.log("INFO", "Stopped FFmpeg processes still running at shutdown", { count: killed });
    await Promise.allSettled([deps.store.flush(), ...deps.flushes.map((flush) => flush())]);
    // The listener stays open, so a request accepted while those were written queues its save
    // after the flush above.
    while (deps.inFlight.active() > 0 && deps.now() < deadline) {
      await deps.inFlight.drained(0, deadline - deps.now());
      await deps.store.flush();
    }
    await deps.flushLog();
  };
}

/**
 * Binds `SIGTERM` and `SIGINT` to the shutdown. The first signal runs it and exits 0; a second
 * signal is ignored rather than falling back to the default action and killing the process in
 * the middle of the drain.
 */
export function installSignalHandlers(
  shutdown: (signal: NodeJS.Signals) => Promise<void>,
  exit: (code?: number) => void = (code) => process.exit(code),
  on: (signal: NodeJS.Signals, handler: () => void) => unknown = (signal, handler) => process.on(signal, handler),
): void {
  let shuttingDown = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void shutdown(signal).finally(() => exit(0));
    });
  }
}
