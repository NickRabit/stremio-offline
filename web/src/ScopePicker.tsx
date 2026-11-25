import { useMemo, useState } from "react";
import { AddonLogo } from "./AddonLogo";
import { catalogTypeTag } from "./catalog-labels";
import { matchesQuery, scopeGroups } from "./catalog-picker-model";
import { t, useI18n } from "./i18n";
import { PickerDialog, type PickerOption } from "./PickerDialog";
import { parseSearchScope } from "./search-scope";
import type { SearchableCatalog } from "./types";

export interface ScopePickerProps {
  searchable: SearchableCatalog[];
  value: string;
  type: "" | "movie" | "series";
  logos?: Record<string, string | undefined>;
  onPick: (value: string) => void;
  onClose: () => void;
}

export function ScopePicker({ searchable, value, type, logos, onPick, onClose }: ScopePickerProps) {
  useI18n();
  const [query, setQuery] = useState("");
  const groups = useMemo(() => scopeGroups(searchable, { query, type }), [query, searchable, type]);
  const globalAddons = new Set(searchable.filter((catalog) => catalog.globalSearch).map((catalog) => catalog.addonKey)).size;
  const openGroup = parseSearchScope(value).addonKey;

  const leading: PickerOption[] = query.trim() ? [] : [{
    key: "shared",
    label: t("search.shared"),
    sublabel: t("search.sharedHint", { count: globalAddons }),
    selected: value === "",
    onChoose: () => onPick(""),
  }];

  const pickerGroups = groups.map((group) => ({
    key: group.addonKey,
    title: group.addonName,
    icon: <AddonLogo addonKey={group.addonKey} name={group.addonName} src={logos?.[group.addonKey]}/>,
    badge: group.globalSearch ? undefined : <span className="picker-badge picker-tag-manual">{t("search.manualOnly")}</span>,
    count: group.rows.length,
    options: [
      ...(matchesQuery(group.addonName, query) ? [{
        key: group.addonValue,
        label: t("search.wholeAddon"),
        selected: value === group.addonValue,
        onChoose: () => onPick(group.addonValue),
      }] : []),
      ...group.rows.map((row): PickerOption => ({
        key: row.value,
        label: row.name,
        tags: <span className="picker-tag">{catalogTypeTag(row.type)}</span>,
        selected: value === row.value,
        onChoose: () => onPick(row.value),
      })),
    ],
  }));

  return <PickerDialog label={t("search.scopeTitle")} subtitle={t("search.scopeHint")}
    searchPlaceholder={t("picker.searchScope")} query={query} onQuery={setQuery}
    leading={leading} groups={pickerGroups} rail accordion openGroup={openGroup}
    empty={<><p>{t("picker.noMatch", { query })}</p><p>{t("picker.noMatchHint")}</p></>}
    footer={<p className="identify-hint">{t("search.manualOnlyHint")}</p>}
    onClose={onClose}/>;
}
