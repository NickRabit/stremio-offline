import type { UIEvent } from "react";

/**
 * Folds a listing header away once the list has been deliberately pushed down, and brings it
 * back only on a pull towards the start. This is the same lopsided hysteresis the catalogue and
 * the library use, kept in one place so a second listing folds identically; `blocked` lets a
 * caller stop folding while the list is being restored or a player is over it.
 */
export function createCompactOnScroll(blocked: () => boolean = () => false) {
  const history = new WeakMap<HTMLElement, { top: number; travel: number; until: number }>();
  // A header opened by hand is held open for as long as the fling that followed lasts.
  let held = false;
  let idle = 0;
  const release = () => { held = false; window.clearTimeout(idle); };
  const attach = () => {
    for (const event of ["touchstart", "wheel", "keydown"]) window.addEventListener(event, release, { passive: true });
  };

  /**
   * Hiding asks for a deliberate push down and only once the list has really left its top;
   * bringing the header back asks for much more, because a thumb that drifts upward did not
   * mean to ask for it.
   */
  const compactOnScroll = (event: UIEvent<HTMLDivElement>, compact: boolean, update: (value: boolean) => void, revealOnPull = false) => {
    if (blocked()) return;
    const element = event.currentTarget;
    const top = Math.max(0, element.scrollTop);
    const previous = history.get(element) ?? { top: 0, travel: 0, until: 0 };
    const delta = top - previous.top;
    const travel = Math.sign(delta) === Math.sign(previous.travel) ? previous.travel + delta : delta;
    const now = performance.now();
    const next = top <= 32 ? false
      : travel > 56 && top > 80 ? true
      : revealOnPull && travel < -Math.max(120, element.clientHeight * 0.18) ? false
      : compact;
    const header = element.closest(".detail-panel")?.querySelector(".hero");
    const headerHeight = header?.getBoundingClientRect().height ?? 200;
    const canHide = element.scrollHeight - element.clientHeight > headerHeight + 32;
    if (held) {
      window.clearTimeout(idle);
      idle = window.setTimeout(release, 160);
    }
    const changed = !held && now >= previous.until && next !== compact && (!next || canHide);
    history.set(element, { top, travel: changed ? 0 : travel, until: changed ? now + 250 : previous.until });
    if (changed) update(next);
  };
  const hold = () => { held = true; };
  const dispose = () => {
    for (const event of ["touchstart", "wheel", "keydown"]) window.removeEventListener(event, release);
    window.clearTimeout(idle);
  };
  return { compactOnScroll, hold, attach, dispose };
}
