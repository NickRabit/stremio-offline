import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { AddonLogo } from "./AddonLogo";
import {
  bucketsPresent,
  catalogGroups,
  fallbackForBucket,
  recentCatalogs,
  refOf,
  sameRef,
  typeBucket,
  type CatalogRef,
  type TypeBucket,
} from "./catalog-picker-model";
import { catalogTypeTag } from "./catalog-labels";
import { useDialogFocus } from "./dialog-focus";
import { useDialogViewport } from "./dialog-viewport";
import { t, useI18n } from "./i18n";
import { PickerDialog, type PickerOption } from "./PickerDialog";
import type { Catalog } from "./types";

export interface CatalogPickerPrefs { recentCount: 0 | 3 | 5 | 8; recent: CatalogRef[]; hiddenAddons: string[] }
export interface CatalogPickerProps {
  catalogs: Catalog[];
  current: CatalogRef;
  prefs: CatalogPickerPrefs;
  logos?: Record<string, string | undefined>;
  onPick: (ref: CatalogRef) => void;
  onBucket: (bucket: TypeBucket) => void;
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
  bucket === "movie" ? t("catalog.movies") : bucket === "series" ? t("catalog.series") : t("catalog.typeOther");

const otherTypeTag = (type: string): ReactNode => {
  const label = type === "movie" ? t("picker.onlyMovies") : type === "series" ? t("picker.onlySeries") : type;
  return <span className="picker-tag picker-tag-type">{label}</span>;
};

export function CatalogPicker({ catalogs, current, prefs, logos, onPick, onBucket, onPrefs, onClose }: CatalogPickerProps) {
  useI18n();
  const [query, setQuery] = useState("");
  const [includeHidden, setIncludeHidden] = useState(false);
  const [editing, setEditing] = useState(false);
  const currentBucket = typeBucket(current.type);
  const present = bucketsPresent(catalogs);
  const groups = useMemo(() => catalogGroups(catalogs, {
    bucket: currentBucket,
    query,
    hiddenAddons: prefs.hiddenAddons,
    includeHidden,
  }), [catalogs, currentBucket, includeHidden, prefs.hiddenAddons, query]);
  const recent = useMemo(() => recentCatalogs(catalogs, prefs.recent, prefs.recentCount),
    [catalogs, prefs.recent, prefs.recentCount]);
  const hiddenPresent = new Set(catalogs.map((catalog) => catalog.addonKey).filter((key) => prefs.hiddenAddons.includes(key)));
  const count = useMemo(() => catalogGroups(catalogs, { bucket: currentBucket, query: "", hiddenAddons: prefs.hiddenAddons, includeHidden: false })
    .reduce((total, group) => total + group.countInBucket, 0), [catalogs, currentBucket, prefs.hiddenAddons]);

  const chips = recent.length && !query.trim() ? {
    title: t("picker.recent"),
    options: recent.map((catalog): PickerOption => {
      const ref = refOf(catalog);
      return {
        key: `${ref.addonKey}:${ref.type}:${ref.id}`,
        label: catalog.name ?? catalog.id,
        selected: sameRef(ref, current),
        tags: typeBucket(catalog.type) !== currentBucket ? <span className="picker-tag picker-tag-type">{catalogTypeTag(catalog.type)}</span> : undefined,
        onChoose: () => onPick(ref),
      };
    }),
  } : undefined;

  const pickerGroups = groups.map((group) => ({
    key: group.addonKey,
    title: group.addonName,
    icon: <AddonLogo addonKey={group.addonKey} name={group.addonName} src={logos?.[group.addonKey]}/>,
    badge: group.hidden ? <span className="picker-badge">{t("picker.hiddenBadge")}</span> : undefined,
    count: group.countInBucket,
    note: group.notBrowsable > 0 ? t("picker.notBrowsable", { count: group.notBrowsable }) : undefined,
    options: group.rows.map((row): PickerOption => ({
      key: `${row.ref.addonKey}:${row.ref.type}:${row.ref.id}`,
      label: row.name,
      selected: sameRef(row.ref, current),
      muted: row.otherType,
      tags: row.otherType || row.needsSearch ? <>
        {row.otherType && (currentBucket === "other"
          ? <span className="picker-tag">{row.ref.type}</span>
          : otherTypeTag(row.ref.type))}
        {row.needsSearch && <span className="picker-tag picker-tag-search">{t("picker.needsSearch")}</span>}
      </> : undefined,
      onChoose: () => onPick(row.ref),
    })),
  }));

  if (editing) return <CatalogPickerEdit catalogs={catalogs} prefs={prefs} onPrefs={onPrefs}
    onDone={() => setEditing(false)} onClose={onClose}/>;

  const segments = <div className="library-shelf-segments picker-segments" role="group" aria-label={t("catalog.type")}>
    {present.map((bucket) => {
      const disabled = bucket !== currentBucket && !fallbackForBucket(catalogs, current, bucket, prefs.hiddenAddons);
      return <button key={bucket} type="button" className={bucket === currentBucket ? "active" : undefined}
        aria-pressed={bucket === currentBucket} disabled={disabled} onClick={() => onBucket(bucket)}>{bucketLabel(bucket)}</button>;
    })}
  </div>;

  return <PickerDialog label={t("catalog.pickerTitle")} subtitle={t("catalog.pickerCount", { count })}
    searchPlaceholder={t("picker.searchCatalog")} query={query} onQuery={setQuery}
    headerExtra={segments} chips={chips} groups={pickerGroups} rail accordion openGroup={current.addonKey}
    empty={<><p>{t("picker.noMatch", { query })}</p><p>{t("picker.noMatchHint")}</p></>}
    footer={<>
      <p className="identify-hint">{t("picker.otherTypeHint")}</p>
      <div className="picker-foot-actions">
        {wideFinePointer() && <span className="picker-keys">{t("picker.keys")}</span>}
        {!query.trim() && hiddenPresent.size > 0 && <button type="button" aria-pressed={includeHidden}
          onClick={() => setIncludeHidden((shown) => !shown)}>{t("picker.showHidden", { count: hiddenPresent.size })}</button>}
        <button type="button" onClick={() => setEditing(true)}>{t("picker.edit")}</button>
      </div>
    </>}
    onClose={onClose}/>;
}

function CatalogPickerEdit({ catalogs, prefs, onPrefs, onDone, onClose }: {
  catalogs: Catalog[];
  prefs: CatalogPickerPrefs;
  onPrefs: (patch: Partial<CatalogPickerPrefs>) => void;
  onDone: () => void;
  onClose: () => void;
}) {
  useI18n();
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog);
  useDialogViewport(dialog);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
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
          <div className="library-shelf-segments picker-segments" role="group" aria-label={t("picker.recent")}>
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
