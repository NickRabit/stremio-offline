import { useEffect, useMemo, useRef, useState } from "react";
import { t, useI18n } from "./i18n";
import { librarySourceChoices, librarySourceEntries, librarySourceRows, type LibrarySourceGroup, type LibrarySourcePanel } from "./library-sources";
import { sourceRowKey } from "./library-detail-sources";
import { providerLabel, SourceFilters, SourceRows } from "./source-rows";
import { addonNotices, isLocalStream, noticeText, resolveStreamSort, sortRuleId, type StreamOrder, type StreamSort } from "./streams";
import type { SourceProfile, Stream } from "./types";

export interface SourceChooserProps {
  /** The rows the place leads with: the item's own versions, the file on screen, the row the
   *  catalogue played. They head the list under `leadLabel`. */
  lead: Stream[];
  leadLabel: string;
  /** Every other group of the title, from `useLibrarySources`. */
  groups: LibrarySourceGroup[];
  panel?: LibrarySourcePanel;
  selected: Stream | null;
  onSelect: (stream: Stream) => void;
  preferredLanguage: string;
  badgeOf?: (stream: Stream) => string;
  /** Optional class for the list, so the dialog and the player can size it. */
  listClassName?: string;
  /** The viewer's addon order, when the place knows it; else the order the groups arrived in. */
  priority?: Map<string, number>;
  sourceProfiles?: SourceProfile[] | null;
  defaultSort?: string;
}

/** The row of `rows` the place holds: the very object, or the row that names the same source --
 *  the playing row and the session are minted apart for one library file. Identity wins first:
 *  two libraries may hand out one media-source id for two different copies. */
const rowOf = (rows: Stream[], selected: Stream | null) => selected
  ? rows.find((row) => row === selected)
    ?? rows.find((row) => (selected.sourceId.length > 0 && row.sourceId === selected.sourceId)
      || (Boolean(selected.localPath) && row.localPath === selected.localPath))
    ?? (selected.stableKey ? rows.find((row) => row.stableKey === selected.stableKey) : undefined)
    ?? null
  : null;

/** One source across two listings: the server mints a fresh source id for every listing, so a row
 *  the place read itself and the same row a group read later meet by the key the source is stored
 *  under, not by their ids. */
const sameSource = (stream: Stream) => stream.remoteItem || stream.localPath ? sourceRowKey(stream) : stream.stableKey ?? sourceRowKey(stream);

/** The one chooser body every place draws: the classes a title offers, the source, language and
 *  order menus over them, and the notices that go with them. The detail's dialog and the
 *  player's panel both render it, so one title reads the same wherever it is offered. */
