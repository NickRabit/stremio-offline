const HOURS_MINUTES = /^(\d+)\s*h(?:ours?|rs?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/i;
const MINUTES_ONLY = /^(\d+)\s*m(?:in(?:utes?)?)?$/i;
const ISO_DURATION = /^PT(?:(\d+)H)?(?:(\d+)M)?$/i;

function minutesFromText(raw: string): number | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const iso = ISO_DURATION.exec(text);
  if (iso) return Number(iso[1] ?? 0) * 60 + Number(iso[2] ?? 0);
  const hours = HOURS_MINUTES.exec(text);
  if (hours) return Number(hours[1]) * 60 + Number(hours[2] ?? 0);
  const minutes = MINUTES_ONLY.exec(text);
  if (minutes) return Number(minutes[1]);
  return undefined;
}

/** Minutes from a meta's `runtime`: a number, "85 min", "1h 25min", "1 h 25 min", "PT85M".
 *  Anything else, zero or negative is undefined. */
export function runtimeMinutes(meta: { runtime?: unknown } | null | undefined): number | undefined {
  const raw = meta?.runtime;
  const minutes = typeof raw === "number"
    ? raw
    : typeof raw === "string" ? minutesFromText(raw) : undefined;
  return minutes != null && Number.isFinite(minutes) && minutes > 0 ? minutes : undefined;
}

/** Whether a file of `seconds` is this film: |minutes - runtime| <= max(3, 6 % of runtime).
 *  The 6 % covers the PAL speed-up. */
export function runtimeFits(seconds: number, runtime: number): boolean {
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(runtime) || runtime <= 0) return false;
  const minutes = seconds / 60;
  return Math.abs(minutes - runtime) <= Math.max(3, runtime * 0.06);
}

/** The index of the only candidate that fits, or undefined. A candidate with an unknown
 *  runtime could be the one, so it blocks confirmation unless it is the only unknown and
 *  `votes` shows it at under a tenth of the fitting candidate's votes. */
export function confirmedByRuntime(seconds: number, runtimes: Array<number | undefined>, votes: number[]): number | undefined {
  const fitting = runtimes
    .map((runtime, index) => (runtime != null && runtimeFits(seconds, runtime) ? index : -1))
    .filter((index) => index >= 0);
  if (fitting.length !== 1) return undefined;
  const winner = fitting[0]!;
  const unknown = runtimes
    .map((runtime, index) => (runtime == null ? index : -1))
    .filter((index) => index >= 0);
  if (!unknown.length) return winner;
  if (unknown.length > 1) return undefined;
  const rival = unknown[0]!;
  return (votes[rival] ?? 0) < (votes[winner] ?? 0) * 0.1 ? winner : undefined;
}
