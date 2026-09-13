import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SearchResult } from "./addons.js";
import { log } from "./logger.js";
import {
  autoAccept, cacheFieldsFromMeta, episodesFromMeta, knownTitleOf, lookupSkipped, needsRefresh, pickSuggestion, scanMiss,
  scannedRecently, scanSkipReason, scoreHit,
  type LibraryEpisodeRecord, type LibraryMetaRecord, type LibrarySuggestion, type TitleUnit,
} from "./library-match.js";
import { parseMediaPath } from "./library-parse.js";
import { parseLibraryPath } from "./libraries.js";
import { isPathWithin, type FoundFile } from "./library.js";
import type { AddonRecord, MetaItem } from "./types.js";

export type ScanStatus = "idle" | "running" | "paused" | "completed" | "failed";
export type ScanPauseReason = "playback" | "download" | "breaker";

export interface ScanState {
  status: ScanStatus;
  pauseReason?: ScanPauseReason;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  total: number;
  done: number;
  matched: number;
  skipped: number;
  failed: number;
  current?: string;
  remaining: string[];
  error?: string;
  /** Set when the run covers one item instead of the whole library. */
  scope?: string;
  /** Set when the run covers one library. The id is segment zero of every key, so this
   *  is the same prefix filter a single item uses, one level up. */
  libraryId?: string;
}

export interface LibraryScanOpts {
  dataDir: string;
  /** The walk is the host's: it spans libraries and knows each one's type, so the
   *  scan asks for units instead of building them from a single root. */
  units: () => Promise<TitleUnit[]>;
  searchAll: (addons: AddonRecord[], query: string, type?: string) => Promise<Pick<SearchResult, "items">>;
  metadata: (addons: AddonRecord[], type: string, id: string) => Promise<MetaItem | null>;
  addons: () => AddonRecord[];
  libraryMeta: () => Record<string, LibraryMetaRecord>;
  librarySuggestions: () => Record<string, LibrarySuggestion>;
  updateMeta: (mutator: (
    meta: Record<string, LibraryMetaRecord>,
    suggestions: Record<string, LibrarySuggestion>,
    episodes: Record<string, LibraryEpisodeRecord>,
  ) => void) => Promise<void>;
  savePoster: (key: string, url: string | undefined) => void;
  deleteGeneratedArt: (key: string) => Promise<void>;
  busy: () => ScanPauseReason | undefined;
  /** A key is qualified, so the scan cannot build a path from one root: the host resolves it. */
  pathExists: (key: string) => Promise<boolean>;
  /** Libraries the interface touched since the last run. Only those pay for the
   *  metadata refresh: a two-thousand-title archive nobody looks at does not. */
  browsed?: () => ReadonlySet<string>;
  /** Age at which a bound series is re-fetched; `0` switches the pass off. */
  metaTtlMs?: number;
  gapMs?: number;
  wakeMs?: number;
}

