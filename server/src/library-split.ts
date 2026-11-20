import path from "node:path";
import { isPathWithin, isVideo } from "./library.js";
import { knownTitleForUnit, type LibraryMetaRecord, type TitleUnit } from "./library-match.js";
import { isInside, libraryPath, parseLibraryPath, posixBase, relativeWithin, sameFile, toPosix, type LibraryRecord, type LibraryType } from "./libraries.js";

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
  /** The title's other files lying beside `key` rather than inside it -- a second version or an
   *  extra of a film that shares a folder with other films. Library-qualified; moved with `key`. */
  files?: string[];
  /** The title is keyed by a video (a film beside others in a folder): the move job is told so
   *  for `key` and every one of `files`, since reading the title again mid-job can name the
   *  folder's film once the other films have left. */
  fileTitle?: true;
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
  /** Every name directly under the root, folders without videos and plain files included: a new
   *  folder must not take one of them. */
  taken: string[];
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
  /** The names directly under the parent root, as the route read them. */
  topNames: string[];
}

function splitKind(
  unit: TitleUnit,
  relative: string,
  libraryType: LibraryType,
  records: Record<string, LibraryMetaRecord>,
): Pick<SplitPlanItem, "label" | "kind" | "basis"> {
  // The same answer the library view gives: a loose film in a collection folder does not
  // inherit the folder's binding, so it is not filed under another film's name.
  const record = knownTitleForUnit(unit, records);
  if (record?.id && !record.unmatched && (record.type === "movie" || record.type === "series")) {
    return {
      label: record.name ? (record.year ? `${record.name} (${record.year})` : record.name) : posixBase(relative),
      kind: record.type,
      basis: "identified",
    };
  }
  const label = posixBase(relative);
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
  const { library, libraries, healthOf, units, records, downloadTargets, operationBusy, topNames } = input;
  const owned = units.filter((unit) => parseLibraryPath(unit.key)?.libraryId === library.id);

  const items: SplitPlanItem[] = owned.map((unit) => {
    // The unit cache walks library-qualified files, so `unit.relative` is the qualified key as
    // well; the path below the root is taken from the key.
    const relative = relativeWithin(library.id, unit.key);
    const key = libraryPath(library.id, relative);
    // A unit keyed by its first file names the others only in `sampleFiles`; moving the key
    // alone would leave them behind in the parent.
    const files = unit.sampleFiles
      .filter((file) => parseLibraryPath(file)?.libraryId === library.id && !isPathWithin(file, unit.key))
      .map((file) => libraryPath(library.id, relativeWithin(library.id, file)));
    const paths = [unit.key, ...files];
    const busy: SplitPlanItem["busy"] = downloadTargets.some((target) => paths.some((path) => isPathWithin(target, path)))
      ? "download"
      : paths.some((path) => operationBusy.has(path)) ? "operation" : undefined;
    return {
      key,
      relative,
      ...splitKind(unit, relative, library.type, records),
      ...(busy ? { busy } : {}),
      ...(files.length ? { files } : {}),
      ...(isVideo(posixBase(relative)) ? { fileTitle: true as const } : {}),
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
    taken: [...new Set(topNames)].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" })),
  };
}
