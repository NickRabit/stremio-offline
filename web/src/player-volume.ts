/** What the player is set to, remembered per device. The overlay -- and with it the `<video>` --
 *  is unmounted whenever the player closes, so the element's own volume starts from the
 *  browser's default again; this is the only place that value survives.
 *
 *  Per device on purpose: the volume belongs to the television or the phone somebody is
 *  watching on, not to the account. */
const KEY = "player-volume";

/** Anything the element can hold: a stored value outside 0-1 is a bug or a hand-edited file. */
export const clampVolume = (value: number): number =>
  (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1);

export function readVolume(): number {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === null || stored.trim() === "") return 1;
    return clampVolume(Number(stored));
  } catch { return 1; }
}

export function writeVolume(value: number): void {
  try { localStorage.setItem(KEY, String(clampVolume(value))); } catch { /* private mode may forbid storage */ }
}
