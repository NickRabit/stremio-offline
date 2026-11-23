/** At most this many bytes of a segment wait in memory for the disk (with up to eight segments
 *  of up to eight downloads, a slow disk holds at most about twice this per segment). A network chunk is a few
 *  dozen kilobytes; chunks that arrive while a write is still on its way go out together in the
 *  next one, so a slow NAS disk gets fewer, larger writes without holding the transfer back. */
export const SEGMENT_WRITE_QUEUE_BYTES = 1024 * 1024;

/** Writes a segment's bytes behind the transfer: one write at a time, everything that arrived
 *  meanwhile joined into the next one. `written` reports each block once it is on disk, which is
 *  what a resume may count on. */
export class SegmentWriter {
  private queued: Buffer[] = [];
  private queuedBytes = 0;
  private writing: Promise<void> | undefined;
  private error: unknown;
  private failed = false;

  constructor(
    private position: number,
    private readonly write: (block: Buffer, position: number) => Promise<unknown>,
    private readonly written: (bytes: number) => void,
    private readonly limit = SEGMENT_WRITE_QUEUE_BYTES,
    /** Told of a failed write at once, so a caller waiting on the network can stop reading and
     *  report the disk's error instead of whatever the wait would end in. */
    private readonly failedWith: (error: unknown) => void = () => {},
  ) {}

  /** Queues a piece; resolves at once unless enough is already waiting for the disk. */
  async push(piece: Buffer): Promise<void> {
    if (this.failed) throw this.error;
    this.queued.push(piece);
    this.queuedBytes += piece.length;
    this.start();
    if (this.queuedBytes >= this.limit) await this.settle();
  }

  /** Waits until everything queued is on disk, or throws the write's error. */
  async settle(): Promise<void> {
    while (this.writing) await this.writing;
    if (this.queuedBytes && !this.failed) {
      this.start();
      while (this.writing) await this.writing;
    }
    if (this.failed) throw this.error;
  }

  private start(): void {
    this.writing ??= this.drain()
      .catch((error: unknown) => { this.failed = true; this.error = error; this.failedWith(error); })
      .finally(() => {
        this.writing = undefined;
        // A piece pushed after the last block went out but before this ran found a write still
        // "running" and started none: it goes out now rather than waiting for the next push.
        if (this.queuedBytes && !this.failed) this.start();
      });
  }

  private async drain(): Promise<void> {
    while (this.queuedBytes && !this.failed) {
      const block = this.queued.length === 1 ? this.queued[0]! : Buffer.concat(this.queued, this.queuedBytes);
      this.queued = [];
      this.queuedBytes = 0;
      await this.write(block, this.position);
      this.position += block.length;
      this.written(block.length);
    }
  }
}
