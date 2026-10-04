import { ChevronRight, Film } from "lucide-react";
import { localeTag, t, useI18n } from "./i18n";
import type { FollowView, NewEpisode } from "./types";

const pad2 = (value: number) => String(Math.max(0, Math.trunc(value))).padStart(2, "0");

/** The Library row of episodes a followed series announced, drawn like the resume row.
 *  Nothing at all is shown while nothing is followed; a follow with nothing new keeps the
 *  subhead so its list stays reachable. */
export function NewEpisodesRow({ follows, episodes, onOpen, onManage }: {
  follows: FollowView[];
  episodes: NewEpisode[];
  onOpen: (episode: NewEpisode) => void;
  onManage: () => void;
}) {
  useI18n();
  if (!follows.length) return null;
  return <div className="resume-row">
    <div className="subhead"><h3>{t("follow.newEpisodes")}</h3><button className="resume-show-all" onClick={onManage}>{t("follow.manage", { count: follows.length })} <ChevronRight/></button></div>
    {episodes.length > 0
      ? <div className="resume-strip">{episodes.slice(0, 12).map((episode) => <button className="browse-item" key={`${episode.followId}:${episode.videoId}`} onClick={() => onOpen(episode)}>
          <span className="browse-art">{episode.poster ? <img src={episode.poster} alt="" loading="lazy"/> : <Film/>}</span>
          <strong>{episode.name}</strong>
          <small>{episode.type === "movie" ? t("follow.movieBadge") : `S${pad2(episode.season)}E${pad2(episode.episode)}${episode.title ? ` · ${episode.title}` : ""}`}</small>
          <small>{new Date(episode.released).toLocaleDateString(localeTag())}</small>
        </button>)}</div>
      : <p className="identify-hint">{t("follow.noNewEpisodes")}</p>}
  </div>;
}
