import { t } from "./i18n";
import type { LibraryView, SplitPlan, SplitPlanChild, SplitPlanFolder, SplitPlanItem } from "./types";

export const SPLIT_MOVE_CHUNK = 500;
export const SPLIT_DISMISSED_KEY = "library-split-dismissed";

export type SplitTarget =
  | { mode: "child"; id: string; name: string }
  | { mode: "folder"; name: string }
  | { mode: "new"; name: string };
export type SplitDestination = "movie" | "series" | "leave";
export type FolderNameError = "nameInvalid" | "nameTaken";

export function canSplitLibrary(library: LibraryView): boolean {
  return library.type === "mixed" && library.enabled && !library.unreachable && !library.readOnly;
}

export function posixRoot(root: string): string {
  return root.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function hasNestedLibrary(library: LibraryView, libraries: LibraryView[]): boolean {
  if (!library.root) return false;
  const prefix = `${posixRoot(library.root)}/`;
  return libraries.some((other) => other.id !== library.id && !!other.root && posixRoot(other.root).startsWith(prefix));
}

export function offerCandidate(libraries: LibraryView[]): LibraryView | undefined {
  return libraries.find((library) => canSplitLibrary(library) && !!library.root && !hasNestedLibrary(library, libraries));
}

export function joinLibraryRoot(parentRoot: string, folderName: string): string {
  const backslash = parentRoot.includes("\\") && !parentRoot.includes("/");
  const sep = backslash ? "\\" : "/";
  const stripped = parentRoot.endsWith(sep) ? parentRoot.slice(0, -1) : parentRoot;
  return `${stripped}${sep}${folderName}`;
}

export function firstSegment(relative: string): string {
  return relative.replace(/\\/g, "/").split("/")[0] ?? "";
}

export function eligibleChildren(plan: SplitPlan, kind: "movie" | "series"): SplitPlanChild[] {
  return plan.children.filter((child) =>
    child.enabled && !child.unreachable && !child.readOnly && (child.type === kind || child.type === "mixed"));
}

export function eligibleFolders(plan: SplitPlan, kind: "movie" | "series"): SplitPlanFolder[] {
  return plan.folders.filter((folder) => kind === "movie"
    ? folder.movies > 0 && folder.series === 0 && folder.unknown === 0
    : folder.series > 0 && folder.movies === 0 && folder.unknown === 0);
}

export function preselectTarget(plan: SplitPlan, kind: "movie" | "series"): SplitTarget {
  const children = eligibleChildren(plan, kind);
  const typed = children.find((child) => child.type === kind);
  if (typed) return { mode: "child", id: typed.id, name: typed.name };
  const mixed = children.find((child) => child.type === "mixed");
  if (mixed) return { mode: "child", id: mixed.id, name: mixed.name };
  const folders = eligibleFolders(plan, kind);
  if (folders.length) {
    const countOf = (folder: SplitPlanFolder) => kind === "movie" ? folder.movies : folder.series;
    const best = folders.reduce((lead, folder) => countOf(folder) > countOf(lead) ? folder : lead);
    return { mode: "folder", name: best.name };
  }
  return { mode: "new", name: kind === "movie" ? t("split.defaultMoviesName") : t("split.defaultSeriesName") };
}

export function folderNameError(name: string, plan: SplitPlan): FolderNameError | undefined {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || /[/\\]/.test(trimmed)) return "nameInvalid";
  const lower = trimmed.toLowerCase();
  // A title sitting at the top under that name is a folder too: a library created there would adopt it.
  if (plan.folders.some((folder) => folder.name.toLowerCase() === lower)) return "nameTaken";
  if (plan.items.some((item) => firstSegment(item.relative).toLowerCase() === lower)) return "nameTaken";
  if (plan.children.some((child) => firstSegment(child.relative).toLowerCase() === lower)) return "nameTaken";
  return undefined;
}

export function sameTarget(movie: SplitTarget, series: SplitTarget): boolean {
  if (movie.mode === "child" && series.mode === "child") return movie.id === series.id;
  if (movie.mode === "folder" && series.mode === "folder") return movie.name.toLowerCase() === series.name.toLowerCase();
  if (movie.mode === "new" && series.mode === "new") return movie.name.trim().toLowerCase() === series.name.trim().toLowerCase();
  return false;
}

export function targetErrors(plan: SplitPlan, movie: SplitTarget, series: SplitTarget):
  { movie?: FolderNameError; series?: FolderNameError; same?: true } {
  const errors: { movie?: FolderNameError; series?: FolderNameError; same?: true } = {};
  if (movie.mode === "new") {
    const error = folderNameError(movie.name, plan);
    if (error) errors.movie = error;
  }
  if (series.mode === "new") {
    const error = folderNameError(series.name, plan);
    if (error) errors.series = error;
  }
  if (sameTarget(movie, series)) errors.same = true;
  return errors;
}

export function inPlaceFolderNames(movie: SplitTarget, series: SplitTarget): string[] {
  const names: string[] = [];
  if (movie.mode === "folder") names.push(movie.name);
  if (series.mode === "folder") names.push(series.name);
  return names;
}

