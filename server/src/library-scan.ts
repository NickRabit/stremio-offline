import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";
import {
  autoAccept, cacheFieldsFromMeta, episodesFromMeta, knownTitleForUnit, lookupSkipped, needsRefresh, pickSuggestion, scanMiss,
  scannedRecently, scanSkipReason, scoreHit, viewMeta, yearFromMeta, MATCH_RULE_VERSION, needsReevaluation, parseUnit,
  SUGGESTION_MIN_SCORE,
  type LibraryEpisodeRecord, type LibraryMetaRecord, type LibrarySuggestion, type SuggestionReason, type TitleKind, type TitleUnit,
  type ScoredHit,
} from "./library-match.js";
import type { LibraryCandidate, LibraryCandidateSource } from "./library-candidates.js";
import type { ParsedMedia } from "./library-parse.js";
import { confirmedByEpisodes, diskEpisodes, episodeEvidence, type CatalogueEpisode, type EpisodeEvidence } from "./library-episodes.js";
import { parseLibraryPath } from "./libraries.js";
import { isPathWithin, type FoundFile } from "./library.js";
import type { MediaInfo } from "./naming.js";
import type { AddonRecord, MetaItem } from "./types.js";

export type ScanStatus = "idle" | "running" | "paused" | "completed" | "failed";
export type ScanPauseReason = "playback" | "download" | "breaker" | "operation";

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
  /** Set when the run was started by the automatic scanner rather than a person. */
  automatic?: boolean;
  /** The libraries an automatic run is confined to. Persisted so a resume keeps its scope. */
  libraryIds?: string[];
  /** Set when the run rechecks existing automatic bindings instead of looking for new ones. */
  recheck?: boolean;
  /** What the run decided, split the way the review list reads it. */
  accepted?: number;
  proposed?: number;
  missed?: number;
  excluded?: number;
  /** The matching rules this run applied. Kept with the run for diagnostics; whether the
   *  remembered rows still owe a pass is read from the rows themselves. */
  ruleVersion?: number;
  /** A bounded trail of what the run decided and why, newest last. No credentials. */
  diagnostics?: ScanDiagnostic[];
}

/** One structured line of what the scan did with one identity unit. */
export interface ScanDiagnostic {
  unit: string;
  kind: TitleKind;
  decision: "accepted" | "proposed" | "missed" | "excluded" | "failed";
  query: string;
  querySource: "provider-hint" | "search";
  provider?: string;
  candidateId?: string;
  candidateName?: string;
  titleSimilarity?: number;
  yearDelta?: number;
  partConflict?: boolean;
  alternatives?: Array<{ id: string; name: string; score: number }>;
  reason?: SuggestionReason;
  at: string;
}

/** The diagnostics a run keeps before the oldest is dropped. Bounded so the state file
 *  cannot grow with the library. */
const DIAGNOSTIC_LIMIT = 50;

