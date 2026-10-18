import { t } from "./i18n";
import { catalogTypeTag } from "./catalog-labels";
import type { SearchableCatalog } from "./types";

export function SearchScopeOptions({ searchable }: { searchable: SearchableCatalog[] }) {
  const addons = [...new Map(searchable.map((item) => [item.addonKey, {
    name: item.addonName,
    globalSearch: item.globalSearch,
  }])).entries()];
  return <>
    <option value="">{t("catalog.allAddons")}</option>
    {addons.map(([key, addon]) => {
      const hint = addon.globalSearch ? undefined : t("catalog.onlyWhenPicked");
      return <optgroup key={key} label={`${addon.name}${addon.globalSearch ? "" : " ·"}`} title={hint}>
        <option value={`addon:${key}`} title={hint}>{t("catalog.allCatalogs")}{addon.globalSearch ? "" : " ·"}</option>
        {searchable.filter((item) => item.addonKey === key).map((item) => {
          const itemHint = item.globalSearch ? undefined : t("catalog.onlyWhenPicked");
          return <option key={`${item.type}:${item.id}`} value={`catalog:${key}:${item.type}:${item.id}`} title={itemHint}>
            {item.name} ({catalogTypeTag(item.type)}){item.globalSearch ? "" : " ·"}
          </option>;
        })}
      </optgroup>;
    })}
  </>;
}
