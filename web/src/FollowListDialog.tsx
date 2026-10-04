import { useEffect, useRef, useState } from "react";
import { Download, Film, X } from "lucide-react";
import { FollowDialog } from "./FollowDialog";
import { localeTag, t, useI18n } from "./i18n";
import type { Addon, FollowView, LibraryView } from "./types";

const pad2 = (value: number) => String(Math.max(0, Math.trunc(value))).padStart(2, "0");
const episodeCode = (season: number, episode: number) => `S${pad2(season)}E${pad2(episode)}`;

export function FollowListDialog({ follows, languages, libraries, addons, audioLanguage, subtitleLanguage, onChanged, onClose, onNotify }: {
  follows: FollowView[];
  languages: Array<{ code: string; name: string }>;
  libraries: LibraryView[];
  addons: Addon[];
  audioLanguage: string;
  subtitleLanguage: string;
  /** One follow the list's own dialog changed, or null when it was unfollowed. */
  onChanged: (followId: string, follow: FollowView | null) => void;
  onClose: () => void;
  onNotify: (text: string) => void;
}) {
  useI18n();
  const [openId, setOpenId] = useState<string | null>(null);
  // The nested dialog closes on Escape on its own, so the list must not also hear it.
  const openRef = useRef(openId);
  openRef.current = openId;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !openRef.current) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const open = follows.find((follow) => follow.id === openId) ?? null;

  return <>
    <div className="identify-overlay" role="dialog" aria-modal="true" aria-labelledby="follow-list-title" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="panel identify-card dialog-split follow-card">
        <div className="identify-head"><h2 id="follow-list-title">{t("follow.listTitle")}</h2><button className="icon-button" aria-label={t("common.close")} onClick={onClose}><X/></button></div>
        <div className="dialog-body">
          <div className="follow-list">
            {follows.map((follow) => <button type="button" className="follow-row" key={follow.id} onClick={() => setOpenId(follow.id)}>
              <span className="follow-row-art">{follow.poster ? <img src={follow.poster} alt="" loading="lazy"/> : <Film/>}</span>
              <span className="follow-row-copy">
                <strong>{follow.name}{!follow.enabled && <em className="follow-badge">{t("follow.pausedBadge")}</em>}{follow.autoDownload && <Download aria-hidden="true"/>}</strong>
                <small>{follow.nextEpisode
                  ? t("follow.nextEpisode", { code: episodeCode(follow.nextEpisode.season, follow.nextEpisode.episode), date: follow.nextEpisode.released ? new Date(follow.nextEpisode.released).toLocaleDateString(localeTag()) : "" })
                  : follow.latestEpisode
                    ? t("follow.latestEpisode", { code: episodeCode(follow.latestEpisode.season, follow.latestEpisode.episode), date: follow.latestEpisode.released ? new Date(follow.latestEpisode.released).toLocaleDateString(localeTag()) : "" })
                    : t("follow.noNextEpisode")}</small>
                {follow.downloads.attention > 0 && <small className="follow-attention">{t("follow.stateAttention")} · {follow.downloads.attention}</small>}
              </span>
            </button>)}
          </div>
        </div>
        <footer className="dialog-foot"><button type="button" className="primary" onClick={onClose}>{t("common.close")}</button></footer>
      </div>
    </div>
    {open && <FollowDialog follow={open} languages={languages} libraries={libraries} addons={addons} audioLanguage={audioLanguage} subtitleLanguage={subtitleLanguage}
      onChanged={(updated) => { if (updated) onChanged(open.id, updated); else { onChanged(open.id, null); setOpenId(null); } }}
      onClose={() => setOpenId(null)} onNotify={onNotify}/>}
  </>;
}
