import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError } from "./api";
import { t } from "./i18n";
import { arrangeStreams, compareRuleRank, isLocalStream, sortRuleId, streamLanguages, type StreamOrder } from "./streams";
import type { CatalogueRef } from "./title-enrichment";
import type { RemoteLibrary, Stream } from "./types";

/** One selectable block of the chooser: the rows a group answered, tagged with where they came
 *  from, so a filter can name it and a failure can be retried on its own. A discovery entry names
 *  the lookup that has to answer before a whole class of groups can even be asked. */
export interface LibrarySourceGroup {
  /** Stable across a reload: `addon:<key>` or `remote:<libraryId>`; `local` for the viewer's
   *  own copies of a remote title. */
  key: string;
  kind: "local" | "remote" | "addon" | "discovery";
  /** The addon or library name; the caller composes the full label with the provider. */
  name: string;
  provider?: RemoteLibrary["provider"];
  status: "idle" | "loading" | "loaded" | "error";
  streams: Stream[];
  error: string;
}

/** What a detail hands the shared chooser: the groups and the one action over them. */
export interface LibrarySourcePanel {
  groups: LibrarySourceGroup[];
  /** Asks one failed group or discovery again; one that already answered is never read twice. */
  retry: (key: string) => void;
}

/** One option of a chooser filter menu, with the count the menu shows beside it. */
export interface SourceFilterChoice { value: string; label: string; count: number }

export const LOCAL_GROUP = "local";
export const addonGroupKey = (addonKey: string) => `addon:${addonKey}`;
export const remoteGroupKey = (libraryId: string) => `remote:${libraryId}`;
/** The filter value that stands for the rows the detail already had: its own library's versions. */
export const ORIGIN_SOURCE = "\u0000origin";
/** The lookup that names the addons offering the title; its failure is retried on its own. */
export const ADDONS_DISCOVERY = "\u0000providers";
/** The lookup that names the libraries the account may browse. */
export const LIBRARIES_DISCOVERY = "\u0000libraries";

/** Two addon calls and two library matches may be out at once; a slow provider delays only
 *  itself, and the viewer's own copies are a single request of their own. Discovery of the
 *  providers and of the libraries may be out together. */
const LIMITS: Record<LibrarySourceGroup["kind"], number> = { local: 1, remote: 2, addon: 2, discovery: 2 };

const aborted = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/** One row per source id: an addon that repeats a source under two labels is still one thing. */
const dedupe = (streams: Stream[]): Stream[] => {
  const seen = new Set<string>();
  return streams.filter((stream) => typeof stream.sourceId === "string" && stream.sourceId.trim().length > 0
    && !seen.has(stream.sourceId) && (seen.add(stream.sourceId), true));
};

/** One class of sources in the chooser: the rows the detail already had, and one entry per group. */
export interface LibrarySourceEntry { key: string; kind: "native" | "local" | "remote" | "addon"; label: string; streams: Stream[] }

/** The classes the chooser lists, the detail's own rows first. A group still out or failed
 *  contributes nothing yet, so a slow answer can never hold the rows that did land. */
export function librarySourceEntries(native: Stream[], nativeLabel: string, groups: LibrarySourceGroup[], labelOf: (group: LibrarySourceGroup) => string): LibrarySourceEntry[] {
  const playable = (streams: Stream[]) => streams.filter((stream) => stream.playable);
  return [
    { key: ORIGIN_SOURCE, kind: "native", label: nativeLabel, streams: playable(native) },
    // A discovery entry carries status, never rows: only the classes it names are listed.
    ...groups.filter((group) => group.kind !== "discovery").map((group) => ({ key: group.key, kind: group.kind as LibrarySourceEntry["kind"], label: labelOf(group), streams: group.status === "loaded" ? playable(group.streams) : [] })),
  ];
}

/** The order the configured providers hold, read from the plan the discovery answered: the same
 *  order every time, never the order two addon calls happened to land in. */
export function addonPriority(entries: LibrarySourceEntry[]): Map<string, number> {
  const priority = new Map<string, number>();
  for (const entry of entries) if (entry.kind === "addon" && entry.label && !priority.has(entry.label)) priority.set(entry.label, priority.size);
  return priority;
}

/**
 * The rows the chooser shows: the detail's own versions and the viewer's copies first, then remote
 * libraries and addons in rule order. A named size sort ranks every class together.
 */
