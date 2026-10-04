import { useEffect, useMemo, useRef, useState } from "react";
import { BellRing, Download, ListVideo, X } from "lucide-react";
import { ApiError, api, describeError } from "./api";
import { localeTag, serverText, t, useI18n } from "./i18n";
import { SeriesDownloadDialog } from "./SeriesDownloadDialog";
import type { Addon, FollowEpisodeRow, FollowView, LibraryView, Video } from "./types";

interface SetupEpisode { id: string; season?: number; episode?: number; title?: string; released?: string }

/** The episodes a title carries, in the shape the download setup expects. Rows without a
 *  whole season and episode are not episodes of a series and are dropped. */
export const toEpisodes = (videos?: Video[]): SetupEpisode[] => (videos ?? []).flatMap((video) => {
  if (!video.id || typeof video.season !== "number" || typeof video.episode !== "number" || video.season < 1) return [];
  const title = video.title ?? video.name;
  return [{ id: video.id, season: video.season, episode: video.episode, ...(title ? { title } : {}), ...(video.released ? { released: video.released } : {}) }];
});

const pad2 = (value: number) => String(Math.max(0, Math.trunc(value))).padStart(2, "0");
const episodeCode = (season: number, episode: number) => `S${pad2(season)}E${pad2(episode)}`;
const formatWhen = (value?: string) => value ? new Date(value).toLocaleString(localeTag(), { dateStyle: "short", timeStyle: "short" }) : "";
const formatDay = (value?: string) => value ? new Date(value).toLocaleDateString(localeTag()) : "";
/** An uncertain date is shown with the marker the calendar uses; without a date at all it says so. */
const episodeDate = (row: { released?: string; dateUncertain?: boolean }) =>
  row.dateUncertain ? `≈ ${row.released ? formatDay(row.released) : t("following.dateUnknown")}` : formatDay(row.released);

