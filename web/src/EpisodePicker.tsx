import { ChevronRight } from "lucide-react";
import type { JSX } from "react";
import { t } from "./i18n";

export interface PickerEpisode {
  key: string;
  season?: number;
  episode?: number;
  title?: string;
}

interface Props {
  episodes: PickerEpisode[];
  selectedKey: string | null;
  onPick: (key: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loading: boolean;
  season: number | null;
  onSeason: (season: number) => void;
}

const pad = (value: number) => String(value).padStart(2, "0");

export function EpisodePicker({ episodes, selectedKey, onPick, open, onOpenChange, loading, season, onSeason }: Props): JSX.Element {
  const seasons = [...new Set(episodes.map((episode) => episode.season).filter((value): value is number => typeof value === "number"))]
    .sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
  const selected = selectedKey === null ? undefined : episodes.find((episode) => episode.key === selectedKey);
  const activeSeason = season ?? selected?.season ?? seasons.find((value) => value > 0) ?? seasons[0] ?? 0;
  const visibleEpisodes = episodes.filter((episode) => seasons.length <= 1 || episode.season === activeSeason);
  // Another season makes its first episode the chosen one, so Play and the source row below never
  // keep standing for an episode of the season the viewer just left. The list stays open on it.
  const chooseSeason = (next: number) => {
    onSeason(next);
    const first = episodes.filter((episode) => episode.season === next)
      .sort((a, b) => (a.episode ?? Number.MAX_SAFE_INTEGER) - (b.episode ?? Number.MAX_SAFE_INTEGER))[0];
    if (first && first.key !== selectedKey) {
      onPick(first.key);
      onOpenChange(true);
    }
  };

  return <div className="catalogue-episodes">
    {selectedKey === null || open ? <>
      <div className="subhead episode-head"><h3>{t("episodes.heading")}</h3>
        <div className="episode-tools">
          {seasons.length > 1 && <select className="season-select" aria-label={t("episodes.season")} value={activeSeason}
            onChange={(event) => chooseSeason(Number(event.target.value))}>
            {seasons.map((value) => <option key={value} value={value}>{value === 0 ? t("episodes.specials") : t("episodes.seasonNumber", { season: value })}</option>)}
          </select>}
          <span>{visibleEpisodes.length}</span>
        </div>
      </div>
      {loading ? <div className="loading" role="status">{t("common.loading")}</div>
        : !episodes.length ? <p className="identify-hint">{t("mediaServer.noEpisodes")}</p>
          : <div className="episode-list">{visibleEpisodes.map((episode, index) => <button type="button" key={episode.key}
            className={episode.key === selectedKey ? "selected" : ""} onClick={() => {
              onPick(episode.key);
              onOpenChange(false);
            }}>
            <b>{episode.season != null ? `${pad(episode.season)}×${pad(episode.episode ?? 0)}` : index + 1}</b>
            <span>{episode.title || t("episodes.one")}</span>
            <ChevronRight/>
          </button>)}</div>}
    </> : selected ? <div className="episode-current">
      <small>{t("episodes.chosen")}</small>
      <b>{selected.season != null ? `${pad(selected.season)}×${pad(selected.episode ?? 0)}` : t("episodes.part")}</b>
      <span>{selected.title || t("episodes.one")}</span>
      <button type="button" onClick={() => onOpenChange(true)}>{t("episodes.change")}</button>
    </div> : null}
  </div>;
}
