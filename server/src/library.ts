import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { foldPath, posixBase, posixDir, posixJoin, toFs } from "./libraries.js";

const VIDEO = new Set([".mkv", ".mp4", ".avi", ".m4v", ".mov", ".webm", ".ts", ".m2ts", ".wmv", ".flv", ".mpg", ".mpeg"]);

export interface LibraryFile {
  path: string; label: string; season: number | null; episode: number | null; size: number; modified: string;
}

/** The overview without files. A folder may hold thousands of items, so the list is fetched separately. */
export type LibraryKind = "movie" | "series" | "collection";

export interface LibrarySummary {
  key: string; kind: LibraryKind; title: string;
  fileCount: number; size: number; modified: string;
  /** The thumbnail address, when there is one. The client does not care whether it sits next to the video or in the data directory. */
  poster?: string;
  meta?: { type: string; id: string; name?: string; poster?: string; background?: string; description?: string; year?: string };
}

export interface LibraryEntry {
  /** The folder the item came from. Stable even after the title is renamed from metadata. */
  key: string;
  kind: LibraryKind;
  title: string;
  files: LibraryFile[];
  poster?: string;
  size: number;
  modified: string;
  meta?: { type: string; id: string; name?: string; poster?: string; background?: string; description?: string; year?: string };
}

/** "01 serie", "Season 2", "S03" -- the queue writes the season folder, but hand-copied files differ. */
export function parseSeason(folder: string): number | null {
  const match = /^(?:s(?:eason)?|serie|série|series|sezona|sezóna)?[\s._-]*(\d{1,3})(?:\s*(?:serie|série|season|sezona|sezóna))?$/i.exec(folder.trim())
    ?? /(?:^|\D)s(\d{1,3})(?:\D|$)/i.exec(folder.trim());
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) ? value : null;
}

/** "07 - Name", "S01E07 Name", "7." -- the episode number comes first, the rest is the name. */
export function parseEpisode(filename: string): { episode: number | null; title: string } {
  const base = filename.replace(/\.[^.]+$/, "").trim();
  const tagged = /^s\d{1,3}[\s._-]*e(\d{1,4})[\s._-]*(.*)$/i.exec(base);
  if (tagged) return { episode: Number(tagged[1]), title: tagged[2].trim() || `Epizoda ${Number(tagged[1])}` };
  const numbered = /^(\d{1,4})\s*[-–.)]?\s*(.*)$/.exec(base);
  if (numbered) {
    const episode = Number(numbered[1]);
    return { episode, title: numbered[2].trim() || `Epizoda ${episode}` };
  }
  return { episode: null, title: base };
}

const TAGGED_EPISODE = /\bs(\d{1,3})[\s._-]*e(\d{1,4})\b/i;
const CROSS_EPISODE = /\b(\d{1,2})x(\d{1,3})\b/i;

/** Season and episode of a video file: "S01E02" or "1x02" in its own name first,
 *  then a plain leading number inside a season folder. */
export function numberedEpisode(relative: string): { season: number; episode: number } | undefined {
  const base = posixBase(relative);
  if (!isVideo(base)) return undefined;
  const name = base.replace(/\.[^.]+$/, "");
  const tagged = TAGGED_EPISODE.exec(name) ?? CROSS_EPISODE.exec(name);
  if (tagged) return { season: Number(tagged[1]), episode: Number(tagged[2]) };
  const folder = posixDir(relative);
  const season = folder ? parseSeason(posixBase(folder)) : null;
  const { episode } = parseEpisode(base);
  if (season != null && episode != null) return { season, episode };
  return undefined;
}

export const isVideo = (filename: string) => VIDEO.has(path.extname(filename).toLowerCase());

/** The path must not lead outside the download directory, not even through a symlink.
 *  `relative` is a POSIX key; the separator is converted only here, at the syscall. */
