const INITIAL_BUFFER_BYTES = 64 * 1024;

export class ResponseTooLargeError extends Error {
  constructor(readonly limit: number, readonly observedBytes = limit) {
    super(`Response body exceeds ${limit} bytes.`);
    this.name = "ResponseTooLargeError";
  }
}

const cancel = (cancelable: { cancel(reason?: unknown): Promise<void> }) => {
  try {
    void cancelable.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best effort and must not replace the original failure.
  }
};

export function cancelResponseBody(response: Response): void {
  if (response.body) cancel(response.body);
}

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? Object.assign(new Error("Aborted"), { name: "AbortError" });

function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) {
    cancel(reader);
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const settle = () => {
      if (settled) return false;
      settled = true;
      cleanup();
      return true;
    };
    const onAbort = () => {
      if (!settle()) return;
      cancel(reader);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => { if (settle()) resolve(result); },
      (error) => { if (settle()) reject(error); },
    );
  });
}

export async function readLimitedBody(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const body = response.body;
  const lengthHeader = response.headers.get("content-length")?.trim() ?? "";
  const declared = /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : undefined;
  if (declared !== undefined && declared > maxBytes) {
    if (body) cancel(body);
    throw new ResponseTooLargeError(maxBytes, declared);
  }
  if (!body) return Buffer.alloc(0);

  const reader = body.getReader();
  const initial = Number.isSafeInteger(declared) && declared! >= 0 && declared! <= maxBytes
    ? declared!
    : Math.min(maxBytes, INITIAL_BUFFER_BYTES);
  let data = Buffer.allocUnsafe(initial);
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await readWithSignal(reader, signal);
      if (done) return total === data.length ? data : data.subarray(0, total);
      if (!value.byteLength) continue;
      if (value.byteLength > maxBytes - total) throw new ResponseTooLargeError(maxBytes, total + value.byteLength);

      const required = total + value.byteLength;
      if (required > data.length) {
        const grown = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(required, data.length * 2, INITIAL_BUFFER_BYTES)));
        data.copy(grown, 0, total);
        data = grown;
      }
      data.set(value, total);
      total = required;
    }
  } catch (error) {
    cancel(reader);
    throw error;
  }
}
