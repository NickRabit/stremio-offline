import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "./dialog-focus";
import { useDialogViewport } from "./dialog-viewport";
import { Check, ChevronDown, CirclePlay, Download, FolderOpen, HardDrive, Images, ListRestart, RotateCcw, Star, X } from "lucide-react";
import { DetailHero, LIBRARY_HERO_EMPTY_GRADIENT, LIBRARY_HERO_GRADIENT, useBackdrop } from "./DetailHero";
import type { GalleryImage } from "./gallery-images";
import { hideBroken } from "./settings-ui";
import { t, useI18n } from "./i18n";
import { defaultSource, orderSources, playableSources, sourceIdentity, sourceRowKey } from "./library-detail-sources";
import { librarySourceEntries, librarySourceRows, type LibrarySourceGroup, type LibrarySourcePanel } from "./library-sources";
import { providerLabel, streamLabel } from "./source-rows";
import { isLocalStream, isRemoteStream, pickDefaultStream, resolveStreamSort, sortRuleId, streamBadge, streamLanguages, streamSize } from "./streams";
import { label } from "./languages";
import { bytes } from "./settings-ui";
import { SourceChooser } from "./SourceChooser";
import type { SourceProfile, Stream } from "./types";

export interface LibraryTitleDetailProps {
  /** Scopes the viewer's source choice to one title, so another title opens with a fresh default. */
  identityKey: string;
  title: string;
  /** A line of context under the title, such as an episode's own numbering. */
  subtitle?: string;
  poster?: string;
  /** The backdrops to try, best first, optionally ending with an existing preview. */
  backdrops?: Array<string | undefined>;
  /** The pictures the gallery overlay will hold, computed by the caller from its own metadata. */
  gallery?: GalleryImage[];
  /** Opens the app's gallery overlay, optionally after reading the stored pictures at a path. */
  onGallery?: (images: GalleryImage[], path?: string) => void;
  /** The metadata line: what the catalogue, the provider or the file record said. */
  facts?: ReactNode;
  /** Appended inside the facts line. The line is drawn for this alone when `facts` is empty. */
  factsExtra?: ReactNode;
  /** Between the facts line and the synopsis. */
  heroExtra?: ReactNode;
  /** After the actions, before the source picker. */
  extras?: ReactNode;
  description?: string;
  /** The title's chips, drawn by the shared row so a library matches the catalogue. */
  chips?: ReactNode;
  /** The favorite control, present wherever the owner of the title can toggle it. */
  favorite?: boolean;
  onToggleFavorite?: (favorite: boolean) => void;
  favoriteDisabled?: boolean;
  /** The watched control; absent when the owner has nothing to mark. */
  watched?: boolean;
  onToggleWatched?: () => void;
  watchedDisabled?: boolean;
  watchedLabel?: string;
  /** The owner's own "open folder" control, drawn last on the one action row. */
  onOpenFolder?: () => void;
  /** The playable versions, or null while they are still being read. */
  sources: Stream[] | null;
  /** The row the caller opened this detail on. It is selected as soon as the listing holds it,
   *  a row that arrives later never replaces it, and a row the viewer picks still wins. */
  initialSource?: Stream;
  /** A copy owned by the opened item, preferred after a saved-position source and before the
   *  source order's default. A matched folder uses this to keep another copy of the title from
   *  becoming its first source. */
  preferredSource?: Stream;
  /** The source the title's stored position was last played from: the detail opens on that row
   *  wherever the title still offers it, unless the viewer picked one themselves. */
  resumeStableKey?: string;
  /** The caller already ordered `sources` (the catalogue's own order): they are listed as given,
   *  not largest first. */
  keepOrder?: boolean;
  /** The viewer's addon order, which the source chooser ranks addon rows by. */
  addonPriority?: Map<string, number>;
  /** The native rows alone, when `sources` merges them with loaded addon rows: the default
   *  version is then drawn from these, so a larger addon answer never replaces it. */
  defaultSources?: Stream[] | null;
  /** The groups beside the title's own versions: addon answers, the viewer's other copies and the
   *  other libraries. Its presence alone makes the arrow appear, and opening it reads them all. */
  sourceGroups?: LibrarySourcePanel;
  /** Told the moment the chooser opens: the one intent that starts every group. */
  onOpenSources?: () => void;
  /** What the title's own rows are called in the filter menu. */
  nativeSourceLabel?: string;
  /** The viewer's audio language, which the legacy fallback order prefers. */
  preferredLanguage?: string;
  sourceProfiles?: SourceProfile[] | null;
  defaultSort?: string;
  sourceError?: string;
  onRetry?: () => void;
  /** What the caller wants in the source list's own place while it has nothing of its own to
   *  show -- an episode still to be chosen. Left out, the list says loading or that it is empty. */
  placeholder?: ReactNode;
  /** True while the title's own metadata is still on its way: the synopsis keeps its place with a
   *  pulsing stand-in rather than saying there is none. */
  descriptionLoading?: boolean;
  /** The caller's own block under the hero: an episode's picker or the episode now on screen. */
  episodes?: ReactNode;
  /** The saved position of the selected source, keyed by its identity so another version's
   *  position can never be drawn. */
  progress?: { position: number; duration: number; sourceKey: string };
  /** Told whenever the played version changes, so a caller can read that version's own state. */
  onSourceChange?: (stream: Stream | null, explicitlyPicked: boolean) => void;
  /** Clears the selected source's saved position; true once the owner's write succeeded. */
  onClearProgress?: (stream: Stream) => Promise<boolean>;
  /** Start-over asks for the same stream with `fromBeginning`, which leaves its progress alone. */
  onPlay: (stream: Stream, fromBeginning?: boolean) => void;
  /** Queues a copy of the currently selected version into a local library. Absent where saving
   *  has no meaning, so the action only appears for a source that can be copied. */
  onSaveToLibrary?: (stream: Stream) => void;
  /** The other half of the save split: the viewer wants to choose the destination themselves.
   *  Absent keeps the single save button the local detail draws. */
  onSaveElsewhere?: (stream: Stream) => void;
  /** Saves the selected version to the device at the keyboard. Absent for a remote original and
   *  wherever the account may not do it. */
  onDownloadToDevice?: (stream: Stream) => void;
  /** Whether one row may be copied at all; absent offers the action for every row. */
  saveSupported?: (stream: Stream) => boolean;
  /** A source row's own tag; absent falls back to the library's name. */
  sourceBadge?: (stream: Stream) => string;
}

