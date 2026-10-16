import { Film, FolderOpen, HardDrive, Star } from "lucide-react";
import { Empty, ShapeToggle } from "./app-chrome";
import { t } from "./i18n";
import { TileArt } from "./TileArt";
import type { FavoriteCatalogItem, FavoriteFilter, FavoriteItem, FavoriteLibraryItem, FavoriteRemoteItem, TileShape } from "./types";

const FILTERS = [
  { value: "all", label: "favorites.filterAll" },
  { value: "movies", label: "favorites.filterMovies" },
  { value: "series", label: "favorites.filterSeries" },
] as const satisfies ReadonlyArray<{ value: FavoriteFilter; label: "favorites.filterAll" | "favorites.filterMovies" | "favorites.filterSeries" }>;

const EMPTY = {
  all: { title: "favorites.emptyAllTitle", text: "favorites.emptyAllText" },
  movies: { title: "favorites.emptyMoviesTitle", text: "favorites.emptyMoviesText" },
  series: { title: "favorites.emptySeriesTitle", text: "favorites.emptySeriesText" },
} as const;

const percent = (item: FavoriteLibraryItem): number | null =>
  item.progress && item.progress.duration > 0
    ? Math.min(100, Math.max(0, Math.round((item.progress.position / item.progress.duration) * 100)))
    : null;

/** The one Favourites section: library stars, catalogue stars and media-server stars in one grid,
 *  the way Continue watching already is, filtered by a segmented control. A library entry bound to
 *  a title opens that title's detail, whatever kind of copy it is; an unbound one opens the folder
 *  or plays the file the way the library does; a catalogue entry opens the shared detail, and a
 *  media-server entry opens that server's own detail. */
export function FavoritesView({ filter, onFilter, items, busy, shape, onToggleShape, onPlay, onOpenFolder, onOpenTitle, onOpenCatalog, onOpenRemote, hasMore, loadingMore, onLoadMore }: {
  filter: FavoriteFilter;
  onFilter: (filter: FavoriteFilter) => void;
  items: FavoriteItem[];
  busy: boolean;
  shape: TileShape;
  onToggleShape: () => void;
  onPlay: (item: FavoriteLibraryItem) => void;
  onOpenFolder: (item: FavoriteLibraryItem) => void;
  onOpenTitle: (item: FavoriteLibraryItem) => void;
  onOpenCatalog: (item: FavoriteCatalogItem) => void;
  onOpenRemote: (item: FavoriteRemoteItem) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const empty = EMPTY[filter];
  return <div className="favorites-view">
    <div className="heading"><small>{t("home.eyebrow")}</small><h2>{t("favorites.title")}</h2></div>
    <div className="filterbar section-filter">
      <div className="library-shelf-segments" role="radiogroup" aria-label={t("favorites.title")}>
        {FILTERS.map((entry) => <button key={entry.value} type="button" className={filter === entry.value ? "active" : ""} aria-pressed={filter === entry.value} onClick={() => onFilter(entry.value)}>{t(entry.label)}</button>)}
      </div>
      <ShapeToggle shape={shape} onToggle={onToggleShape}/>
    </div>
    {busy && !items.length
      ? <div className="loading">{t("common.loading")}</div>
      : !items.length
        ? <Empty icon={<Star/>} title={t(empty.title)} text={t(empty.text)}/>
        : <>
          <div className={`browse-grid favorites-grid tile-shape-${shape}`}>
            {items.map((item) => item.kind === "library"
              ? <button key={`library:${item.path}`} className="browse-item" data-path={item.path} data-kind="favorite-library"
                  onClick={() => item.title ? onOpenTitle(item) : item.itemKind === "folder" ? onOpenFolder(item) : onPlay(item)}>
                  <span className="browse-art">
                    <TileArt shape={shape} poster={item.poster} wide={item.wide} fallback={item.itemKind === "folder" ? <FolderOpen/> : <Film/>}/>
                    <i className="fav-mark"><Star/></i>
                    {percent(item) != null && <i className="resume-bar"><i style={{ width: `${percent(item)}%` }}/></i>}
                  </span>
                  <strong>{item.label}</strong>
                  <small>{item.year ?? (item.itemKind === "folder" ? t("library.openFolder") : "")}</small>
                </button>
              : item.kind === "catalog"
                ? <button key={`catalog:${item.type}:${item.id}`} className="browse-item" data-catalog-key={`${item.type}:${item.id}`} data-kind="favorite-catalog"
                    onClick={() => onOpenCatalog(item)}>
                    <span className="browse-art"><TileArt shape={shape} poster={item.poster} wide={item.wide} fallback={<Film/>}/><i className="fav-mark"><Star/></i></span>
                    <strong>{item.name}</strong>
                    <small>{item.year ?? ""}</small>
                  </button>
                : <button key={`remote:${item.libraryId}:${item.itemId}`} className="browse-item" data-remote-id={item.itemId} data-kind="favorite-remote"
                    onClick={() => onOpenRemote(item)}>
                    <span className="browse-art"><TileArt shape={shape} poster={item.poster} wide={item.wide} fallback={<HardDrive/>}/><i className="fav-mark"><Star/></i></span>
                    <strong>{item.title}</strong>
                    {/* A list never names its source, and the card projection carries no year of
                        its own: the caption line stays empty rather than naming the server. */}
                    <small>{""}</small>
                  </button>)}
          </div>
          {hasMore && <div className="load-more">{loadingMore ? <span>{t("common.loadingMore")}</span> : <button onClick={onLoadMore}>{t("common.loadMore")}</button>}</div>}
        </>}
  </div>;
}
