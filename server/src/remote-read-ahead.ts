/** FFmpeg opens a media-server original by jumping between the start and the end of the file --
 *  an OpenDML AVI keeps one 16-byte index entry near the start for every index chunk at the end --
 *  and every jump is a new request. One probe of such a film asked the media server 126 times.
 *  Reads are therefore taken from the media server in bounded blocks and kept for a while, so the
 *  jumps are answered from memory and the server is asked only for the blocks themselves. */

export type OpenRange = (range: string, signal: AbortSignal) => Promise<Response>;

/** The media server refused the range itself; the route answers 416 with this content range. */
export class RangeNotSatisfiable extends Error {
  constructor(readonly contentRange: string | undefined) { super("The requested range is not satisfiable."); }
}

/** The media server answered with something that is not the bounded partial read that was asked
 *  for; the route falls back to an ordinary transfer. */
export class UnexpectedAnswer extends Error {}

/** The blocks already being read take the whole budget; the caller reads this one directly. */
export class ReadAheadFull extends Error {}

export interface ReadAheadBlock {
  readonly start: number;
  /** Exclusive end of the bytes this block will hold once its read completes. */
  end: number;
  size: number;
  contentType: string | undefined;
  chunks: Buffer[];
  filled: number;
  done: boolean;
  failed?: unknown;
  at: number;
  wake: Set<() => void>;
  /** Settles once the media server has answered the block's read; rejects when it refused it. */
  ready: Promise<void>;
  /** Stops the block's read; a block that is dropped is never read further. */
  stop: AbortController;
  /** Whether the block is still held here and its bytes still counted. */
  held: boolean;
}

const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/;

export class RemoteReadAhead {
  private readonly blocks = new Map<string, ReadAheadBlock[]>();
  private held = 0;

  constructor(
    readonly blockBytes = 1024 * 1024,
    private readonly total = 64 * 1024 * 1024,
    private readonly ttlMs = 10 * 60_000,
    private readonly fillTimeoutMs = 30_000,
    private readonly now = () => Date.now(),
  ) {}

  /** The block holding `offset`, or the one still being read that will hold it. */
  find(key: string, offset: number): ReadAheadBlock | undefined {
    const list = this.blocks.get(key);
    if (!list) return undefined;
    for (const block of [...list]) {
      if (block.failed !== undefined || offset < block.start || offset >= block.end) continue;
      if (this.now() - block.at > this.ttlMs) { this.drop(key, block); continue; }
      block.at = this.now();
      return block;
    }
    return undefined;
  }

  /** The block holding `offset` once its answer has arrived, joining a read already under way
   *  or starting one. */
  async take(key: string, offset: number, open: OpenRange): Promise<ReadAheadBlock> {
    const held = this.find(key, offset);
    if (!held) return this.fill(key, offset, open);
    await held.ready;
    return held;
  }

