import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, CirclePlay, FolderOpen, Images, RotateCcw, Star, X } from "lucide-react";
import { DetailHero, LIBRARY_HERO_EMPTY_GRADIENT, LIBRARY_HERO_GRADIENT, useBackdrop } from "./DetailHero";
import type { GalleryImage } from "./gallery-images";
import { bytes, hideBroken } from "./settings-ui";
import { t, useI18n } from "./i18n";
import { defaultSource, orderSources, playableSources, sourceIdentity, sourceName } from "./library-detail-sources";
import type { Stream } from "./types";

export interface LibraryTitleDetailProps {
  /** Scopes the viewer's source choice to one title, so another title opens with a fresh default. */
  identityKey: string;
  title: string;
  /** A line of context under the title, such as an episode's own numbering. */
  subtitle?: string;
  poster?: string;
  /** The backdrops to try, best first: the first one that loads is the hero. Never a poster. */
  backdrops?: Array<string | undefined>;
  /** The pictures the gallery overlay will hold, computed by the caller from its own metadata. */
  gallery?: GalleryImage[];
  /** Opens the app's gallery overlay, optionally after reading the stored pictures at a path. */
  onGallery?: (images: GalleryImage[], path?: string) => void;
  /** The metadata line: what the catalogue, the provider or the file record said. */
  facts?: ReactNode;
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
  sourceError?: string;
  onRetry?: () => void;
  onPlay: (stream: Stream) => void;
  /** A source row's own tag; absent falls back to the library's name. */
  sourceBadge?: (stream: Stream) => string;
}

const sizeLabel = (stream: Stream) => {
  const value = stream.behaviorHints?.videoSize;
  return typeof value === "number" && value > 0 ? bytes(value) : "";
};

/** The one detail body a playable title shares, local or remote: the catalogue hero, the synopsis
 *  and the sources with a split Play button. The provider-specific parts arrive as props, so the
 *  two containers cannot drift apart and a future add-on stream joins the same selector. */
export function LibraryTitleDetail({ identityKey, title, subtitle, poster, backdrops, gallery, onGallery, facts, description, chips, favorite, onToggleFavorite, favoriteDisabled, watched, onToggleWatched, watchedDisabled, watchedLabel, onOpenFolder, sources, sourceError, onRetry, onPlay, sourceBadge }: LibraryTitleDetailProps) {
  useI18n();
  const backdrop = useBackdrop(backdrops ?? []);
  const [chosen, setChosen] = useState<{ identity: string; key: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const arrowRef = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);

  // Another title opens over this one: the picker closes with it.
  useEffect(() => { setPickerOpen(false); }, [identityKey]);
  // Closing the picker hands the focus back to the arrow that opened it.
  useEffect(() => {
    if (wasOpen.current && !pickerOpen) arrowRef.current?.focus();
    wasOpen.current = pickerOpen;
  }, [pickerOpen]);

  // Largest first, so the default the Play button uses is the row on top of the picker.
  const pickable = orderSources(playableSources(sources ?? []));
  const selected = (chosen?.identity === identityKey
    ? pickable.find((stream) => sourceIdentity(stream) === chosen.key) : undefined) ?? defaultSource(pickable);
  const multiple = pickable.length > 1;
  const badgeOf = (stream: Stream) => sourceBadge?.(stream) || stream.libraryName || t("sources.localBadge");
  const choose = (stream: Stream) => {
    setChosen({ identity: identityKey, key: sourceIdentity(stream) });
    setPickerOpen(false);
  };

  const copy = <>
    {chips}
    <h2>{title}</h2>
    {subtitle && <p className="meta-line">{subtitle}</p>}
    {facts && <p className="meta-line">{facts}</p>}
    <p className="library-detail-synopsis">{description || t("catalog.noDescription")}</p>
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
      gallery={trigger ? <button type="button" className={`gallery-open ${trigger.wide ? "wide" : "poster"}`} title={t("gallery.openHint")} onClick={() => trigger.open()}>
        <img key={trigger.image} src={trigger.image} alt="" onError={hideBroken}/><span><Images/> {trigger.label}</span>
      </button> : undefined}
      copy={copy}/>
    {sourceError ? <div className="remote-error" role="alert">
      <span>{sourceError}</span>
      {onRetry && <button type="button" onClick={onRetry}>{t("home.retry")}</button>}
    </div> : sources === null ? <div className="loading" role="status">{t("common.loading")}</div>
      : !pickable.length ? <><p className="identify-hint">{t("mediaServer.noSources")}</p><p className="identify-hint">{t("mediaServer.noSourcesHint")}</p></> : null}
    <div className="library-detail-actions">
      <div className="actions library-detail-play">
        {multiple ? <div className="split-button">
          <button className="primary" disabled={!selected} onClick={() => selected && onPlay(selected)}><CirclePlay/> {t("player.play")}</button>
          <button ref={arrowRef} type="button" className="split-button-toggle" aria-haspopup="dialog" aria-expanded={pickerOpen}
            aria-label={t("library.chooseSource")} title={t("library.chooseSource")} onClick={() => setPickerOpen(true)}><ChevronDown/></button>
        </div>
          : <button className="primary" disabled={!selected} onClick={() => selected && onPlay(selected)}><CirclePlay/> {t("player.play")}</button>}
      </div>
      {onToggleFavorite && <button type="button" className="icon-button" aria-pressed={favorite ?? false} disabled={favoriteDisabled ?? false}
        aria-label={t(favorite ? "favorite.remove" : "favorite.add")} title={t(favorite ? "favorite.remove" : "favorite.add")}
        onClick={() => onToggleFavorite(!(favorite ?? false))}><Star fill={favorite ? "currentColor" : "none"}/></button>}
      {onToggleWatched && <button type="button" className="icon-button" aria-pressed={watched} disabled={watchedDisabled ?? false}
        aria-label={(watchedLabel ?? t(watched ? "mediaServer.markUnwatched" : "mediaServer.markWatched"))} title={(watchedLabel ?? t(watched ? "mediaServer.markUnwatched" : "mediaServer.markWatched"))}
        onClick={() => onToggleWatched()}>{watched === undefined ? <RotateCcw/> : <Check/>}</button>}
      {onOpenFolder && <button type="button" onClick={onOpenFolder}><FolderOpen/> {t("library.openFolder")}</button>}
    </div>
    {pickerOpen && <SourcePicker sources={pickable} selected={selected} badgeOf={badgeOf} onSelect={choose} onClose={() => setPickerOpen(false)}/>}
  </div>;
}

