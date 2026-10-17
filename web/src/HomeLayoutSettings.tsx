import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, LayoutList, Plus, RotateCcw, Trash2 } from "lucide-react";
import { api } from "./api";
import { SettingsSectionHead } from "./settings-ui";
import { t, useI18n, type Key } from "./i18n";
import { homeFeedTitle } from "./home-state";
import type { HomeLayout, HomeLayoutEntry, HomeLayoutResponse } from "../../server/src/home";
import { homeFeedSelectionKey, parseHomeCatalogRowId } from "../../server/src/home";

/** A row's own feed key, so "Remove" can name it in `feeds`. */
const feedKeyOf = (id: string): string | undefined => {
  const parsed = parseHomeCatalogRowId(id);
  return parsed ? homeFeedSelectionKey(parsed.addonKey, parsed.type, parsed.id) : undefined;
};

const labelOf = (row: HomeLayoutEntry): string => row.kind === "builtin" ? t(row.label as Key) : homeFeedTitle(row.id, row.label);

/** How long a change waits before it is written, so flipping two switches is one save. */
export const HOME_LAYOUT_SAVE_MS = 300;

/** The account's own Home arrangement: every row it may have, the ones it shows, the order
 *  they sit in, and the catalogue feeds it added for itself. Personal, so an ordinary account
 *  gets it too; the instance-level Show on Home switches stay the default every account starts
 *  from. Every change saves on its own, coalesced, and the page redraws from the answer. */
export function HomeLayoutSettings({ disabled = false, onError }: { disabled?: boolean; onError: (error: unknown) => void }) {
  useI18n();
  const [view, setView] = useState<HomeLayoutResponse | null>(null);
  const [draft, setDraft] = useState<HomeLayout | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<HomeLayout | null>(null);
  const sequence = useRef(0);
  const report = useRef(onError);
  report.current = onError;

  const load = useCallback(async (token: number) => {
    try {
      const next = await api.homeLayout();
      // A newer edit bumps the sequence, so an answer that lands after it must not overwrite the draft.
      if (token !== sequence.current) return;
      setView(next); setDraft(next.layout);
    }
    catch (error) { report.current(error); }
  }, []);

  useEffect(() => { void load(++sequence.current); }, [load]);
  useEffect(() => () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = undefined; }
    const next = pending.current;
    pending.current = null;
    // A change made just before leaving Settings is sent rather than dropped with the timer.
    if (next) void api.updateSettings({ homeLayout: next }).catch(() => undefined);
  }, []);

  /** Shows the change at once and writes it shortly after; the answer is read back so the
   *  arrangement, hidden rows and feeds stay the server's canonical answer. */
  const save = (next: HomeLayout) => {
    setDraft(next);
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    const token = ++sequence.current;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      pending.current = null;
      api.updateSettings({ homeLayout: next })
        .then(() => { if (token === sequence.current) return load(token); }, (error) => report.current(error))
        .catch(() => undefined);
    }, HOME_LAYOUT_SAVE_MS);
  };

  const reset = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = undefined; }
    pending.current = null;
    const token = ++sequence.current;
    setDraft({ order: [], hidden: [], feeds: [] });
    api.updateSettings({ homeLayout: null })
      .then(() => { if (token === sequence.current) return load(token); }, (error) => report.current(error))
      .catch(() => undefined);
  };

  if (!view || !draft) return <section className="panel settings-section home-layout-section">
    <SettingsSectionHead icon={<LayoutList/>} title={t("settings.homeTitle")} text={t("settings.homeText")}/>
  </section>;

  const added = new Set(view.rows.filter((row) => row.added).map((row) => row.id));
  const byId = new Map(view.rows.map((row) => [row.id, row]));
  const orderIndex = (id: string) => { const index = draft.order.indexOf(id); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
  const arranged = [...added].map((id) => byId.get(id)!).sort((a, b) => orderIndex(a.id) - orderIndex(b.id));
  const offered = view.rows.filter((row) => row.kind === "feed" && !row.added);
  const personal = new Set(draft.feeds);
  const shownOf = (id: string) => !draft.hidden.includes(id);

  const move = (id: string, direction: -1 | 1) => {
    const ids = arranged.map((row) => row.id);
    const index = ids.findIndex((held) => held === id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= ids.length) return;
    const [moved] = ids.splice(index, 1);
    ids.splice(next, 0, moved!);
    save({ ...draft, order: ids });
  };
  const toggle = (id: string) => save({ ...draft, hidden: shownOf(id) ? [...draft.hidden, id] : draft.hidden.filter((held) => held !== id) });
  const add = (id: string) => { const key = feedKeyOf(id); if (key) save({ ...draft, feeds: [...draft.feeds, key] }); };
  const remove = (id: string) => {
    const key = feedKeyOf(id);
    save({ ...draft, feeds: draft.feeds.filter((held) => held !== key), order: draft.order.filter((held) => held !== id), hidden: draft.hidden.filter((held) => held !== id) });
  };

  return <section className="panel settings-section home-layout-section">
    <SettingsSectionHead icon={<LayoutList/>} title={t("settings.homeTitle")} text={t("settings.homeText")}/>
    <ul className="home-layout-list">
      {arranged.map((row, index) => {
        // `confirm` is a count in Home's heading, never a shelf, so its position cannot move.
        const movable = row.id !== "confirm";
        return <li key={row.id} className={`home-layout-row${shownOf(row.id) ? "" : " hidden"}`}>
          <span className="home-layout-label">{labelOf(row)}</span>
          <span className="home-layout-controls">
          {movable && <button type="button" className="icon" disabled={disabled || index === 0}
            aria-label={t("settings.homeMoveUp", { row: labelOf(row) })} title={t("settings.homeMoveUp", { row: labelOf(row) })}
            onClick={() => move(row.id, -1)}><ChevronUp/></button>}
          {movable && <button type="button" className="icon" disabled={disabled || index === arranged.length - 1}
            aria-label={t("settings.homeMoveDown", { row: labelOf(row) })} title={t("settings.homeMoveDown", { row: labelOf(row) })}
            onClick={() => move(row.id, 1)}><ChevronDown/></button>}
          <label className="switch"><input type="checkbox" role="switch" checked={shownOf(row.id)} disabled={disabled}
            aria-label={t("settings.homeShowRow", { row: labelOf(row) })} onChange={() => toggle(row.id)}/><span/></label>
          {row.kind === "feed" && personal.has(feedKeyOf(row.id) ?? "") && <button type="button" className="danger icon"
            disabled={disabled} aria-label={t("settings.homeRemove", { row: labelOf(row) })} title={t("settings.homeRemove", { row: labelOf(row) })}
            onClick={() => remove(row.id)}><Trash2/></button>}
          </span>
        </li>;
      })}
    </ul>
    {offered.length > 0 && <div className="home-layout-add">
      <strong>{t("settings.homeAddCatalog")}</strong>
      <small>{t("settings.homeAddCatalogHint")}</small>
      <ul>{offered.map((row) => <li key={row.id}><span>{labelOf(row)}</span>
        <button type="button" disabled={disabled} aria-label={t("settings.homeAddRow", { row: labelOf(row) })} onClick={() => add(row.id)}><Plus/> {t("settings.homeAdd")}</button>
      </li>)}</ul>
    </div>}
    <div className="setting-actions">
      <button type="button" disabled={disabled} onClick={reset}><RotateCcw/> {t("settings.homeReset")}</button>
    </div>
  </section>;
}
