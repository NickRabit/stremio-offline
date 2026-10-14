import { t } from "./i18n";
import type { AddonDownloadSettings, DownloadTargetSettings, LibraryView } from "./types";

export type SaveKind = "movie" | "series";
export interface SaveTarget { libraryId: string; subfolder: string; layout: "structured" | "flat" }

const usable = (library: LibraryView) => library.enabled && !library.readOnly && !library.unreachable;
const takes = (library: LibraryView, kind: SaveKind) => library.type === kind || library.type === "mixed";

/** Libraries a title of this kind may be saved into: enabled, writable, reachable, type fits,
 *  and the account may queue a download there at all. */
export function offeredLibraries(libraries: LibraryView[], kind: SaveKind): LibraryView[] {
  return libraries.filter((library) => usable(library) && library.writable && takes(library, kind));
}

/** The rule a native media-server copy is preselected to: the destination the server projected
 *  for that exact source. Nothing is invented when there is no projection, so the choice falls
 *  back to the kind's own default and the server re-resolves the target it admits. */
export function sourceTargetRule(stream: { downloadLibraryId?: string } | null | undefined): AddonDownloadSettings | undefined {
  const libraryId = stream?.downloadLibraryId;
  if (!libraryId) return undefined;
  const entry = (): DownloadTargetSettings => ({ subfolder: "", layout: "structured", libraryId });
  return { movie: entry(), series: entry() };
}

/** Where the addon rule puts it; libraryId falls back to the library flagged defaultMovie/defaultSeries. */
export function ruleTarget(settings: AddonDownloadSettings | undefined, kind: SaveKind, libraries: LibraryView[]): Partial<SaveTarget> & { subfolder: string; layout: "structured" | "flat" } {
  const rule = settings?.[kind];
  const libraryId = rule?.libraryId
    ?? libraries.find((library) => kind === "movie" ? library.defaultMovie : library.defaultSeries)?.id;
  return { ...(libraryId ? { libraryId } : {}), subfolder: rule?.subfolder ?? "", layout: rule?.layout ?? "structured" };
}

/** The name the server gives a title's folder, tidied the way it tidies it, for comparing. */
const folderName = (value: string) => value.normalize("NFC").replace(/[\u0000-\u001f/:*?"<>|\\]/g, " ")
  .split(/\s+/).filter(Boolean).join(" ").toLowerCase();

/** Folder chain the title lands in, for display: library name, subfolder segments, then
 *  for structured layout the title folder (movie) or show folder + season folder (series).
 *  A subfolder that already is the title's folder, or its season, is not repeated, as the
 *  server does not repeat it either. */
export function targetPreview(target: Partial<SaveTarget> & { subfolder: string; layout: "structured" | "flat" }, libraries: LibraryView[], title: string, kind: SaveKind, season?: number): string[] {
  const library = target.libraryId ? libraries.find((item) => item.id === target.libraryId) : undefined;
  const segments = [library?.name ?? t("saveTarget.defaultLibrary"), ...target.subfolder.split("/").filter(Boolean)];
  if (target.layout === "structured") {
    const chain = [title, ...(kind === "series" && season != null ? [`${String(season).padStart(2, "0")} serie`] : [])];
    const picked = segments.slice(1);
    let covered = Math.min(chain.length, picked.length);
    while (covered > 0 && !picked.slice(picked.length - covered).every((segment, index) => folderName(segment) === folderName(chain[index]))) covered -= 1;
    segments.push(...chain.slice(covered));
  }
  return segments;
}
