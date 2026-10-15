import { sourceTargetRule } from "./save-target";
import { isRemoteStream } from "./streams";
import type { AddonDownloadSettings, Stream } from "./types";

/** What the destination dialog needs for one row a detail or the player offered: the exact row,
 *  its media subject, and the destination that row's own source projects. */
export interface AlternativeSave {
  title: string;
  kind: "movie" | "series";
  stream: Stream;
  media: Record<string, unknown>;
  /** The destination the server projected for this exact source. An addon answer has none here:
   *  it takes its own addon's rule instead. */
  rule?: AddonDownloadSettings;
  /** A native copy whose server projected no destination: the viewer picks one themselves, and the
   *  server re-resolves and re-admits whatever is picked. */
  ruleUnavailable: boolean;
}

/** The copy one row is saved as: always the exact source that was clicked, with the destination
 *  only that source projects -- never another version's, and never an invented one. */
export function alternativeSaveRequest(title: string, stream: Stream, media: Record<string, unknown>, kind: "movie" | "series"): AlternativeSave {
  const rule = stream.remoteItem ? sourceTargetRule(stream) : undefined;
  return { title, kind, stream, media, ...(rule ? { rule } : {}), ruleUnavailable: isRemoteStream(stream) && rule === undefined };
}
