import { Search, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { api } from "./api";
import { t } from "./i18n";
import { SettingControl, SettingsSectionHead } from "./settings-ui";
import type { SearchPreferences, SearchState } from "./types";

/** Personal, so it stays usable in restricted mode. Every control writes as it changes, like
 *  the rest of the page; a failed write shows the error and puts back what the server holds. */
export function SearchSettings({ state, onState, onNotify, onError }: { state: SearchState | null; onState: (state: SearchState) => void; onNotify: (message: string) => void; onError: (error: unknown) => void }) {
  const reload = () => api.searchState().then(onState).catch(() => undefined);
  const save = async (patch: Partial<SearchPreferences>) => {
    try { onState(await api.updateSearchPreferences(patch)); }
    catch (error) { onError(error); await reload(); }
  };
  const clear = async () => {
    if (!confirm(t("settings.searchHistoryConfirm"))) return;
    try { onState(await api.clearSearchHistory()); onNotify(t("settings.searchHistoryCleared")); }
    catch (error) { onError(error); await reload(); }
  };
  // Another device may have searched since this one last asked.
  useEffect(() => { void reload(); }, []);
  const off = !state;
  return <section className="panel settings-section search-settings"><SettingsSectionHead icon={<Search/>} title={t("settings.searchTitle")} text={t("settings.searchText")}/>
    <SettingControl title={t("settings.searchLive")} text={t("settings.searchLiveHint")}>
      <select aria-label={t("settings.searchLive")} disabled={off} value={state?.liveSearch === false ? "0" : "1"} onChange={(event) => void save({ liveSearch: event.target.value === "1" })}>
        <option value="1">{t("settings.searchLiveOn")}</option><option value="0">{t("settings.searchLiveOff")}</option>
      </select></SettingControl>
    <SettingControl title={t("settings.searchOrder")} text={t("settings.searchOrderHint")}>
      <select aria-label={t("settings.searchOrder")} disabled={off} value={state?.defaultOrder ?? "source"} onChange={(event) => void save({ defaultOrder: event.target.value === "titleMatch" ? "titleMatch" : "source" })}>
        <option value="source">{t("catalog.sortAddon")}</option><option value="titleMatch">{t("catalog.sortTitleMatch")}</option>
      </select></SettingControl>
    <SettingControl title={t("settings.searchHistory")} text={t("settings.searchHistoryHint")}>
      <select aria-label={t("settings.searchHistory")} disabled={off} value={state?.saveHistory === false ? "0" : "1"} onChange={(event) => void save({ saveHistory: event.target.value === "1" })}>
        <option value="1">{t("settings.store")}</option><option value="0">{t("settings.doNotStore")}</option>
      </select></SettingControl>
    <SettingControl title={t("settings.clearSearchHistory")} text={t("settings.clearSearchHistoryHint")}>
      <button type="button" className="danger" disabled={off || !state.saveHistory || !state.recent.length} onClick={() => void clear()}><Trash2/> {t("settings.clearSearchHistory")}</button>
    </SettingControl>
  </section>;
}
