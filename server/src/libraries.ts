import { realpath } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

/** `lib_` + 8 lowercase hex. Never derived from the path, never reused. */
export const LIBRARY_ID = /^lib_[0-9a-f]{8}$/;

export type LibraryType = "movie" | "series" | "mixed";

export interface LibraryRecord {
  id: string;
  name: string;
  type: LibraryType;
  /** Absolute path as the server sees it. Inside a granted root. */
  root: string;
  enabled: boolean;
  /** Display and pick order. */
  order: number;
  addedAt: string;
  /** The root was not writable at the last check. Never auto-removed. */
  readOnly?: boolean;
  /** May we drop poster.jpg next to the media here? Forced false when readOnly. */
  writeArtwork: boolean;
  /** The root could not be reached at the last check. Metadata and artwork stay. */
  unreachable?: boolean;
}

/** A library that was removed without forgetting. Its id is kept so that adding the same
 *  folder again picks up its match history, its artwork and its favourite and resume rows
 *  instead of starting from nothing. */
export interface DepartedLibrary { id: string; root: string; removedAt: string }

export const DEPARTED_MAX = 20;
export const DEPARTED_DAYS = 30;

/** What is still worth keeping: expired entries and everything past the cap are dropped, the
 *  oldest first, so the list cannot grow with every add-and-remove. */
export function activeDeparted(departed: DepartedLibrary[], now = Date.now()): DepartedLibrary[] {
  const cutoff = now - DEPARTED_DAYS * 24 * 60 * 60_000;
  return departed.filter((entry) => Date.parse(entry.removedAt) >= cutoff).slice(-DEPARTED_MAX);
}

/** The id a re-added folder takes back: the newest departed entry for the same folder, both
 *  sides through `realpath`, so two mounts of one disk are the same library. */
export async function departedIdFor(departed: DepartedLibrary[], root: string, now = Date.now()): Promise<string | undefined> {
  const absolute = path.resolve(root);
  const real = await realpath(absolute).catch(() => absolute);
  // A root that is away when it is removed can only be recorded as it was spelled, so both
  // forms count: the resolved one and the lexical one.
  return [...activeDeparted(departed, now)].reverse().find((entry) => entry.root === real || entry.root === absolute)?.id;
}

/** The part of `Settings` a default lookup needs. Kept structural so this module
 *  stays free of a store import. */
export interface DefaultLibrarySettings { defaultMovieLibrary?: string; defaultSeriesLibrary?: string }

/** A root the deployment has granted this process. Reading anything outside it is refused. */
export interface RootGrant { path: string; source: "env" | "user"; grantedAt: string }

export const newLibraryId = () => `lib_${randomBytes(4).toString("hex")}`;

const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

/** What the filesystem under this build treats as one file. macOS and Windows fold case and
 *  Linux does not, which is the difference the rename guard has to respect: changing only the
 *  case of a name is a real rename there and must not be refused as "the name is taken".
 *  `caseInsensitive` is a parameter so the rule can be tested on any runner. */
export const sameFile = (left: string, right: string, caseInsensitive = CASE_INSENSITIVE_FS) =>
  left === right || (caseInsensitive && left.toLowerCase() === right.toLowerCase());

/** Paths crossing a module boundary use `/`; `path.sep` appears only at a syscall. */
export const toPosix = (value: string) => value.split(path.sep).join("/");
export const toFs = (value: string) => value.split("/").join(path.sep);

export const posixBase = (value: string) => value.slice(value.lastIndexOf("/") + 1);
export const posixDir = (value: string) => {
  const index = value.lastIndexOf("/");
  return index < 0 ? "" : value.slice(0, index);
};
export const posixJoin = (...parts: string[]) => parts.filter(Boolean).join("/");

/** "lib_ab12cd34/Show/01 serie/01.mkv" -> the id and "Show/01 serie/01.mkv". */
export function parseLibraryPath(value: string): { libraryId: string; relative: string } | undefined {
  const trimmed = normalize(value);
  const parts = trimmed.split("/");
  if (!LIBRARY_ID.test(parts[0] ?? "")) return undefined;
  return { libraryId: parts[0]!, relative: parts.slice(1).join("/") };
}

export function libraryPath(libraryId: string, relative: string): string {
  const trimmed = normalize(relative);
  return trimmed ? `${libraryId}/${trimmed}` : libraryId;
}

/** The part of a qualified key below the library. An unqualified value comes back untouched. */
export function relativeWithin(libraryId: string, key: string): string {
  const value = normalize(key);
  if (value === libraryId) return "";
  return value.startsWith(`${libraryId}/`) ? value.slice(libraryId.length + 1) : value;
}

