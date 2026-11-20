import path from "node:path";
import { isPathWithin } from "./library.js";
import { knownTitleOf, type LibraryMetaRecord, type TitleUnit } from "./library-match.js";
import { isInside, libraryPath, parseLibraryPath, posixBase, sameFile, toPosix, type LibraryRecord, type LibraryType } from "./libraries.js";

export type SplitKind = "movie" | "series" | "unknown";
export type SplitBasis = "identified" | "guessed" | "none";

export interface SplitPlanItem {
  /** Library-qualified key, the form `POST /api/library/ops` takes as an item. */
  key: string;
  /** Posix path below the library root. */
  relative: string;
  /** "Name (Year)" from the binding when identified, else the last path segment. */
  label: string;
  kind: SplitKind;
  basis: SplitBasis;
  /** Present only when the item must not be moved now. */
  busy?: "download" | "operation";
}

export interface SplitPlanChild {
  id: string;
  name: string;
  type: LibraryType;
  /** Posix path of the child's root relative to the parent root, e.g. "tv-test-serialy" or "a/b". */
  relative: string;
  enabled: boolean;
  unreachable: boolean;
  readOnly: boolean;
}

export interface SplitPlanFolder {
  /** A top-level folder name directly under the parent root. */
  name: string;
  movies: number;
  series: number;
  unknown: number;
}

export interface SplitPlan {
  library: { id: string; name: string; root: string; type: LibraryType };
  counts: { movies: number; series: number; unknown: number };
  children: SplitPlanChild[];
  folders: SplitPlanFolder[];
  items: SplitPlanItem[];
}

export interface SplitPlanInput {
  library: LibraryRecord;
  /** Every configured library, the parent included. */
  libraries: LibraryRecord[];
  /** Health of a library; the route passes `healthOf`. */
  healthOf: (library: LibraryRecord) => { unreachable?: boolean; readOnly?: boolean };
  /** Every title unit across all libraries, keys library-qualified (what `libraryUnits()` returns). */
  units: TitleUnit[];
  /** `metaStore.qualifiedMeta()`. */
  records: Record<string, LibraryMetaRecord>;
  /** Library-qualified keys of the files active downloads are writing (see Busy rules). */
  downloadTargets: string[];
  /** Unit keys another library operation or reservation holds (see Busy rules). */
  operationBusy: ReadonlySet<string>;
}

function splitKind(
  unit: TitleUnit,
  libraryType: LibraryType,
  records: Record<string, LibraryMetaRecord>,
): Pick<SplitPlanItem, "label" | "kind" | "basis"> {
  const record = knownTitleOf(unit.key, records);
  if (record?.id && !record.unmatched && (record.type === "movie" || record.type === "series")) {
    return {
      label: record.name ? (record.year ? `${record.name} (${record.year})` : record.name) : posixBase(unit.relative),
      kind: record.type,
      basis: "identified",
    };
  }
  const label = posixBase(unit.relative);
  if (libraryType === "mixed" && unit.kind === "series") return { label, kind: "series", basis: "guessed" };
  if (libraryType === "movie" || libraryType === "series") return { label, kind: libraryType, basis: "guessed" };
  return { label, kind: "unknown", basis: "none" };
}

const folderCount = (folder: SplitPlanFolder, kind: SplitKind) => {
  if (kind === "movie") folder.movies += 1;
  else if (kind === "series") folder.series += 1;
  else folder.unknown += 1;
};

export function buildSplitPlan(input: SplitPlanInput): SplitPlan {
  const { library, libraries, healthOf, units, records, downloadTargets, operationBusy } = input;
  const owned = units.filter((unit) => parseLibraryPath(unit.key)?.libraryId === library.id);

  const items: SplitPlanItem[] = owned.map((unit) => {
    const busy: SplitPlanItem["busy"] = downloadTargets.some((target) => isPathWithin(target, unit.key))
      ? "download"
      : operationBusy.has(unit.key) ? "operation" : undefined;
    return {
      key: libraryPath(library.id, unit.relative),
      relative: unit.relative,
      ...splitKind(unit, library.type, records),
      ...(busy ? { busy } : {}),
    };
  }).sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { sensitivity: "base" }) || left.relative.localeCompare(right.relative));

  const children = libraries
    .filter((child) => child.id !== library.id && isInside(child.root, library.root) && !sameFile(child.root, library.root))
    .map((child) => {
      const health = healthOf(child);
      return {
        id: child.id,
        name: child.name,
        type: child.type,
        relative: toPosix(path.relative(library.root, child.root)),
        enabled: child.enabled,
        unreachable: health.unreachable ?? child.unreachable ?? false,
        readOnly: health.readOnly ?? child.readOnly ?? false,
      };
    })
    .sort((left, right) => left.relative.localeCompare(right.relative));

  const counts = { movies: 0, series: 0, unknown: 0 };
  const folderMap = new Map<string, SplitPlanFolder>();
  const childNames = new Set(children.map((child) => child.relative.split("/")[0]!));
  for (const item of items) {
    if (item.kind === "movie") counts.movies += 1;
    else if (item.kind === "series") counts.series += 1;
    else counts.unknown += 1;

    const slash = item.relative.indexOf("/");
    if (slash < 0) continue;
    const name = item.relative.slice(0, slash);
    if (childNames.has(name)) continue;
    const folder = folderMap.get(name) ?? { name, movies: 0, series: 0, unknown: 0 };
    folderCount(folder, item.kind);
    folderMap.set(name, folder);
  }

  return {
    library: { id: library.id, name: library.name, root: toPosix(library.root), type: library.type },
    counts,
    children,
    folders: [...folderMap.values()].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" })),
    items,
  };
}