export function resolveInside(root: string, relative: string): string | undefined {
  const base = path.resolve(root);
  const target = path.resolve(base, toFs(relative));
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  return target === base || target.startsWith(prefix) ? target : undefined;
}

/** The separator between key segments. Keys are POSIX on the wire; a native absolute
 *  path (the media guard) is compared through the same helper. */
const SEPARATORS = path.sep === "/" ? ["/"] : ["/", path.sep];

/** Rewrites the path of the item itself and of everything under it. */
export function remapPath(value: string, from: string, to: string): string {
  if (value === from) return to;
  return from && SEPARATORS.some((separator) => value.startsWith(`${from}${separator}`))
    ? to + value.slice(from.length)
    : value;
}

export function isPathWithin(value: string, parent: string): boolean {
  if (value === parent) return true;
  return Boolean(parent) && SEPARATORS.some((separator) => value.startsWith(`${parent}${separator}`));
}

/** True when `relative` is another library's root itself or holds one: deleting, moving or
 *  renaming it would take that library with it. */
export function holdsLibraryRoot(
  carveOuts: ReadonlySet<string> | undefined,
  relative: string,
  // Same parameter as `sameFile`, for the same reason: the rule is platform-dependent and
  // has to be testable on a runner that does not fold. Linux is one, so CI is one.
  // An absent answer means no probe reached the volume, and an unknown fold folds: folding
  // wrongly costs a delete the user has to do another way, not folding wrongly costs a
  // library that was inside the folder.
  caseInsensitive?: boolean,
): boolean {
  if (!carveOuts?.size) return false;
  const fold = caseInsensitive ?? true;
  // Folded, because on a case-folding volume `Archiv` and `archiv` are one directory: a
  // guard that compares the spellings would let the other one through, and a nested root
  // recorded in a different case than its parent's tree would not be seen at all.
  const folder = foldPath(relative, fold);
  for (const path of carveOuts) if (isPathWithin(foldPath(path, fold), folder)) return true;
  return false;
}

/** Catalogue titles nothing in the library points at once the path is deleted.
 * What another path still holds -- a series split across two folders, say -- stays:
 * deleting one of them does not mean the title left the library. */
export function orphanedCatalogKeys(meta: Record<string, { type: string; id: string }>, relative: string): Set<string> {
  const removed = new Set<string>(); const kept = new Set<string>();
  for (const [key, value] of Object.entries(meta)) {
    if (!value.id) continue;
    (isPathWithin(key, relative) ? removed : kept).add(`${value.type}:${value.id}`);
  }
  for (const key of kept) removed.delete(key);
  return removed;
}

/** Folders on the way up from a removed item that hold no video any more.
 * A folder whose last film is gone is litter, even when a subtitle or a poster stayed behind,
 * so the whole folder goes rather than an empty shell of it. Ordered deepest first.
 * A folder that holds another library is never emptied: deleting it would delete that
 * library, so the walk stops there whether or not it holds videos of its own. */
export async function emptiedFolders(root: string, relative: string, exclude?: ReadonlySet<string>): Promise<string[]> {
  const gone: string[] = [];
  let folder = posixDir(relative);
  while (folder) {
    if (!resolveInside(root, folder)) break;
    if (holdsLibraryRoot(exclude, folder)) break;
    if ((await listVideos(root, folder, 0, exclude)).length) break;
    gone.push(folder);
    folder = posixDir(folder);
  }
  return gone;
}

/** Subfolders of one folder. The destination picker lists these: unlike browsing, a folder
 *  holding no video is still somewhere an item can be moved to, so nothing is filtered out. */
export async function listFolders(root: string, relative: string, exclude?: ReadonlySet<string>): Promise<{ path: string; name: string }[]> {
  const target = resolveInside(root, relative);
  if (!target) return [];
  let entries;
  try { entries = await readdir(target, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ path: posixJoin(relative, entry.name), name: entry.name }))
    .filter((entry) => !exclude?.has(entry.path))
    .sort((a, b) => a.name.localeCompare(b.name, "cs"));
}

