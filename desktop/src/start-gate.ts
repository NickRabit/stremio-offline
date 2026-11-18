import type { SerialQueue } from "./serial-queue.js";

/** What the gate needs of the local backend. */
export interface StartableBackend<C> {
  start(): Promise<C>;
  abortStart(): void;
}

/** A start that gave way to a settings change waiting for the queue it would have held. */
export class StartYieldedError extends Error {
  constructor() {
    super("The local server start gave way to a settings change.");
    this.name = "StartYieldedError";
  }
}

/**
 * Who goes first between a local start and what the settings window asks of the shell's queue.
 * A start may take minutes on a cold machine and holds the queue all that time, so a newer
 * request or a waiting settings change ends it, and a start that would begin while such a change
 * waits does not begin at all.
 */
export class StartGate {
  private starting: StartableBackend<unknown> | null = null;
  private waiting = 0;

  /** Ends a start a request made, if one is in flight. A running backend is not touched. */
  abort(): void {
    this.starting?.abortStart();
  }

  /** The start a request asked for, which a newer request or a waiting settings change ends. */
  async start<C>(backend: StartableBackend<C>): Promise<C> {
    if (this.waiting > 0) throw new StartYieldedError();
    this.starting = backend;
    try {
      return await backend.start();
    } finally {
      this.starting = null;
    }
  }

  /** Queues a settings change ahead of any start: the one in flight ends, and none begins until
   *  the change has its turn. */
  runFromSettings<T>(queue: SerialQueue, task: () => Promise<T>): Promise<T> {
    this.waiting += 1;
    let counted = true;
    const release = () => {
      if (!counted) return;
      counted = false;
      this.waiting -= 1;
    };
    this.abort();
    return queue.run(async () => {
      release();
      return task();
    }).finally(release);
  }
}
