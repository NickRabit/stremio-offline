import { t } from "./i18n";
import type { LibraryView, SplitPlan, SplitPlanChild, SplitPlanItem } from "./types";

export const SPLIT_MOVE_CHUNK = 500;
export const SPLIT_DISMISSED_KEY = "library-split-dismissed";

export type SplitTarget =
  | { mode: "child"; id: string; name: string }
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

/** Every library the offer may name, in display order. The caller walks them, skipping the
 *  dismissed ones and those whose plan does not hold both kinds, so one library that does not
 *  qualify never hides another that does. */
export function offerCandidates(libraries: LibraryView[]): LibraryView[] {
  return libraries.filter((library) => canSplitLibrary(library) && !!library.root && !hasNestedLibrary(library, libraries));
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

export function preselectTarget(plan: SplitPlan, kind: "movie" | "series"): SplitTarget {
  const children = eligibleChildren(plan, kind);
  const typed = children.find((child) => child.type === kind);
  if (typed) return { mode: "child", id: typed.id, name: typed.name };
  const mixed = children.find((child) => child.type === "mixed");
  if (mixed) return { mode: "child", id: mixed.id, name: mixed.name };
  return { mode: "new", name: kind === "movie" ? t("split.defaultMoviesName") : t("split.defaultSeriesName") };
}

export function folderNameError(name: string, plan: SplitPlan): FolderNameError | undefined {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || /[/\\]/.test(trimmed)) return "nameInvalid";
  const lower = trimmed.toLowerCase();
  // A title sitting at the top under that name is a folder too: a library created there would adopt it.
  if (plan.folders.some((folder) => folder.name.toLowerCase() === lower)) return "nameTaken";
  if (plan.items.some((item) => firstSegment(item.relative).toLowerCase() === lower)) return "nameTaken";
  if ((plan.taken ?? []).some((taken) => taken.toLowerCase() === lower)) return "nameTaken";
  if (plan.children.some((child) => firstSegment(child.relative).toLowerCase() === lower)) return "nameTaken";
  return undefined;
}

export function sameTarget(movie: SplitTarget, series: SplitTarget): boolean {
  if (movie.mode === "child" && series.mode === "child") return movie.id === series.id;
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

export function defaultDestination(item: SplitPlanItem): SplitDestination {
  if (item.busy) return "leave";
  if (item.kind === "movie" || item.kind === "series") return item.kind;
  return "leave";
}

export function defaultDestinations(plan: SplitPlan): Record<string, SplitDestination> {
  const dest: Record<string, SplitDestination> = {};
  for (const item of plan.items) dest[item.key] = defaultDestination(item);
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

export function groupCounts(plan: SplitPlan):
  { identified: number; guessed: number; undecided: number; busy: number } {
  let identified = 0, guessed = 0, undecided = 0, busy = 0;
  for (const item of plan.items) {
    if (item.busy) { busy += 1; continue; }
    if (item.kind === "unknown") { undecided += 1; continue; }
    if (item.basis === "guessed") guessed += 1;
    else identified += 1;
  }
  return { identified, guessed, undecided, busy };
}

export function movableKeys(
  plan: SplitPlan,
  destinations: Record<string, SplitDestination>,
  kind: "movie" | "series",
): string[] {
  return movableItems(plan, destinations, kind).flatMap((item) => [item.key, ...(item.files ?? [])]);
}

/** The titles that move to `kind`'s target; `movableKeys` spells out every file they hold. */
export function movableItems(
  plan: SplitPlan,
  destinations: Record<string, SplitDestination>,
  kind: "movie" | "series",
): SplitPlanItem[] {
  return plan.items.filter((item) => !item.busy && destinations[item.key] === kind);
}

export function chunkKeys(keys: string[], size = SPLIT_MOVE_CHUNK): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += size) chunks.push(keys.slice(i, i + size));
  return chunks;
}

export function leftCount(
  plan: SplitPlan,
  destinations: Record<string, SplitDestination>,
): number {
  return plan.items.filter((item) => item.busy || destinations[item.key] === "leave").length;
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
    if (target.mode === "new") lines.push(t("split.summaryCreate", { name, path: joinLibraryRoot(parentRoot, name) }));
    else lines.push(t("split.summaryReuse", { name }));
  };
  describe(movie);
  describe(series);
  let moving = false;
  for (const kind of ["movie", "series"] as const) {
    const titles = movableItems(plan, destinations, kind);
    if (!titles.length) continue;
    moving = true;
    lines.push(t("split.summaryMove", {
      items: t("split.itemCount", { count: titles.length }),
      name: targetName(kind === "movie" ? movie : series),
    }));
  }
  if (moving) {
    lines.push(t("split.summaryRename"));
    lines.push(t("split.summaryCarry"));
  } else {
    lines.push(t("split.summaryNoMoves"));
  }
  const left = leftCount(plan, destinations);
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