export function FollowDialog({ follow, videos, languages, libraries, addons, audioLanguage, subtitleLanguage, onChanged, onClose, onNotify }: {
  follow: FollowView;
  videos?: Video[];
  languages: Array<{ code: string; name: string }>;
  libraries: LibraryView[];
  addons: Addon[];
  audioLanguage: string;
  subtitleLanguage: string;
  onChanged: (follow: FollowView | null) => void;
  onClose: () => void;
  onNotify: (text: string) => void;
}) {
  useI18n();
  const [current, setCurrent] = useState(follow);
  const [episodes, setEpisodes] = useState<FollowEpisodeRow[]>([]);
  const [checking, setChecking] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [loadedVideos, setLoadedVideos] = useState<SetupEpisode[] | null>(null);
  // The setup dialog closes on Escape on its own, so the lower dialog must not also hear it.
  const setupOpenRef = useRef(setupOpen);
  setupOpenRef.current = setupOpen;

  const apply = (next: FollowView) => { setCurrent(next); onChanged(next); };
  const setupEpisodes = useMemo(() => videos ? toEpisodes(videos) : loadedVideos ?? [], [videos, loadedVideos]);

  useEffect(() => {
    let stale = false;
    api.followEpisodes(follow.id).then((rows) => { if (!stale) setEpisodes(rows); }).catch(() => undefined);
    return () => { stale = true; };
  }, [follow.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !setupOpenRef.current) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setEnabled = async (enabled: boolean) => {
    try { apply(await api.updateFollow(current.id, { enabled })); }
    catch (error) { onNotify(describeError(error)); }
  };
  const checkNow = async () => {
    setChecking(true);
    try { apply(await api.checkFollow(current.id)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 429) onNotify(serverText(error.messageKey, error.message));
      else onNotify(describeError(error));
    } finally { setChecking(false); }
  };
  const disableAuto = async () => {
    if (!window.confirm(t("follow.autoDisableConfirm"))) return;
    try { apply(await api.updateFollow(current.id, { autoDownload: null })); }
    catch (error) { onNotify(describeError(error)); }
  };
  const unfollow = async () => {
    if (!window.confirm(t("follow.unfollowConfirm"))) return;
    try { await api.unfollow(current.id); onChanged(null); onClose(); }
    catch (error) { onNotify(describeError(error)); }
  };
  const closeSetup = () => {
    setSetupOpen(false);
    void api.followByMeta(current.type, current.metaId)
      .then((refreshed) => { if (refreshed) apply(refreshed); })
      .catch(() => undefined);
  };
  const openSetup = async () => {
    if (setupEpisodes.length) { setSetupOpen(true); return; }
    setLoadingMeta(true);
    try {
      const meta = await api.meta(current.type, current.metaId);
      setLoadedVideos(toEpisodes(meta.videos));
      setSetupOpen(true);
    } catch (error) { onNotify(describeError(error)); }
    finally { setLoadingMeta(false); }
  };
  const reload = async () => {
    const [rows, refreshed] = await Promise.all([api.followEpisodes(current.id), api.followByMeta(current.type, current.metaId)]);
    setEpisodes(rows);
    if (refreshed) apply(refreshed);
  };
  const runAction = async (run: () => Promise<void>) => {
    try { await run(); await reload(); }
    catch (error) { onNotify(describeError(error)); }
  };

  const auto = current.autoDownload;
  const autoStart = auto
    ? auto.startMode === "new" ? t("follow.startNew") : t("follow.startFrom", { code: episodeCode(auto.startSeason ?? 1, auto.startEpisode ?? 1) })
    : "";
  const autoLibrary = auto
    ? (auto.selection.targetSettings?.libraryId && libraries.find((library) => library.id === auto.selection.targetSettings?.libraryId)?.name) || t("saveTarget.defaultLibrary")
    : "";
  const countParts = [
    current.downloads.queued ? t("follow.countQueued", { count: current.downloads.queued }) : "",
    current.downloads.waiting ? t("follow.countWaiting", { count: current.downloads.waiting }) : "",
    current.downloads.completed ? t("follow.countCompleted", { count: current.downloads.completed }) : "",
  ].filter(Boolean);
  const shownEpisodes = episodes
    .filter((row) => row.download || row.eligibility !== "outside")
    .sort((left, right) => right.season - left.season || right.episode - left.episode);
  const showEpisodes = Boolean(auto) || episodes.some((row) => row.download);

  return <>
    <div className="identify-overlay" role="dialog" aria-modal="true" aria-labelledby="follow-dialog-title" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="panel identify-card dialog-split follow-card">
        <div className="identify-head"><div><span className="bulk-eyebrow">{current.name}</span><h2 id="follow-dialog-title">{t("follow.dialogTitle")}</h2></div><button className="icon-button" aria-label={t("common.close")} onClick={onClose}><X/></button></div>
        <div className="dialog-body">
          <section className="bulk-section">
            <div className="bulk-section-head"><BellRing/><div><h3>{t("follow.statusHeading")}</h3></div></div>
            <p className="identify-hint">{current.nextEpisode ? t("follow.nextEpisode", { code: episodeCode(current.nextEpisode.season, current.nextEpisode.episode), date: formatDay(current.nextEpisode.released) }) : t("follow.noNextEpisode")}</p>
            <p className="identify-hint">{current.lastCheckedAt ? t("follow.lastChecked", { time: formatWhen(current.lastCheckedAt) }) : t("follow.neverChecked")}</p>
            {current.lastErrorKey && <p className="identify-hint follow-warning">{serverText(current.lastErrorKey, current.lastErrorKey)}</p>}
            <label className="switch follow-pause"><input type="checkbox" checked={!current.enabled} onChange={(event) => void setEnabled(!event.target.checked)}/><span/>{t("follow.paused")}</label>
            <button type="button" disabled={checking} onClick={() => void checkNow()}>{checking ? t("common.loading") : t("follow.checkNow")}</button>
          </section>
          <section className="bulk-section">
            <div className="bulk-section-head"><Download/><div><h3>{t("follow.autoHeading")}</h3><p>{t("follow.autoHint")}</p></div></div>
            {!auto
              ? loadingMeta
                ? <p className="identify-hint" aria-live="polite">{t("common.loading")}</p>
                : <button type="button" onClick={() => void openSetup()}>{t("follow.autoEnable")}</button>
              : <>
                <p className="identify-hint">{t("follow.autoSummary", { start: autoStart, library: autoLibrary })}</p>
                {auto.blockedKey && <p className="identify-hint follow-warning">{serverText(auto.blockedKey, auto.blockedKey)}</p>}
                <div className="follow-actions"><button type="button" onClick={() => void openSetup()}>{t("follow.autoEdit")}</button><button type="button" onClick={() => void disableAuto()}>{t("follow.autoDisable")}</button></div>
              </>}
            {countParts.length > 0 && <p className="identify-hint">{t("follow.counts", { parts: countParts.join(" · ") })}</p>}
          </section>
          {showEpisodes && <section className="bulk-section">
            <div className="bulk-section-head"><ListVideo/><div><h3>{t("follow.episodesHeading")}</h3></div></div>
            {shownEpisodes.map((row) => {
              const state = row.download?.state;
              const canSkip = state === "reserved" || state === "queued" || state === "waiting";
              const canRetry = state === "waiting" || state === "attention" || state === "skipped";
              const pillState = state ?? (row.eligibility === "upcoming" ? "upcoming" : undefined);
              return <div className="follow-episode" key={row.key}>
                <div className="follow-episode-main"><b>{episodeCode(row.season, row.episode)}</b><span className="follow-episode-title">{row.title ?? ""}</span></div>
                <div className="follow-episode-meta">
                  <small title={row.dateUncertain ? t("following.dateUncertainHint") : undefined}>{episodeDate(row)}</small>
                  {pillState && <span className={`state-pill state-${pillState}`}>{state === "waiting" ? t("follow.stateWaiting") : state === "completed" ? t("follow.stateCompleted") : state === "skipped" ? t("follow.stateSkipped") : state === "attention" ? t("follow.stateAttention") : state === "reserved" || state === "queued" ? t("follow.stateQueued") : t("follow.stateUpcoming")}</span>}
                  {state === "waiting" && row.download?.nextAttemptAt && <small>{t("follow.nextAttempt", { time: formatWhen(row.download.nextAttemptAt) })}</small>}
                  {state === "attention" && row.download?.reasonKey && <small>{serverText(row.download.reasonKey, row.download.reasonKey)}</small>}
                </div>
                {(canSkip || canRetry) && <span className="follow-episode-actions">
                  {canSkip && <button type="button" onClick={() => void runAction(() => api.skipFollowEpisode(current.id, row.key))}>{t("follow.skip")}</button>}
                  {canRetry && <button type="button" onClick={() => void runAction(() => api.retryFollowEpisode(current.id, row.key))}>{t("follow.retry")}</button>}
                </span>}
              </div>;
            })}
          </section>}
        </div>
        <footer className="dialog-foot"><p className="identify-hint">{t("follow.footerHint")}</p><button type="button" onClick={() => void unfollow()}>{t("follow.unfollow")}</button><button type="button" className="primary" onClick={onClose}>{t("common.close")}</button></footer>
      </div>
    </div>
    {setupOpen && <SeriesDownloadDialog type={current.type} label={current.name} title={current.name} episodes={setupEpisodes}
      audioLanguage={audioLanguage} subtitleLanguage={subtitleLanguage} languages={languages} libraries={libraries} addons={addons}
      follow={{ followId: current.id, ...(current.autoDownload ? { initial: current.autoDownload } : {}) }}
      onClose={closeSetup}/>}
  </>;
}
