import { MediaServerError } from "./media-server-types.js";

export interface OriginalQuotaSeams {
  clock?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface OriginalSlot {
  wrap(response: Response, signal: AbortSignal): Response;
  release(): void;
}

interface SourceState {
  refs: number;
  nextFreeAt: number;
}

const abortError = (signal: AbortSignal): unknown =>
  signal.reason ?? new Error("The media-server quota wait was cancelled.");

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) {
    reject(abortError(signal));
    return;
  }
  const onAbort = () => {
    clearTimeout(timer);
    reject(abortError(signal));
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  timer.unref?.();
  signal.addEventListener("abort", onAbort, { once: true });
});

export class OriginalQuota {
  private readonly connections = new Map<string, Map<string, SourceState>>();
  private readonly clock: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(seams: OriginalQuotaSeams = {}) {
    this.clock = seams.clock ?? (() => Date.now());
    this.sleep = seams.sleep ?? defaultSleep;
  }

  reserve(connectionId: string, sourceKey: string, limits: { bitrateLimit?: number; streamLimit?: number }): OriginalSlot {
    let sources = this.connections.get(connectionId);
    if (!sources) {
      sources = new Map();
      this.connections.set(connectionId, sources);
    }
    let state = sources.get(sourceKey);
    if (!state) {
      if (limits.streamLimit !== undefined && sources.size >= limits.streamLimit) {
        throw new MediaServerError("busy", "Too many media-server streams are open.");
      }
      state = { refs: 0, nextFreeAt: 0 };
      sources.set(sourceKey, state);
    }
    state.refs += 1;
    const held = state;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs > 0 || sources.get(sourceKey) !== held) return;
      sources.delete(sourceKey);
      if (sources.size === 0) this.connections.delete(connectionId);
    };

    return {
      release,
      wrap: (response, signal) => {
        if (!response.body) {
          release();
          return response;
        }
        const reader = response.body.getReader();
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          signal.removeEventListener("abort", onAbort);
          release();
        };
        const onAbort = () => {
          finish();
          void reader.cancel(abortError(signal)).catch(() => undefined);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();

        const bitrateLimit = limits.bitrateLimit;
        const body = new ReadableStream<Uint8Array>({
          pull: async (controller) => {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                finish();
                controller.close();
                return;
              }
              const bytes = chunk.value;
              if (bitrateLimit === undefined) {
                controller.enqueue(bytes);
                return;
              }
              const burst = bitrateLimit / 8;
              const pieces = Math.max(1, Math.ceil(bytes.byteLength / burst));
              const size = Math.ceil(bytes.byteLength / pieces);
              for (let offset = 0; offset < bytes.byteLength; offset += size) {
                const piece = bytes.subarray(offset, Math.min(bytes.byteLength, offset + size));
                const now = this.clock();
                const start = Math.max(now, held.nextFreeAt);
                held.nextFreeAt = start + piece.byteLength * 8000 / bitrateLimit;
                const wait = start - now - 1000;
                if (wait > 0) await this.sleep(wait, signal);
                controller.enqueue(piece);
              }
            } catch (error) {
              finish();
              void reader.cancel(error).catch(() => undefined);
              controller.error(error);
            }
          },
          cancel: async (reason) => {
            finish();
            await reader.cancel(reason).catch(() => undefined);
          },
        });
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      },
    };
  }

  forget(connectionId: string): void {
    this.connections.delete(connectionId);
  }
}