/** A nonnegative, floored clock, with hours only when they are there. */
const clock = (value: number) => {
  const total = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const hours = Math.floor(total / 3600);
  return `${hours ? `${hours}:` : ""}${String(Math.floor((total % 3600) / 60)).padStart(hours ? 2 : 1, "0")}:${String(total % 60).padStart(2, "0")}`;
};

/** The one detail body a playable title shares, local or remote: the catalogue hero, the synopsis
 *  and the sources with a split Play button. The provider-specific parts arrive as props, so the
 *  two containers cannot drift apart and a future add-on stream joins the same selector. */
export function LibraryTitleDetail({ identityKey, title, subtitle, poster, backdrops, gallery, onGallery, facts, factsExtra, heroExtra, extras, description, chips, favorite, onToggleFavorite, favoriteDisabled, watched, onToggleWatched, watchedDisabled, watchedLabel, onOpenFolder, sources, initialSource, preferredSource, resumeStableKey, keepOrder, addonPriority, defaultSources, sourceGroups, onOpenSources, nativeSourceLabel, preferredLanguage, sourceProfiles = null, defaultSort = "recommended", sourceError, onRetry, placeholder, descriptionLoading, episodes, progress, onSourceChange, onClearProgress, onPlay, onSaveToLibrary, onSaveElsewhere, onDownloadToDevice, saveSupported, sourceBadge }: LibraryTitleDetailProps) {
  useI18n();
  const backdrop = useBackdrop(backdrops ?? []);
  const [chosen, setChosen] = useState<{ identity: string; key: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [clearing, setClearing] = useState<string | null>(null);
  const [cleared, setCleared] = useState<{ scope: string; position: number; duration: number } | null>(null);
  const arrowRef = useRef<HTMLButtonElement | null>(null);
  const playRef = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);

  // Another title opens over this one: the picker closes with it.
  useEffect(() => { setPickerOpen(false); }, [identityKey]);
  // Closing the picker hands the focus back to the arrow that opened it.
  useEffect(() => {
    if (wasOpen.current && !pickerOpen) arrowRef.current?.focus();
    wasOpen.current = pickerOpen;
  }, [pickerOpen]);

  // The title's own versions lead the picker, largest reported size first; the groups follow in
  // the order their plan gave. The default is the largest own version: a row that arrived from
  // another library or an addon is never chosen silently, though the viewer can still pick one.
  // The row the caller opened on leads the title's own versions when the listing does not hold it
  // yet, matched by row identity so two names for one file are never listed twice.
  const own = useMemo(() => {
    const order = keepOrder ? (streams: Stream[]) => streams : orderSources;
    const rows = order(playableSources(sources ?? []));
    if (!initialSource?.playable) return rows;
    const key = sourceRowKey(initialSource);
    return rows.some((stream) => sourceRowKey(stream) === key) ? rows : order([initialSource, ...rows]);
  }, [sources, initialSource, keepOrder]);
  const groups = sourceGroups?.groups ?? [];
  const resolvedSort = resolveStreamSort(defaultSort, sourceProfiles);
  const pickable = useMemo(() => librarySourceRows(
    librarySourceEntries(own, nativeSourceLabel ?? t("sources.localFilter"), groups, () => ""), "", "", resolvedSort, preferredLanguage ?? ""), [own, groups, nativeSourceLabel, preferredLanguage, resolvedSort]);
  const activeRuleId = sortRuleId(resolvedSort);
  const ruleAware = Boolean(activeRuleId && pickable.some((stream) => stream.rules?.[activeRuleId]));
  const defaultPick = defaultSources === null
    ? null
    : ruleAware
      ? pickDefaultStream(pickable, activeRuleId) ?? null
      : defaultSource(defaultSources === undefined ? own : defaultSources);
  const picked = chosen?.identity === identityKey ? pickable.find((stream) => sourceRowKey(stream) === chosen.key) : undefined;
  // The row this detail was opened on is the selection until the viewer picks another one: later
  // arrivals keep it, and while it is still on its way the default stands in for it.
  const seeded = initialSource && initialSource.playable
    ? pickable.find((stream) => sourceRowKey(stream) === sourceRowKey(initialSource)) : undefined;
  // The row the title's own stored position names, once the detail holds it: a switch is what
  // makes the next open land on the source it moved to. A row that is not here yet is simply not
  // a candidate, so a group still to load can never be selected for it.
  const stored = resumeStableKey ? pickable.find((row) => row.stableKey === resumeStableKey) : undefined;
  const preferred = preferredSource && preferredSource.playable
    ? pickable.find((row) => sourceRowKey(row) === sourceRowKey(preferredSource)) : undefined;
  const selected = picked ?? seeded ?? stored ?? preferred ?? defaultPick;
  const selectedLabel = selected ? streamLabel(selected) : "";
  const releaseFile = selected?.behaviorHints?.filename;
  const ruleRefusal = Boolean(ruleAware && !selected && pickable.some((stream) => stream.playable));
  const multiple = own.length > 1 || sourceGroups != null || ruleRefusal;
  const canSave = selected !== null && (saveSupported?.(selected) ?? true);
  // A device save is offered wherever the caller can hand the row to the server: a file of this
  // machine, an addon answer, and a media server's own original, whose projection carries the
  // account's own right the way its copy into a library does. Only a source that says no hides it.
  const canDownloadToDevice = Boolean(onDownloadToDevice && selected && selected.playable)
    && selected?.capabilities?.downloadToDevice !== false;
  // The tag a row wears: the transport the catalogue names it by (HTTP, RD, the provider, the local
  // chip), never the addon's own label, which travels as the row's caption instead. A caller's own
  // badge dresses a row that names no transport itself, and never overrides what the row's own
  // provider or the addon's answer says.
  const badgeOf = (stream: Stream) => {
    if (stream.addonName || stream.addonKey) return streamBadge(stream);
    // A copy another media server owns wears its own provider, never the one the detail was
    // opened on: the caller's badge is a fallback, not the row's identity.
    if (isRemoteStream(stream) && stream.provider) return providerLabel(stream.provider);
    return sourceBadge?.(stream) || (stream.provider ? providerLabel(stream.provider) : "")
      || stream.libraryName || t("sources.localBadge");
  };
  const choose = (stream: Stream) => {
    setChosen({ identity: identityKey, key: sourceRowKey(stream) });
    setPickerOpen(false);
  };
  const openPicker = () => {
    onOpenSources?.();
    setPickerOpen(true);
  };
  const playOrChoose = (fromBeginning?: boolean) => {
    if (selected && fromBeginning === undefined) onPlay(selected);
    else if (selected) onPlay(selected, fromBeginning);
    else if (ruleRefusal) openPicker();
  };

  const selectedKey = selected ? sourceIdentity(selected) : null;
  const selectionScope = `${identityKey}\0${selectedKey ?? ""}`;
  const currentScope = useRef(selectionScope);
  currentScope.current = selectionScope;
  // The chosen version is announced once per actual change, never on a re-render: a caller
  // reading the new version's state must not be asked again just because the tree redrew.
  const onChangeRef = useRef(onSourceChange);
  onChangeRef.current = onSourceChange;
  const explicitlyPicked = Boolean(picked);
  const announced = useRef<{ identity: string; key: string | null; explicitlyPicked: boolean } | null>(null);
  useEffect(() => {
    if (announced.current?.identity === identityKey && announced.current.key === selectedKey
      && announced.current.explicitlyPicked === explicitlyPicked) return;
    announced.current = { identity: identityKey, key: selectedKey, explicitlyPicked };
    onChangeRef.current?.(selected ? selected : null, explicitlyPicked);
  }, [identityKey, selectedKey, explicitlyPicked]);
  // A cleared version stays hidden until the selection moves on; the owner's own refresh then
  // says what the store really holds.
  useEffect(() => { setCleared(null); setClearing(null); }, [identityKey, selectedKey]);

  useEffect(() => {
    if (cleared?.scope === selectionScope && progress
      && (progress.position !== cleared.position || progress.duration !== cleared.duration)) setCleared(null);
  }, [cleared, selectionScope, progress?.position, progress?.duration]);

  const savedPosition = progress && selectedKey && progress.sourceKey === selectedKey && !(cleared?.scope === selectionScope
    && cleared.position === progress.position && cleared.duration === progress.duration)
    && Number.isFinite(progress.position) && progress.position > 0 ? progress : null;
  const fullDuration = Boolean(savedPosition && Number.isFinite(savedPosition.duration) && savedPosition.duration > 0);
  const percent = fullDuration ? Math.min(100, Math.max(0, Math.round((savedPosition!.position / savedPosition!.duration) * 100))) : 0;
  const clear = async (stream: Stream) => {
    if (!onClearProgress) return;
    const key = sourceIdentity(stream);
    const scope = selectionScope;
    const trigger = document.activeElement;
    const position = progress?.position ?? 0;
    const duration = progress?.duration ?? 0;
    if (clearing === key) return;
    setClearing(key);
    let done = false;
    try { done = await onClearProgress(stream); } catch { done = false; }
    if (currentScope.current !== scope) return;
    setClearing((current) => current === key ? null : current);
    if (done) {
      setCleared({ scope, position, duration });
      if (document.activeElement === trigger || (trigger instanceof HTMLElement && !trigger.isConnected && document.activeElement === document.body)) playRef.current?.focus();
    }
  };

  // The chips are the hero's own row rather than the first line of the copy: the corner art sits
  // beside that row, and a row it narrows is a row that wraps on a phone.
  const chipRow = chips || onToggleFavorite ? <div className="library-detail-chips">
      {onToggleFavorite && <button type="button" className={`watch-star${favorite ? " on" : ""}`} aria-pressed={favorite ?? false} disabled={favoriteDisabled ?? false}
        aria-label={t(favorite ? "favorite.remove" : "favorite.add")} title={t(favorite ? "favorite.remove" : "favorite.add")}
        onClick={() => onToggleFavorite(!(favorite ?? false))}><Star/></button>}
      {chips}
    </div> : undefined;
  const copy = <>
    <h2>{title}</h2>
    {subtitle && <p className="meta-line">{subtitle}</p>}
    {(facts || factsExtra) && <p className="meta-line">{facts}{facts && factsExtra ? " " : null}{factsExtra}</p>}
    {heroExtra}
    {descriptionLoading && !description
      ? <div className="library-detail-synopsis detail-skeleton" role="status" aria-label={t("common.loading")}><i/><i/><i/></div>
      : <p className="library-detail-synopsis">{description || t("catalog.noDescription")}</p>}
  </>;

  // The gallery is the same overlay the catalogue and a library row open; the corner only says how
  // many pictures it holds and, for a local title, that the saved ones are read when it is opened.
  const primary = gallery?.[0]?.url ?? poster;
  const trigger = primary && onGallery ? {
    image: primary,
    wide: gallery?.[0]?.shape === "wide",
    label: (gallery?.length ?? 0) > 1 ? t("gallery.stillCount", { count: gallery!.length }) : t("gallery.enlarge"),
    open: () => onGallery(gallery ?? [], undefined),
  } : undefined;

  return <div className="library-title-detail"
    style={backdrop ? { backgroundImage: `${LIBRARY_HERO_GRADIENT},url(${backdrop})` } : { backgroundImage: LIBRARY_HERO_EMPTY_GRADIENT }}>
    <DetailHero className="library-detail-hero"
      {...(chipRow ? { chips: chipRow } : {})}
      gallery={trigger ? <button type="button" className={`gallery-open ${trigger.wide ? "wide" : "poster"}`} title={t("gallery.openHint")} onClick={() => trigger.open()}>
        <img key={trigger.image} src={trigger.image} alt="" onError={hideBroken}/><span><Images/> {trigger.label}</span>
      </button> : undefined}
      copy={copy}/>
    {episodes}
    {sourceError ? <div className="remote-error" role="alert">
      <span>{sourceError}</span>
      {onRetry && <button type="button" onClick={onRetry}>{t("home.retry")}</button>}
    </div> : sources === null ? (placeholder === undefined
      // The row a picked source will fill, at its own height: nothing below it moves when it lands.
      ? <div className="library-detail-source detail-skeleton" role="status" aria-label={t("common.loading")}><i/></div> : placeholder)
      : !pickable.length ? (placeholder === undefined ? <><p className="identify-hint">{t("mediaServer.noSources")}</p><p className="identify-hint">{t("mediaServer.noSourcesHint")}</p></> : placeholder) : null}
    {savedPosition && <div className="library-detail-progress">
      {fullDuration && <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={t("player.position")}>
        <i style={{ width: `${percent}%` }}/>
      </div>}
      <span>{fullDuration
        ? t("library.savedPosition", { position: clock(savedPosition.position), duration: clock(savedPosition.duration) })
        : t("library.savedPositionUnknown", { position: clock(savedPosition.position) })}</span>
      {onClearProgress && <button type="button" className="icon-button" aria-label={t("home.forget")} title={t("home.forget")}
        disabled={clearing === selectedKey} onClick={() => selected && void clear(selected)}><RotateCcw/></button>}
    </div>}
    {/* What the buttons act on: the row the viewer has chosen, named and measured the way its own
        row reads, so Play, To library and To device visibly act on one version of the title. */}
    {!selected && ruleRefusal && <div className="library-detail-source">
      <span className="source-will-play">{t("detail.willPlay")}</span>
      <small>{t("detail.willPlayChoose")}</small>
    </div>}
    {selected && <div className="library-detail-source">
      <span className="source-will-play">{t("detail.willPlay")}</span>
      {!isLocalStream(selected) && <i className={isRemoteStream(selected) ? "remote" : undefined}>{badgeOf(selected)}</i>}
      <strong>{selectedLabel}</strong>
      {!isLocalStream(selected) && <small>{selected.addonName || [selected.provider ? providerLabel(selected.provider) : "", selected.libraryName].filter(Boolean).join(" · ")}</small>}
      {streamSize(selected) ? <b>{bytes(streamSize(selected)!)}</b> : null}
      <small>{streamLanguages(selected, preferredLanguage ?? "").map((code) => <em className="lang-badge" key={code}>{label(code)}</em>)}</small>
      {releaseFile && releaseFile !== selectedLabel ? <span className="source-file">{releaseFile}</span> : null}
    </div>}
    <div className="library-detail-actions">
      <div className="actions library-detail-play">
        {multiple ? <div className="split-button">
          <button ref={playRef} type="button" className="primary" disabled={!selected && !ruleRefusal} onClick={() => playOrChoose()}><CirclePlay/> {t("player.play")}</button>
          <button ref={arrowRef} type="button" className="split-button-toggle primary" aria-haspopup="dialog" aria-expanded={pickerOpen}
            aria-label={t("library.chooseSource")} title={t("library.chooseSource")} onClick={openPicker}><ChevronDown/></button>
        </div>
          : <button ref={playRef} type="button" className="primary" disabled={!selected && !ruleRefusal} onClick={() => playOrChoose()}><CirclePlay/> {t("player.play")}</button>}
      </div>
      {savedPosition && <button type="button" className="icon-button library-detail-icon-action" aria-label={t("player.playFromStart")} title={t("player.playFromStart")}
        onClick={() => playOrChoose(true)}><ListRestart/></button>}
      {/* Beside the position it belongs to, wherever a detail draws it: the two are the pair that
          reads and writes what the store holds for the row on screen. */}
      {onToggleWatched && <button type="button" className="icon-button library-detail-icon-action" aria-pressed={watched} disabled={watchedDisabled ?? false}
        aria-label={(watchedLabel ?? t(watched ? "mediaServer.markUnwatched" : "mediaServer.markWatched"))} title={(watchedLabel ?? t(watched ? "mediaServer.markUnwatched" : "mediaServer.markWatched"))}
        onClick={() => onToggleWatched()}>{watched === undefined ? <RotateCcw/> : <Check/>}</button>}
      {onSaveToLibrary && (onSaveElsewhere
        ? <div className="split-button library-detail-save">
          <button type="button" aria-label={t("save.toLibrary")} title={t("save.toLibrary")} disabled={!canSave}
            onClick={() => selected && canSave && onSaveToLibrary(selected)}><HardDrive/> <span className="library-detail-action-label">{t("save.toLibrary")}</span></button>
          <button type="button" className="split-button-toggle" aria-haspopup="dialog" aria-label={t("save.toLibraryElsewhere")} title={t("save.toLibraryElsewhere")} disabled={!canSave}
            onClick={() => selected && canSave && onSaveElsewhere(selected)}><ChevronDown/></button>
        </div>
        : <button type="button" aria-label={t("save.toLibrary")} title={t("save.toLibrary")} disabled={!canSave}
          onClick={() => selected && canSave && onSaveToLibrary(selected)}><HardDrive/> <span className="library-detail-action-label">{t("save.toLibrary")}</span></button>)}
      {canDownloadToDevice && <button type="button" aria-label={t("library.downloadToDevice")} title={t("library.downloadToDevice")}
        onClick={() => selected && onDownloadToDevice?.(selected)}><Download/> <span className="library-detail-action-label">{t("library.downloadToDevice")}</span></button>}
      {onOpenFolder && <button type="button" aria-label={t("library.openFolder")} title={t("library.openFolder")} onClick={onOpenFolder}><FolderOpen/> <span className="library-detail-action-label">{t("library.openFolder")}</span></button>}
    </div>
    {extras}
    {pickerOpen && <SourcePicker own={own} groups={groups} panel={sourceGroups} selected={selected} badgeOf={badgeOf} {...(addonPriority ? { priority: addonPriority } : {})}
      nativeLabel={nativeSourceLabel ?? t("sources.localFilter")} preferredLanguage={preferredLanguage ?? ""}
      sourceProfiles={sourceProfiles} defaultSort={defaultSort}
      onSelect={choose} onSortPick={(stream) => setChosen({ identity: identityKey, key: sourceRowKey(stream) })} onClose={() => setPickerOpen(false)}/>}
  </div>;
}

