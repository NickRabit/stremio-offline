import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { log } from "./logger.js";
import { ffmpegPath } from "./media-tools.js";
import { completeVttBlocks, shiftVtt, vttCoverage } from "./vtt.js";

type Extract = (args: string[], file: string, append: boolean, signal: AbortSignal) => Promise<unknown>;

/** A resumed reader writes its own WEBVTT header, which belongs only at the top. */
const withoutHeader = () => {
  let past = false;
  return new Transform({
    transform(chunk, _encoding, next) {
      if (past) return next(null, chunk);
      const text = chunk.toString() as string;
      const blank = text.indexOf("\n\n");
      if (blank < 0) return next();
      past = true;
      next(null, text.slice(blank + 2));
    },
  });
};

/** Through a pipe, not "-y file": writing a file itself FFmpeg keeps the cues in its own
 *  buffer and the sidecar stays empty until the whole film has been read, which on a
 *  remote source is minutes. A pipe is written through, so the cues land as they come. */
const extract: Extract = (args, file, append, signal) => new Promise<void>((resolve, reject) => {
  const out = createWriteStream(file, append ? { flags: "a" } : {});
  out.once("error", reject);
  out.once("open", () => {
    const child = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
    const cues = append ? child.stdout.pipe(withoutHeader()) : child.stdout;
    cues.pipe(out);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    const kill = () => child.kill("SIGKILL");
    // A backstop against an FFmpeg that hung; the reader is normally ended by the abort.
    const backstop = setTimeout(kill, 30 * 60_000);
    signal.addEventListener("abort", kill, { once: true });
    child.once("error", (error) => { clearTimeout(backstop); out.end(); reject(error); });
    child.once("close", (code, killedBy) => {
      clearTimeout(backstop);
      signal.removeEventListener("abort", kill);
      out.end();
      if (signal.aborted || code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code ?? killedBy}: ${stderr.slice(-200)}`));
    });
  });
});

/** Cues only have to reach a little past the playhead to be worth attaching: on a slow
 *  source reading a couple of minutes ahead takes longer than the viewer's next seek, and
 *  the player reads the track again as the reader gets further. */
export const SIDECAR_LEAD_S = 5;
/** A paused reader picks up again while the cues are still this far ahead of the picture. */
export const SIDECAR_RESUME_LEAD_S = 120;
/** How long a reader keeps away from a source that just refused it, and the ceiling for that
 *  wait. The hosts behind these films answer a handful of connections and then stop answering
 *  at all, so a reader that failed must not come straight back for another one. */
export const SIDECAR_RETRY_MS = 5_000;
export const SIDECAR_RETRY_MAX_MS = 60_000;
/** And this far before the reader lets go of the source: a seek needs a connection of
 *  its own, and the hosts behind these films rarely give out a second one. */
export const SIDECAR_AHEAD_S = 900;

interface Job {
  revision: string; track: number; start: number; file: string;
  directory: string; args: (start: number) => Promise<string[]>;
  controller: AbortController; done: Promise<void>;
  running: boolean; started: boolean; complete: boolean; served: boolean;
  /** Consecutive failed bursts, and when the next one may be started. */
  failures: number; waitUntil: number;
  /** How far the cues written so far reach, refreshed whenever the player asks for them. */
  coverage: number;
}

export class PlayerSidecars {
  private jobs = new Map<string, Job>();
  private released = new Set<string>();
  constructor(private run: Extract = extract, private failed: (id: string, error: unknown) => void = () => {}) {}

  /** One reader per track: a seek usually lands inside what this one has already written,
   *  and only a position it cannot serve -- another track, a jump back before its start, or
   *  one so far ahead that it would have to read the film to get there -- needs another. */
  ensure(id: string, directory: string, track: number, offset: number, args: (start: number) => Promise<string[]>) {
    this.released.delete(id);
    const current = this.jobs.get(id);
    // A reader started at this very position is the right one even before it has written a cue:
    // without this, every repeated call replaced a reader that was only just getting going, and
    // each replacement is another connection to a source that counts them.
    // Within a second of where it began is the same position: the offset arrives rounded through
    // one path and exact through another, and a hair of difference must not cost a connection.
    const sameStart = current !== undefined && Math.abs(offset - current.start) < 1;
    if (current && current.track === track && (sameStart || (offset >= current.start && offset <= current.coverage))) {
      this.keepAhead(current, id, offset);
      return;
    }
    const previous = current;
    previous?.controller.abort();
    const revision = randomUUID();
    const start = Math.max(0, offset);
    const job: Job = {
      revision, track, start, file: path.join(directory, `sidecar-${revision}.vtt`),
      directory, args, controller: new AbortController(), done: Promise.resolve(),
      running: false, started: false, complete: false, served: false, coverage: -Infinity, failures: 0, waitUntil: 0,
    };
    this.jobs.set(id, job);
    void (async () => {
      if (previous) { await previous.done; await rm(previous.file, { force: true }).catch(() => undefined); }
      if (this.jobs.get(id) !== job) return;
      this.launch(id, job, start, false);
    })();
  }

  private launch(id: string, job: Job, from: number, append: boolean, why: "new" | "catching up" | "again" = append ? "catching up" : "new") {
    // This burst's own signal: a pause gives the job a fresh one for the next burst, and
    // reading the job's current signal here would make a paused reader look finished.
    const { signal } = job.controller;
    // A read that was already on its way must not start a reader for a session that has since
    // been closed: its FFmpeg would outlive the media it reads and hammer a revoked source.
    // And one burst at a time: two callers that both found the job before it had started would
    // otherwise run two FFmpegs over the same file, truncating what the other has written.
    if (job.running || signal.aborted || this.jobs.get(id) !== job || this.released.has(id)) return;
    job.running = true;
    job.started = true;
    log("INFO", "Reading embedded subtitles", { id, track: job.track, from: Math.round(from), why });
    const startedAt = Date.now();
    job.done = (async () => {
      try {
        await mkdir(job.directory, { recursive: true });
        const input = await job.args(from);
        if (signal.aborted) return;
        await this.run([...input, "-f", "webvtt", "pipe:1"], job.file, append, signal);
        if (!signal.aborted) {
          job.failures = 0;
          job.complete = true;
          job.coverage = Infinity;
          log("INFO", "Embedded subtitles read to the end", { id, track: job.track, seconds: Math.round((Date.now() - startedAt) / 1000) });
        }
      } catch (error) {
        if (!signal.aborted) {
          job.failures += 1;
          const wait = Math.min(SIDECAR_RETRY_MS * job.failures, SIDECAR_RETRY_MAX_MS);
          job.waitUntil = Date.now() + wait;
          this.failed(id, error);
          log("INFO", "Leaving the source alone before reading subtitles again", { id, track: job.track, failures: job.failures, seconds: Math.round(wait / 1000) });
        }
      } finally {
        job.running = false;
        if (!job.complete) log("DEBUG", "The subtitle reader stopped", { id, track: job.track, ended: signal.aborted ? "it was told to" : "the reader ended by itself", coverage: Math.round(job.coverage) });
      }
    })();
  }

  /** The reader runs in bursts: it fills the cues a quarter of an hour ahead and then
   *  releases the source, so a seek or a track switch has a connection to open. */
  private keepAhead(job: Job, id: string, offset: number) {
    // A job that has not started is already on its way: it waits for the reader it replaced to
    // let go of the source. Starting it here would defeat that wait and could double the read.
    if (!job.started || this.released.has(id) || job.complete || Date.now() < job.waitUntil) return;
    if (job.running && job.coverage >= offset + SIDECAR_AHEAD_S) { void this.pause(job); return; }
    if (!job.running && job.coverage < offset + SIDECAR_RESUME_LEAD_S) {
      const from = Number.isFinite(job.coverage) ? Math.max(job.start, job.coverage) : job.start;
      this.launch(id, job, from, Number.isFinite(job.coverage), Number.isFinite(job.coverage) ? "catching up" : "again");
    }
  }

  /** Stops the FFmpeg but keeps the cues it found, so reading can pick up where it left off. */
  private async pause(job: Job) {
    const stopping = job.controller;
    stopping.abort();
    await job.done;
    if (job.controller === stopping) job.controller = new AbortController();
  }

  revision(id: string) { return this.jobs.get(id)?.revision; }

  /** The cues are written with source timestamps, so they are shifted to the playing
   *  generation here rather than extracted again for every position. */
  async read(id: string, revision: string | undefined, offset: number, delay = 0, position: number | null = offset): Promise<{ text: string; complete: boolean; coverage: number } | undefined> {
    const job = this.jobs.get(id);
    if (!job || (revision !== undefined && job.revision !== revision)) return undefined;
    // Taken before the file is read. A reader that finishes while this read is in flight
    // rewrites the file, and a file caught mid-rewrite is empty: read afterwards, that
    // becomes an empty track the player is told is the whole of it and never asks for again.
    const complete = job.complete;
    let raw: string;
    try { raw = await readFile(job.file, "utf8"); } catch { return undefined; }
    const text = complete ? raw : completeVttBlocks(raw);
    if (!complete) {
      job.coverage = vttCoverage(text);
      if (position !== null) this.keepAhead(job, id, position);
      if (job.coverage < offset + SIDECAR_LEAD_S) {
        // The one line that says why a film is playing without subtitles.
        log("DEBUG", "Embedded subtitles are still behind the picture", { id, wanted: Math.round(offset + SIDECAR_LEAD_S), reached: Math.round(job.coverage) });
        return undefined;
      }
    }
    if (!job.served) {
      job.served = true;
      const first = text.split(/\n\n+/).find((block) => block.includes("-->"))?.split("\n")[0];
      log("INFO", "Embedded subtitles reached the player", { id, track: job.track, complete, from: Math.round(offset), delay, first });
    }
    // The delay is the viewer's own correction: a positive one holds the cues back.
    const shift = offset - delay;
    const shifted = shift !== 0 ? shiftVtt(text, shift) : text;
    return { text: shifted, complete, coverage: complete ? Infinity : job.coverage };
  }

  /** Lets go of the source without losing the cues, for a conversion that needs to open it. */
  async release(id: string) {
    this.released.add(id);
    const job = this.jobs.get(id);
    if (job?.running) await this.pause(job);
  }

  async stop(id: string) {
    this.released.delete(id);
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id);
    job.controller.abort();
    await job.done;
    await rm(job.file, { force: true }).catch(() => undefined);
  }
}
