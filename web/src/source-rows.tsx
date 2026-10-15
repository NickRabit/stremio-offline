import { Check, HardDrive } from "lucide-react";
import { useMemo } from "react";
import { t, useI18n } from "./i18n";
import { label } from "./languages";
import { sourceRowKey } from "./library-detail-sources";
import { bytes } from "./settings-ui";
import { isLocalStream, isRemoteStream, streamBadge, streamLanguages, streamSize, type StreamSort } from "./streams";
import type { MediaServerProvider, Stream } from "./types";
import type { SourceFilterChoice } from "./library-sources";

/** The name a row shows, exactly as the catalogue's own list reads it: a local copy leads with the
 *  file name it carries, and every other row with what the addon or the media server called the
 *  version -- a file name never displaces an addon's own quality label. */
export const streamLabel = (stream: Stream): string =>
  isLocalStream(stream) && stream.behaviorHints?.filename
    ? stream.behaviorHints.filename
    : stream.name || stream.title?.split("\n")[0] || stream.description?.split("\n")[0] || t("tv.version");

/** The one label a provider is named by, wherever a row or a filter names it. */
export const providerLabel = (provider: MediaServerProvider): string =>
  t(provider === "emby" ? "mediaServer.provider.emby" : "mediaServer.provider.jellyfin");

/** One filter menu: the value it holds, what "no filter" says and the options beside it. */
export interface SourceFilterField {
  value: string;
  onChange: (value: string) => void;
  all: { label: string; count: number };
  options: SourceFilterChoice[];
}

export interface SourceFiltersProps {
  /** The menus only earn their place beside more than one class of source. */
  visible: boolean;
  addon: SourceFilterField;
  language?: SourceFilterField;
  sort: { value: StreamSort; onChange: (value: StreamSort) => void };
}

/** The source, language and order menus over one list of sources, drawn the same way in the
 *  catalogue and in a library detail. The caller owns the options and their counts. */
export function SourceFilters({ visible, addon, language, sort }: SourceFiltersProps) {
  useI18n();
  if (!visible) return null;
  return <div className="stream-filters">
    <label><span>{t("sources.addon")}</span><select value={addon.value} onChange={(event) => addon.onChange(event.target.value)}>
      <option value="">{addon.all.label} ({addon.all.count})</option>
      {addon.options.map((option) => <option key={option.value} value={option.value}>{option.label} ({option.count})</option>)}
    </select></label>
    {language && language.options.length > 0 && <label><span>{t("auth.language")}</span><select value={language.value} onChange={(event) => language.onChange(event.target.value)}>
      <option value="">{language.all.label} ({language.all.count})</option>
      {language.options.map((option) => <option key={option.value} value={option.value}>{option.label} ({option.count})</option>)}
    </select></label>}
    <label><span>{t("common.sorting")}</span><select value={sort.value} onChange={(event) => sort.onChange(event.target.value as StreamSort)}>
      <option value="recommended">{t("sources.sortRecommended")}</option>
      <option value="size-desc">{t("sources.sortLargest")}</option>
      <option value="size-asc">{t("sources.sortSmallest")}</option>
      <option value="addon">{t("sources.sortAddon")}</option>
    </select></label>
  </div>;
}

export interface SourceRowsProps {
  rows: Stream[];
  /** The row drawn as chosen, by object identity inside `rows`. */
  selected: Stream | null;
  onSelect: (stream: Stream) => void;
  /** Told the moment a row is picked, so a caller can keep that choice across later answers. */
  onPicked?: () => void;
  /** The languages read from the played file itself, which beat the guessed ones for its row. */
  probe?: (stream: Stream) => string[];
  /** The badge a row wears when it is not a local copy; an addon row names itself instead. */
  badgeOf?: (stream: Stream) => string;
  /** The language the title itself is in, standing in for a source that admitted none. */
  titleLanguage?: string;
  className?: string;
  listRef?: React.RefObject<HTMLDivElement | null>;
  onScroll?: (event: React.UIEvent<HTMLDivElement>) => void;
}

/** One row per source: its class, its name, where it comes from, its size and its languages.
 *  Its own template, so the catalogue list and the library chooser can never drift apart. */
export function SourceRows({ rows, selected, onSelect, onPicked, probe, badgeOf, titleLanguage, className, listRef, onScroll }: SourceRowsProps) {
  useI18n();
  // One row per source: two groups may hand out the very same source again, and a row React
  // cannot tell from another would both warn and lose the focus the viewer left on it. The
  // first occurrence keeps the place it was ranked into.
  const listed = useMemo(() => {
    const seen = new Set<string>();
    return rows.filter((stream) => !seen.has(sourceRowKey(stream)) && (seen.add(sourceRowKey(stream)), true));
  }, [rows]);
  return <div className={className ?? "stream-list"} ref={listRef} {...(onScroll ? { onScroll } : {})}>
    {listed.map((stream) => {
      const local = isLocalStream(stream);
      const remote = isRemoteStream(stream);
      const probed = probe?.(stream) ?? [];
      const languages = probed.length ? probed : streamLanguages(stream, titleLanguage);
      const badge = local ? undefined : badgeOf?.(stream) || streamBadge(stream);
      const source = local ? stream.libraryName : remote ? [stream.provider ? providerLabel(stream.provider) : "", stream.libraryName].filter(Boolean).join(" · ") : stream.addonName;
      const line = source && source !== badge ? source : "";
      const size = streamSize(stream);
      return <button type="button" key={sourceRowKey(stream)} className={selected === stream ? "selected" : ""} aria-pressed={selected === stream}
        title={local ? t("sources.localHint") : remote ? t("sources.remoteHint") : undefined}
        onClick={() => { onPicked?.(); onSelect(stream); }}>
        <i className={local ? "local" : remote ? "remote" : stream.kind === "torrent" ? "rd" : stream.playable ? undefined : "ext"}>
          {local ? <><HardDrive/>{t("sources.localBadge")}</> : badge}
        </i>
        <span><strong>{streamLabel(stream)}</strong>{line && <small>{line}</small>}</span>
        <span className="stream-meta">{size ? <b>{bytes(size)}</b> : null}
          <small>{languages.map((code) => <em className="lang-badge" key={code} title={probed.length ? t("sources.audioInFile") : t("sources.languageGuess")}>{label(code)}</em>)}</small>
        </span>
        {selected === stream && <Check aria-hidden="true"/>}
      </button>;
    })}
  </div>;
}