const idle = (): ScanState => ({
  status: "idle", total: 0, done: 0, matched: 0, skipped: 0, failed: 0, remaining: [],
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const nowIso = () => new Date().toISOString();

function addonPrefixes(addons: AddonRecord[]): string[] {
  const prefixes: string[] = [];
  for (const addon of addons.filter((item) => item.enabled && item.role !== "source")) {
    prefixes.push(...(addon.manifest.idPrefixes ?? []));
    for (const resource of addon.manifest.resources ?? []) {
      if (typeof resource !== "string") prefixes.push(...(resource.idPrefixes ?? []));
    }
  }
  return [...new Set(prefixes)];
}

function idForPrefix(raw: string, prefixes: string[], needle: string): string | undefined {
  const matching = prefixes.filter((prefix) => prefix.toLowerCase().includes(needle));
  if (!matching.length) return undefined;
  const prefix = matching[0]!;
  if (raw.startsWith(prefix)) return raw;
  return prefix.endsWith(":") ? `${prefix}${raw}` : `${prefix}:${raw}`;
}

export class LibraryScan {
  private state: ScanState = idle();
  private units = new Map<string, TitleUnit>();
  /** Keys whose turn re-reads an existing binding instead of looking for a match. */
  private readonly refreshing = new Set<string>();
  private readonly stateFile: string;
  private readonly gapMs: number;
  private readonly wakeMs: number;
  private readonly metaTtlMs: number;
  private saveChain: Promise<void> = Promise.resolve();
  private pumpScheduled = false;
  private cancelled = false;
  private readonly pathExists: (relative: string) => Promise<boolean>;

  constructor(private readonly opts: LibraryScanOpts) {
    this.stateFile = path.join(opts.dataDir, "library-scan.json");
    this.gapMs = opts.gapMs ?? 3_000;
    this.wakeMs = opts.wakeMs ?? 15_000;
    this.metaTtlMs = opts.metaTtlMs ?? 14 * 24 * 60 * 60_000;
    this.pathExists = opts.pathExists;
  }

  snapshot(): ScanState { return { ...this.state, remaining: [...this.state.remaining] }; }

  async load() {
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    try {
      const loaded = JSON.parse(await readFile(this.stateFile, "utf8")) as ScanState;
      if (loaded && typeof loaded === "object" && Array.isArray(loaded.remaining)) this.state = { ...idle(), ...loaded };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log("ERROR", "The library scan state was unreadable, starting idle", { reason: error instanceof Error ? error.message : String(error) });
        this.state = idle();
      }
    }
    if (this.state.status === "running" || this.state.status === "paused") {
      await this.refreshUnits();
      // An upgrade qualifies the unit keys, and a run that was interrupted before it would
      // resume against keys the walk no longer produces: every entry would miss and the
      // interface would watch a whole library being skipped. Nothing to resume, start over.
      if (this.state.remaining.length && !this.state.remaining.some((key) => this.units.has(key))) {
        log("WARN", "The library scan state names no item of any library, starting idle");
        this.state = idle();
        await this.save();
        return;
      }
      this.schedulePump();
    }
  }

  /** `force` throws away the memory of earlier fruitless searches and asks the
   *  catalogues about every unbound title again. */
  /** `force` throws away the memory of earlier fruitless searches; `path` narrows the
   *  run to one item, which the interface uses for "find metadata" on a single title. */
  async start({ force = false, path: scope = "", libraryId }: { force?: boolean; path?: string; libraryId?: string } = {}): Promise<ScanState> {
    if (this.state.status === "running" || this.state.status === "paused") return this.snapshot();
    const units = await this.opts.units();
    this.units = new Map(units.map((unit) => [unit.key, unit]));
    this.refreshing.clear();
    this.cancelled = false;
    const browsed = this.opts.browsed?.() ?? new Set<string>();
    const records = this.opts.libraryMeta();
    const suggestions = this.opts.librarySuggestions();
    const inRun = (unit: TitleUnit) => {
      if (libraryId && !isPathWithin(unit.key, libraryId)) return false;
      if (!scope) return true;
      return isPathWithin(unit.key, scope) || isPathWithin(scope, unit.key);
    };
    const wanted = units.filter(inRun);
    // Asking for one item is a deliberate act, so it ignores the searched-in-vain memory.
    const again = force || Boolean(scope);
    const queued = wanted.filter((unit) => {
      if (lookupSkipped(unit.key, records) || scanSkipReason(records[unit.key]) || knownTitleOf(unit.key, records)?.id) return false;
      return again || !scannedRecently(suggestions[unit.key]);
    });
    const refreshing = this.metaTtlMs > 0 && !scope
      ? wanted.filter((unit) => {
        // The binding has to sit on the item itself: an inherited one belongs to the
        // folder above, which is refreshed on its own turn when it holds videos.
        const record = records[unit.key];
        const owner = parseLibraryPath(unit.key)?.libraryId;
        return Boolean(record?.id && owner && browsed.has(owner) && needsRefresh(record, this.metaTtlMs));
      })
      : [];
    const pending = queued.map((unit) => unit.key);
    // A refresh for a title that is also queued for a first match would ask twice.
    for (const unit of refreshing) {
      if (pending.includes(unit.key)) continue;
      this.refreshing.add(unit.key);
      pending.push(unit.key);
    }
    if (again) await this.opts.updateMeta((_meta, current) => { for (const unit of wanted) delete current[unit.key]; });
    this.state = {
      status: "running",
      startedAt: nowIso(),
      updatedAt: nowIso(),
      total: queued.length,
      done: 0, matched: 0, skipped: 0, failed: 0,
      remaining: pending,
      current: pending[0],
      ...(scope ? { scope } : {}),
      ...(libraryId ? { libraryId } : {}),
    };
    await this.save();
    log("INFO", "Library scan started", { total: pending.length, titles: units.length, force, refresh: refreshing.length, ...(scope ? { path: scope } : {}), ...(libraryId ? { libraryId } : {}) });
    this.schedulePump();
    return this.snapshot();
  }

  async stop() {
    this.cancelled = true;
    this.state = { ...idle(), updatedAt: nowIso() };
    await this.save();
  }

  private async refreshUnits() {
    this.units = new Map((await this.opts.units()).map((unit) => [unit.key, unit]));
  }

  private schedulePump() {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    void this.runLoop().finally(() => { this.pumpScheduled = false; });
  }

  private async runLoop() {
    try {
      while (!this.cancelled && (this.state.status === "running" || this.state.status === "paused")) {
        const reason = this.opts.busy();
        if (reason) {
          if (this.state.status !== "paused" || this.state.pauseReason !== reason) {
            this.state.status = "paused";
            this.state.pauseReason = reason;
            await this.save();
            log("INFO", "Library scan paused", { reason });
          }
          await sleep(this.wakeMs);
          continue;
        }
        if (this.state.status === "paused") {
          this.state.status = "running";
          delete this.state.pauseReason;
          await this.save();
        }
        const key = this.state.remaining[0];
        if (!key) {
          this.state.status = "completed";
          this.state.finishedAt = nowIso();
          delete this.state.current;
          await this.save();
          log("INFO", "Library scan completed", { matched: this.state.matched, skipped: this.state.skipped, failed: this.state.failed });
          return;
        }
        this.state.current = key;
        await this.save();
        await this.processUnit(key);
      }
    } catch (error) {
      this.state.status = "failed";
      this.state.error = error instanceof Error ? error.message : String(error);
      await this.save();
      log("WARN", "Library scan failed", { reason: this.state.error });
    }
  }

  private async processUnit(key: string) {
    let addonCall = false;
    try {
      const unit = this.units.get(key);
      if (!unit || !await this.pathExists(key)) { await this.finishUnit("skipped"); return; }
      const refresh = this.refreshing.has(key);
      const records = this.opts.libraryMeta();
      const bound = records[key];
      // A refresh is the one turn allowed to ask about a binding that already exists.
      if (!refresh && (lookupSkipped(key, records) || scanSkipReason(records[key]) || knownTitleOf(key, records)?.id)) { await this.finishUnit("skipped"); return; }

      const parsed = parseMediaPath(key);
      if (this.opts.busy()) { delete this.state.current; return; }
      this.refreshing.delete(key);

      if (refresh && bound?.id) { addonCall = true; await this.refreshBinding(key, bound); return; }

      const identified = await this.identify(unit, parsed);
      addonCall = identified.called;

      if (identified.accept) {
        const item = identified.accept.item;
        const meta = await this.opts.metadata(this.opts.addons(), item.type, item.id);
        addonCall = true;
        const fields = cacheFieldsFromMeta(meta ?? item);
        const episodeRows = episodesFromMeta(meta ?? item);
        let wrote = false;
        await this.opts.updateMeta((metaMap, suggestions, episodes) => {
          const known = metaMap[key];
          if (lookupSkipped(key, metaMap) || scanSkipReason(metaMap[key]) || knownTitleOf(key, metaMap)?.id) return;
          metaMap[key] = {
            ...known,
            type: item.type, id: item.id, source: "scan", locked: false,
            matchedAt: nowIso(), backfilledAt: nowIso(), ...fields,
          };
          Object.assign(episodes, episodeRows);
          delete suggestions[key];
          wrote = true;
        });
        if (!wrote) { await this.finishUnit("skipped"); return; }
        if (!this.opts.busy()) {
          await this.opts.deleteGeneratedArt(key);
          this.opts.savePoster(key, (meta ?? item).poster);
        }
        log("INFO", "Library title matched", { key, type: item.type, id: item.id, source: "scan" });
        await this.finishUnit("matched");
        return;
      }

      // Either way the unit is remembered as searched, so a later scan can walk
      // past it instead of asking the catalogues the same question again.
      const outcome = identified.suggestion
        ? { ...identified.suggestion, scannedAt: nowIso() }
        : scanMiss(unit.kind);
      await this.opts.updateMeta((_metaMap, suggestions) => { suggestions[key] = outcome; });
      await this.finishUnit("skipped");
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : String(error);
      log("WARN", "Library scan unit failed", { key, reason: this.state.error });
      await this.finishUnit("failed");
    } finally {
      if (addonCall && this.gapMs) await sleep(this.gapMs);
    }
  }

  private finishUnit(kind: "matched" | "skipped" | "failed") {
    const key = this.state.current;
    this.state[kind] += 1;
    this.state.done += 1;
    this.state.remaining = this.state.remaining.filter((item) => item !== key);
    delete this.state.current;
    return this.save();
  }

  /** A refresh is one exact metadata call about the id the binding already has: no search
   *  and no scoring. A lookup that comes back empty leaves the binding exactly as it was,
   *  and the poster it already has is kept either way. */
  private async refreshBinding(key: string, bound: LibraryMetaRecord) {
    const meta = await this.opts.metadata(this.opts.addons(), bound.type, bound.id);
    if (!meta) {
      log("WARN", "Library binding refresh found nothing", { key, id: bound.id });
      await this.finishUnit("skipped");
      return;
    }
    const fields = cacheFieldsFromMeta(meta);
    const episodeRows = episodesFromMeta(meta);
    let wrote = false;
    await this.opts.updateMeta((metaMap, suggestions, episodes) => {
      // The binding may have been unmatchd or replaced while the call was in flight, and
      // a refresh never creates one.
      if (metaMap[key]?.id !== bound.id) return;
      metaMap[key] = { ...metaMap[key], ...fields, backfilledAt: nowIso(), refreshedAt: nowIso() };
      Object.assign(episodes, episodeRows);
      delete suggestions[key];
      wrote = true;
    });
    if (wrote) log("INFO", "Library binding refreshed", { key, type: bound.type, id: bound.id, source: "scan" });
    await this.finishUnit("skipped");
  }

  private async identify(unit: TitleUnit, parsed: ReturnType<typeof parseMediaPath>) {
    const addons = this.opts.addons();
    const imdb = parsed.providerHints?.imdb;
    if (imdb) {
      const meta = await this.opts.metadata(addons, unit.kind, imdb)
        ?? await this.opts.metadata(addons, unit.kind === "movie" ? "series" : "movie", imdb);
      return { called: true, accept: meta ? { item: { ...meta, type: meta.type || unit.kind }, score: 100, titleSimilarity: 1, autoEligible: true } : undefined };
    }
    const prefixes = addonPrefixes(addons);
    const tmdbId = parsed.providerHints?.tmdb ? idForPrefix(parsed.providerHints.tmdb, prefixes, "tmdb") : undefined;
    const tvdbId = parsed.providerHints?.tvdb ? idForPrefix(parsed.providerHints.tvdb, prefixes, "tvdb") : undefined;
    const prefixed = tmdbId ?? tvdbId;
    if (prefixed) {
      const meta = await this.opts.metadata(addons, unit.kind, prefixed);
      if (meta) return { called: true, accept: { item: { ...meta, type: meta.type || unit.kind }, score: 100, titleSimilarity: 1, autoEligible: true } };
    }
    // Global-search opt-outs do not affect library matching.
    const found = await this.opts.searchAll(addons, parsed.query, unit.kind);
    const hits = found.items.filter((item) => item.name).map((item) => scoreHit(parsed, item, unit.kind));
    return { called: true, accept: autoAccept(hits), suggestion: pickSuggestion(hits) };
  }

  private save() {
    this.state.updatedAt = nowIso();
    const snapshot = this.snapshot();
    this.saveChain = this.saveChain.then(async () => {
      await mkdir(path.dirname(this.stateFile), { recursive: true });
      const temp = `${this.stateFile}.tmp`;
      await writeFile(temp, JSON.stringify(snapshot), { mode: 0o600 });
      await rename(temp, this.stateFile);
    }).catch((error) => {
      log("WARN", "The library scan state could not be saved", { reason: error instanceof Error ? error.message : String(error) });
    });
    return this.saveChain;
  }
}