export function SourceChooser({ lead, leadLabel, groups: read, panel, selected, onSelect, preferredLanguage, badgeOf, listClassName, priority, sourceProfiles = null, defaultSort = "recommended" }: SourceChooserProps) {
  useI18n();
  const [filter, setFilter] = useState("");
  const [language, setLanguage] = useState("");
  const [sort, setSort] = useState<StreamOrder>(() => resolveStreamSort(defaultSort, sourceProfiles));
  const resolvedSort = resolveStreamSort(sort, sourceProfiles);
  const defaultRuleId = sortRuleId(resolveStreamSort(defaultSort, sourceProfiles));
  const listRef = useRef<HTMLDivElement | null>(null);
  // A place that leads with the viewer's own copies would name the file it holds twice, once as a
  // lead row and once in the own-copies group: the group drops the rows the lead already holds,
  // and a group it empties stops being a menu entry of its own.
  const groups = useMemo(() => {
    if (!lead.length || !lead.every(isLocalStream)) return read;
    const held = new Set(lead.map(sourceRowKey));
    return read.map((group) => group.kind === "local" ? { ...group, streams: group.streams.filter((stream) => !held.has(sourceRowKey(stream))) } : group);
  }, [lead, read]);
  const labelOf = (group: LibrarySourceGroup) =>
    group.kind === "discovery" || group.kind === "addon" ? group.name
      : group.provider ? `${providerLabel(group.provider)} · ${group.name}` : t("sources.localFilter");
  // A lead of addon or media-server rows that a loaded group also answers is listed under that
  // group, by its own name: one source is one row in one class, never "Sources" and the addon both.
  const shownLead = useMemo(() => {
    // The player leads with the bare row it plays; the own-copies group knows the same file with
    // its size and library, so the lead is drawn from that fuller row.
    if (lead.every(isLocalStream)) {
      const known = new Map(read.filter((group) => group.kind === "local").flatMap((group) => group.streams).map((stream) => [sourceRowKey(stream), stream]));
      return lead.map((row) => known.get(sourceRowKey(row)) ?? row);
    }
    const answered = new Set(groups.filter((group) => group.status === "loaded").flatMap((group) => group.streams.filter((stream) => stream.playable).map(sameSource)));
    return lead.filter((row) => !answered.has(sameSource(row)));
  }, [lead, groups, read]);
  const entries = useMemo(() => librarySourceEntries(shownLead, leadLabel, groups, labelOf), [shownLead, leadLabel, groups]);
  const choices = useMemo(() => librarySourceChoices(entries, filter, language), [entries, filter, language]);
  // The row the place holds leads the classes the list orders itself -- the rule and
  // addon-priority orders, the way every player drew the source that was playing. A named size
  // sort ranks it with every other row: the viewer asked for the sizes, not for the row.
  const rows = useMemo(() => {
    const listed = librarySourceRows(entries, filter, language, resolvedSort, preferredLanguage, undefined, priority);
    const first = resolvedSort === "recommended" || sortRuleId(resolvedSort) || resolvedSort === "addon"
      ? rowOf(listed, selected)
      : null;
    return first ? [first, ...listed.filter((row) => row !== first)] : listed;
  }, [entries, filter, language, resolvedSort, preferredLanguage, selected, priority]);
  const chosen = rowOf(rows, selected);
  /** A discovery or a group still out: the list is not empty yet, it is still arriving. */
  const pending = groups.some((group) => group.status === "idle" || group.status === "loading");
  const notices = addonNotices(groups.filter((group) => group.kind === "addon" && group.status === "loaded").flatMap((group) => group.streams));
  // The place that opened the chooser hands the keyboard to the row it holds, or to the first one.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLButtonElement>("button.selected") ?? listRef.current?.querySelector<HTMLButtonElement>("button");
    node?.focus();
  }, []);
  return <>
    <SourceFilters visible={groups.length > 0 || lead.length > 1} addon={{
      value: filter, onChange: setFilter, all: { label: t("sources.allSources"), count: choices.total }, options: choices.options,
    }} profiles={sourceProfiles} {...(choices.languages.length ? { language: {
      value: language, onChange: setLanguage, all: { label: t("sources.anyLanguage"), count: choices.languageTotal }, options: choices.languages,
    } } : {})} sort={{ value: resolvedSort, onChange: (value: StreamSort) => setSort(value) }}/>
    {notices.map((notice) => <p className="notice" key={notice.sourceId}><b>{notice.addonName}</b> {noticeText(notice)}</p>)}
    <SourceRows className={listClassName ?? "stream-list"} rows={rows} selected={chosen} onSelect={onSelect}
      ruleId={sortRuleId(resolvedSort) ?? defaultRuleId}
      badgeOf={badgeOf} listRef={listRef}/>
    {pending && <p className="identify-hint" role="status">{t("sources.askingOthers")}</p>}
    {/* One line for the whole list, never one per silent library: seven libraries that found
        nothing are one fact, and the per-group failures below keep their own retry. */}
    {!rows.length && !pending && <p className="identify-hint" role="status">{filter || language
      ? t("sources.noneMatchFilter", { count: filter ? entries.find((entry) => entry.key === filter)?.streams.length ?? 0 : choices.total })
      : t("sources.none")}</p>}
    {/* The filters emptied a list that is not empty: the way back is the one the catalogue
        offers, clearing both menus at once. */}
    {!rows.length && !pending && Boolean(filter || language) && <p className="identify-hint">
      <button type="button" className="link-button" onClick={() => { setFilter(""); setLanguage(""); }}>{t("sources.clearFilters")}</button>
    </p>}
    {groups.filter((group) => group.status === "error").map((group) => <p className="notice" role="alert" key={group.key}>
      <b>{labelOf(group)}</b> {group.error}
      {panel && <button type="button" className="link-button" onClick={() => panel.retry(group.key)}>{t("home.retry")}</button>}
    </p>)}
  </>;
}
