import type { ProgressPayload } from "./api";

/** Under five seconds in, there is nothing worth resuming from. */
const MIN_POSITION = 5;

/** The report worth sending, or null while the length is unknown or playback has barely started. */
export function progressToSave(
  report: { position: number; duration: number },
  meta: Omit<ProgressPayload, "position" | "duration">,
): ProgressPayload | null {
  const { position, duration } = report;
  if (!duration || position < MIN_POSITION) return null;
  return { ...meta, position, duration };
}
