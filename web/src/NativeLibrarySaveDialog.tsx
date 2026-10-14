import { useEffect, useRef, useState } from "react";
import { api, describeError } from "./api";
import { t, useI18n } from "./i18n";
import { defaultSource, orderSources, playableSources, sourceIdentity, sourceName } from "./library-detail-sources";
import { SaveTargetDialog } from "./SaveTargetDialog";
import { offeredLibraries, sourceTargetRule, type SaveKind, type SaveTarget } from "./save-target";
import { bytes } from "./settings-ui";
import { catalogueRef } from "./title-enrichment";
import type { LibraryView, MediaServerProvider, RemoteItem, Stream } from "./types";

/** The attached library a copy lands through: its id scopes the version read, the provider and
 *  name only label the chooser, and its own configured destination is the fallback when the
 *  sources themselves carry none. */
export interface NativeSaveLibrary {
  id: string;
  provider: MediaServerProvider;
  name?: string;
  downloadLibraryId?: string;
}

const sizeLabel = (stream: Stream) => {
  const value = stream.behaviorHints?.videoSize;
  return typeof value === "number" && value > 0 ? bytes(value) : "";
};

const providerKey = (provider: MediaServerProvider) =>
  provider === "emby" ? "mediaServer.provider.emby" as const : "mediaServer.provider.jellyfin" as const;

const aborted = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/**
 * The native copy dialog: it chooses the exact version of an explicitly picked media-server
 * item, then the local destination, and queues the copy. The caller may hand over the versions
 * it already holds (the open detail) or let the dialog read them once on open (a tile menu); a
 * parent series is read only when an episode is saved without one already in scope. The one
 * action button lives here, so the catalogue, the detail and the context menu share it.
 */
