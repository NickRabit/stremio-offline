import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { AddonLogo } from "./AddonLogo";
import {
  browseMembers,
  browseBucket,
  bucketsPresent,
  catalogGroups,
  catalogRefKey,
  recentCatalogs,
  refOf,
  sameRef,
  typeBucket,
  type CatalogRef,
  type BrowseCatalog,
  type TypeBucket,
} from "./catalog-picker-model";
import { catalogTypeTag } from "./catalog-labels";
import { useDialogFocus } from "./dialog-focus";
import { useDialogViewport } from "./dialog-viewport";
import { FilterTabs } from "./FilterTabs";
import { t, useI18n } from "./i18n";
import { PickerDialog, type PickerOption } from "./PickerDialog";

export interface CatalogPickerPrefs { recentCount: 0 | 3 | 5 | 8; recent: CatalogRef[]; hiddenAddons: string[] }
export interface CatalogPickerProps {
  catalogs: BrowseCatalog[];
  current: CatalogRef;
  prefs: CatalogPickerPrefs;
  logos?: Record<string, string | undefined>;
  onPick: (ref: CatalogRef) => void;
  /** The type the list opens on; the switch inside only changes which list is shown. */
  initialBucket?: TypeBucket;
  onPrefs: (patch: Partial<CatalogPickerPrefs>) => void;
  onClose: () => void;
}

const RECENT_COUNTS: CatalogPickerPrefs["recentCount"][] = [0, 3, 5, 8];

const wideFinePointer = (): boolean => {
  const narrow = typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(max-width: 700px), (max-height: 500px)").matches;
  const coarse = typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(pointer: coarse)").matches;
  return !narrow && !(typeof navigator !== "undefined" && navigator.maxTouchPoints > 0) && !coarse;
};

const bucketLabel = (bucket: TypeBucket): string =>
  bucket === "all" ? t("common.all") : bucket === "movie" ? t("catalog.movies") : bucket === "series" ? t("catalog.series") : t("catalog.typeOther");

const onlyTypeTag = (type: string): ReactNode =>
  <span className="picker-tag picker-tag-type">{type === "movie" ? t("picker.onlyMovies") : t("picker.onlySeries")}</span>;

export function CatalogPicker({ catalogs, current, prefs, logos, onPick, initialBucket, onPrefs, onClose }: CatalogPickerProps) {
  useI18n();
  const [query, setQuery] = useState("");
  const [includeHidden, setIncludeHidden] = useState(false);
  const [editing, setEditing] = useState(false);
  const [currentBucket, setBucket] = useState<TypeBucket>(initialBucket ?? (current.combined ? "all" : typeBucket(current.type)));
  const present = bucketsPresent(catalogs);
  const groups = useMemo(() => catalogGroups(catalogs, {
    bucket: currentBucket,
    query,
    hiddenAddons: prefs.hiddenAddons,
    includeHidden,
  }), [catalogs, currentBucket, includeHidden, prefs.hiddenAddons, query]);
  const recent = useMemo(() => recentCatalogs(catalogs, prefs.recent.filter((ref) => includeHidden || !prefs.hiddenAddons.includes(ref.addonKey)), prefs.recentCount),
    [catalogs, prefs.recent, prefs.recentCount, prefs.hiddenAddons, includeHidden]);
  const hiddenPresent = new Set(catalogs.map((catalog) => catalog.addonKey).filter((key) => prefs.hiddenAddons.includes(key)));
  const filtering = Boolean(query.trim());
  const groupCount = (group: (typeof groups)[number]) => filtering ? group.rows.length : group.countInBucket;
  const count = groups.reduce((total, group) => total + groupCount(group), 0);

  const chips = recent.length && !query.trim() ? {
    title: t("picker.recent"),
    options: recent.map((catalog): PickerOption => {
      const ref = refOf(catalog);
      return {
        key: catalogRefKey(ref),
        label: catalog.name ?? catalog.id,
        sublabel: catalog.addonName,
        selected: sameRef(ref, current),
        tags: browseBucket(catalog) !== currentBucket ? <span className="picker-tag picker-tag-type">{catalog[browseMembers] ? t("catalog.moviesAndSeries") : catalogTypeTag(catalog.type)}</span> : undefined,
        onChoose: () => onPick(ref),
      };
    }),
  } : undefined;

  const pickerGroups = groups.map((group) => ({
    key: group.addonKey,
    title: group.addonName,
    icon: <AddonLogo addonKey={group.addonKey} name={group.addonName} src={logos?.[group.addonKey]}/>,
    badge: group.hidden ? <span className="picker-badge">{t("picker.hiddenBadge")}</span> : undefined,
    count: groupCount(group),
    note: group.notBrowsable > 0 ? t("picker.notBrowsable", { count: group.notBrowsable }) : undefined,
    options: group.rows.map((row): PickerOption => ({
      key: catalogRefKey(row.ref),
      label: row.name,
      selected: sameRef(row.ref, current),
      muted: row.otherType,
      tags: row.otherType || row.onlyType || typeBucket(row.ref.type) === "other" || row.needsSearch ? <>
        {(row.otherType || typeBucket(row.ref.type) === "other") && <span className="picker-tag picker-tag-type">{catalogTypeTag(row.ref.type)}</span>}
        {row.onlyType && onlyTypeTag(row.onlyType)}
        {row.needsSearch && <span className="picker-tag picker-tag-search">{t("picker.needsSearch")}</span>}
      </> : undefined,
      onChoose: () => onPick(row.ref),
    })),
  }));

  if (editing) return <CatalogPickerEdit catalogs={catalogs} prefs={prefs} onPrefs={onPrefs}
    onDone={() => setEditing(false)} onClose={onClose}/>;

  const segments = <FilterTabs className="picker-segments" label={t("catalog.type")} value={currentBucket} onChange={setBucket}
    tabs={present.map((bucket) => ({ value: bucket, label: bucketLabel(bucket) }))}/>;

  return <PickerDialog label={t("catalog.pickerTitle")} subtitle={filtering ? `${t("catalog.results")} · ${count}` : t(currentBucket === "all" ? "catalog.pickerCountAll" : "catalog.pickerCount", { count })}
    searchPlaceholder={t("picker.searchCatalog")} query={query} onQuery={setQuery}
    headerExtra={segments} chips={chips} groups={pickerGroups} rail accordion openGroup={current.addonKey}
    empty={<><p>{t("picker.noMatch", { query })}</p><p>{t("picker.noMatchHint")}</p></>}
    footer={<>
      {groups.some((group) => group.rows.some((row) => row.otherType)) && <p className="identify-hint">{t("picker.otherTypeHint")}</p>}
      <div className="picker-foot-actions">
        {wideFinePointer() && <span className="picker-keys">{t("picker.keys")}</span>}
        {!query.trim() && hiddenPresent.size > 0 && <button type="button" aria-pressed={includeHidden}
          onClick={() => setIncludeHidden((shown) => !shown)}>{includeHidden ? t("picker.hideHidden") : t("picker.showHidden", { count: hiddenPresent.size })}</button>}
        <button type="button" onClick={() => setEditing(true)}>{t("picker.edit")}</button>
      </div>
    </>}
    onClose={onClose}/>;
}