export function librarySourceRows(entries: LibrarySourceEntry[], filter: string, language: string, sort: StreamOrder,
  preferredLanguage: string, titleLanguage?: string, priority?: Map<string, number>): Stream[] {
  const rank = priority ?? addonPriority(entries);
  const kept = (filter ? entries.filter((entry) => entry.key === filter) : entries)
    .map((entry) => ({ ...entry, streams: language ? entry.streams.filter((stream) => streamLanguages(stream, titleLanguage).includes(language)) : entry.streams }));
  const of = (kind: LibrarySourceEntry["kind"]) => kept.filter((entry) => entry.kind === kind).flatMap((entry) => entry.streams);
  const native = of("native"), local = of("local"), remote = of("remote"), addon = of("addon");
  if (sort === "recommended") {
    return [...native, ...local, ...remote, ...arrangeStreams(addon, { addon: "", language: "", sort }, preferredLanguage, rank, titleLanguage)];
  }
  const ruleId = sortRuleId(sort);
  if (ruleId) {
    const byRule = (rows: Stream[]) => rows.some((stream) => stream.rules?.[ruleId])
      ? [...rows].sort((left, right) => compareRuleRank(left, right, ruleId))
      : rows;
    const ruleRows = [...local, ...remote, ...addon];
    if (ruleRows.some((stream) => stream.rules?.[ruleId])) {
      return [...byRule(native), ...byRule(ruleRows)];
    }
    return [...byRule(native), ...local, ...remote, ...arrangeStreams(addon, { addon: "", language: "", sort: "recommended" }, preferredLanguage, rank, titleLanguage)];
  }
  if (sort === "addon") return [...native, ...local, ...remote, ...arrangeStreams(addon, { addon: "", language: "", sort }, preferredLanguage, rank, titleLanguage)];
  return arrangeStreams([...native, ...local, ...remote, ...addon], { addon: "", language: "", sort }, preferredLanguage, rank, titleLanguage);
}

/** The menus over one chooser: the source menu names every class the other filters allow and the
 *  "all sources" count holds every row of them, so picking a source never hides the others. The
 *  language menu is the other way round: it counts what the picked source holds, so it can never
 *  contradict the list beside it. */
export function librarySourceChoices(entries: LibrarySourceEntry[], filter: string, language: string, titleLanguage?: string): {
  total: number; options: SourceFilterChoice[]; languageTotal: number; languages: SourceFilterChoice[];
} {
  const inLanguage = (entry: LibrarySourceEntry) => language ? entry.streams.filter((stream) => streamLanguages(stream, titleLanguage).includes(language)) : entry.streams;
  const byLanguage = entries.map((entry) => ({ entry, streams: inLanguage(entry) }));
  const chosen = filter ? entries.filter((entry) => entry.key === filter) : entries;
  const languages = new Map<string, number>();
  for (const entry of chosen) for (const stream of entry.streams) for (const code of streamLanguages(stream, titleLanguage)) languages.set(code, (languages.get(code) ?? 0) + 1);
  if (language && !languages.has(language)) languages.set(language, 0);
  const options = byLanguage.filter((entry) => entry.streams.length > 0).map((entry) => ({ value: entry.entry.key, label: entry.entry.label, count: entry.streams.length }));
  // The picked source keeps its option even when the language filter left it no row: a menu with
  // no option for the value it holds falls back to "All sources" while the list beside it stays
  // filtered. Its label has to come from the entry, so a group that is gone cannot be named.
  const picked = filter ? entries.find((entry) => entry.key === filter) : undefined;
  if (picked && !options.some((option) => option.value === filter)) options.push({ value: filter, label: picked.label, count: 0 });
  return {
    total: byLanguage.reduce((count, entry) => count + entry.streams.length, 0),
    options,
    languageTotal: chosen.reduce((count, entry) => count + entry.streams.length, 0),
    languages: [...languages.entries()].sort((left, right) => right[1] - left[1]).map(([value, count]) => ({ value, label: value, count })),
  };
}

export interface LibrarySourcesOptions {
  /** The native title and account the answers belong to; a change drops every one of them. */
  scope: string;
  /** The viewer opened the chooser: the single intent that reads every group, once per scope. */
  open: boolean;
  /** The catalogue identity the extra sources are asked by; without one there is nothing to ask. */
  catalogue: CatalogueRef | null;
  /** The provider's name filter: a series name for an episode, never the episode's own. */
  nameHint?: string;
  /** The libraries this account may browse, or null to discover them once per scope. */
  libraries: RemoteLibrary[] | null;
  /** Reads the viewer's own copies of the title through the generic catalogue identity. */
  localCopies?: boolean;
  /** The library the native versions already came from; it is never asked a second time. */
  originLibraryId?: string;
}

export interface LibrarySourcesState {
  groups: LibrarySourceGroup[];
  /** Whether a group or the discovery behind it is still out. */
  loading: boolean;
  /** Every row a loaded group answered. */
  streams: Stream[];
  /** Asks one failed group again without touching the groups that already answered. */
  retry: (key: string) => void;
}

