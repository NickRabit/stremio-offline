import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { dropKeyed, pinInherited, remapKeyed, type LibraryEpisodeRecord, type LibraryMetaRecord, type LibrarySuggestion } from "./library-match.js";
import { isPathWithin, remapPath } from "./library.js";
import { libraryPath, parseLibraryPath } from "./libraries.js";
import { log } from "./logger.js";

/** One library's remembered matches. Keys are library-relative, so the file reads on its
 *  own and stays valid if a library is ever re-identified. */
export interface LibraryMetaFile {
  version: number;
  meta: Record<string, LibraryMetaRecord>;
  suggestions: Record<string, LibrarySuggestion>;
}

export type MetaMutator = (file: LibraryMetaFile, episodes: Record<string, LibraryEpisodeRecord>) => void;

/** A mutator working on qualified keys, the way the path handling and the scan do. */
export type QualifiedMutator = (
  meta: Record<string, LibraryMetaRecord>,
  suggestions: Record<string, LibrarySuggestion>,
  episodes: Record<string, LibraryEpisodeRecord>,
) => void;

/** A scan accepting titles arrives in bursts, and one write per library per burst is
 *  enough. The point of the split is that a match never rewrites the whole state. */
const SAVE_DEBOUNCE_MS = 2000;

const emptyFile = (): LibraryMetaFile => ({ version: 1, meta: {}, suggestions: {} });

const records = <T,>(value: unknown): Record<string, T> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, T> : {};

const libraryDir = (dataDir: string) => path.join(dataDir, "library");
const fileIn = (dataDir: string, name: string) => path.join(libraryDir(dataDir), name);

async function writeAtomic(file: string, data: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, data, { mode: 0o600 });
  await rename(temp, file);
}

/** Written by the migration as well, which runs before any store exists. */
export const writeLibraryFile = (dataDir: string, libraryId: string, meta: Record<string, LibraryMetaRecord>, suggestions: Record<string, LibrarySuggestion>) =>
  writeAtomic(fileIn(dataDir, `${libraryId}.json`), JSON.stringify({ version: 1, meta, suggestions }, null, 2));

export const writeEpisodesFile = (dataDir: string, episodes: Record<string, LibraryEpisodeRecord>) =>
  writeAtomic(fileIn(dataDir, "episodes.json"), JSON.stringify(episodes, null, 2));

function parseFile(raw: string): LibraryMetaFile {
  const parsed = JSON.parse(raw) as Partial<LibraryMetaFile>;
  return { version: parsed.version ?? 1, meta: records<LibraryMetaRecord>(parsed.meta), suggestions: records<LibrarySuggestion>(parsed.suggestions) };
}

/** Where `state.json` used to keep the match history: one file per library, plus the
 *  episode rows, which are keyed by catalogue identity and shared by every library. */
export class LibraryMetaStore {
  private files = new Map<string, LibraryMetaFile>();
  private episodeRows: Record<string, LibraryEpisodeRecord> = {};
  private views?: { meta: Record<string, LibraryMetaRecord>; suggestions: Record<string, LibrarySuggestion> };
  private timers = new Map<string, NodeJS.Timeout>();
  private dirty = new Set<string>();
  private episodesTouched = false;
  /** Merging a row is what marks the shared file for a write; the map itself is live. */
  private readonly episodeMap = new Proxy(this.episodeRows, {
    set: (target, key, value) => { this.episodesTouched = true; Reflect.set(target, key, value); return true; },
    deleteProperty: (target, key) => { this.episodesTouched = true; return Reflect.deleteProperty(target, key); },
  });
  private readonly dataDir: string;

  constructor(dataDir = process.env.DATA_DIR ?? "/data") {
    this.dataDir = dataDir;
  }