export function isInPlace(item: SplitPlanItem, folderNames: string[]): boolean {
  return folderNames.some((name) => item.relative.startsWith(`${name}/`));
}

export function inPlaceFolderOf(item: SplitPlanItem, folderNames: string[]): string | undefined {
  return folderNames.find((name) => item.relative.startsWith(`${name}/`));
}

export function defaultDestination(item: SplitPlanItem, inPlace: boolean): SplitDestination {
  if (inPlace || item.busy) return "leave";
  if (item.kind === "movie" || item.kind === "series") return item.kind;
  return "leave";
}

export function defaultDestinations(plan: SplitPlan, movie: SplitTarget, series: SplitTarget): Record<string, SplitDestination> {
  const folders = inPlaceFolderNames(movie, series);
  const dest: Record<string, SplitDestination> = {};
  for (const item of plan.items) dest[item.key] = defaultDestination(item, isInPlace(item, folders));
  return dest;
}

const rowRank = (item: SplitPlanItem) => {
  if (item.busy) return 3;
  if (item.kind === "unknown") return 0;
  if (item.basis === "guessed") return 1;
  return 2;
};

export function sortedItems(plan: SplitPlan): SplitPlanItem[] {
  return plan.items.slice().sort((a, b) => rowRank(a) - rowRank(b) || a.label.localeCompare(b.label));
}

export function groupCounts(plan: SplitPlan, movie: SplitTarget, series: SplitTarget):
  { identified: number; guessed: number; undecided: number; busy: number; inPlace: number } {
  const folders = inPlaceFolderNames(movie, series);
  let identified = 0, guessed = 0, undecided = 0, busy = 0, inPlace = 0;
  for (const item of plan.items) {
    if (isInPlace(item, folders)) { inPlace += 1; continue; }
    if (item.busy) { busy += 1; continue; }
    if (item.kind === "unknown") { undecided += 1; continue; }
    if (item.basis === "guessed") guessed += 1;
    else identified += 1;
  }
  return { identified, guessed, undecided, busy, inPlace };
}

export function movableKeys(
  plan: SplitPlan,
  destinations: Record<string, SplitDestination>,
  kind: "movie" | "series",
  movie: SplitTarget,
  series: SplitTarget,
): string[] {
  const folders = inPlaceFolderNames(movie, series);
  return plan.items
    .filter((item) => !item.busy && !isInPlace(item, folders) && destinations[item.key] === kind)
    .map((item) => item.key);
}

export function chunkKeys(keys: string[], size = SPLIT_MOVE_CHUNK): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += size) chunks.push(keys.slice(i, i + size));
  return chunks;
}

export function leftCount(
  plan: SplitPlan,
  destinations: Record<string, SplitDestination>,
  movie: SplitTarget,
  series: SplitTarget,
): number {
  const folders = inPlaceFolderNames(movie, series);
  return plan.items.filter((item) => !isInPlace(item, folders) && (item.busy || destinations[item.key] === "leave")).length;
}

export function targetName(target: SplitTarget): string {
  return target.mode === "new" ? target.name.trim() : target.name;
}

export function summaryLines(
  plan: SplitPlan,
  movie: SplitTarget,
  series: SplitTarget,
  destinations: Record<string, SplitDestination>,
  defaultsOn: boolean,
  parentName: string,
  parentRoot: string,
): string[] {
  const lines: string[] = [];
  const describe = (target: SplitTarget) => {
    const name = targetName(target);
    const path = joinLibraryRoot(parentRoot, target.mode === "child" ? name : (target.mode === "new" ? name : target.name));
    if (target.mode === "new") lines.push(t("split.summaryCreate", { name, path }));
    else if (target.mode === "folder") lines.push(t("split.summaryFolder", { name, path }));
    else lines.push(t("split.summaryReuse", { name }));
  };
  describe(movie);
  describe(series);
  let moving = false;
  for (const kind of ["movie", "series"] as const) {
    const keys = movableKeys(plan, destinations, kind, movie, series);
    if (!keys.length) continue;
    moving = true;
    lines.push(t("split.summaryMove", {
      items: t("split.itemCount", { count: keys.length }),
      name: targetName(kind === "movie" ? movie : series),
    }));
  }
  if (moving) {
    lines.push(t("split.summaryRename"));
    lines.push(t("split.summaryCarry"));
  } else {
    lines.push(t("split.summaryNoMoves"));
  }
  const left = leftCount(plan, destinations, movie, series);
  if (left) lines.push(t("split.summaryLeft", { items: t("split.itemCount", { count: left }), name: parentName }));
  if (defaultsOn) lines.push(t("split.summaryDefaults", { movies: targetName(movie), series: targetName(series) }));
  lines.push(t("split.summaryParent", { name: parentName }));
  return lines;
}

export function readDismissedIds(): string[] {
  try {
    const raw = localStorage.getItem(SPLIT_DISMISSED_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function writeDismissedIds(ids: string[]): void {
  try { localStorage.setItem(SPLIT_DISMISSED_KEY, JSON.stringify(ids)); }
  catch { /* dismissed for this page only */ }
}