interface ScopedGroups { scope: string; groups: LibrarySourceGroup[] }
/** The state of one discovery lookup, kept beside the plan so a retry names exactly it. */
interface DiscoveryJob { status: "loading" | "loaded" | "error"; error: string }

/**
 * The extra sources of one native title, read the moment the viewer opens the chooser: every
 * addon that offers the title, and every other library the account may browse. Nothing here
 * reads an endpoint before that single intent, the answers are scoped to the title, library and
 * account they were asked for -- a scope change aborts them all -- and a group that already
 * answered is never read again while the detail stays mounted.
 */
export function useLibrarySources(options: LibrarySourcesOptions): LibrarySourcesState {
  const { scope, open, catalogue, nameHint, libraries, localCopies, originLibraryId } = options;
  const [state, setState] = useState<ScopedGroups>(() => ({ scope, groups: [] }));
  const scopeRef = useRef(scope);
  const optionsRef = useRef(options);
  scopeRef.current = scope;
  optionsRef.current = options;
  const epoch = useRef(0);
  const controllers = useRef(new Map<string, AbortController>());
  const started = useRef(new Set<string>());
  const running = useRef<Record<LibrarySourceGroup["kind"], number>>({ local: 0, remote: 0, addon: 0, discovery: 0 });
  const jobs = useRef(new Map<string, DiscoveryJob>());
  const providers = useRef<Array<{ key: string; name: string }> | null>(null);
  const discovered = useRef<RemoteLibrary[] | null>(null);

  // The rows belong to the scope they were read for: another title's answers are refused here,
  // even before the effect below has had a chance to drop them.
  const groups = state.scope === scope ? state.groups : [];

  const setGroup = (key: string, patch: Partial<LibrarySourceGroup>) => {
    setState((value) => value.scope === scopeRef.current
      ? { ...value, groups: value.groups.map((group) => group.key === key ? { ...group, ...patch } : group) }
      : value);
  };

  /** The groups this title may collect, in the one order the chooser and its retry walk them:
   *  the viewer's own copies, the other libraries, the addons in their configured order, and last
   *  the discovery entries that name a lookup still needed before its class can be asked. */
  const planGroups = (): LibrarySourceGroup[] => {
    const current = optionsRef.current;
    const want: LibrarySourceGroup[] = [];
    if (!current.catalogue) return want;
    const job = (key: string, name: string): LibrarySourceGroup => {
      const state = jobs.current.get(key);
      return { key, kind: "discovery", name, status: state?.status ?? "idle", streams: [], error: state?.error ?? "" };
    };
    if (current.localCopies) want.push({ key: LOCAL_GROUP, kind: "local", name: "", status: "idle", streams: [], error: "" });
    for (const library of current.libraries ?? discovered.current ?? []) {
      if (library.id === current.originLibraryId || !library.enabled) continue;
      want.push({ key: remoteGroupKey(library.id), kind: "remote", name: library.name, provider: library.provider, status: "idle", streams: [], error: "" });
    }
    for (const provider of providers.current ?? []) want.push({ key: addonGroupKey(provider.key), kind: "addon", name: provider.name, status: "idle", streams: [], error: "" });
    want.push(job(ADDONS_DISCOVERY, t("sources.discoveryAddons")));
    if (current.libraries === null) want.push(job(LIBRARIES_DISCOVERY, t("sources.discoveryLibraries")));
    return want;
  };

  /** Grows the list with the groups discovery has just named, keeping what already landed. */
  const syncPlan = () => {
    const want = planGroups();
    setState((value) => {
      if (value.scope !== scopeRef.current) return value;
      const existing = new Map(value.groups.map((group) => [group.key, group]));
      // A discovery entry is its own current status, never the object an earlier plan left.
      const next = want.map((group) => group.kind === "discovery" ? group : existing.get(group.key) ?? group);
      if (next.length === value.groups.length && next.every((group, index) => group === value.groups[index])) return value;
      return { ...value, groups: next };
    });
  };

  const start = (key: string, kind: LibrarySourceGroup["kind"], request: (signal: AbortSignal) => Promise<Stream[]>) => {
    if (started.current.has(key) || running.current[kind] >= LIMITS[kind]) return;
    started.current.add(key);
    running.current[kind] += 1;
    const mine = epoch.current;
    const scope = scopeRef.current;
    const controller = new AbortController();
    controllers.current.set(key, controller);
    const live = () => mine === epoch.current && scope === scopeRef.current;
    setGroup(key, { status: "loading", error: "" });
    void request(controller.signal)
      .then((streams) => {
        release(key, controller);
        if (!live() || controller.signal.aborted) return;
        setGroup(key, { status: "loaded", streams, error: "" });
      })
      .catch((error) => {
        release(key, controller);
        if (!live() || controller.signal.aborted || aborted(error)) return;
        setGroup(key, { status: "error", streams: [], error: describeError(error) });
      })
      .finally(() => {
        if (live()) running.current[kind] -= 1;
        pump();
      });
  };

  // Only the request that still owns an entry may release it: an old scope's answer must not
  // drop the new scope's controller, or that read would be left with nobody to abort it.
  const release = (key: string, controller: AbortController) => {
    if (controllers.current.get(key) === controller) controllers.current.delete(key);
  };

  const startDiscovery = (key: string, request: (signal: AbortSignal) => Promise<void>) => {
    if (started.current.has(key) || running.current.discovery >= LIMITS.discovery) return;
    started.current.add(key);
    running.current.discovery += 1;
    const mine = epoch.current;
    const scope = scopeRef.current;
    const controller = new AbortController();
    controllers.current.set(key, controller);
    const live = () => mine === epoch.current && scope === scopeRef.current && !controller.signal.aborted;
    const setJob = (job: DiscoveryJob) => { if (!live()) return; jobs.current.set(key, job); syncPlan(); };
    setJob({ status: "loading", error: "" });
    void request(controller.signal)
      .then(() => setJob({ status: "loaded", error: "" }))
      .catch((error) => { if (aborted(error)) return; setJob({ status: "error", error: describeError(error) }); })
      .finally(() => {
        release(key, controller);
        if (mine === epoch.current && scope === scopeRef.current) running.current.discovery -= 1;
        pump();
      });
  };

  const pump = () => {
    const current = optionsRef.current;
    if (!current.open || !current.catalogue) return;
    const mine = epoch.current;
    const scope = scopeRef.current;
    const live = () => mine === epoch.current && scope === scopeRef.current;
    const ref = current.catalogue;
    if (!started.current.has(ADDONS_DISCOVERY)) {
      startDiscovery(ADDONS_DISCOVERY, async (signal) => {
        const found = await api.streamSources(ref.type, ref.id, signal);
        if (!live()) return;
        providers.current = found;
      });
    }
    if (current.libraries === null && !started.current.has(LIBRARIES_DISCOVERY)) {
      startDiscovery(LIBRARIES_DISCOVERY, async (signal) => {
        const found = await api.remoteLibraries({ timeoutMs: 3_000, signal });
        if (!live()) return;
        discovered.current = found;
      });
    }
    // Every group the plan already knows is asked on its own: the viewer's own copies and the
    // addons never wait for the library discovery, and a library that is still unknown is simply
    // not in the plan yet -- its discovery entry says so.
    syncPlan();
    for (const group of planGroups()) {
      if (group.kind === "discovery") continue;
      if (running.current[group.kind] >= LIMITS[group.kind]) continue;
      if (group.kind === "local") start(group.key, "local", (signal) => api.localStreams(ref.type, ref.id, signal).then((rows) => rows.filter(isLocalStream)));
      else if (group.kind === "remote") start(group.key, "remote", (signal) => api.remoteLibraryStreams(group.key.slice("remote:".length), ref.type, ref.id, signal, current.nameHint));
      else start(group.key, "addon", (signal) => api.streams(ref.type, ref.id, group.key.slice("addon:".length), signal).then(dedupe));
    }
  };

  // A scope change -- another title, library or account -- invalidates immediately and aborts
  // everything in flight; the answers of the old scope never land under the new one.
  useEffect(() => {
    epoch.current += 1;
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
    started.current = new Set();
    running.current = { local: 0, remote: 0, addon: 0, discovery: 0 };
    jobs.current.clear();
    providers.current = null;
    discovered.current = null;
    setState((value) => value.scope === scope ? value : { scope, groups: [] });
  }, [scope]);

  useEffect(() => () => {
    epoch.current += 1;
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
  }, []);

  const libraryKey = libraries === null ? "" : libraries.map((library) => library.id).join(",");
  const catalogueKey = catalogue ? `${catalogue.type}:${catalogue.id}` : "";
  useEffect(() => {
    if (open) pump();
  }, [open, scope, catalogueKey, libraryKey, nameHint, localCopies, originLibraryId]);

  const retry = useCallback((key: string) => {
    started.current.delete(key);
    jobs.current.delete(key);
    setGroup(key, { status: "idle", error: "" });
    pump();
  }, []);

  return {
    groups,
    loading: groups.some((group) => group.status === "idle" || group.status === "loading"),
    streams: groups.flatMap((group) => group.status === "loaded" ? group.streams : []),
    retry,
  };
}