function CatalogPickerEdit({ catalogs, prefs, onPrefs, onDone, onClose }: {
  catalogs: BrowseCatalog[];
  prefs: CatalogPickerPrefs;
  onPrefs: (patch: Partial<CatalogPickerPrefs>) => void;
  onDone: () => void;
  onClose: () => void;
}) {
  useI18n();
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog);
  useDialogViewport(dialog);
  // Esc leaves the editor for the list it was opened from; the close button and the backdrop close.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);
  const addons = useMemo(() => {
    const grouped = new Map<string, { name: string; ids: Set<string> }>();
    for (const catalog of catalogs) {
      const addon = grouped.get(catalog.addonKey);
      if (addon) addon.ids.add(catalog.id);
      else grouped.set(catalog.addonKey, { name: catalog.addonName, ids: new Set([catalog.id]) });
    }
    return [...grouped.entries()].map(([key, addon]) => [key, { name: addon.name, count: addon.ids.size }] as const);
  }, [catalogs]);

  const toggleAddon = (addonKey: string, visible: boolean) => {
    onPrefs({
      hiddenAddons: visible
        ? prefs.hiddenAddons.filter((key) => key !== addonKey)
        : [...prefs.hiddenAddons, addonKey],
    });
  };

  return <div ref={dialog} tabIndex={-1} className="identify-overlay" role="dialog" aria-modal="true"
    aria-label={t("catalog.pickerTitle")} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="panel identify-card dialog-split picker-card">
      <div className="identify-head picker-head"><h2>{t("catalog.pickerTitle")}</h2>
        <button type="button" className="icon-button" aria-label={t("common.close")} onClick={onClose}><X/></button></div>
      <div className="dialog-body picker-edit-body">
        <section className="picker-edit-section">
          <h3>{t("picker.recent")}</h3>
          <div className="filter-tabs picker-segments" role="group" aria-label={t("picker.recent")}>
            {RECENT_COUNTS.map((count) => <button key={count} type="button" className={count === prefs.recentCount ? "active" : undefined}
              aria-pressed={count === prefs.recentCount} onClick={() => onPrefs({ recentCount: count })}>
              {count ? String(count) : t("picker.recentOff")}
            </button>)}
          </div>
          <button type="button" disabled={!prefs.recent.length} onClick={() => onPrefs({ recent: [] })}>{t("picker.recentClear")}</button>
          <p className="identify-hint">{t("picker.recentHint")}</p>
        </section>
        <section className="picker-edit-section">
          <h3>{t("picker.showInPicker")}</h3>
          <div className="picker-addon-list">
            {addons.map(([addonKey, addon]) => <label className="picker-addon-row" key={addonKey}>
              <span className="switch"><input type="checkbox" checked={!prefs.hiddenAddons.includes(addonKey)}
                onChange={(event) => toggleAddon(addonKey, event.target.checked)}/><span/></span>
              <AddonLogo addonKey={addonKey} name={addon.name}/>
              <span className="picker-addon-copy"><strong>{addon.name}</strong><small>{t("picker.addonCatalogs", { count: addon.count })}</small></span>
            </label>)}
          </div>
          <p className="identify-hint">{t("picker.hiddenHint")}</p>
        </section>
      </div>
      <footer className="dialog-foot"><button type="button" className="primary" onClick={onDone}>{t("picker.done")}</button></footer>
    </div>
  </div>;
}