export type MoveProblem = "sameFolder" | "intoItself";

/** Where an item lands once it is moved into `folder` -- the root is the empty path.
 *  A folder cannot swallow itself, and a move that changes nothing is refused rather than
 *  silently renaming the item onto its own path. */
export function moveDestination(relative: string, folder: string): { path: string } | { error: MoveProblem } {
  const from = posixDir(relative);
  const target = folder === "." ? "" : folder;
  if (from === target) return { error: "sameFolder" };
  if (isPathWithin(target, relative)) return { error: "intoItself" };
  return { path: posixJoin(target, posixBase(relative)) };
}

export interface FoundFile { relative: string; size: number; modified: string }

/** A ceiling for a caller that only needs an estimate. `files` counts down and `until` is a
 *  `Date.now()` deadline; either reaching zero ends the walk where it stands. */
export interface WalkBudget { files: number; until: number }

/** Every video under root, same walk `scanLibrary` uses. Depth cap 8, skip dotfiles.
 *  `exclude` holds library-relative folders another library owns: they are never entered.
 *  `budget` bounds a walk over a tree nobody has vouched for yet (§6's add preview). */
export async function listVideos(root: string, relative = "", depth = 0, exclude?: ReadonlySet<string>, budget?: WalkBudget): Promise<FoundFile[]> {
  // The structure is the user's own: downloads/series/Show/01 serie/episode.mkv and deeper.
  if (depth > 8) return [];
  if (budget && (budget.files <= 0 || Date.now() > budget.until)) return [];
  let entries;
  try { entries = await readdir(path.join(root, toFs(relative)), { withFileTypes: true }); }
  catch { return []; }
  const found: FoundFile[] = [];
  for (const entry of entries) {
    if (budget && (budget.files <= 0 || Date.now() > budget.until)) break;
    if (entry.name.startsWith(".")) continue;
    const next = posixJoin(relative, entry.name);
    if (entry.isDirectory()) {
      if (exclude?.has(next)) continue;
      found.push(...await listVideos(root, next, depth + 1, exclude, budget));
      continue;
    }
    if (!entry.isFile() || !isVideo(entry.name)) continue;
    if (budget) budget.files -= 1;
    try {
      const info = await stat(path.join(root, toFs(next)));
      found.push({ relative: next, size: info.size, modified: info.mtime.toISOString() });
    } catch { /* the file disappeared meanwhile */ }
  }
  return found;
}

/** A cheap stamp of the whole tree. The automatic scan compares it before doing anything,
 *  so an unchanged library asks the catalogues nothing. */
export function libraryFingerprint(files: FoundFile[]): string {
  let size = 0;
  let newest = "";
  for (const file of files) {
    size += file.size;
    if (file.modified > newest) newest = file.modified;
  }
  return `${files.length}:${size}:${newest}`;
}

/** One folder is one title. Several files in it are versions or episodes of the same thing, not separate items. */
export function buildLibrary(files: FoundFile[]): LibraryEntry[] {
  const groups = new Map<string, FoundFile[]>();
  for (const file of files) {
    const parts = file.relative.split("/");
    // A file sitting in the root has no folder and stands for itself.
    const key = parts.length === 1 ? file.relative : parts[0];
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(file);
  }

  const entries: LibraryEntry[] = [...groups.entries()].map(([key, group]) => {
    const inSeason = group.some((file) => file.relative.split("/").length >= 3);
    const items: LibraryFile[] = group.map((file) => {
      const parts = file.relative.split("/");
      const filename = parts[parts.length - 1];
      const season = parts.length >= 3 ? parseSeason(parts[parts.length - 2]) : null;
      const { episode, title } = parseEpisode(filename);
      return {
        path: file.relative,
        label: inSeason ? title : filename.replace(/\.[^.]+$/, ""),
        season, episode, size: file.size, modified: file.modified,
      };
    }).sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || a.label.localeCompare(b.label, "cs"));

    return {
      key,
      // One film, a series with seasons, or a folder with a pile of files to browse.
      kind: inSeason ? "series" : items.length > 1 ? "collection" : "movie",
      title: key.replace(/\.[^.]+$/, ""),
      files: items,
      size: items.reduce((sum, item) => sum + item.size, 0),
      modified: items.map((item) => item.modified).sort().at(-1) ?? "",
    };
  });

  return entries.sort((a, b) => b.modified.localeCompare(a.modified));
}