export interface LibraryScanOpts {
  dataDir: string;
  /** The walk is the host's: it spans libraries and knows each one's type, so the
   *  scan asks for units instead of building them from a single root. */
  units: () => Promise<TitleUnit[]>;
  /** The trusted providers only: TMDB when it is configured, then the installed Cinemeta. */
  candidates: LibraryCandidateSource;
  metadata: (addons: AddonRecord[], type: string, id: string) => Promise<MetaItem | null>;
  addons: () => AddonRecord[];
  /** The language the interface reads, which TMDB is asked in. */
  language?: () => string;
  libraryMeta: () => Record<string, LibraryMetaRecord>;
  librarySuggestions: () => Record<string, LibrarySuggestion>;
  updateMeta: (mutator: (
    meta: Record<string, LibraryMetaRecord>,
    suggestions: Record<string, LibrarySuggestion>,
    episodes: Record<string, LibraryEpisodeRecord>,
  ) => void) => Promise<void>;
  savePoster: (key: string, url: string | undefined, backdrop?: string) => void;
  /** Alternate artwork of a title whose selected metadata carried a gallery. */
  saveGallery?: (key: string, pictures: NonNullable<MediaInfo["gallery"]>) => void;
  /** Fills a missing wide variant of an entry the run walks. The host queues it like any other
   *  artwork job, so a rescan backfills the library without waiting for a browse. */
  fillWideArtwork?: (key: string) => void;
  deleteGeneratedArt: (key: string) => Promise<void>;
  busy: () => ScanPauseReason | undefined;
  /** A key is qualified, so the scan cannot build a path from one root: the host resolves it. */
  pathExists: (key: string) => Promise<boolean>;
  /** Whether an automatic run may still look up metadata for this library. Asked before
   *  each queued item, so a switch thrown mid-run keeps the rest of its queue out. */
  automaticLibraryEnabled: (libraryId: string) => boolean;
  /** Libraries the interface touched since the last run. Only those pay for the
   *  metadata refresh: a two-thousand-title archive nobody looks at does not. */
  browsed?: () => ReadonlySet<string>;
  /** Age at which a bound series is re-fetched; `0` switches the pass off. */
  metaTtlMs?: number;
  /** Runs after a run reaches "completed", while its result is still the current one.
   *  The host uses it to reconcile the saved proposals against the tree the run walked. */
  onCompleted?: () => void | Promise<void>;
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

/** A binding a recheck may revisit: one the scan itself made, unlocked, and not an item
 *  somebody told the scanner to leave alone. */
function recheckable(record?: LibraryMetaRecord): boolean {
  const viewed = viewMeta(record);
  return Boolean(viewed?.id) && viewed!.source === "scan" && viewed!.locked === false && record?.skipLookup !== true;
}

function catalogueEpisodes(meta: MetaItem | null | undefined): CatalogueEpisode[] {
  if (!Array.isArray(meta?.videos)) return [];
  const out: CatalogueEpisode[] = [];
  for (const video of meta.videos) {
    const season = Number(video.season);
    const episode = Number(video.episode);
    if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;
    const name = video.name ?? video.title;
    out.push({ season, episode, ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}) });
  }
  return out;
}

