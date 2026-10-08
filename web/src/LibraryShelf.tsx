import { useState } from "react";
import { ChevronRight, CirclePlay, Film, HardDrive, MoreVertical } from "lucide-react";
import { fmtEta } from "./download-format";
import { localeTag, t, useI18n } from "./i18n";
import type { BrowseResult, FollowView, NewEpisode } from "./types";

const pad2 = (value: number) => String(Math.max(0, Math.trunc(value))).padStart(2, "0");

export type LibraryShelfSegment = "resume" | "episodes" | "favorites";

/** One Continue watching row as the library preview hands it over. It names the show the way
 *  the library card does, without the catalogue id a stored position would carry. */
export interface LibraryResumeItem {
  key: string;
  path?: string;
  title: string;
  poster?: string;
  season?: number | null;
  episode?: number | null;
  position: number;
  duration: number;
  series?: { name?: string };
}

/** The library root's one shelf: Continue watching, New episodes and Favourites behind a
 *  segment control, drawn where the three blocks used to stack. The selected segment is the
 *  account's, so the shelf only reports a click and lets the caller write it. */
export function LibraryShelf({ segment, showResume, resume, resumeTotal, episodes, follows, favorites, onSegment, onPlayResume, onRevealResume, onOpenEpisode, onOpenFavorite, onShowResume, onShowEpisodes, onShowFavorites }: {
  segment: LibraryShelfSegment;
  showResume: boolean;
  resume: LibraryResumeItem[];
  resumeTotal: number;
  episodes: NewEpisode[];
  follows: FollowView[];
  favorites: BrowseResult | null;
  onSegment: (segment: LibraryShelfSegment) => void;
  onPlayResume: (item: LibraryResumeItem) => void;
  onRevealResume: (path: string) => void;
  onOpenEpisode: (episode: NewEpisode) => void;
  onOpenFavorite: (item: BrowseResult["items"][number]) => void;
  onShowResume: () => void;
  onShowEpisodes: () => void;
  onShowFavorites: () => void;
}) {
  useI18n();
  const [menuKey, setMenuKey] = useState<string | null>(null);
  // A saved "resume" on an account that hides Continue falls back to Favourites for this look
  // only; nothing is written back.
  const displayed: LibraryShelfSegment = segment === "resume" && !showResume ? "favorites" : segment;
  const favoriteCards = favorites?.items ?? [];
  const favoriteTotal = favorites?.total ?? favoriteCards.length;
  const hasResume = showResume && resume.length > 0;
  if (!hasResume && !follows.length && favoriteTotal === 0) return null;

  const showAll = displayed === "episodes"
    ? <button className="resume-show-all" onClick={onShowEpisodes}>{t("follow.manage", { count: follows.length })} <ChevronRight/></button>
    : displayed === "favorites"
      ? <button className="resume-show-all" onClick={onShowFavorites}>{t("library.showAll")} ({favoriteTotal}) <ChevronRight/></button>
      : <button className="resume-show-all" onClick={onShowResume}>{t("library.showAll")} ({resumeTotal}) <ChevronRight/></button>;

  const cards = displayed === "resume"
    ? resume.slice(0, 8).map((item) => <button className="browse-item" key={item.key} data-path={item.path} onClick={() => { if (item.path) onPlayResume(item); }}>
        <span className="browse-art">
          {item.poster ? <img src={item.poster} alt="" loading="lazy"/> : <Film/>}
          <i className="browse-play"><CirclePlay/></i>
          <i className="resume-bar"><i style={{ width: `${Math.min(100, Math.round(item.position / (item.duration || 1) * 100))}%` }}/></i>
        </span>
        <span className="browse-menu" onClick={(event) => { event.stopPropagation(); setMenuKey(menuKey === item.key ? null : item.key); }}><MoreVertical/></span>
        <strong>{item.series?.name ?? item.title}</strong>
        <small>{item.season != null ? `${item.season}×${pad2(item.episode ?? 0)} ` : ""}{t("library.remaining", { time: fmtEta(Math.max(0, item.duration - item.position)) })}</small>
        {menuKey === item.key && <span className="browse-actions" onClick={(event) => event.stopPropagation()}>
          <button onClick={() => { setMenuKey(null); if (item.path) onRevealResume(item.path); }}><HardDrive/> {t("library.showInLibrary")}</button>
        </span>}
      </button>)
    : displayed === "episodes"
      ? episodes.slice(0, 8).map((episode) => <button className="browse-item" key={`${episode.followId}:${episode.videoId}`} onClick={() => onOpenEpisode(episode)}>
          <span className="browse-art">{episode.poster ? <img src={episode.poster} alt="" loading="lazy"/> : <Film/>}</span>
          <strong>{episode.name}</strong>
          <small>{episode.type === "movie" ? t("follow.movieBadge") : `S${pad2(episode.season)}E${pad2(episode.episode)}${episode.title ? ` · ${episode.title}` : ""}`}</small>
          <small>{new Date(episode.released).toLocaleDateString(localeTag())}</small>
        </button>)
      : favoriteCards.slice(0, 8).map((item) => <button className="browse-item" key={item.path} onClick={() => onOpenFavorite(item)}>
          <span className="browse-art">{item.poster ? <img src={item.poster} alt="" loading="lazy"/> : <Film/>}</span>
          <strong>{item.kind === "folder" ? item.name : item.label}</strong>
        </button>);

  const empty = displayed === "resume" ? "library.shelf.emptyResume" : displayed === "episodes" ? "library.shelf.emptyEpisodes" : "library.shelf.emptyFavorites";
  const segmentButton = (value: LibraryShelfSegment, label: string) =>
    <button type="button" className={displayed === value ? "active" : ""} aria-pressed={displayed === value} onClick={() => onSegment(value)}>{label}</button>;

  return <section className="resume-row library-shelf">
    <div className="subhead">
      <div className="library-shelf-segments" role="radiogroup" aria-label={t("library.shelf.group")}>
        {showResume && segmentButton("resume", t("library.shelf.resume"))}
        {segmentButton("episodes", t("library.shelf.episodes"))}
        {segmentButton("favorites", t("library.shelf.favorites"))}
      </div>
      {showAll}
    </div>
    {cards.length > 0 ? <div className="resume-strip">{cards}</div> : <p className="identify-hint">{t(empty)}</p>}
  </section>;
}