export async function scanLibrary(root: string, exclude?: ReadonlySet<string>): Promise<LibraryEntry[]> {
  return buildLibrary(await listVideos(root, "", 0, exclude));
}

export const summarize = ({ files, ...entry }: LibraryEntry): LibrarySummary => ({ ...entry, fileCount: files.length });

/** The item's folder relative to the download root. A file in the root has no folder of its own. */
export const entryDirectory = (entry: { key: string; files: { path: string }[] }) =>
  entry.files[0]?.path.includes("/") ? entry.key : "";

/** A slice of one item's files, optionally filtered by name. */
export function pageFiles(entry: LibraryEntry, query: string, skip: number, limit: number) {
  const needle = query.trim().toLowerCase();
  const matching = needle ? entry.files.filter((file) => file.label.toLowerCase().includes(needle)) : entry.files;
  return { files: matching.slice(skip, skip + limit), total: matching.length };
}

export type LibrarySort = "name" | "added" | "size" | "random";

/** A random order has to stay the same across pages, or items would repeat.
 *  The client therefore sends a seed and the order derives from it rather than being truly random. */
const seededKey = (value: string, seed: string) => {
  let hash = 2166136261;
  for (const char of `${seed}:${value}`) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
};

export function sortFiles<T extends { label: string; size: number; modified: string; path: string; season?: number | null; episode?: number | null }>(
  files: T[], sort: LibrarySort, descending: boolean, seed = "",
): T[] {
  const list = [...files];
  const dir = descending ? -1 : 1;
  if (sort === "random") return list.sort((a, b) => seededKey(a.path, seed) - seededKey(b.path, seed));
  list.sort((a, b) => {
    if (sort === "added") return (a.modified.localeCompare(b.modified)) * dir;
    if (sort === "size") return (a.size - b.size) * dir;
    // The default order keeps episodes of a series together, otherwise it sorts by name.
    return ((a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || a.label.localeCompare(b.label, "cs")) * dir;
  });
  return list;
}

/** Describes one path as a list item. Used for the virtual favourites folder, whose items
 *  come from all over the tree. */
export async function describePath(root: string, relative: string, exclude?: ReadonlySet<string>): Promise<BrowseItem | undefined> {
  if (exclude?.has(relative)) return undefined;
  const target = resolveInside(root, relative);
  if (!target) return undefined;
  const info = await stat(target).catch(() => undefined);
  if (!info) return undefined;
  const name = posixBase(relative);
  if (info.isDirectory()) {
    const inside = await listVideos(root, relative, 0, exclude);
    if (!inside.length) return undefined;
    return {
      kind: "folder", path: relative, name, fileCount: inside.length,
      size: inside.reduce((sum, file) => sum + file.size, 0),
      modified: inside.map((file) => file.modified).sort().at(-1) ?? info.mtime.toISOString(),
    };
  }
  if (!isVideo(name)) return undefined;
  const { episode, title } = parseEpisode(name);
  return {
    kind: "file", path: relative, label: title || name.replace(/\.[^.]+$/, ""),
    season: parseSeason(posixBase(posixDir(relative))), episode,
    size: info.size, modified: info.mtime.toISOString(),
  };
}

export type LibraryMatch = "unmatched" | "matched" | "suggested" | "rejected";
export interface BrowseFolder { path: string; name: string; fileCount: number; size: number; modified: string }
export type BrowseMeta = { year?: string; description?: string; catalogName?: string; match?: LibraryMatch; skipLookup?: boolean };
export type BrowseItem =
  | ({ kind: "folder"; favorite?: boolean } & BrowseFolder & BrowseMeta)
  | ({ kind: "file"; favorite?: boolean } & LibraryFile & BrowseMeta);
/** One sorted list. Two arrays would split that order back into groups when rendered. */
export interface BrowseResult { path: string; items: BrowseItem[]; total: number }

/** Whether any video sits under this folder. Stops at the first one, unlike listVideos. */
export async function hasVideo(root: string, relative: string, exclude?: ReadonlySet<string>, depth = 0): Promise<boolean> {
  if (depth > 8) return false;
  let entries;
  try { entries = await readdir(path.join(root, toFs(relative)), { withFileTypes: true }); }
  catch { return false; }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      const next = posixJoin(relative, entry.name);
      if (exclude?.has(next)) continue;
      if (await hasVideo(root, next, exclude, depth + 1)) return true;
      continue;
    }
    if (entry.isFile() && isVideo(entry.name)) return true;
  }
  return false;
}

