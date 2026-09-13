import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { posixBase, posixDir, posixJoin, toFs } from "./libraries.js";

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
 * so the whole folder goes rather than an empty shell of it. Ordered deepest first. */
export async function emptiedFolders(root: string, relative: string): Promise<string[]> {
  const gone: string[] = [];
  let folder = posixDir(relative);
  while (folder) {
    if (!resolveInside(root, folder)) break;
    if ((await listVideos(root, folder)).length) break;
    gone.push(folder);
    folder = posixDir(folder);
  }
  return gone;
}

/** Subfolders of one folder. The destination picker lists these: unlike browsing, a folder
 *  holding no video is still somewhere an item can be moved to, so nothing is filtered out. */
export async function listFolders(root: string, relative: string): Promise<{ path: string; name: string }[]> {
  const target = resolveInside(root, relative);
  if (!target) return [];
  let entries;
  try { entries = await readdir(target, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ path: posixJoin(relative, entry.name), name: entry.name }))
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

/** Every video under root, same walk `scanLibrary` uses. Depth cap 8, skip dotfiles. */
export async function listVideos(root: string, relative = "", depth = 0): Promise<FoundFile[]> {
  // The structure is the user's own: downloads/series/Show/01 serie/episode.mkv and deeper.
  if (depth > 8) return [];
  let entries;
  try { entries = await readdir(path.join(root, toFs(relative)), { withFileTypes: true }); }
  catch { return []; }
  const found: FoundFile[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const next = posixJoin(relative, entry.name);
    if (entry.isDirectory()) { found.push(...await listVideos(root, next, depth + 1)); continue; }
    if (!entry.isFile() || !isVideo(entry.name)) continue;
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

export async function scanLibrary(root: string): Promise<LibraryEntry[]> {
  return buildLibrary(await listVideos(root));
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
export async function describePath(root: string, relative: string): Promise<BrowseItem | undefined> {
  const target = resolveInside(root, relative);
  if (!target) return undefined;
  const info = await stat(target).catch(() => undefined);
  if (!info) return undefined;
  const name = posixBase(relative);
  if (info.isDirectory()) {
    const inside = await listVideos(root, relative);
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

/** The contents of one folder: its subfolders and videos. It does not descend; that is what opening a folder is for. */
export async function browseDirectory(root: string, relative: string, query = "", skip = 0, limit = 60,
  sort: LibrarySort = "name", descending = false, seed = "", onlyPaths?: ReadonlySet<string>): Promise<BrowseResult> {
  const target = resolveInside(root, relative);
  if (!target) return { path: relative, items: [], total: 0 };
  let entries;
  try { entries = await readdir(target, { withFileTypes: true }); } catch { return { path: relative, items: [], total: 0 }; }

  const needle = query.trim().toLowerCase();
  const folders: BrowseFolder[] = [];
  const files: LibraryFile[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const childRelative = posixJoin(relative, entry.name);
    if (entry.isDirectory()) {
      const inside = await listVideos(root, childRelative);
      if (!inside.length) continue;
      if (needle && !entry.name.toLowerCase().includes(needle)) continue;
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
    try {
      const info = await stat(path.join(root, toFs(childRelative)));
      const numbers = numberedEpisode(childRelative);
      files.push({
        path: childRelative, label,
        season: numbers?.season ?? null, episode: numbers?.episode ?? null,
        size: info.size, modified: info.mtime.toISOString(),
      });
    } catch { /* it disappeared in the meantime */ }
  }

  // Folders and files are sorted as one list. Taken separately, sorting by date or size
  // would produce two independent runs one after the other.
  type Mixed = {
    path: string; label: string; size: number; modified: string;
    season?: number | null; episode?: number | null; folder?: BrowseFolder; file?: LibraryFile;
  };
  const mixed: Mixed[] = [
    ...folders.map((folder) => ({ path: folder.path, label: folder.name, size: folder.size, modified: folder.modified, folder })),
    ...files.map((file) => ({ path: file.path, label: file.label, size: file.size, modified: file.modified, season: file.season, episode: file.episode, file })),
  ];
  // The filter has to run before paging. Otherwise a favourite on the second page would
  // never be seen and the total would be wrong.
  const ordered = sortFiles(mixed, sort, descending, seed)
    .filter((item) => !onlyPaths || onlyPaths.has(item.path));
  const page = ordered.slice(skip, skip + limit);
  return {
    path: relative,
    items: page.map((item) => item.folder
      ? { kind: "folder" as const, ...item.folder }
      : { kind: "file" as const, ...item.file! }),
    total: ordered.length,
  };
}
