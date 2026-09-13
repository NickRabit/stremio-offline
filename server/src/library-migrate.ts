import { access, copyFile, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { buildLibrary, listVideos, type LibraryEntry } from "./library.js";
import { libraryPath, newLibraryId, parseLibraryPath, relativeWithin, toPosix, type LibraryRecord } from "./libraries.js";
import { writeEpisodesFile, writeLibraryFile } from "./library-meta-store.js";
import type { LibraryEpisodeRecord, LibraryMetaRecord, LibrarySuggestion } from "./library-match.js";
import { log } from "./logger.js";
import { SCHEMA_VERSION, type State } from "./store.js";

export interface MigrationSummary {
  migrated: boolean;
  libraryId?: string;
  /** Stored path keys rewritten with the library prefix. */
  paths: number;
  /** Rows of match history moved out of `state.json` into `data/library/`. */
  metadata: number;
  artwork: { mapped: number; removed: number };
}

/** The match history as every build before this one stored it: inline in `state.json`. */
type InlineState = State & {
  libraryMeta?: Record<string, LibraryMetaRecord>;
  librarySuggestions?: Record<string, LibrarySuggestion>;
  libraryEpisodes?: Record<string, LibraryEpisodeRecord>;
};

const nothing = (): MigrationSummary => ({ migrated: false, paths: 0, metadata: 0, artwork: { mapped: 0, removed: 0 } });
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
  const state = JSON.parse(raw) as InlineState;
  const legacy = (state.schemaVersion ?? 1) < SCHEMA_VERSION;
  const inline = Boolean(state.libraryMeta || state.librarySuggestions || state.libraryEpisodes);
  if (!legacy && !inline) return nothing();

  if (legacy) {
    // A rollback to an older image is realistic, so the untouched v1 file is kept.
    await copyFile(file, `${file}.v1.bak`);
  }
  // The second branch is a state the libraries build already migrated: it kept the match
  // history inline, and this build reads it from `data/library/` only.
  const summary = legacy ? await migrateLibraries(state, { dataDir, downloadDir }) : nothing();
  if (!legacy) summary.metadata = await splitInlineMetadata(state, dataDir);
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temp, file);
  return summary;
}

/** Moves the match history out of the state into `data/library/`, keyed the way those
 *  files store it: library-relative for the matches, shared for the episode rows. */
async function splitInlineMetadata(state: InlineState, dataDir: string): Promise<number> {
  const meta = state.libraryMeta ?? {};
  const suggestions = state.librarySuggestions ?? {};
  const episodes = state.libraryEpisodes ?? {};
  delete state.libraryMeta;
  delete state.librarySuggestions;
  delete state.libraryEpisodes;

  const files = new Map<string, { meta: Record<string, LibraryMetaRecord>; suggestions: Record<string, LibrarySuggestion> }>();
  const bucket = (libraryId: string) => {
    let file = files.get(libraryId);
    if (!file) { file = { meta: {}, suggestions: {} }; files.set(libraryId, file); }
    return file;
  };
  // A key without a library prefix is qualified on the way in; one with no library at
  // all has nowhere to go, and losing it silently is worse than saying so.
  const fallback = state.libraries?.[0]?.id;
  let rows = 0;
  let dropped = 0;
  const each = <T,>(records: Record<string, T>, into: (libraryId: string, relative: string, value: T) => void) => {
    for (const [key, value] of Object.entries(records)) {
      const libraryId = parseLibraryPath(key)?.libraryId ?? fallback;
      if (!libraryId) { dropped += 1; continue; }
      into(libraryId, relativeWithin(libraryId, toPosix(key)), value);
      rows += 1;
    }
  };
  each(meta, (libraryId, relative, value) => { bucket(libraryId).meta[relative] = value; });
  each(suggestions, (libraryId, relative, value) => { bucket(libraryId).suggestions[relative] = value; });
  for (const [libraryId, file] of files) await writeLibraryFile(dataDir, libraryId, file.meta, file.suggestions);
  if (Object.keys(episodes).length) await writeEpisodesFile(dataDir, episodes);
  if (dropped) log("WARN", "Library metadata rows outside any library were dropped", { rows: dropped });
  return rows;
}

/** Rewrites a v1 state in place: one library for the download directory, every stored
 *  path key prefixed with its id. No file on disk is moved or renamed. */
export async function migrateLibraries(state: InlineState, opts: { dataDir: string; downloadDir: string }): Promise<MigrationSummary> {
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
  return { migrated: true, libraryId: id, paths, metadata: await splitInlineMetadata(state, opts.dataDir), artwork: await rekeyArtwork(opts, id) };
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
