import { memo, useEffect, useRef, useState } from "react";
import { ChevronRight, Shuffle, TriangleAlert } from "lucide-react";
import { HomeCard, type HomeCardActions } from "./HomeCard";
import { showAllTarget, type ShowAllTarget } from "./home-cards";
import { t, type Key } from "./i18n";
import type { HomeRowState } from "./home-state";
import type { BuiltinHomeRowId, HomeRowId } from "../../server/src/home";
import type { TileShape } from "./types";
import { useOmission } from "./home-omit";

const TITLE: Record<BuiltinHomeRowId, Key> = {
  resume: "home.continue", episodes: "home.newEpisodes", completed: "home.readyToPlay",
  recent: "home.recent", tonight: "home.tonight", favorites: "home.favorites", confirm: "home.toConfirm",
};
const SHOW_ALL: Partial<Record<HomeRowId, Key>> = { episodes: "home.openFollowing" };
const SKELETON = [0, 1, 2, 3];
/** How far below the screen a waiting shelf starts loading, so it is drawn by the time it
 *  scrolls in. */
const AHEAD = "800px 0px";
/** The first cards of a shelf cover a phone or desktop row; their pictures are asked for at once
 *  when the shelf comes within NEAR_PX of the screen, where Safari's lazy loading starts too late. */
export const EAGER_CARDS = 6;
const NEAR_PX = 800;

const skeleton = <div className="resume-strip skeleton" aria-hidden="true">{SKELETON.map((index) => <div className="browse-item" key={index}><span className="browse-art"/><span className="home-skeleton-line title"/><span className="home-skeleton-line caption"/></div>)}</div>;

/** One media shelf: its heading, its Show all, and either its cards, a first-load skeleton or
 *  its own error line with a retry. A row with nothing in it and no failure is not drawn. */
export const HomeShelf = memo(function HomeShelf({ row, title, state, shape, actions, onRetry, onShowAll, onShuffle, onVisible, onOpenCatalog }: {
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
  /** An addon shelf's heading opens its whole catalogue. */
  onOpenCatalog?: () => void;
}) {
  const placeholder = useRef<HTMLElement>(null);
  // The partial mark explains itself on a click: a phone has no hover for the title.
  const [explained, setExplained] = useState(false);
  const waiting = (!state || state.status === "idle") && onVisible !== undefined;
  // A shelf with nothing in it is not drawn -- but one that turns out empty on screen leaves
  // only once that moves nothing in view (see useOmission).
  const empty = state !== undefined && state.status !== "idle" && state.status !== "error" && state.items.length === 0;
  const omit = state !== undefined && (state.status === "ok" || (state.status === "loading" && state.settled === true)) && empty && !state.partial;
  const held = useRef<HTMLElement>(null);
  const gone = useOmission(omit, held);
  // Watched on the card strip, not on the section: the section has observers of its own, and a
  // shelf restored from the cache may sit far below the screen.
  const strip = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const cards = state?.items.length ?? 0;
  // How many cards get their picture before the shelf is moved: those the strip shows, and two
  // more. The rest come once it is scrolled, touched or focused.
  const [shown, setShown] = useState(EAGER_CARDS);
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    const element = strip.current;
    if (!near || !element) return;
    const card = element.firstElementChild as HTMLElement | null;
    const width = card?.getBoundingClientRect().width ?? 0;
    if (width > 0) setShown(Math.ceil(element.clientWidth / width) + 2);
  }, [near, cards]);
  const move = () => { if (!moved) setMoved(true); };
  useEffect(() => {
    const element = strip.current;
    if (near || !element) return;
    if (typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); setNear(true); }
    }, { rootMargin: `${NEAR_PX}px 0px` });
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, cards]);
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

  const heading = (text: string) => onOpenCatalog
    ? <h3><button className="home-catalog-link" title={t("home.openCatalog")} onClick={onOpenCatalog}><span>{text}</span><ChevronRight aria-hidden="true"/></button></h3>
    : <h3>{text}</h3>;

  if (waiting) return <section className="home-row" data-row={row} ref={placeholder}>
    <div className="subhead"><div className="home-head">{heading(title ?? row)}</div></div>
    {skeleton}
  </section>;
  if ((!state || state.status === "idle") && row in TITLE) return <section className="home-row" data-row={row}>
    <div className="subhead"><div className="home-head">{heading(title ?? t(TITLE[row as BuiltinHomeRowId]))}</div></div>
    {skeleton}
  </section>;
  if (!state || state.status === "idle") return null;
  if (omit) return gone ? null : <section className="home-row" data-row={row} ref={held} aria-hidden="true">
    <div className="subhead"><div className="home-head">{heading(title ?? (row in TITLE ? t(TITLE[row as BuiltinHomeRowId]) : row))}</div></div>
    {skeleton}
  </section>;
  const target = showAllTarget(row, state.hasMore);
  const partial = state.status !== "error" && state.partial === true;

  return <section className="home-row" data-row={row}>
    <div className="subhead">
      <div className="home-head">{heading(title ?? (row in TITLE ? t(TITLE[row as BuiltinHomeRowId]) : row))}{row === "confirm" && state.total != null && <span className="count">{state.total}</span>}{partial && <button type="button" className="home-partial" title={t("home.partial")} aria-label={t("home.partial")} aria-expanded={explained} aria-controls={`home-partial-${row}`} onClick={() => setExplained((open) => !open)}><TriangleAlert aria-hidden="true"/></button>}</div>
      {(row === "tonight" || row.startsWith("catalog:") ) && onShuffle && <button className="home-shuffle" aria-label={t("home.shuffle")} title={t("home.shuffle")} onClick={onShuffle}><Shuffle/></button>}
      {target && <button className="resume-show-all" onClick={() => onShowAll(target)}>{t(SHOW_ALL[row] ?? "library.showAll")}<ChevronRight/></button>}
    </div>
    {partial && explained && <div className="home-note" id={`home-partial-${row}`} role="note"><span>{t("home.partialHint")}</span><button className="home-retry" onClick={() => { setExplained(false); onRetry(row); }}>{t("home.retry")}</button></div>}
    {state.status === "error"
      ? <div className="home-note bad"><span>{t("home.rowFailed")}</span><button className="home-retry" onClick={() => onRetry(row)}>{t("home.retry")}</button></div>
      : <>
          {state.status === "loading" && empty
            ? skeleton
            : <div ref={strip} className={`resume-strip${state.status === "loading" ? " refreshing" : ""}`} aria-busy={state.status === "loading" || undefined} data-shape={shape}
                onScroll={move} onPointerDown={move} onFocus={move}>
                {state.items.map((card, index) => <HomeCard key={card.key} card={card} shape={shape} actions={actions}
                  eager={near && index < EAGER_CARDS} art={near && (moved || index < shown)}/>)}
              </div>}
        </>}
  </section>;
});
