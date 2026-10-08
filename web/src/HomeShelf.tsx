import { ChevronRight } from "lucide-react";
import { HomeCard, type HomeCardActions } from "./HomeCard";
import { showAllTarget, type ShowAllTarget } from "./home-cards";
import { t, type Key } from "./i18n";
import type { HomeRowState } from "./home-state";
import type { MediaRowId } from "../../server/src/home";
import type { TileShape } from "./types";

const TITLE: Record<MediaRowId, Key> = { resume: "home.continue", completed: "home.readyToPlay", favorites: "home.favorites" };
const SKELETON = [0, 1, 2, 3];

/** One media shelf: its heading, its Show all, and either its cards, a first-load skeleton or
 *  its own error line with a retry. A row with nothing in it and no failure is not drawn. */
export function HomeShelf({ row, state, shape, actions, onRetry, onShowAll }: {
  row: MediaRowId;
  state: HomeRowState | undefined;
  shape: TileShape;
  actions: HomeCardActions;
  onRetry: (row: MediaRowId) => void;
  onShowAll: (target: ShowAllTarget) => void;
}) {
  if (!state || state.status === "idle") return null;
  const empty = state.items.length === 0;
  if (state.status === "ok" && empty) return null;
  const target = showAllTarget(row, state.items, state.hasMore);

  return <section className="home-row" data-row={row}>
    <div className="subhead">
      <div className="home-head"><h3>{t(TITLE[row])}</h3></div>
      {target && <button className="resume-show-all" onClick={() => onShowAll(target)}>{t(row === "favorites" ? "home.openLibrary" : "library.showAll")}<ChevronRight/></button>}
    </div>
    {state.status === "error"
      ? <div className="home-note bad"><span>{t("home.rowFailed")}</span><button className="home-retry" onClick={() => onRetry(row)}>{t("home.retry")}</button></div>
      : <>
          {state.partial && <div className="home-note"><span>{t("home.partial")}</span><button className="home-retry" onClick={() => onRetry(row)}>{t("home.retry")}</button></div>}
          {state.status === "loading" && empty
            ? <div className="resume-strip skeleton" aria-hidden="true">{SKELETON.map((index) => <div className="browse-item" key={index}><span className="browse-art"/><span className="home-skeleton-line"/></div>)}</div>
            : <div className={`resume-strip${state.status === "loading" ? " refreshing" : ""}`} aria-busy={state.status === "loading" || undefined} data-shape={shape}>
                {state.items.map((card) => <HomeCard key={card.key} card={card} shape={shape} actions={actions}/>)}
              </div>}
        </>}
  </section>;
}