function NativeLibrarySaveDialogContent({ library, item, series, knownSources, initialSource, libraries, artwork, onClose, onQueued }: {
  library: NativeSaveLibrary;
  item: RemoteItem;
  /** The parent series, when the caller entered the episode from its show. */
  series?: RemoteItem | null;
  /** The versions the caller already holds; `null`/absent asks the dialog to read them once. */
  knownSources?: Stream[] | null;
  /** The version the detail's own selector holds, offered as the first choice when copyable. */
  initialSource?: Stream | null;
  libraries: LibraryView[];
  /** Exact catalogue artwork, when the caller already has it; a remote proxy path is never sent. */
  artwork?: { poster?: string; background?: string };
  onClose: () => void;
  onQueued: () => void;
}) {
  useI18n();
  const epoch = useRef(0);
  const seriesEpoch = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const [loadedSeries, setLoadedSeries] = useState<RemoteItem | null>(series ?? null);
  const [sources, setSources] = useState<Stream[] | null>(knownSources ?? null);
  const [seriesPending, setSeriesPending] = useState(item.type === "episode" && !series && Boolean(item.seriesId));
  const [loading, setLoading] = useState(knownSources == null);
  const [error, setError] = useState("");
  const [chosenKey, setChosenKey] = useState<string | null>(initialSource ? sourceIdentity(initialSource) : null);

  // One read per open, cancellable and epoch guarded: a late answer from another item's dialog
  // never lands here. A series is asked for only because the viewer pressed save, never while a
  // listing row merely draws.
  useEffect(() => {
    if (knownSources != null) return;
    const mine = ++epoch.current;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const found = await api.remoteSources(library.id, item.id, controller.signal);
        if (mine !== epoch.current || controller.signal.aborted) return;
        setSources(found);
        setLoading(false);
      } catch (value) {
        if (mine !== epoch.current || controller.signal.aborted || aborted(value)) return;
        setError(describeError(value));
        setLoading(false);
      }
    })();
    return () => { controller.abort(); if (epoch.current === mine) epoch.current += 1; };
  }, [library.id, item.id, attempt]);

  // An episode saved from a menu has no series in scope; its parent is read once, only because
  // the viewer pressed save. A missing series id is not guessed at -- the copy is still made.
  useEffect(() => {
    if (item.type !== "episode" || loadedSeries || !item.seriesId) return;
    setSeriesPending(true);
    const mine = ++seriesEpoch.current;
    const controller = new AbortController();
    void api.remoteItem(library.id, item.seriesId, controller.signal)
      .then((answer) => {
        if (mine !== seriesEpoch.current || controller.signal.aborted || answer.item.type !== "series") return;
        setLoadedSeries(answer.item);
      })
      .catch(() => undefined)
      .finally(() => { if (mine === seriesEpoch.current && !controller.signal.aborted) setSeriesPending(false); });
    return () => { controller.abort(); if (seriesEpoch.current === mine) seriesEpoch.current += 1; };
  }, [library.id, item.id, item.seriesId, loadedSeries]);

  const loaded = sources ?? [];
  const usable = orderSources(playableSources(loaded));
  const copyable = usable.filter((stream) => stream.capabilities?.downloadToLibrary === true);
  const selected = (chosenKey ? usable.find((stream) => sourceIdentity(stream) === chosenKey) : undefined) ?? defaultSource(usable) ?? null;
  const kind: SaveKind = item.type === "movie" ? "movie" : "series";
  const offered = offeredLibraries(libraries, kind);
  // The automatic option is preselected to the destination the server projected for this exact
  // source, or the kind's own default when it projected none. A manual pick still replaces it.
  const rule = sourceTargetRule(selected) ?? sourceTargetRule({ downloadLibraryId: library.downloadLibraryId });

  // Identical labels are told apart by the localized version number, never by an opaque id.
  const optionLabels = (() => {
    const context = [t(providerKey(library.provider)), library.name].filter(Boolean).join(" · ");
    const base = usable.map((stream) => [sourceName(stream), sizeLabel(stream), context].filter(Boolean).join(" · "));
    const counts = new Map<string, number>();
    for (const label of base) counts.set(label, (counts.get(label) ?? 0) + 1);
    return base.map((label, index) => (counts.get(label) ?? 0) > 1 ? `${label} · ${t("mediaServer.versionNumber", { number: index + 1 })}` : label);
  })();

  const title = item.type === "episode" && item.season != null && item.episode != null
    ? `${loadedSeries?.name ?? item.name} · ${t("mediaServer.episodeLabel", { season: item.season, episode: item.episode })}`
    : item.name;

  // The payload is built from exact fields only: the series' own ids for an episode, the film's
  // for a movie, and catalogue artwork when the caller already holds it. No remote proxy path,
  // no filename guess and no title lookup ever reaches it; an item without ids copies bare.
  const media = (): Record<string, unknown> => {
    const ref = item.type === "movie" ? catalogueRef("movie", item.providerIds) : catalogueRef("series", loadedSeries?.providerIds);
    const art = {
      ...(artwork?.poster ? { poster: artwork.poster } : {}),
      ...(artwork?.background ? { background: artwork.background } : {}),
    };
    if (item.type === "movie") {
      return { kind: "movie", title: item.name, ...(item.year ? { year: item.year } : {}), ...(ref ? { id: ref.id, metaType: ref.type } : {}), ...art };
    }
    return {
      kind: "episode", title: loadedSeries?.name ?? item.name,
      ...(item.season != null ? { season: item.season } : {}),
      ...(item.episode != null ? { episode: item.episode } : {}),
      episodeTitle: item.name, ...(ref ? { id: ref.id, metaType: ref.type } : {}), ...art,
    };
  };

  const submit = async (target?: SaveTarget) => {
    if (!selected || selected.capabilities?.downloadToLibrary !== true || !offered.length) return false;
    await api.download(title, selected, media(), target);
    onQueued();
    return true;
  };

  const noVersion = !loading && !error && loaded.length === 0;
  const denied = !loading && !error && loaded.length > 0 && copyable.length === 0;

  return <SaveTargetDialog
    label={title} kind={kind} title={item.type === "episode" ? loadedSeries?.name ?? item.name : item.name}
    season={item.type === "episode" ? item.season : undefined}
    libraries={libraries} rule={rule}
    submitDisabled={seriesPending || loading || Boolean(error) || !offered.length || !selected || selected.capabilities?.downloadToLibrary !== true}
    onClose={onClose} onSubmit={submit}>
    {loading && <p className="identify-hint" role="status">{t("common.loading")}</p>}
    {error && <p className="login-error" role="alert">{error} <button type="button" onClick={() => setAttempt((value) => value + 1)}>{t("home.retry")}</button></p>}
    {noVersion && <p className="identify-hint">{t("mediaServer.sourcesEmpty")}</p>}
    {denied && <p className="identify-hint" role="status">{t("mediaServer.downloadDisabled")}</p>}
    {!loading && !error && usable.length > 1 && <label className="native-source-choice">
      <span>{t("library.chooseSource")}</span>
      <select aria-label={t("library.chooseSource")} value={selected ? sourceIdentity(selected) : ""}
        onChange={(event) => setChosenKey(event.target.value)}>
        {usable.map((stream, index) => <option key={sourceIdentity(stream)} value={sourceIdentity(stream)}>{optionLabels[index]}</option>)}
      </select>
    </label>}
    {!offered.length && <p className="identify-hint">{t("saveTarget.noLibrary")}</p>}
  </SaveTargetDialog>;
}

export function NativeLibrarySaveDialog(props: Parameters<typeof NativeLibrarySaveDialogContent>[0]) {
  return <NativeLibrarySaveDialogContent key={`${props.library.id}:${props.item.id}`} {...props}/>;
}
