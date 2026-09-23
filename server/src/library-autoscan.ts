import { libraryFingerprint, type FoundFile } from "./library.js";
import { log } from "./logger.js";
import type { ScanState } from "./library-scan.js";

export type AutoScanReason = "startup" | "interval" | "watch";

/** One library the check may walk. A root that is unreachable is left out of the
 *  list entirely, so its absence never reads as a mass deletion. */
export interface AutoScanLibrary { id: string; files: () => Promise<FoundFile[]> }

export interface LibraryAutoScanOpts {
  enabled: () => boolean;
  /** The libraries eligible for an automatic scan, one fingerprint each. A library whose
   *  automatic lookup is switched off is left out, so its absence is never a change. */
  libraries: () => Promise<AutoScanLibrary[]>;
  status: () => ScanState;
  /** The libraries that changed, never empty: an automatic run never widens to the whole
   *  install, so a library nobody touched is neither walked nor searched. */
  start: (libraryIds: string[]) => Promise<ScanState>;
  /** Playback or a running download; the scan would only pause itself anyway. */
  busy: () => boolean;
  watch?: (onChange: () => void) => { active: boolean; close(): void };
  intervalMs?: number;
  startupDelayMs?: number;
}

/** Copying a file into the download folder is the one way a title arrives without
 *  the queue knowing about it. The periodic check is the reliable half, the watch
 *  only makes it prompt where the filesystem reports changes at all. */
export class LibraryAutoScan {
  /** Kept for a library that is not in the list right now: an unplugged disk must not
   *  look like a tree that lost everything when it comes back. */
  private readonly fingerprints = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private watching: { active: boolean; close(): void } | undefined;
  private running = false;
  private readonly intervalMs: number;
  private readonly startupDelayMs: number;

  constructor(private readonly opts: LibraryAutoScanOpts) {
    this.intervalMs = opts.intervalMs ?? 6 * 60 * 60_000;
    this.startupDelayMs = opts.startupDelayMs ?? 2 * 60_000;
  }

  start() {
    if (this.timer) return;
    this.startupTimer = setTimeout(() => { void this.check("startup"); }, this.startupDelayMs);
    this.startupTimer.unref?.();
    this.timer = setInterval(() => { void this.check("interval"); }, this.intervalMs);
    this.timer.unref?.();
    this.watching = this.opts.watch?.(() => { void this.check("watch"); });
    log("INFO", "Automatic library scan armed", { intervalMs: this.intervalMs, watching: Boolean(this.watching?.active) });
  }

  stop() {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.startupTimer = undefined;
    this.timer = undefined;
    this.watching?.close();
    this.watching = undefined;
  }

  /** A manual scan covers the same ground, so its result becomes our baseline too. */
  async remember() {
    for (const library of await this.opts.libraries()) {
      this.fingerprints.set(library.id, libraryFingerprint(await library.files()));
    }
  }

  /** Forget what a library looked like, so the next eligible check runs even when its files
   *  never changed while its automatic lookup was off. */
  invalidate(libraryId: string) {
    this.fingerprints.delete(libraryId);
  }

  isWatching() { return Boolean(this.watching?.active); }

  async check(reason: AutoScanReason): Promise<boolean> {
    if (this.running || !this.opts.enabled()) return false;
    const status = this.opts.status().status;
    if (status === "running" || status === "paused") return false;
    // Nothing is gained by starting while the disk and the line are busy; the scan
    // would pause on its own and the next check picks it up.
    if (this.opts.busy()) return false;
    this.running = true;
    try {
      const libraries = await this.opts.libraries();
      const stamps = new Map<string, string>();
      const changed: string[] = [];
      for (const library of libraries) {
        const stamp = libraryFingerprint(await library.files());
        stamps.set(library.id, stamp);
        // The first check after a restart has no baseline: files may have been copied
        // in while the server was down, and a scan with nothing new to do is free.
        if (this.fingerprints.get(library.id) !== stamp) changed.push(library.id);
      }
      if (!changed.length) return false;
      const state = await this.opts.start(changed);
      // Recorded only once the scan is under way, so a start that failed on a
      // sleeping addon is tried again at the next check.
      for (const [id, stamp] of stamps) this.fingerprints.set(id, stamp);
      log("INFO", "Automatic library scan started", { reason, total: state.total, libraries: changed });
      return true;
    } catch (error) {
      log("WARN", "The automatic library scan could not start", { reason: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      this.running = false;
    }
  }
}
