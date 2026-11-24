import { finished, Writable } from "node:stream";

/** Passes chunks on to `sink` and reports each one to `written` only once the sink has written it,
 *  so a count kept from it never runs ahead of the file a resume measures. */
export function countWritten(sink: NodeJS.WritableStream, written: (bytes: number) => void): Writable {
  const target = sink as Writable;
  const forward = (chunk: Buffer, done: (error?: Error | null) => void) => {
    target.write(chunk, (error) => {
      if (!error) written(chunk.byteLength);
      done(error);
    });
  };
  const counted = new Writable({
    write(chunk: Buffer, _encoding, callback) { forward(chunk, callback); },
    // Everything that queued up while a write was out goes to the sink at once, so it can still join them.
    writev(chunks, callback) {
      let left = chunks.length;
      let failure: Error | null = null;
      for (const { chunk } of chunks) {
        forward(chunk as Buffer, (error) => {
          failure ??= error ?? null;
          if (--left === 0) callback(failure);
        });
      }
    },
    final(callback) {
      target.end();
      finished(target, (error) => callback(error ?? null));
    },
    // Settles once the sink has closed, so a write still out has landed before anyone measures the file.
    destroy(error, callback) {
      target.destroy(error ?? undefined);
      finished(target, () => callback(error));
    },
  });
  target.on("error", (error) => counted.destroy(error));
  return counted;
}
