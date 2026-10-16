import { History } from "lucide-react";
import { Empty, ShapeToggle } from "./app-chrome";
import { HomeCard, type HomeCardActions } from "./HomeCard";
import { t } from "./i18n";
import type { ResumeCard, ResumeFilter, TileShape } from "./types";

const FILTERS = [
  { value: "all", label: "resume.filterAll" },
  { value: "movies", label: "resume.filterMovies" },
  { value: "series", label: "resume.filterSeries" },
] as const satisfies ReadonlyArray<{ value: ResumeFilter; label: "resume.filterAll" | "resume.filterMovies" | "resume.filterSeries" }>;

const EMPTY = {
  all: { title: "resume.emptyAllTitle", text: "resume.emptyAllText" },
  movies: { title: "resume.emptyMoviesTitle", text: "resume.emptyMoviesText" },
  series: { title: "resume.emptySeriesTitle", text: "resume.emptySeriesText" },
} as const;

/** The one Continue watching section: the same merged cards Home's resume row draws, paged past
 *  that row's bound and filtered by the kind of title. A card written from a library file plays it,
 *  anything else opens the episode it remembers, and the menu forgets the progress behind the
 *  card. */
export function ResumeView({ filter, onFilter, items, busy, shape, onToggleShape, actions, hasMore, loadingMore, onLoadMore }: {
  filter: ResumeFilter;
  onFilter: (filter: ResumeFilter) => void;
  items: ResumeCard[];
  busy: boolean;
  shape: TileShape;
  onToggleShape: () => void;
  actions: HomeCardActions;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const empty = EMPTY[filter];
  return <div className="section-view">
    <div className="heading"><small>{t("home.eyebrow")}</small><h2>{t("resume.title")}</h2></div>
    <div className="filterbar section-filter">
      <div className="library-shelf-segments" role="radiogroup" aria-label={t("resume.title")}>
        {FILTERS.map((entry) => <button key={entry.value} type="button" className={filter === entry.value ? "active" : ""} aria-pressed={filter === entry.value} onClick={() => onFilter(entry.value)}>{t(entry.label)}</button>)}
      </div>
      <ShapeToggle shape={shape} onToggle={onToggleShape}/>
    </div>
    {busy && !items.length
      ? <div className="loading">{t("common.loading")}</div>
      : !items.length
        ? <Empty icon={<History/>} title={t(empty.title)} text={t(empty.text)}/>
        : <>
          <div className={`browse-grid section-grid favorites-grid tile-shape-${shape}`}>
            {items.map((card) => <HomeCard key={card.key} card={card} shape={shape} actions={actions}/>)}
          </div>
          {hasMore && <div className="load-more">{loadingMore ? <span>{t("common.loadingMore")}</span> : <button onClick={onLoadMore}>{t("common.loadMore")}</button>}</div>}
        </>}
  </div>;
}
