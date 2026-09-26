import type { RequestHandler } from "express";

/**
 * Counts the requests being answered, so a shutdown can let them finish instead of exiting
 * under a write that was already on its way. A request can arrive a moment after the signal --
 * the desktop shell stops its backend right after the page's last keepalive request left -- so
 * the count has to stay at zero for a short quiet spell, not merely touch it.
 */
export class InFlight {
  private count = 0;

  middleware(): RequestHandler {
    return (_req, res, next) => {
      this.count++;
      let done = false;
      const end = () => { if (!done) { done = true; this.count--; } };
      res.once("finish", end);
      res.once("close", end);
      next();
    };
  }

  active(): number {
    return this.count;
  }

  /** Resolves true once nothing has been in flight for `quietMs`, false when `limitMs` ran out first. */
  drained(quietMs: number, limitMs: number, pollMs = 25): Promise<boolean> {
    const deadline = Date.now() + limitMs;
    let quietSince = this.count === 0 ? Date.now() : null;
    return new Promise((resolve) => {
      const check = () => {
        const now = Date.now();
        if (this.count > 0) quietSince = null;
        else quietSince ??= now;
        if (quietSince !== null && now - quietSince >= quietMs) return resolve(true);
        if (now >= deadline) return resolve(false);
        setTimeout(check, pollMs);
      };
      check();
    });
  }
}