/** The qualified key a queued download's target belongs to. A job from before libraries
 *  carries a bare path and knows no library: the sweep has no way to say whose picture it
 *  is, so it leaves it alone rather than guessing — and never asks for a library that a
 *  multi-library install cannot single out. */
export function queuedArtworkKey(job: { target: string; libraryId?: string }): string | undefined {
  if (!job.target) return undefined;
  if (parseLibraryPath(job.target)) return job.target;
  return job.libraryId ? libraryPath(job.libraryId, job.target) : undefined;
}

export function libraryFor(libraries: LibraryRecord[], id: string): LibraryRecord | undefined {
  return libraries.find((library) => library.id === id);
}

function usable(library: LibraryRecord) {
  return library.enabled && !library.unreachable;
}

function accepts(library: LibraryRecord, wanted: LibraryType) {
  return library.type === wanted || library.type === "mixed";
}

/** Where a download lands when the addon rule names no library: the stored default,
 *  then the first enabled library of the kind, then the first enabled `mixed`. */
export function defaultLibrary(libraries: LibraryRecord[], settings: DefaultLibrarySettings, kind: "movie" | "episode"): LibraryRecord | undefined {
  const wanted: LibraryType = kind === "movie" ? "movie" : "series";
  const available = libraries.filter(usable).sort((a, b) => a.order - b.order);
  const preferred = available.find((library) => library.id === (kind === "movie" ? settings.defaultMovieLibrary : settings.defaultSeriesLibrary));
  if (preferred && accepts(preferred, wanted)) return preferred;
  return available.find((library) => library.type === wanted) ?? available.find((library) => library.type === "mixed");
}

/** Roots of other libraries that sit inside this one. The parent never walks or prunes them. */
export function carveOuts(libraries: LibraryRecord[], library: LibraryRecord): string[] {
  const root = path.resolve(library.root);
  return libraries
    .filter((other) => other.id !== library.id)
    .map((other) => ({ other, relative: toPosix(path.relative(root, path.resolve(other.root))) }))
    .filter(({ relative }) => relative !== "" && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative))
    .map(({ relative }) => relative);
}

export interface ResolvedPath {
  library: LibraryRecord;
  /** Library-relative POSIX path, `""` for the root. */
  relative: string;
  /** Qualified path: the library id, then `relative`. */
  key: string;
  absolute: string;
}

/** Resolve, guard and return the absolute filesystem path behind a wire path.
 *  An unqualified value is the single-library pass-through: it is accepted only
 *  while exactly one library is configured, so today's installs keep today's
 *  wire format. Refuses an unknown or disabled library, a dot segment, traversal
 *  out of the root, and a symlink that leaves the root. */
export async function resolveLibraryPath(libraries: LibraryRecord[], value: string): Promise<ResolvedPath | undefined> {
  const parsed = parseLibraryPath(value);
  let library: LibraryRecord | undefined;
  let relative: string;
  if (parsed) {
    library = libraryFor(libraries, parsed.libraryId);
    relative = parsed.relative;
  } else {
    if (libraries.length !== 1) return undefined;
    [library] = libraries;
    relative = normalize(value);
  }
  if (!library || !library.enabled) return undefined;
  if (relative.split("/").some((segment) => segment === "." || segment === "..")) return undefined;

  const root = path.resolve(library.root);
  const absolute = path.resolve(root, toFs(relative));
  if (!isInside(absolute, root)) return undefined;
  const [real, realRoot] = await Promise.all([realAncestor(absolute), realAncestor(root)]);
  if (!real || !realRoot) return undefined;
  if (!isInside(real, realRoot)) return undefined;
  return { library, relative, key: libraryPath(library.id, relative), absolute };
}

export function isLibraryId(value: string): boolean {
  return LIBRARY_ID.test(normalize(value));
}

/** Strip the separators that carry no meaning on the wire. */
function normalize(value: string): string {
  return toPosix(value).replace(/^\/+|\/+$/g, "");
}

/** The deepest existing ancestor of `target`, resolved. A path that does not exist yet
 *  is still guarded, through the directory it would be created in. */
export async function realAncestor(target: string): Promise<string | undefined> {
  let current = target;
  for (;;) {
    try { return await realpath(current); }
    catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

/** Containment on absolute native paths. `path.relative` handles a drive letter and a
 *  UNC root without a colon split. */
export function isInside(value: string, parent: string): boolean {
  const relative = path.relative(parent, value);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