/** One entry of the list as returned by browseDirectory: a folder with its aggregates, a file
 *  with its size and date, or both halves carrying only what an order by name needs. */
interface MixedItem {
  path: string; label: string; size: number; modified: string;
  season?: number | null; episode?: number | null; folder?: BrowseFolder; file?: LibraryFile;
}

interface BrowseCacheEntry { complete: boolean; mtimeMs?: number; builtAt: number; mixed: MixedItem[] }

const BROWSE_CACHE_MS = 20_000;
const BROWSE_CACHE_MAX = 64;
const browseCache = new Map<string, BrowseCacheEntry>();

/** Pages 2..N of a folder should not repeat the walk page 1 already did. Entries are
 *  dropped when the folder's own mtime moves, and in any case after `BROWSE_CACHE_MS`. */
export function clearBrowseCache(): void {
  browseCache.clear();
}

const browseCacheKey = (root: string, relative: string, query: string, exclude?: ReadonlySet<string>) =>
  `${root}\u0000${relative}\u0000${query}\u0000${exclude?.size ? [...exclude].sort().join("\u0001") : ""}`;

function readBrowseCache(key: string, mtimeMs: number | undefined): BrowseCacheEntry | undefined {
  const entry = browseCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.builtAt > BROWSE_CACHE_MS || entry.mtimeMs !== mtimeMs) {
    browseCache.delete(key);
    return undefined;
  }
  return entry;
}

function writeBrowseCache(key: string, entry: BrowseCacheEntry): void {
  browseCache.delete(key);
  browseCache.set(key, entry);
  while (browseCache.size > BROWSE_CACHE_MAX) browseCache.delete(browseCache.keys().next().value!);
}

/** The folder's own entries as one unsorted list. `cheap` skips every aggregate a sort by
 *  name does not read, and leaves `size` and `modified` for the page that actually shows them. */
