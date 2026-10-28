import { Check, HardDrive } from "lucide-react";
import { useMemo } from "react";
import { t, useI18n } from "./i18n";
import { label } from "./languages";
import { sourceRowKey } from "./library-detail-sources";
import { sourceProfileName } from "./source-profile-copy";
import { bytes } from "./settings-ui";
import { isLocalStream, isRemoteStream, resolveStreamSort, sortRuleId, streamBadge, streamLanguages, streamSize, type StreamSort } from "./streams";
import type { MediaServerProvider, SourceProfile, Stream } from "./types";
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

/** The class a lone row belongs to, named the way `useLibrarySources` names its groups: a place
 *  that leads a chooser with one row labels it as the group that row would have joined. */
export const streamGroupLabel = (stream: Stream): string =>
  isLocalStream(stream) ? t("sources.localFilter")
    : isRemoteStream(stream) ? [stream.provider ? providerLabel(stream.provider) : "", stream.libraryName].filter(Boolean).join(" · ")
      : stream.addonName ?? t("sources.heading");

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
  sort: { value: string; onChange: (value: StreamSort) => void };
  profiles?: SourceProfile[] | null;
}

export function SourceSortOptions({ profiles, value }: { profiles: SourceProfile[] | null; value: string }) {
  const resolved = resolveStreamSort(value, profiles);
  const rules = (profiles ?? []).filter((profile) => profile.template === "rules");
  const options = rules.map((profile) => ({
    value: `rule:${profile.id}`,
    label: sourceProfileName(profile.nameKey, profile.name),
  }));
  const fixed = new Set(["size-desc", "size-asc", "addon"]);
  if (!fixed.has(resolved) && !options.some((option) => option.value === resolved)) {
    const ruleId = sortRuleId(resolved);
    options.push({
      value: resolved,
      label: ruleId
        ? sourceProfileName(rules.find((profile) => profile.id === ruleId)?.nameKey, rules.find((profile) => profile.id === ruleId)?.name) || ruleId
        : t("sources.sortRecommended"),
    });
  }
  return <>
    {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    <option value="size-desc">{t("sources.sortLargest")}</option>
    <option value="size-asc">{t("sources.sortSmallest")}</option>
    <option value="addon">{t("sources.sortAddon")}</option>
  </>;
}

/** A place that was asked and had nothing is no choice to offer: picking it would only empty the
 *  list. The one already chosen stays, so the menu still says what is selected. */
const offered = (field: SourceFilterField): SourceFilterChoice[] =>
  field.options.filter((option) => option.count > 0 || option.value === field.value);

/** The source, language and order menus over one list of sources, drawn the same way in the
 *  catalogue and in a library detail. The caller owns the options and their counts. */
export function SourceFilters({ visible, addon, language, sort, profiles = null }: SourceFiltersProps) {
  useI18n();
  if (!visible) return null;
  const addonOptions = offered(addon);
  const languageOptions = language ? offered(language) : [];
  return <div className="stream-filters">
    <label><span>{t("sources.addon")}</span><select value={addon.value} onChange={(event) => addon.onChange(event.target.value)}>
      <option value="">{addon.all.label} ({addon.all.count})</option>
      {addonOptions.map((option) => <option key={option.value} value={option.value}>{option.label} ({option.count})</option>)}
    </select></label>
    {language && languageOptions.length > 0 && <label><span>{t("auth.language")}</span><select value={language.value} onChange={(event) => language.onChange(event.target.value)}>
      <option value="">{language.all.label} ({language.all.count})</option>
      {languageOptions.map((option) => <option key={option.value} value={option.value}>{option.label} ({option.count})</option>)}
    </select></label>}
    <label><span>{t("common.sorting")}</span><select value={resolveStreamSort(sort.value, profiles)} onChange={(event) => sort.onChange(event.target.value as StreamSort)}>
      <SourceSortOptions profiles={profiles} value={sort.value}/>
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
  ruleId?: string;
  className?: string;
  listRef?: React.RefObject<HTMLDivElement | null>;
  onScroll?: (event: React.UIEvent<HTMLDivElement>) => void;
}

/** One row per source: its class, its name, where it comes from, its size and its languages.
 *  Its own template, so the catalogue list and the library chooser can never drift apart. */
const RULE_REASONS = new Set(["language", "resolutionLow", "resolutionHigh", "cinema", "subtitles", "sample", "size", "provider", "torrent"]);

export function SourceRows({ rows, selected, onSelect, onPicked, probe, badgeOf, titleLanguage, ruleId, className, listRef, onScroll }: SourceRowsProps) {
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
      const audioInFile = probed.length > 0 || Boolean(stream.audioLanguages?.length && !stream.audioLanguagesGuessed);
      const badge = local ? undefined : badgeOf?.(stream) || streamBadge(stream);
      const source = local ? stream.libraryName : remote ? [stream.provider ? providerLabel(stream.provider) : "", stream.libraryName].filter(Boolean).join(" · ") : stream.addonName;
      const line = source && source !== badge ? source : "";
      const size = streamSize(stream);
      // Only reasons the app can name; a break with none of them says nothing.
      const verdict = ruleId ? stream.rules?.[ruleId] : undefined;
      const ruleReasons = verdict?.status === "breaks"
        ? verdict.reasons.filter((reason) => RULE_REASONS.has(reason)).map((reason) => t(`sources.ruleReason.${reason}`))
        : [];
      const ruleBreak = ruleReasons.length ? t("sources.ruleBreaks", { reasons: ruleReasons.join(", ") }) : "";
      return <button type="button" key={sourceRowKey(stream)} className={selected === stream ? "selected" : ""} aria-pressed={selected === stream}
        title={local ? t("sources.localHint") : remote ? t("sources.remoteHint") : undefined}
        onClick={() => { onPicked?.(); onSelect(stream); }}>
        <i className={local ? "local" : remote ? "remote" : stream.kind === "torrent" ? "rd" : stream.playable ? undefined : "ext"}>
          {local ? <><HardDrive/>{t("sources.localBadge")}</> : badge}
        </i>
        <span><strong>{streamLabel(stream)}</strong>{line && <small>{line}</small>}{ruleBreak && <small>{ruleBreak}</small>}</span>
        <span className="stream-meta">{size ? <b>{bytes(size)}</b> : null}
          <small>{languages.map((code) => <em className="lang-badge" key={code} title={audioInFile ? t("sources.audioInFile") : t("sources.languageGuess")}>{label(code)}</em>)}</small>
        </span>
        {selected === stream && <Check aria-hidden="true"/>}
      </button>;
    })}
  </div>;
}
