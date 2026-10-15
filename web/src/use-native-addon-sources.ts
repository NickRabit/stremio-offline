import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, describeError } from "./api";
import { rankAddonStreams } from "./native-addon-sources";
import type { CatalogueRef } from "./title-enrichment";
import type { Stream } from "./types";

/** One supplementary provider offered for the open title. */
export interface AddonProviderState {
  key: string;
  name: string;
  status: "idle" | "loading" | "error" | "loaded";
  /** The ranked rows this provider answered, once they landed. */
  streams: Stream[];
  error: string;
}

export interface NativeAddonSourcesState {
  /** null until the viewer pressed the action; an empty list when no addon offers this title. */
  providers: AddonProviderState[] | null;
  discovering: boolean;
  discoverError: string;
  /** Every row a loaded provider answered, deduplicated and ranked largest first. */
  streams: Stream[];
  /** Reads the providers once for the current scope; a second press while one is out is dropped. */
  discover: () => void;
  /** Reads one provider's rows by its explicit key; never the unfiltered endpoint. */
  load: (key: string) => void;
}

/** The rows one scope collected, tagged with the scope so a render can refuse another title's. */
interface ScopedRows {
  scope: string;
  providers: AddonProviderState[] | null;
  discovering: boolean;
  discoverError: string;
}

const blank = (scope: string): ScopedRows => ({ scope, providers: null, discovering: false, discoverError: "" });

const aborted = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/** One row per source id: an addon that repeats a source under two labels is still one thing. */
const dedupe = (streams: Stream[]): Stream[] => {
  const seen = new Set<string>();
  return streams.filter((stream) => typeof stream.sourceId === "string" && stream.sourceId.trim().length > 0 && !seen.has(stream.sourceId) && (seen.add(stream.sourceId), true));
};

/**
 * The on-demand supplementary sources of one native title. Nothing here reads an addon endpoint
 * until the viewer asks: discovery only on `discover`, one provider only on `load`. Every answer
 * is scoped to the title, library and account it was asked for and dropped the moment that scope
 * changes, so no state can outlive the title that collected it.
 */
export function useNativeAddonSources({ scope, identity }: { scope: string; identity: CatalogueRef | null }): NativeAddonSourcesState {
  const [state, setState] = useState<ScopedRows>(() => blank(scope));
  const epoch = useRef(0);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const discoverController = useRef<{ scope: string; controller: AbortController } | null>(null);
  const providerControllers = useRef(new Map<string, { scope: string; controller: AbortController }>());
  const providersRef = useRef<AddonProviderState[] | null>(null);

  // The rows belong to the scope they were read for: another title's answers are refused here,
  // even before the effect below has had a chance to reset them.
  const current = state.scope === scope ? state : blank(scope);
  providersRef.current = current.providers;

  const abortAll = () => {
    discoverController.current?.controller.abort();
    discoverController.current = null;
    for (const entry of providerControllers.current.values()) entry.controller.abort();
    providerControllers.current.clear();
  };

  // A scope change -- another title, library or account -- invalidates immediately and aborts
  // everything in flight. The answers of the old scope never land under the new one.
  useEffect(() => {
    epoch.current += 1;
    abortAll();
    setState((value) => (value.scope === scope ? value : blank(scope)));
  }, [scope]);

  useEffect(() => () => {
    epoch.current += 1;
    abortAll();
  }, []);

  const discover = useCallback(() => {
    const ref = identityRef.current;
    const capturedScope = scopeRef.current;
    if (!ref || providersRef.current !== null) return;
    if (discoverController.current?.scope === capturedScope) return;
    discoverController.current?.controller.abort();
    const mine = epoch.current;
    const controller = new AbortController();
    discoverController.current = { scope: capturedScope, controller };
    setState((value) => (value.scope === capturedScope ? { ...value, discovering: true, discoverError: "" } : value));
    void api.streamSources(ref.type, ref.id, controller.signal)
      .then((found) => {
        if (discoverController.current?.controller === controller) discoverController.current = null;
        if (mine !== epoch.current || scopeRef.current !== capturedScope || controller.signal.aborted) return;
        setState((value) => (value.scope === capturedScope
          ? { ...value, discovering: false, discoverError: "", providers: found.map((row) => ({ key: row.key, name: row.name, status: "idle", streams: [], error: "" })) }
          : value));
      })
      .catch((error) => {
        if (discoverController.current?.controller === controller) discoverController.current = null;
        if (mine !== epoch.current || scopeRef.current !== capturedScope || controller.signal.aborted || aborted(error)) return;
        setState((value) => (value.scope === capturedScope ? { ...value, discovering: false, discoverError: describeError(error) } : value));
      });
  }, []);

  const load = useCallback((key: string) => {
    const ref = identityRef.current;
    const capturedScope = scopeRef.current;
    if (!ref) return;
    const existing = providerControllers.current.get(key);
    if (existing?.scope === capturedScope) return;
    existing?.controller.abort();
    const mine = epoch.current;
    const controller = new AbortController();
    providerControllers.current.set(key, { scope: capturedScope, controller });
    const patch = (update: (entry: AddonProviderState) => AddonProviderState) =>
      setState((value) => value.scope === capturedScope && value.providers
        ? { ...value, providers: value.providers.map((entry) => entry.key === key ? update(entry) : entry) }
        : value);
    // Only the request that still owns the entry may release it: an old scope's rejection must
    // not drop the new scope's controller for the same provider, or nothing would abort it.
    const release = () => { if (providerControllers.current.get(key)?.controller === controller) providerControllers.current.delete(key); };
    patch((entry) => ({ ...entry, status: "loading", error: "" }));
    void api.streams(ref.type, ref.id, key, controller.signal)
      .then((found) => {
        release();
        if (mine !== epoch.current || scopeRef.current !== capturedScope || controller.signal.aborted) return;
        patch((entry) => ({ ...entry, status: "loaded", streams: rankAddonStreams(dedupe(found)), error: "" }));
      })
      .catch((error) => {
        release();
        if (mine !== epoch.current || scopeRef.current !== capturedScope || controller.signal.aborted || aborted(error)) return;
        patch((entry) => ({ ...entry, status: "error", error: describeError(error) }));
      });
  }, []);

  const streams = useMemo(
    () => rankAddonStreams(dedupe((current.providers ?? []).flatMap((provider) => provider.status === "loaded" ? provider.streams : []))),
    [current.providers]);

  return { providers: current.providers, discovering: current.discovering, discoverError: current.discoverError, streams, discover, load };
}