async function readMixed(root: string, relative: string, entries: Dirent[], needle: string,
  exclude: ReadonlySet<string> | undefined, cheap: boolean): Promise<MixedItem[]> {
  const folders: BrowseFolder[] = [];
  const files: LibraryFile[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const childRelative = posixJoin(relative, entry.name);
    if (exclude?.has(childRelative)) continue;
    if (entry.isDirectory()) {
      if (needle && !entry.name.toLowerCase().includes(needle)) continue;
      if (cheap) {
        if (!await hasVideo(root, childRelative, exclude)) continue;
        folders.push({ path: childRelative, name: entry.name, fileCount: 0, size: 0, modified: "" });
        continue;
      }
      const inside = await listVideos(root, childRelative, 0, exclude);
      if (!inside.length) continue;
      folders.push({
        path: childRelative, name: entry.name, fileCount: inside.length,
        size: inside.reduce((sum, f) => sum + f.size, 0),
        modified: inside.map((f) => f.modified).sort().at(-1) ?? "",
      });
      continue;
    }
    if (!entry.isFile() || !isVideo(entry.name)) continue;
    const label = entry.name.replace(/\.[^.]+$/, "");
    if (needle && !label.toLowerCase().includes(needle)) continue;
    const numbers = numberedEpisode(childRelative);
    if (cheap) {
      files.push({
        path: childRelative, label,
        season: numbers?.season ?? null, episode: numbers?.episode ?? null,
        size: 0, modified: "",
      });
      continue;
    }
    try {
      const info = await stat(path.join(root, toFs(childRelative)));
      files.push({
        path: childRelative, label,
        season: numbers?.season ?? null, episode: numbers?.episode ?? null,
        size: info.size, modified: info.mtime.toISOString(),
      });
    } catch { /* it disappeared in the meantime */ }
  }

  return [
    ...folders.map((folder) => ({ path: folder.path, label: folder.name, size: folder.size, modified: folder.modified, folder })),
    ...files.map((file) => ({ path: file.path, label: file.label, size: file.size, modified: file.modified, season: file.season, episode: file.episode, file })),
  ];
}

/** The contents of one folder: its subfolders and videos. It does not descend; that is what opening a folder is for. */
export async function browseDirectory(root: string, relative: string, query = "", skip = 0, limit = 60,
  sort: LibrarySort = "name", descending = false, seed = "", onlyPaths?: ReadonlySet<string>,
  exclude?: ReadonlySet<string>): Promise<BrowseResult> {
  const target = resolveInside(root, relative);
  if (!target) return { path: relative, items: [], total: 0 };
  const info = await stat(target).catch(() => undefined);
  // Ordering by date or size needs every aggregate, so those sorts walk the whole folder and
  // rely on the cache instead. A name and a random order read only the label and the path, so
  // they can leave the walk to the page that is actually returned.
  const cheap = sort === "name" || sort === "random";
  const key = browseCacheKey(root, relative, query, exclude);
  const cached = readBrowseCache(key, info?.mtimeMs);

  let mixed: MixedItem[];
  let complete: boolean;
  if (cached && (cheap || cached.complete)) {
    mixed = cached.mixed;
    complete = cached.complete;
  } else {
    let entries;
    try { entries = await readdir(target, { withFileTypes: true }); } catch { return { path: relative, items: [], total: 0 }; }
    mixed = await readMixed(root, relative, entries, query.trim().toLowerCase(), exclude, cheap);
    complete = !cheap;
    writeBrowseCache(key, { complete, mtimeMs: info?.mtimeMs, builtAt: Date.now(), mixed });
  }

  // The filter has to run before paging. Otherwise a favourite on the second page would
  // never be seen and the total would be wrong.
  const ordered = sortFiles(mixed, sort, descending, seed)
    .filter((item) => !onlyPaths || onlyPaths.has(item.path));
  const page = ordered.slice(skip, skip + limit);

  const items: BrowseItem[] = [];
  for (const item of page) {
    if (item.folder) {
      if (complete) { items.push({ kind: "folder", ...item.folder }); continue; }
      const inside = await listVideos(root, item.folder.path, 0, exclude);
      items.push({
        kind: "folder", ...item.folder,
        fileCount: inside.length,
        size: inside.reduce((sum, f) => sum + f.size, 0),
        modified: inside.map((f) => f.modified).sort().at(-1) ?? "",
      });
      continue;
    }
    const file = item.file!;
    if (complete) { items.push({ kind: "file", ...file }); continue; }
    const fileInfo = await stat(path.join(root, toFs(file.path))).catch(() => undefined);
    items.push({
      kind: "file", ...file,
      size: fileInfo?.size ?? file.size,
      modified: fileInfo?.mtime.toISOString() ?? file.modified,
    });
  }
  return { path: relative, items, total: ordered.length };
}
