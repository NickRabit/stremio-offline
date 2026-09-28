import { t } from "./i18n";
import type { AddonDownloadSettings, LibraryView } from "./types";

export type SaveKind = "movie" | "series";
export interface SaveTarget { libraryId: string; subfolder: string; layout: "structured" | "flat" }

const usable = (library: LibraryView) => library.enabled && !library.readOnly && !library.unreachable;
const takes = (library: LibraryView, kind: SaveKind) => library.type === kind || library.type === "mixed";

/** Libraries a title of this kind may be saved into: enabled, writable, reachable, type fits. */
export function offeredLibraries(libraries: LibraryView[], kind: SaveKind): LibraryView[] {
  return libraries.filter((library) => usable(library) && takes(library, kind));
}

/** Where the addon rule puts it; libraryId falls back to the library flagged defaultMovie/defaultSeries. */
export function ruleTarget(settings: AddonDownloadSettings | undefined, kind: SaveKind, libraries: LibraryView[]): Partial<SaveTarget> & { subfolder: string; layout: "structured" | "flat" } {
  const rule = settings?.[kind];
  const libraryId = rule?.libraryId
    ?? libraries.find((library) => kind === "movie" ? library.defaultMovie : library.defaultSeries)?.id;
  return { ...(libraryId ? { libraryId } : {}), subfolder: rule?.subfolder ?? "", layout: rule?.layout ?? "structured" };
}

/** Folder chain the title lands in, for display: library name, subfolder segments, then
 *  for structured layout the title folder (movie) or show folder + season folder (series). */
export function targetPreview(target: Partial<SaveTarget> & { subfolder: string; layout: "structured" | "flat" }, libraries: LibraryView[], title: string, kind: SaveKind, season?: number): string[] {
  const library = target.libraryId ? libraries.find((item) => item.id === target.libraryId) : undefined;
  const segments = [library?.name ?? t("saveTarget.defaultLibrary"), ...target.subfolder.split("/").filter(Boolean)];
  if (target.layout === "structured") {
    segments.push(title);
    if (kind === "series" && season != null) segments.push(`${String(season).padStart(2, "0")} serie`);
  }
  return segments;
}
