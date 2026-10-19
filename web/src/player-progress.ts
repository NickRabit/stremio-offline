import type { ProgressPayload } from "./api";

/** Under five seconds in, there is nothing worth resuming from. */
const MIN_POSITION = 5;

/** Resuming only happens further in than this, so a title barely started begins at the top. */
const RESUME_THRESHOLD = 30;

/** The report worth sending, or null while the length is unknown or playback has barely started. */
export function progressToSave(
  report: { position: number; duration: number },
  meta: Omit<ProgressPayload, "position" | "duration">,
): ProgressPayload | null {
  const { position, duration } = report;
  if (!duration || position < MIN_POSITION) return null;
  return { ...meta, position, duration };
}

/** What one saved state may resume from: a start-over never does, a watched title always
 *  begins at the top, and a position only counts when it is worth resuming and belongs to
 *  the version about to play. Anything unusable reads as the beginning. */
export function initialPlaybackPosition(
  saved: { position?: number; watched?: boolean; mediaSourceId?: string } | null | undefined,
  remoteContext: { mediaSourceId?: string } | null | undefined,
  fromBeginning?: boolean,
): number {
  if (fromBeginning) return 0;
  const position = saved?.position;
  if (typeof position !== "number" || !Number.isFinite(position) || position <= RESUME_THRESHOLD) return 0;
  if (saved?.watched) return 0;
  if (remoteContext && saved?.mediaSourceId !== remoteContext.mediaSourceId) return 0;
  return position;
}

/** The addon a catalogue position is filed under, which decides whether that addon's Continue
 *  watching and Home switches hide it. A title on the catalogue panel came from the catalogue
 *  being browsed -- unless the panel holds search results, which every searched addon answered:
 *  then it is the addon the search was narrowed to, else the addon whose stream is playing. A
 *  position filed under no addon at all passes every switch, so the stream's addon is the last
 *  word rather than nothing. */
export function panelProgressAddonKey(panel: {
  searching: boolean;
  scopeAddonKey?: string;
  catalogAddonKey?: string;
  streamAddonKey?: string;
}): string | undefined {
  if (panel.searching) return panel.scopeAddonKey || panel.streamAddonKey || undefined;
  return panel.catalogAddonKey || panel.streamAddonKey || undefined;
}