/** The destination picker beside Play: the same dialog shell as Save to…, one row per playable
 *  source with the catalogue's own filters and rows. Clicking a row chooses it and closes; Escape
 *  returns to the arrow. */
function SourcePicker({ own, groups, panel, selected, badgeOf, nativeLabel, preferredLanguage, priority, sourceProfiles, defaultSort, onSelect, onSortPick, onClose }: {
  priority?: Map<string, number>;
  own: Stream[];
  groups: LibrarySourceGroup[];
  panel?: LibrarySourcePanel;
  selected: Stream | null;
  badgeOf: (stream: Stream) => string;
  nativeLabel: string;
  preferredLanguage: string;
  sourceProfiles: SourceProfile[] | null;
  defaultSort: string;
  onSelect: (stream: Stream) => void;
  /** A change of sorting picks the row that order would play, and the dialog stays open. */
  onSortPick: (stream: Stream) => void;
  onClose: () => void;
}) {
  useI18n();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  useDialogFocus(overlayRef);
  useDialogViewport(overlayRef);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // The library panel is a container-query container, which would trap a fixed overlay inside it
  // and clip it; the dialog is portalled to the body so it covers the viewport as the shell intends.
  return createPortal(<div ref={overlayRef} tabIndex={-1} className="identify-overlay" role="dialog" aria-modal="true" aria-label={t("library.chooseSource")}
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="panel identify-card dialog-split library-source-card">
      <div className="identify-head">
        <h2>{t("library.chooseSource")}</h2>
        <button type="button" className="icon-button" aria-label={t("common.close")} onClick={onClose}><X/></button>
      </div>
      <div className="dialog-body">
        <p className="identify-hint">{t("mediaServer.versionsHint")}</p>
        <SourceChooser lead={own} leadLabel={nativeLabel} groups={groups} {...(panel ? { panel } : {})}
          selected={selected} onSelect={onSelect} preferredLanguage={preferredLanguage} badgeOf={badgeOf} {...(priority ? { priority } : {})}
          sourceProfiles={sourceProfiles} defaultSort={defaultSort} onSortPick={onSortPick}
          listClassName="stream-list remote-streams library-source-list"/>
      </div>
      <footer className="dialog-foot">
        <button type="button" onClick={onClose}>{t("common.close")}</button>
      </footer>
    </div>
  </div>, document.body);
}