  /** Starts one bounded read at `offset` and resolves once the media server has answered with
   *  the partial content asked for. The block is registered before that answer, so a reader
   *  arriving meanwhile joins it rather than asking again. The body keeps arriving into the
   *  block after that; the read belongs to the block, not to any one listener, so a reader that
   *  leaves does not cut it. */
  async fill(key: string, offset: number, open: OpenRange): Promise<ReadAheadBlock> {
    // A read under way is counted at its full size: it cannot be evicted before it ends.
    const reserve = (this.pending() + 1) * this.blockBytes;
    this.evict(reserve);
    if (this.held + reserve > this.total) throw new ReadAheadFull();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fillTimeoutMs);
    timer.unref?.();
    let answered!: () => void;
    let refused!: (error: unknown) => void;
    const block: ReadAheadBlock = {
      start: offset, end: offset + this.blockBytes, size: 0, contentType: undefined,
      chunks: [], filled: 0, done: false, at: this.now(), wake: new Set(),
      ready: new Promise<void>((resolve, reject) => { answered = resolve; refused = reject; }),
      stop: controller, held: true,
    };
    block.ready.catch(() => undefined);
    const list = this.blocks.get(key) ?? [];
    list.push(block);
    this.blocks.set(key, list);
    const fail = (error: unknown): never => {
      clearTimeout(timer);
      block.failed = error;
      this.drop(key, block);
      refused(error);
      throw error;
    };
    let response: Response;
    try { response = await open(`bytes=${offset}-${offset + this.blockBytes - 1}`, controller.signal); }
    catch (error) { return fail(error); }
    const cancel = () => { void response.body?.cancel().catch(() => undefined); };
    if (response.status === 416) { cancel(); return fail(new RangeNotSatisfiable(response.headers.get("content-range") ?? undefined)); }
    const range = CONTENT_RANGE.exec(response.headers.get("content-range") ?? "");
    if (response.status !== 206 || !range || Number(range[1]) !== offset || !response.body) { cancel(); return fail(new UnexpectedAnswer()); }
    // A host that answers with the rest of the file is read only as far as the block reaches.
    block.end = Math.min(Number(range[2]) + 1, offset + this.blockBytes);
    block.size = Number(range[3]);
    block.contentType = response.headers.get("content-type") ?? undefined;
    answered();
    void this.pour(key, block, response.body, controller.signal).finally(() => clearTimeout(timer));
    return block;
  }

  private async pour(key: string, block: ReadAheadBlock, body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const want = block.end - block.start;
    try {
      while (block.filled < want) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        const piece = Buffer.from(value.subarray(0, want - block.filled));
        if (!block.held) throw new Error("The block was dropped.");
        block.chunks.push(piece);
        block.filled += piece.length;
        this.held += piece.length;
        this.notify(block);
      }
      if (block.filled < want) throw new Error("The media server ended the read early.");
      block.done = true;
    } catch (error) {
      block.failed = error;
      this.drop(key, block);
    } finally {
      void reader.cancel().catch(() => undefined);
      this.notify(block);
      this.evict();
    }
  }

  /** The block's bytes from `from` up to `until` (exclusive), as they arrive. */
  async *read(block: ReadAheadBlock, from: number, until: number): AsyncGenerator<Buffer> {
    let position = from;
    const stop = Math.min(until, block.end);
    while (position < stop) {
      const available = block.start + block.filled;
      if (position < available) {
        const piece = this.slice(block, position - block.start, Math.min(stop, available) - block.start);
        position += piece.length;
        yield piece;
        continue;
      }
      if (block.failed !== undefined) throw block.failed;
      if (block.done) return;
      await new Promise<void>((resolve) => { block.wake.add(resolve); });
    }
  }

  /** Drops what one source holds; `key` also covers the child reads named `key:…`. */
  forget(key: string): void {
    for (const [held, list] of [...this.blocks]) {
      if (held !== key && !held.startsWith(`${key}:`)) continue;
      for (const block of [...list]) this.drop(held, block);
    }
  }

  get size(): number { return this.held; }

  private slice(block: ReadAheadBlock, from: number, until: number): Buffer {
    const parts: Buffer[] = [];
    let offset = 0;
    for (const chunk of block.chunks) {
      const chunkEnd = offset + chunk.length;
      if (chunkEnd > from && offset < until) parts.push(chunk.subarray(Math.max(0, from - offset), Math.min(chunk.length, until - offset)));
      offset = chunkEnd;
      if (offset >= until) break;
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }

  private notify(block: ReadAheadBlock): void {
    const waiting = [...block.wake];
    block.wake.clear();
    for (const resolve of waiting) resolve();
  }

  private drop(key: string, block: ReadAheadBlock): void {
    const list = this.blocks.get(key);
    const index = list?.indexOf(block) ?? -1;
    if (index >= 0) {
      list!.splice(index, 1);
      if (!list!.length) this.blocks.delete(key);
    }
    if (!block.held) return;
    block.held = false;
    this.held -= block.filled;
    if (!block.done) block.stop.abort();
  }

  private pending(): number {
    let count = 0;
    for (const list of this.blocks.values()) for (const block of list) if (!block.done) count += 1;
    return count;
  }

  /** Expired blocks go first, then the least recently read finished ones until the budget
   *  holds; a block still being read is never cut. */
  private evict(reserve = 0): void {
    for (const [key, list] of [...this.blocks]) {
      for (const block of [...list]) if (block.done && this.now() - block.at > this.ttlMs) this.drop(key, block);
    }
    while (this.held + reserve > this.total) {
      let oldest: { key: string; block: ReadAheadBlock } | undefined;
      for (const [key, list] of this.blocks) {
        for (const block of list) if (block.done && (!oldest || block.at < oldest.block.at)) oldest = { key, block };
      }
      if (!oldest) return;
      this.drop(oldest.key, oldest.block);
    }
  }
}