export class LibraryScan {
  private state: ScanState = idle();
  private units = new Map<string, TitleUnit>();
  /** Entries this run has to ask for a wide variant, until it is allowed to work. */
  private eagerWide: string[] = [];
  /** Keys whose turn re-reads an existing binding instead of looking for a match. */
  private readonly refreshing = new Set<string>();
  /** Keys whose turn re-reads an automatic binding and may propose a correction. */
  private readonly rechecking = new Set<string>();
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
    // No blanket pause: the trusted providers answer one request at a time, and TMDB's own
    // Retry-After is what paces a refused scan. `LIBRARY_SCAN_GAP_MS` still overrides it.
    this.gapMs = opts.gapMs ?? 0;
    this.wakeMs = opts.wakeMs ?? 15_000;
    this.metaTtlMs = opts.metaTtlMs ?? 14 * 24 * 60 * 60_000;
    this.pathExists = opts.pathExists;
  }

  snapshot(): ScanState {
    return {
      ...this.state,
      remaining: [...this.state.remaining],
      ...(this.state.diagnostics ? { diagnostics: [...this.state.diagnostics] } : {}),
    };
  }

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
      this.rechecking.clear();
      if (this.state.recheck) {
        const records = this.opts.libraryMeta();
        for (const key of this.state.remaining) if (recheckable(records[key])) this.rechecking.add(key);
      }
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
  async start({ force = false, path: scope = "", libraryId, automatic = false, libraryIds = [], recheckScanBindings = false }: {
    force?: boolean; path?: string; libraryId?: string; automatic?: boolean; libraryIds?: string[]; recheckScanBindings?: boolean;
  } = {}): Promise<ScanState> {
    // An automatic call always names the libraries that changed. An empty list is a caller
    // mistake, and reading it as "every library" is the one thing it must never mean.
    if (automatic && !libraryIds.length) {
      log("WARN", "An automatic library scan named no library, so nothing was scanned");
      return this.snapshot();
    }
    // A recheck is about one library's existing bindings; without a library to scope it to
    // it would either mean every library or nothing, and neither is what was asked for.
    const recheck = recheckScanBindings && Boolean(libraryId);
    if (recheckScanBindings && !libraryId) {
      log("WARN", "An automatic-match recheck named no library, so nothing was rechecked");
      return this.snapshot();
    }
    if (this.state.status === "running" || this.state.status === "paused") return this.snapshot();
    const units = await this.opts.units();
    this.units = new Map(units.map((unit) => [unit.key, unit]));
    this.refreshing.clear();
    this.rechecking.clear();
    this.cancelled = false;
    const browsed = this.opts.browsed?.() ?? new Set<string>();
    const records = this.opts.libraryMeta();
    const suggestions = this.opts.librarySuggestions();
    const automaticIds = new Set(libraryIds);
    const inRun = (unit: TitleUnit) => {
      if (automatic && !automaticIds.has(parseLibraryPath(unit.key)?.libraryId ?? "")) return false;
      if (libraryId && !isPathWithin(unit.key, libraryId)) return false;
      if (!scope) return true;
      return isPathWithin(unit.key, scope) || isPathWithin(scope, unit.key);
    };
    const wanted = units.filter(inRun);
    // Asking for one item is a deliberate act, so it ignores the searched-in-vain memory.
    const again = force || Boolean(scope);
    const queued = wanted.filter((unit) => {
      if (lookupSkipped(unit.key, records)) return false;
      if (recheck) return recheckable(records[unit.key]);
      if (scanSkipReason(records[unit.key]) || knownTitleForUnit(unit, records)?.id) return false;
      // A row the current rules have not seen is reconsidered once, so a rule change
      // does not need a full rescan on every startup.
      return again || !scannedRecently(suggestions[unit.key]) || needsReevaluation(suggestions[unit.key]);
    });
    const refreshing = this.metaTtlMs > 0 && !scope && !recheck
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
    // Only fill wide art for titles this run will actually search or refresh. A rule upgrade
    // must not queue artwork across an entire library just because it walks the tree.
    this.eagerWide = pending.slice();
    if (recheck) for (const unit of queued) this.rechecking.add(unit.key);
    // A recheck keeps the binding and the suggestion it already has: what it adds is a
    // correction beside them, never a proposal that replaced them before anybody looked.
    if (again && !recheck) await this.opts.updateMeta((_meta, current) => { for (const unit of wanted) delete current[unit.key]; });
    this.state = {
      status: "running",
      startedAt: nowIso(),
      updatedAt: nowIso(),
      total: queued.length,
      done: 0, matched: 0, skipped: 0, failed: 0,
      accepted: 0, proposed: 0, missed: 0, excluded: 0,
      ruleVersion: MATCH_RULE_VERSION,
      diagnostics: [],
      remaining: pending,
      current: pending[0],
      ...(scope ? { scope } : {}),
      ...(libraryId ? { libraryId } : {}),
      ...(automatic ? { automatic: true, libraryIds: [...libraryIds] } : {}),
      ...(recheck ? { recheck: true } : {}),
    };
    await this.save();
    log("INFO", "Library scan started", { total: pending.length, titles: units.length, force, refresh: refreshing.length, ...(scope ? { path: scope } : {}), ...(libraryId ? { libraryId } : {}), ...(automatic ? { automatic: true, libraries: libraryIds } : {}), ...(recheck ? { recheck: true } : {}) });
    this.schedulePump();
    return this.snapshot();
  }

  async stop() {
    this.cancelled = true;
    this.eagerWide = [];
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
        if (this.eagerWide.length) {
          const keys = this.eagerWide;
          this.eagerWide = [];
          for (const key of keys) this.opts.fillWideArtwork?.(key);
        }
        const key = this.state.remaining[0];
        if (!key) {
          this.state.status = "completed";
          this.state.finishedAt = nowIso();
          delete this.state.current;
          await this.save();
          log("INFO", "Library scan completed", { matched: this.state.matched, skipped: this.state.skipped, failed: this.state.failed });
          try { await this.opts.onCompleted?.(); }
          catch (error) { log("WARN", "The library scan could not reconcile its proposals", { reason: error instanceof Error ? error.message : String(error) }); }
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
      // The library may have been switched off while this run was queued, or while the
      // server was down. Its item is dropped without a catalogue call; the run moves on.
      if (this.state.automatic && !this.opts.automaticLibraryEnabled(parseLibraryPath(key)?.libraryId ?? "")) {
        this.note("excluded", key, { kind: this.units.get(key)?.kind ?? "movie" });
        await this.finishUnit("skipped");
        return;
      }
      const unit = this.units.get(key);
      if (!unit || !await this.pathExists(key)) {
        this.note("excluded", key, { kind: unit?.kind ?? "movie" });
        await this.finishUnit("skipped");
        return;
      }
      const refresh = this.refreshing.has(key);
      const recheck = this.rechecking.has(key);
      const records = this.opts.libraryMeta();
      const bound = records[key];
      // A refresh is the one turn allowed to ask about a binding that already exists.
      if (!refresh && !recheck && (lookupSkipped(key, records) || scanSkipReason(records[key]) || knownTitleForUnit(key, records)?.id)) {
        this.note("excluded", key, { kind: unit.kind });
        await this.finishUnit("skipped");
        return;
      }

      // The query comes from the unit's own identity, not from the key's parent folder: a
      // loose film inside a collection is searched as the film, not as the collection.
      const parsed = parseUnit(unit);
      if (this.opts.busy()) { delete this.state.current; return; }
      this.refreshing.delete(key);
      this.rechecking.delete(key);

      if (refresh && bound?.id) { addonCall = true; await this.refreshBinding(key, bound); return; }
      if (recheck && bound?.id) { addonCall = true; await this.recheckBinding(key, unit, bound, parsed); return; }

      const identified = await this.identify(unit, parsed);
      addonCall = identified.called;

      if (identified.accept) {
        const item = identified.accept.item;
        const meta = await this.opts.metadata(this.opts.addons(), item.type, item.id);
        addonCall = true;
        // A trusted candidate still has to resolve to a real record. A TMDB search hit is a
        // name and a picture, not a title the catalogue can describe, and binding it would
        // be exactly the "looks right" match this pass exists to stop making.
        if (identified.accept.fromSearch && !meta) {
          log("DEBUG", "The chosen candidate resolved to no metadata record", { key, id: item.id });
          await this.rememberSuggestion(key, unit, identified.suggestion);
          return;
        }
        const record = meta ?? item;
        const fields = cacheFieldsFromMeta(record);
        const episodeRows = episodesFromMeta(record);
        let wrote = false;
        await this.opts.updateMeta((metaMap, suggestions, episodes) => {
          const known = metaMap[key];
          if (lookupSkipped(key, metaMap) || scanSkipReason(metaMap[key]) || knownTitleForUnit(key, metaMap)?.id) return;
          metaMap[key] = {
            ...known,
            type: item.type, id: item.id, source: "scan", locked: false,
            matchedAt: nowIso(), backfilledAt: nowIso(), ...fields,
          };
          Object.assign(episodes, episodeRows);
          delete suggestions[key];
          wrote = true;
        });
        if (!wrote) {
          this.note("excluded", key, { kind: unit.kind });
          await this.finishUnit("skipped");
          return;
        }
        if (!this.opts.busy()) {
          await this.opts.deleteGeneratedArt(key);
          this.opts.savePoster(key, record.poster, record.background);
          // Alternate artwork is one request about the title just bound, never about a
          // candidate that was merely searched for.
          const gallery = identified.accept.candidate
            ? await this.opts.candidates.galleryOf(identified.accept.candidate, unit.kind, this.language())
            : [];
          if (gallery.length) this.opts.saveGallery?.(key, gallery);
        }
        log("INFO", "Library title matched", {
          key, type: item.type, id: item.id, source: "scan",
          ...(identified.accept.evidence ? { evidence: identified.accept.evidence } : {}),
        });
        this.note("accepted", key, { kind: unit.kind, ...identified.diagnostic, candidateId: item.id });
        await this.finishUnit("matched");
        return;
      }

      // Either way the unit is remembered as searched, so a later scan can walk
      // past it instead of asking the catalogues the same question again.
      await this.rememberSuggestion(key, unit, identified.suggestion, identified.diagnostic);
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : String(error);
      log("WARN", "Library scan unit failed", { key, reason: this.state.error });
      this.note("failed", key, { kind: this.units.get(key)?.kind ?? "movie" });
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

  /** One structured line of what happened to a unit, kept bounded and counted. */
  private note(decision: ScanDiagnostic["decision"], key: string, fields: Partial<ScanDiagnostic> = {}) {
    const diagnostic: ScanDiagnostic = {
      ...fields,
      unit: key, kind: fields.kind ?? "movie", decision,
      query: fields.query ?? "", querySource: fields.querySource ?? "search",
      at: nowIso(),
    };
    const list = this.state.diagnostics ?? (this.state.diagnostics = []);
    list.push(diagnostic);
    if (list.length > DIAGNOSTIC_LIMIT) list.splice(0, list.length - DIAGNOSTIC_LIMIT);
    if (decision === "accepted") this.state.accepted = (this.state.accepted ?? 0) + 1;
    else if (decision === "proposed") this.state.proposed = (this.state.proposed ?? 0) + 1;
    else if (decision === "missed") this.state.missed = (this.state.missed ?? 0) + 1;
    else if (decision === "excluded") this.state.excluded = (this.state.excluded ?? 0) + 1;
    log("DEBUG", "Library match decision", { ...diagnostic });
  }

  /** Remembers what a unit's search came to, so a later scan walks past it. */
  private async rememberSuggestion(key: string, unit: TitleUnit, suggestion: LibrarySuggestion | undefined, diagnostic?: Partial<ScanDiagnostic>) {
    const outcome = suggestion ? { ...suggestion, scannedAt: nowIso() } : scanMiss(unit.kind);
    await this.opts.updateMeta((_metaMap, suggestions) => { suggestions[key] = outcome; });
    if (suggestion) this.note("proposed", key, { kind: unit.kind, ...diagnostic, reason: suggestion.reason });
    else this.note("missed", key, { kind: unit.kind, ...diagnostic });
    await this.finishUnit("skipped");
  }

  private language(): string { return this.opts.language?.() ?? "en"; }

  /** A provider that breaks is a title nobody could identify yet, not a run that failed. */
  private async searchTrusted(unit: TitleUnit, parsed: ParsedMedia): Promise<LibraryCandidate[]> {
    try {
      // The whole title, not the shortened query: the service searches every form of it,
      // and the name the folder's single film carries, which the folder may have misspelled.
      return await this.opts.candidates.searchLibraryCandidates(
        parsed.title || parsed.query, unit.kind, parsed.year, this.language(), parsed.fileTitle ? [parsed.fileTitle] : [],
      );
    } catch (error) {
      log("WARN", "The trusted title search failed", { key: unit.key, reason: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  /** One title's second look: ask the trusted providers again and, when they now name a
   *  different title the scan would accept on its own, offer that as a correction. The
   *  binding stays exactly as it was until somebody confirms the proposal, and a provider
   *  that fails changes nothing at all. */
  private async recheckBinding(key: string, unit: TitleUnit, bound: LibraryMetaRecord, parsed: ParsedMedia) {
    const found = await this.searchTrusted(unit, parsed);
    const hits = found.filter((candidate) => candidate.item.name).map((candidate) => scoreHit(parsed, candidate.item, unit.kind));
    const accepted = autoAccept(hits, undefined, { country: parsed.country });
    const candidate = accepted ? found.find((entry) => entry.item.id === accepted.item.id) : undefined;
    const chosen = candidate ? await this.opts.candidates.resolveSelected(candidate, unit.kind, this.language()) : undefined;
    if (!accepted || !chosen) {
      log("DEBUG", "An automatic binding survived its recheck", { key, id: bound.id, proposed: chosen?.id });
      await this.finishUnit("skipped");
      return;
    }
    if (chosen.id === bound.id) {
      await this.opts.updateMeta((metaMap, suggestions) => {
        if (metaMap[key]?.id === bound.id && suggestions[key]?.replacesId === bound.id) delete suggestions[key];
      });
      log("DEBUG", "An automatic binding survived its recheck", { key, id: bound.id, proposed: chosen.id });
      await this.finishUnit("skipped");
      return;
    }
    const year = yearFromMeta(chosen);
    const previousYear = Number(bound.year);
    await this.opts.updateMeta((metaMap, suggestions) => {
      // The binding may have been replaced or unmatchd while the search was in flight.
      if (metaMap[key]?.id !== bound.id) return;
      suggestions[key] = {
        type: chosen.type, id: chosen.id, name: chosen.name, score: accepted.score,
        titleSimilarity: Math.round(accepted.titleSimilarity * 100), reason: "correction",
        scannedAt: nowIso(), replacesId: bound.id, ...(year != null ? { year } : {}),
        ...(chosen.poster ? { poster: chosen.poster } : {}),
        ...(bound.name ? { replacesName: bound.name } : {}),
        ...(Number.isFinite(previousYear) ? { replacesYear: previousYear } : {}),
      };
    });
    log("INFO", "The recheck proposed a correction", { key, from: bound.id, to: chosen.id });
    await this.finishUnit("skipped");
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

  /** A namesake series is decided by the episodes on disk: ask the leading candidates for
   *  their episode lists and let the names the files carry pick the one that fits. */
  private async confirmByEpisodes(
    unit: TitleUnit,
    addons: AddonRecord[],
    hits: ScoredHit[],
    byId: Map<string, LibraryCandidate>,
  ): Promise<{ hit: ScoredHit; candidate: LibraryCandidate; item: MetaItem } | undefined> {
    const ranked: ScoredHit[] = [];
    const seen = new Set<string>();
    for (const hit of [...hits].sort((a, b) => b.score - a.score)) {
      if (hit.score < SUGGESTION_MIN_SCORE || seen.has(hit.item.id) || !byId.has(hit.item.id)) continue;
      seen.add(hit.item.id);
      ranked.push(hit);
      if (ranked.length >= 3) break;
    }
    if (!ranked.length) return undefined;

    const disk = diskEpisodes(unit.sampleFiles);
    const candidates: LibraryCandidate[] = [];
    const items: MetaItem[] = [];
    const evidence: EpisodeEvidence[] = [];
    for (const hit of ranked) {
      const candidate = byId.get(hit.item.id)!;
      let item = candidate.item;
      let meta: MetaItem | null = null;
      try {
        item = await this.opts.candidates.resolveSelected(candidate, "series", this.language());
        meta = await this.opts.metadata(addons, "series", item.id);
      } catch {
        meta = null;
      }
      candidates.push(candidate);
      items.push(item);
      evidence.push(episodeEvidence(disk, catalogueEpisodes(meta)));
    }
    const confirmed = confirmedByEpisodes(evidence);
    if (confirmed == null) return undefined;
    return { hit: ranked[confirmed]!, candidate: candidates[confirmed]!, item: items[confirmed]! };
  }

  private async identify(unit: TitleUnit, parsed: ParsedMedia): Promise<{
    called: boolean;
    accept?: { item: MetaItem; candidate?: LibraryCandidate; fromSearch: boolean; evidence?: "episodes" };
    suggestion?: LibrarySuggestion;
    diagnostic?: Partial<ScanDiagnostic>;
  }> {
    const addons = this.opts.addons();
    const imdb = parsed.providerHints?.imdb;
    if (imdb) {
      const meta = await this.opts.metadata(addons, unit.kind, imdb)
        ?? await this.opts.metadata(addons, unit.kind === "movie" ? "series" : "movie", imdb);
      return {
        called: true,
        accept: meta ? { item: { ...meta, type: meta.type || unit.kind }, fromSearch: false } : undefined,
        diagnostic: { query: imdb, querySource: "provider-hint", candidateId: meta?.id ?? imdb, titleSimilarity: 100 },
      };
    }
    const prefixes = addonPrefixes(addons);
    const tmdbId = parsed.providerHints?.tmdb ? idForPrefix(parsed.providerHints.tmdb, prefixes, "tmdb") : undefined;
    const tvdbId = parsed.providerHints?.tvdb ? idForPrefix(parsed.providerHints.tvdb, prefixes, "tvdb") : undefined;
    const prefixed = tmdbId ?? tvdbId;
    if (prefixed) {
      const meta = await this.opts.metadata(addons, unit.kind, prefixed);
      if (meta) return {
        called: true,
        accept: { item: { ...meta, type: meta.type || unit.kind }, fromSearch: false },
        diagnostic: { query: prefixed, querySource: "provider-hint", candidateId: meta.id, titleSimilarity: 100 },
      };
    }
    // Only the trusted providers are asked. Arbitrary catalogue addons, including ones
    // opted out of the global search, are what bound "Flashdance" to the wrong row.
    const found = await this.searchTrusted(unit, parsed);
    const byId = new Map(found.map((candidate) => [candidate.item.id, candidate]));
    const hits = found.filter((candidate) => candidate.item.name).map((candidate) => scoreHit(parsed, candidate.item, unit.kind));
    let accepted = autoAccept(hits, undefined, { country: parsed.country });
    const suggestion = pickSuggestion(hits);
    let candidate = accepted ? byId.get(accepted.item.id) : undefined;
    let episodeAccept: { hit: ScoredHit; candidate: LibraryCandidate; item: MetaItem } | undefined;
    if (!accepted && unit.kind === "series" && suggestion) {
      episodeAccept = await this.confirmByEpisodes(unit, addons, hits, byId);
      if (episodeAccept) {
        accepted = episodeAccept.hit;
        candidate = episodeAccept.candidate;
      }
    }
    const best = [...hits].sort((a, b) => b.score - a.score)[0];
    const bestProvider = best ? byId.get(best.item.id)?.provider : undefined;
    const diagnostic: Partial<ScanDiagnostic> = {
      query: parsed.query, querySource: "search",
      ...(candidate?.provider ?? bestProvider ? { provider: candidate?.provider ?? bestProvider } : {}),
      ...(best ? {
        candidateId: best.item.id, candidateName: best.item.name,
        titleSimilarity: Math.round(best.titleSimilarity * 100),
        ...(best.yearDelta != null ? { yearDelta: best.yearDelta } : {}),
        ...(best.partConflict ? { partConflict: true } : {}),
      } : {}),
      ...(suggestion?.alternatives?.length
        ? { alternatives: suggestion.alternatives.map((hit) => ({ id: hit.id, name: hit.name, score: hit.score })) }
        : {}),
      ...(suggestion?.reason ? { reason: suggestion.reason } : {}),
    };
    // The identity that gets bound is the resolved one: an IMDb id whenever the provider has
    // one, so the same title can be looked up by every addon that speaks it.
    const item = episodeAccept?.item
      ?? (candidate ? await this.opts.candidates.resolveSelected(candidate, unit.kind, this.language()) : accepted?.item);
    // Why a title stayed unmatched is the question the scan gets asked most, and the scores
    // that decided it are gone the moment this returns. Debug level: one line per title.
    if (!accepted || !item) log("DEBUG", "No match was accepted for the title", {
      query: parsed.query, kind: unit.kind, hits: hits.length,
      best: hits.length
        ? [...hits].sort((a, b) => b.score - a.score).slice(0, 3)
          .map((hit) => ({ name: hit.item.name, year: yearFromMeta(hit.item), score: hit.score, autoEligible: hit.autoEligible }))
        : undefined,
      suggested: suggestion?.name,
    });
    return {
      called: true,
      accept: accepted && item
        ? { item, candidate, fromSearch: true, ...(episodeAccept ? { evidence: "episodes" as const } : {}) }
        : undefined,
      suggestion,
      diagnostic,
    };
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
