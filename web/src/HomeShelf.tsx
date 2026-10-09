import { useEffect, useRef } from "react";
import { ChevronRight, Shuffle } from "lucide-react";
import { HomeCard, type HomeCardActions } from "./HomeCard";
import { showAllTarget, type ShowAllTarget } from "./home-cards";
import { t, type Key } from "./i18n";
import type { HomeRowState } from "./home-state";
import type { BuiltinHomeRowId, HomeRowId } from "../../server/src/home";
import type { TileShape } from "./types";

const TITLE: Record<BuiltinHomeRowId, Key> = {
  resume: "home.continue", episodes: "home.newEpisodes", completed: "home.readyToPlay",
  recent: "home.recent", tonight: "home.tonight", favorites: "home.favorites", confirm: "home.toConfirm",
};
const SHOW_ALL: Partial<Record<HomeRowId, Key>> = { favorites: "home.openLibrary", episodes: "home.openFollowing" };
const SKELETON = [0, 1, 2, 3];
/** How far below the screen a waiting shelf starts loading, so it is drawn by the time it
 *  scrolls in. */
const AHEAD = "800px 0px";

const skeleton = <div className="resume-strip skeleton" aria-hidden="true">{SKELETON.map((index) => <div className="browse-item" key={index}><span className="browse-art"/><span className="home-skeleton-line"/></div>)}</div>;

/** One media shelf: its heading, its Show all, and either its cards, a first-load skeleton or
 *  its own error line with a retry. A row with nothing in it and no failure is not drawn. */
export function HomeShelf({ row, title, state, shape, actions, onRetry, onShowAll, onShuffle, onVisible }: {
  row: HomeRowId;
  title?: string;
  state: HomeRowState | undefined;
  shape: TileShape;
  actions: HomeCardActions;
  onRetry: (row: HomeRowId) => void;
  onShowAll: (target: ShowAllTarget) => void;
  /** Tonight and Cinemeta can be reshuffled independently. */
  onShuffle?: () => void;
  /** A shelf that loads only once it nears the screen; until then it is a placeholder. */
  onVisible?: () => void;
}) {
  const placeholder = useRef<HTMLElement>(null);
  const waiting = (!state || state.status === "idle") && onVisible !== undefined;
  useEffect(() => {
    if (!waiting) return;
    const element = placeholder.current;
    if (!element || typeof IntersectionObserver === "undefined") { onVisible!(); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); onVisible!(); }
    }, { rootMargin: AHEAD });
    observer.observe(element);
    return () => observer.disconnect();
  }, [waiting, onVisible]);

  if (waiting) return <section className="home-row" data-row={row} ref={placeholder}>
    <div className="subhead"><div className="home-head"><h3>{title ?? row}</h3></div></div>
    {skeleton}
  </section>;
  if (!state || state.status === "idle") return null;
  const empty = state.items.length === 0;
  if (state.status === "ok" && empty && !state.partial) return null;
  const target = showAllTarget(row, state.items, state.hasMore);

  return <section className="home-row" data-row={row}>
    <div className="subhead">
      <div className="home-head"><h3>{title ?? (row in TITLE ? t(TITLE[row as BuiltinHomeRowId]) : row)}</h3>{row === "confirm" && state.total != null && <span className="count">{state.total}</span>}</div>
      {(row === "tonight" || row.startsWith("catalog:") ) && onShuffle && <button className="home-shuffle" aria-label={t("home.shuffle")} title={t("home.shuffle")} onClick={onShuffle}><Shuffle/></button>}
      {target && <button className="resume-show-all" onClick={() => onShowAll(target)}>{t(SHOW_ALL[row] ?? "library.showAll")}<ChevronRight/></button>}
    </div>
    {state.status === "error"
      ? <div className="home-note bad"><span>{t("home.rowFailed")}</span><button className="home-retry" onClick={() => onRetry(row)}>{t("home.retry")}</button></div>
      : <>
          {state.partial && <div className="home-note"><span>{t("home.partial")}</span><button className="home-retry" onClick={() => onRetry(row)}>{t("home.retry")}</button></div>}
          {state.status === "loading" && empty
            ? skeleton
            : <div className={`resume-strip${state.status === "loading" ? " refreshing" : ""}`} aria-busy={state.status === "loading" || undefined} data-shape={shape}>
                {state.items.map((card) => <HomeCard key={card.key} card={card} shape={shape} actions={actions}/>)}
              </div>}
        </>}
  </section>;
}