/** The destination picker beside Play: the same dialog shell as Save to…, one row per playable
 *  source. Clicking a row chooses it and closes; Escape returns to the arrow. */
function SourcePicker({ sources, selected, badgeOf, onSelect, onClose }: {
  sources: Stream[];
  selected: Stream | null;
  badgeOf: (stream: Stream) => string;
  onSelect: (stream: Stream) => void;
  onClose: () => void;
}) {
  useI18n();
  const listRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLButtonElement>("button.selected") ?? listRef.current?.querySelector<HTMLButtonElement>("button");
    node?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const selectedKey = selected ? sourceIdentity(selected) : "";
  // The library panel is a container-query container, which would trap a fixed overlay inside it
  // and clip it; the dialog is portalled to the body so it covers the viewport as the shell intends.
  return createPortal(<div ref={overlayRef} className="identify-overlay" role="dialog" aria-modal="true" aria-label={t("library.chooseSource")}
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key !== "Tab") return;
      const controls = [...(overlayRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="panel identify-card dialog-split library-source-card">
      <div className="identify-head">
        <h2>{t("library.chooseSource")}</h2>
        <button type="button" className="icon-button" aria-label={t("common.close")} onClick={onClose}><X/></button>
      </div>
      <div className="dialog-body">
        <p className="identify-hint">{t("mediaServer.versionsHint")}</p>
        <div className="remote-streams library-source-list" ref={listRef}>
          {sources.map((stream) => {
            const key = sourceIdentity(stream);
            const line = [sizeLabel(stream), badgeOf(stream) === stream.libraryName ? "" : stream.libraryName].filter(Boolean).join(" · ");
            return <button type="button" key={key} className={key === selectedKey ? "selected" : ""} aria-pressed={key === selectedKey} onClick={() => onSelect(stream)}>
              <i className="library-badge">{badgeOf(stream)}</i>
              <span><strong>{sourceName(stream)}</strong>{line && <small>{line}</small>}</span>
              {key === selectedKey && <Check aria-hidden="true"/>}
            </button>;
          })}
        </div>
      </div>
      <footer className="dialog-foot">
        <button type="button" onClick={onClose}>{t("common.close")}</button>
      </footer>
    </div>
  </div>, document.body);
}
