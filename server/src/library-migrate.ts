import { access, copyFile, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { buildLibrary, listVideos, type LibraryEntry } from "./library.js";
import { libraryPath, newLibraryId, toPosix, type LibraryRecord } from "./libraries.js";
import { SCHEMA_VERSION, type State } from "./store.js";

export interface MigrationSummary {
  migrated: boolean;
  libraryId?: string;
  /** Stored path keys rewritten with the library prefix. */
  paths: number;
  artwork: { mapped: number; removed: number };
}

const nothing = (): MigrationSummary => ({ migrated: false, paths: 0, artwork: { mapped: 0, removed: 0 } });
const artworkName = (key: string) => `${createHash("sha1").update(key).digest("hex")}.jpg`;
const ARTWORK_FRESH_MS = 60 * 60_000;

/** Runs once, before anything reads the state (see index.ts). A migrated install is
 *  recognisable by `schemaVersion`; a fresh one never gets here. */
export async function migrateStateFile(dataDir: string, downloadDir: string): Promise<MigrationSummary> {
  const file = path.join(dataDir, "state.json");
  const raw = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (raw === undefined) return nothing();
  const state = JSON.parse(raw) as State;
  if ((state.schemaVersion ?? 1) >= SCHEMA_VERSION) return nothing();

  // A rollback to an older image is realistic, so the untouched v1 file is kept.
  await copyFile(file, `${file}.v1.bak`);
  const summary = await migrateLibraries(state, { dataDir, downloadDir });
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temp, file);
  return summary;
}

/** Rewrites a v1 state in place: one library for the download directory, every stored
 *  path key prefixed with its id. No file on disk is moved or renamed. */
export async function migrateLibraries(state: State, opts: { dataDir: string; downloadDir: string }): Promise<MigrationSummary> {
  const library = await legacyLibrary(opts.downloadDir);
  const id = library.id;
  let paths = 0;
  const prefixKeys = <T>(records: Record<string, T> | undefined): Record<string, T> | undefined => {
    if (!records) return records;
    paths += Object.keys(records).length;
    return Object.fromEntries(Object.entries(records).map(([key, value]) => [libraryPath(id, toPosix(key)), value]));
  };

  state.libraryMeta = prefixKeys(state.libraryMeta);
  state.librarySuggestions = prefixKeys(state.librarySuggestions);
  state.favorites = (state.favorites ?? []).map((item) => { paths += 1; return libraryPath(id, toPosix(item)); });
  state.progress = Object.fromEntries(Object.entries(state.progress ?? {}).map(([key, value]) => {
    paths += 1;
    const path0 = key.startsWith("file:") ? key.slice(5) : value.path;
    return [
      key.startsWith("file:") ? `file:${libraryPath(id, toPosix(path0!))}` : key,
      value.path ? { ...value, path: libraryPath(id, toPosix(value.path)) } : value,
    ];
  }));
  state.libraries = [library];
  state.schemaVersion = SCHEMA_VERSION;
  // Only an existing settings blob is rewritten: creating one would make `Store.load`
  // read it as a pre-English install and flip the whole interface to Czech.
  if (state.settings) state.settings = { ...state.settings, defaultMovieLibrary: id, defaultSeriesLibrary: id };
  return { migrated: true, libraryId: id, paths, artwork: await rekeyArtwork(opts, id) };
}

async function legacyLibrary(root: string): Promise<LibraryRecord> {
  const reachable = await stat(root).then(() => true, () => false);
  const writable = reachable ? await access(root, constants.W_OK).then(() => true, () => false) : true;
  return {
    id: newLibraryId(),
    name: path.basename(root) || "Library",
    type: "mixed",
    root,
    enabled: true,
    order: 0,
    addedAt: new Date().toISOString(),
    ...(reachable ? {} : { unreachable: true }),
    ...(reachable && !writable ? { readOnly: true } : {}),
    writeArtwork: !(reachable && !writable),
  };
}

/** Thumbnails are named after the key they belong to, and the old name cannot be
 *  inverted, so the mapping is built forward from the same shapes the orphan sweep
 *  accepts. Anything left over was referenced by nothing. */
async function rekeyArtwork(opts: { dataDir: string; downloadDir: string }, libraryId: string): Promise<{ mapped: number; removed: number }> {
  const dir = path.join(opts.dataDir, "artwork");
  // `listVideos` answers an unreadable root with an empty tree, so a mount that is down
  // would make every stored thumbnail look like an orphan. Nothing is mapped and nothing
  // is removed while the root is away; the next start does the work.
  if (!await access(opts.downloadDir, constants.R_OK).then(() => true, () => false)) return { mapped: 0, removed: 0 };
  const names = new Set(await readdir(dir).catch(() => [] as string[]));
  if (!names.size) return { mapped: 0, removed: 0 };

  const files = await listVideos(opts.downloadDir);
  const entries: LibraryEntry[] = buildLibrary(files);
  const keys = new Set<string>();
  const remember = (key: string) => {
    if (!key) return;
    keys.add(key);
    const parts = key.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) keys.add(`dir:${parts.slice(0, depth).join("/")}`);
  };
  for (const entry of entries) keys.add(entry.key);
  for (const file of files) remember(file.relative);
  for (const target of await queuedTargets(opts.dataDir)) remember(target);

  let mapped = 0;
  for (const key of keys) {
    const from = artworkName(key);
    if (!names.has(from)) continue;
    const to = artworkName(key.startsWith("dir:") ? `dir:${libraryPath(libraryId, key.slice(4))}` : libraryPath(libraryId, key));
    if (from === to) continue;
    names.delete(from);
    if (names.has(to)) { await rm(path.join(dir, from), { force: true }); continue; }
    await rename(path.join(dir, from), path.join(dir, to));
    names.add(to);
    mapped += 1;
  }

  let removed = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    const info = await stat(file).catch(() => undefined);
    // The same freshness guard the sweep uses: a poster may be waiting for its file.
    if (info && Date.now() - info.mtimeMs < ARTWORK_FRESH_MS) continue;
    await rm(file, { force: true });
    removed += 1;
  }
  return { mapped, removed };
}

/** A poster is saved when the job is queued, before the source exists. */
async function queuedTargets(dataDir: string): Promise<string[]> {
  const raw = await readFile(path.join(dataDir, "downloads.json"), "utf8").catch(() => undefined);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((job) => toPosix(String((job as { target?: unknown }).target ?? ""))).filter(Boolean);
  } catch { return []; }
}