  async load() {
    const dir = libraryDir(this.dataDir);
    await mkdir(dir, { recursive: true });
    const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".json"));
    for (const name of names) {
      const raw = await readFile(path.join(dir, name), "utf8").catch(() => undefined);
      if (raw === undefined) continue;
      try {
        if (name === "episodes.json") this.episodeRows = records<LibraryEpisodeRecord>(JSON.parse(raw));
        else this.files.set(name.slice(0, -".json".length), parseFile(raw));
      } catch (error) {
        log("WARN", "Library metadata could not be read", { file: name, reason: String(error).slice(0, 120) });
      }
    }
    this.views = undefined;
  }

  /** Match history of one library, keyed the way its file stores it. */
  meta(libraryId: string) { return this.files.get(libraryId)?.meta ?? {}; }
  suggestions(libraryId: string) { return this.files.get(libraryId)?.suggestions ?? {}; }
  episodes() { return this.episodeMap; }

  /** Qualified-path view, what the path handling and the scan consume. Memoised: it is
   *  read per browse row, and rebuilding it there would walk every library. Read only --
   *  write through `update`. */
  qualifiedMeta() { return this.view().meta; }
  qualifiedSuggestions() { return this.view().suggestions; }

  private view() {
    if (this.views) return this.views;
    const meta: Record<string, LibraryMetaRecord> = {};
    const suggestions: Record<string, LibrarySuggestion> = {};
    for (const [libraryId, file] of this.files) {
      for (const [key, value] of Object.entries(file.meta)) meta[`${libraryId}/${key}`] = value;
      for (const [key, value] of Object.entries(file.suggestions)) suggestions[`${libraryId}/${key}`] = value;
    }
    this.views = { meta, suggestions };
    return this.views;
  }

  /** Rebuilds the qualified view for one library after a write, instead of throwing the
   *  whole map away: a scan writes once per accepted unit. */
  private invalidate(libraryId: string) {
    const views = this.views;
    if (!views || !this.files.has(libraryId)) { this.views = undefined; return; }
    const prefix = `${libraryId}/`;
    for (const key of Object.keys(views.meta)) if (key.startsWith(prefix)) delete views.meta[key];
    for (const key of Object.keys(views.suggestions)) if (key.startsWith(prefix)) delete views.suggestions[key];
    const file = this.files.get(libraryId)!;
    for (const [key, value] of Object.entries(file.meta)) views.meta[`${prefix}${key}`] = value;
    for (const [key, value] of Object.entries(file.suggestions)) views.suggestions[`${prefix}${key}`] = value;
  }

  /** A qualified-path facade over the files: a read or a write lands on the file that
   *  owns the key, and every write names the library it touched. */
  private qualifiedView<T>(pick: (file: LibraryMetaFile) => Record<string, T>, touched: Set<string>): Record<string, T> {
    const at = (key: unknown, create: boolean) => {
      if (typeof key !== "string") return undefined;
      const parsed = parseLibraryPath(key);
      if (!parsed) return undefined;
      const file = create ? this.file(parsed.libraryId) : this.files.get(parsed.libraryId);
      if (!file) return undefined;
      if (create) touched.add(parsed.libraryId);
      return { libraryId: parsed.libraryId, relative: parsed.relative, records: pick(file) };
    };
    return new Proxy({} as Record<string, T>, {
      get: (_target, key) => { const found = at(key, false); return found?.records[found.relative]; },
      set: (_target, key, value) => { const found = at(key, true); if (found) found.records[found.relative] = value as T; return true; },
      deleteProperty: (_target, key) => { const found = at(key, false); if (found) { delete found.records[found.relative]; touched.add(found.libraryId); } return true; },
      has: (_target, key) => Boolean(at(key, false)),
      ownKeys: () => [...this.files].flatMap(([libraryId, file]) => Object.keys(pick(file)).map((key) => libraryPath(libraryId, key))),
      getOwnPropertyDescriptor: (_target, key) => {
        const found = at(key, false);
        return found ? { configurable: true, enumerable: true, writable: true, value: found.records[found.relative] } : undefined;
      },
    });
  }

  /** Qualified keys, per-library writes: what the scan needs, since a mutator handed the
   *  whole map would rewrite every library on every accepted match. */
  async updateQualified(mutator: QualifiedMutator) {
    const touched = new Set<string>();
    mutator(this.qualifiedView((file) => file.meta, touched), this.qualifiedView((file) => file.suggestions, touched), this.episodeMap);
    for (const libraryId of touched) { this.invalidate(libraryId); this.save(libraryId); }
    this.saveEpisodes();
  }

  /** Carries everything remembered about a path to another one. Inside a library that is a
   *  rename in place; across libraries the rows leave one file and land in the other, which
   *  is why the store owns it -- two files have to change together or the move is half done.
   *  `pin` is for a move into another folder, see `pinInherited`. */
  async relocate(from: string, to: string, pin = false) {
    const source = parseLibraryPath(from);
    const target = parseLibraryPath(to);
    if (!source || !target || !source.relative || !target.relative) return;
    const file = this.files.get(source.libraryId);
    if (!file) return;
    const pinned = pin
      ? pinInherited(file.meta, file.suggestions, source.relative, target.relative)
      : { meta: file.meta, suggestions: file.suggestions };
    if (source.libraryId === target.libraryId) {
      file.meta = remapKeyed(pinned.meta, source.relative, target.relative);
      file.suggestions = remapKeyed(pinned.suggestions, source.relative, target.relative);
    } else {
      const carried = <T,>(records: Record<string, T>) => Object.fromEntries(Object.entries(records)
        .filter(([key]) => isPathWithin(key, source.relative))
        .map(([key, value]) => [remapPath(key, source.relative, target.relative), value]));
      const meta = carried(pinned.meta);
      const suggestions = carried(pinned.suggestions);
      file.meta = dropKeyed(pinned.meta, source.relative);
      file.suggestions = dropKeyed(pinned.suggestions, source.relative);
      const destination = this.file(target.libraryId);
      // A row already at the destination path described a file that is not there any more;
      // the one arriving is the one that exists.
      destination.meta = { ...destination.meta, ...meta };
      destination.suggestions = { ...destination.suggestions, ...suggestions };
    }
    this.invalidate(source.libraryId);
    this.save(source.libraryId);
    if (source.libraryId === target.libraryId) return;
    this.invalidate(target.libraryId);
    this.save(target.libraryId);
  }

  /** Mutates one library's file. Keys inside the mutator are library-relative; merge any
   *  episode rows in the same call, through the map it is handed. */
  async update(libraryId: string, mutator: MetaMutator) {
    if (!libraryId) return;
    mutator(this.file(libraryId), this.episodeMap);
    this.invalidate(libraryId);
    this.save(libraryId);
    this.saveEpisodes();
  }

  /** Every library at once, for a write driven by catalogue identity rather than by a
   *  path -- the metadata backfill. Files the mutator left untouched are not written. */
  async updateAll(mutator: (file: LibraryMetaFile, libraryId: string, episodes: Record<string, LibraryEpisodeRecord>) => void) {
    for (const libraryId of [...this.files.keys()]) {
      const before = JSON.stringify(this.files.get(libraryId));
      mutator(this.file(libraryId), libraryId, this.episodeMap);
      if (JSON.stringify(this.files.get(libraryId)) === before) continue;
      this.invalidate(libraryId);
      this.save(libraryId);
    }
    this.saveEpisodes();
  }

  private saveEpisodes() {
    if (!this.episodesTouched) return;
    this.episodesTouched = false;
    this.save("episodes");
  }

  /** Throws one library's match history away. Only an explicit forget gets here. */
  async forget(libraryId: string) {
    const timer = this.timers.get(libraryId);
    if (timer) clearTimeout(timer);
    this.timers.delete(libraryId);
    this.dirty.delete(libraryId);
    this.files.delete(libraryId);
    this.views = undefined;
    await rm(this.fileFor(libraryId), { force: true });
  }

  private file(libraryId: string) {
    let file = this.files.get(libraryId);
    if (!file) { file = emptyFile(); this.files.set(libraryId, file); }
    return file;
  }

  private fileFor(name: string) {
    return fileIn(this.dataDir, name === "episodes" ? "episodes.json" : `${name}.json`);
  }

  private save(name: string) {
    this.dirty.add(name);
    if (this.timers.has(name)) return;
    const timer = setTimeout(() => { this.timers.delete(name); void this.write(name); }, SAVE_DEBOUNCE_MS);
    timer.unref?.();
    this.timers.set(name, timer);
  }

  private async write(name: string) {
    if (!this.dirty.delete(name)) return;
    const file = this.fileFor(name);
    const data = JSON.stringify(name === "episodes" ? this.episodeRows : (this.files.get(name) ?? emptyFile()), null, 2);
    try {
      await writeAtomic(file, data);
    } catch (error) {
      log("WARN", "Library metadata could not be saved", { file: path.basename(file), reason: String(error).slice(0, 120) });
    }
  }

  /** Called on shutdown and before an export, so nothing is lost to the debounce. */
  async flush() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.saveEpisodes();
    for (const name of [...this.dirty]) await this.write(name);
  }
}
