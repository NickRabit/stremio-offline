import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, CirclePlay, X } from "lucide-react";
import { DetailDescription, DetailHero } from "./DetailHero";
import { bytes, hideBroken } from "./settings-ui";
import { t, useI18n } from "./i18n";
import { defaultSource, orderSources, playableSources, sourceIdentity, sourceName } from "./library-detail-sources";
import type { Stream } from "./types";

export interface LibraryTitleDetailProps {
  /** Rebuilds the synopsis disclosure and scopes the viewer's source choice to one title. */
  identityKey: string;
  title: string;
  /** A line of context under the title, such as an episode's own numbering. */
  subtitle?: string;
  poster?: string;
  wide?: string;
  /** The metadata line: what the catalogue, the provider or the file record said. */
  facts?: ReactNode;
  description?: string;
  /** The kind, provider and library labels, as pills. */
  chips?: ReactNode;
  /** The favorite and watched controls, which stay local to whichever library owns the title. */
  actions?: ReactNode;
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
export function LibraryTitleDetail({ identityKey, title, subtitle, poster, wide, facts, description, chips, actions, sources, sourceError, onRetry, onPlay, sourceBadge }: LibraryTitleDetailProps) {
  useI18n();
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
  const summary = selected ? [sourceName(selected), sizeLabel(selected), selected.libraryName].filter(Boolean).join(" · ") : "";
  const choose = (stream: Stream) => {
    setChosen({ identity: identityKey, key: sourceIdentity(stream) });
    setPickerOpen(false);
  };

  const copy = <>
    {chips && <div className="title-chips">{chips}</div>}
    <h2>{title}</h2>
    {subtitle && <p className="meta-line">{subtitle}</p>}
    {facts && <p className="meta-line">{facts}</p>}
    <DetailDescription text={description} identityKey={identityKey}/>
  </>;

  return <div className="library-title-detail">
    <DetailHero className="library-detail-hero" background={wide || poster}
      gallery={poster ? <div className="library-detail-poster"><img key={poster} src={poster} alt="" onError={hideBroken}/></div> : undefined}
      copy={copy}/>
    {actions && <div className="library-detail-actions">{actions}</div>}
    <div className="subhead"><h3>{t("mediaServer.versions")}</h3></div>
    {sourceError ? <div className="remote-error" role="alert">
      <span>{sourceError}</span>
      {onRetry && <button type="button" onClick={onRetry}>{t("home.retry")}</button>}
    </div> : sources === null ? <div className="loading" role="status">{t("common.loading")}</div>
      : !pickable.length ? <><p className="identify-hint">{t("mediaServer.noSources")}</p><p className="identify-hint">{t("mediaServer.noSourcesHint")}</p></> : null}
    <div className="actions library-detail-play">
      {multiple ? <div className="split-button">
        <button className="primary" disabled={!selected} onClick={() => selected && onPlay(selected)}><CirclePlay/> {t("player.play")}</button>
        <button ref={arrowRef} type="button" className="split-button-toggle" aria-haspopup="dialog" aria-expanded={pickerOpen}
          aria-label={t("library.chooseSource")} title={t("library.chooseSource")} onClick={() => setPickerOpen(true)}><ChevronDown/></button>
      </div>
        : <button className="primary" disabled={!selected} onClick={() => selected && onPlay(selected)}><CirclePlay/> {t("player.play")}</button>}
    </div>
    {summary && <p className="identify-hint library-detail-source">{summary}</p>}
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
    const node = listRef.current?.querySelector<HTMLButtonElement>("button.selected, button");
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
