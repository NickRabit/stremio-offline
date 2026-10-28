import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, CalendarClock, FolderOpen, ListFilter, Trash2, X } from "lucide-react";
import { api, describeError } from "./api";
import { useDialogFocus } from "./dialog-focus";
import { inlineLanguageName, t, useI18n } from "./i18n";
import { SaveTargetFields } from "./SaveTargetFields";
import type { SaveTarget } from "./save-target";
import { profileAudioLanguage, profileAudioMode, profileSummary, sourceProfileName } from "./source-profile-copy";
import type { FollowAutoDownload, FollowPreview, FollowStartMode, FollowView, LibraryView, ProfileSelection, SourceProfile, Stream } from "./types";

interface Episode { id: string; season?: number; episode?: number; title?: string; released?: string }

const localPreview = (episodes: Episode[], startMode: FollowStartMode, startSeason?: number, startEpisode?: number, aheadCount?: number): FollowPreview => {
  if (startMode === "new") return { count: 0, episodes: [] };
  const now = Date.now();
  if (startMode === "ahead") {
    const window = episodes.filter((episode) => episode.season != null && episode.season >= 1 && episode.episode != null)
      .sort((left, right) => (left.season ?? 0) - (right.season ?? 0) || (left.episode ?? 0) - (right.episode ?? 0))
      .slice(0, Math.max(0, aheadCount ?? 0));
    return { count: window.filter((episode) => episode.released && Date.parse(episode.released) <= now).length, episodes: [] };
  }
  const due = episodes.filter((episode) => episode.season != null && episode.episode != null && episode.released
    && Date.parse(episode.released) <= now
    && (episode.season > (startSeason ?? 0) || (episode.season === startSeason && episode.episode >= (startEpisode ?? 0))));
  return { count: due.length, episodes: [] };
};
const pad2 = (value: number) => String(Math.max(0, Math.trunc(value))).padStart(2, "0");
const usableProfile = (profile: SourceProfile) => profile.template === "rules"
  && profile.operations.includes("downloadToLibrary")
  && Boolean(sourceProfileName(profile.nameKey, profile.name));

export function SeriesDownloadDialog({ type, label, title, episodes, libraries, follow, canRetain = false,
  downloadSourceProfileId, followSourceProfileId, onRememberDownloadSourceProfile, onRememberFollowSourceProfile,
  exactSource, onExactSave, onClose, onSubmit }: {
  type: string; label: string; title: string; episodes: Episode[]; libraries: LibraryView[];
  canRetain?: boolean;
  downloadSourceProfileId?: string;
  followSourceProfileId?: string;
  onRememberDownloadSourceProfile?: (profileId: string | null) => Promise<void>;
  onRememberFollowSourceProfile?: (profileId: string | null) => Promise<void>;
  follow?: { followId?: string; initial?: FollowAutoDownload; create?: { metaId: string; name: string; poster?: string; addonKey?: string }; onFollowed?: (follow: FollowView) => void };
  exactSource?: { stream: Stream; label: string; preferred: boolean };
  onExactSave?: (target?: SaveTarget) => Promise<void>;
  onClose: () => void;
  onSubmit?: (selection: ProfileSelection, target?: SaveTarget) => Promise<void>;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog);
  useI18n();
  const initial = follow?.initial;
  const creating = Boolean(follow?.create);
  const isMovie = type === "movie";
  const [followMode, setFollowMode] = useState<"notify" | "download">("notify");
  const downloading = !creating || followMode === "download";
  const [profiles, setProfiles] = useState<SourceProfile[]>([]);
  const [profilesState, setProfilesState] = useState<"idle" | "loading" | "ready" | "unavailable">("idle");
  const [profileId, setProfileId] = useState("");
  const [exactSelected, setExactSelected] = useState(Boolean(exactSource?.preferred));
  const [rememberProfile, setRememberProfile] = useState(false);
  const [graceDays, setGraceDays] = useState(initial?.graceDays ?? (follow ? 2 : 0));
  const [retentionDays, setRetentionDays] = useState<number>(initial?.retention?.afterWatchedDays ?? 0);
  const [target, setTarget] = useState<SaveTarget | null>(() => {
    const settings = initial?.selection.targetSettings;
    return settings?.libraryId ? { libraryId: settings.libraryId, subfolder: settings.subfolder, layout: settings.layout } : null;
  });
  const [startMode, setStartMode] = useState<FollowStartMode>(initial?.startMode ?? "new");
  const [startSeason, setStartSeason] = useState<number | undefined>(initial?.startSeason);
  const [startEpisode, setStartEpisode] = useState<number | undefined>(initial?.startEpisode);
  const [aheadCount, setAheadCount] = useState(initial?.aheadCount ?? 3);
  const [preview, setPreview] = useState<FollowPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedProfile = profiles.find((profile) => profile.id === profileId);
  const waitsForAudio = selectedProfile !== undefined && profileAudioMode(selectedProfile) === "prefer";
  const graceLanguage = selectedProfile === undefined ? undefined : profileAudioLanguage(selectedProfile);
  const graceLabel = graceLanguage === undefined
    ? t("rules.waitForAudio")
    : t("rules.waitForAudioLanguage", { language: inlineLanguageName(graceLanguage) });
  const defaultProfileId = follow ? followSourceProfileId : downloadSourceProfileId;
  const remember = follow ? onRememberFollowSourceProfile : onRememberDownloadSourceProfile;
  const showRemember = !exactSelected && Boolean(remember) && Boolean(profileId) && profileId !== (defaultProfileId ?? "");
  const legacyFollow = Boolean(follow?.followId && initial && !initial.sourceProfile);
  const profilesRequested = useRef(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  useEffect(() => {
    if (!downloading || profilesRequested.current) return;
    profilesRequested.current = true;
    setProfilesState("loading");
    let stale = false;
    api.sourceProfiles().then((items) => {
      if (stale) return;
      const offered = items.filter(usableProfile);
      setProfiles(offered);
      if (!offered.length) { setProfilesState("unavailable"); return; }
      const initialId = initial?.sourceProfile?.profileId;
      const modeDefault = follow ? followSourceProfileId : downloadSourceProfileId;
      const preset = follow ? "rules.preset.myLanguage" : "rules.preset.balanced";
      const legacy = Boolean(follow?.followId && initial && !initial.sourceProfile);
      const chosen = legacy ? offered[0]! : offered.find((profile) => profile.id === initialId)
        ?? offered.find((profile) => profile.id === modeDefault)
        ?? offered.find((profile) => profile.nameKey === preset)
        ?? offered[0]!;
      setProfileId(chosen.id);
      setProfilesState("ready");
    }).catch(() => { if (!stale) setProfilesState("unavailable"); });
    return () => { stale = true; };
  }, [downloading, initial, follow, downloadSourceProfileId, followSourceProfileId]);

  useEffect(() => {
    if (!follow) return;
    if (startMode === "from" && (startSeason == null || startEpisode == null)) { setPreview(null); return; }
    const followId = follow.followId;
    if (!followId) { setPreview(localPreview(episodes, startMode, startSeason, startEpisode, aheadCount)); return; }
    let stale = false;
    const timer = window.setTimeout(() => {
      api.followPreview(followId, { startMode, startSeason, startEpisode, aheadCount })
        .then((answer) => { if (!stale) setPreview(answer); })
        .catch(() => { if (!stale) setPreview(null); });
    }, 300);
    return () => { stale = true; window.clearTimeout(timer); };
  }, [follow, episodes, startMode, startSeason, startEpisode, aheadCount]);

  const startSeasons = useMemo(() => [...new Set(episodes.map((episode) => episode.season)
    .filter((value): value is number => typeof value === "number"))].sort((a, b) => a - b), [episodes]);
  const startSeasonEpisodes = episodes.filter((episode) => episode.season === startSeason && typeof episode.episode === "number")
    .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
  const startMissing = Boolean(follow && !isMovie && startMode === "from" && (startSeason == null || startEpisode == null));
  const chooseFrom = () => {
    setStartMode("from");
    if (startSeason == null) {
      const season = startSeasons[0];
      setStartSeason(season);
      setStartEpisode(episodes.find((episode) => episode.season === season)?.episode);
    }
  };

  const submit = async () => {
    if (downloading && !exactSelected && !selectedProfile) return;
    setBusy(true); setError("");
    try {
      if (follow?.create && followMode === "notify") {
        follow.onFollowed?.(await api.follow({ type, id: follow.create.metaId, name: follow.create.name, poster: follow.create.poster, ...(follow.create.addonKey ? { addonKey: follow.create.addonKey } : {}) }));
        onClose();
        return;
      }
      if (exactSelected && exactSource) {
        if (!onExactSave) return;
        await onExactSave(target ?? undefined);
        onClose();
        return;
      }
      const selection: ProfileSelection = { profile: { profileId: selectedProfile!.id, revision: selectedProfile!.revision } };
      if (follow) {
        const created = follow.create ? await api.follow({ type, id: follow.create.metaId, name: follow.create.name, poster: follow.create.poster, ...(follow.create.addonKey ? { addonKey: follow.create.addonKey } : {}) }) : undefined;
        const followId = created?.id ?? follow.followId!;
        const updated = await api.updateFollow(followId, {
          ...(canRetain ? { retention: retentionDays > 0 ? { afterWatchedDays: retentionDays } : null } : {}),
          autoDownload: {
            startMode,
            ...(startMode === "from" && startSeason != null && startEpisode != null ? { startSeason, startEpisode } : {}),
            ...(startMode === "ahead" ? { aheadCount } : {}),
            graceDays: waitsForAudio ? graceDays : 0,
            selection,
            ...(target ? { target } : {}),
          },
        });
        if (created) follow.onFollowed?.(updated);
      } else if (onSubmit) await onSubmit(selection, target ?? undefined);
      if (rememberProfile && showRemember) void Promise.resolve().then(() => remember?.(profileId)).catch(() => undefined);
      onClose();
    } catch (value) { setError(describeError(value)); }
    finally { setBusy(false); }
  };
  const dialogTitle = creating
    ? t(isMovie ? "follow.createTitleMovie" : "follow.createTitle")
    : follow
      ? t("follow.setupTitle")
      : isMovie
        ? t("bulk.titleMovie")
        : type === "series" && episodes.length === 1
          ? t("bulk.titleEpisode")
          : t("bulk.title");

  return <div ref={dialog} tabIndex={-1} className="identify-overlay" role="dialog" aria-modal="true" aria-labelledby="bulk-dialog-title" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="panel identify-card dialog-split bulk-card">
      <div className="identify-head bulk-head"><div><span className="bulk-eyebrow">{label}</span><h2 id="bulk-dialog-title">{dialogTitle}</h2></div><button className="icon-button" aria-label={t("common.cancel")} disabled={busy} onClick={onClose}><X/></button></div>
      <div className="dialog-body bulk-body">
        {creating && <section className="bulk-section"><div className="bulk-section-head"><Bell/><div><h3>{t("follow.howHeading")}</h3></div></div>
          <div className="bulk-strategy" role="radiogroup" aria-label={t("follow.howHeading")}>{(["notify", "download"] as const).map((mode) => <label key={mode} className={followMode === mode ? "selected" : ""}><input type="radio" name="follow-mode" value={mode} checked={followMode === mode} onChange={() => setFollowMode(mode)}/><span><strong>{t(mode === "notify" ? (isMovie ? "follow.movieNotify" : "follow.modeNotify") : (isMovie ? "follow.movieDownload" : "follow.modeDownload"))}</strong><small>{t(mode === "notify" ? (isMovie ? "follow.movieNotifyHint" : "follow.modeNotifyHint") : (isMovie ? "follow.movieDownloadHint" : "follow.modeDownloadHint"))}</small></span></label>)}</div>
        </section>}
        {follow && downloading && !isMovie && <section className="bulk-section"><div className="bulk-section-head"><CalendarClock/><div><h3>{t("follow.startHeading")}</h3></div></div>
          <div className="bulk-strategy" role="radiogroup" aria-label={t("follow.startHeading")}>
            <label className={startMode === "new" ? "selected" : ""}><input type="radio" name="follow-start" value="new" checked={startMode === "new"} onChange={() => setStartMode("new")}/><span><strong>{t("follow.startNew")}</strong></span></label>
            <label className={startMode === "from" ? "selected" : ""}><input type="radio" name="follow-start" value="from" checked={startMode === "from"} onChange={chooseFrom}/><span><strong>{t("follow.startFromLabel")}</strong></span></label>
            <label className={startMode === "ahead" ? "selected" : ""}><input type="radio" name="follow-start" value="ahead" checked={startMode === "ahead"} onChange={() => setStartMode("ahead")}/><span><strong>{t("follow.startAhead")}</strong><select aria-label={t("follow.startAhead")} value={aheadCount} onChange={(event) => { setStartMode("ahead"); setAheadCount(Number(event.target.value)); }}>{Array.from({ length: 10 }, (_value, index) => index + 1).map((count) => <option key={count} value={count}>{t("follow.aheadCount", { count })}</option>)}</select></span></label>
          </div>
          {startMode === "from" && <div className="bulk-language-grid"><label><span>{t("episodes.season")}</span><select value={startSeason ?? ""} onChange={(event) => { const season = Number(event.target.value); setStartSeason(season); setStartEpisode(episodes.find((episode) => episode.season === season)?.episode); }}>{startSeasons.map((season) => <option key={season} value={season}>{t("episodes.seasonNumber", { season })}</option>)}</select></label><label><span>{t("episodes.heading")}</span><select value={startEpisode ?? ""} onChange={(event) => setStartEpisode(Number(event.target.value))}>{startSeasonEpisodes.map((episode) => <option key={episode.id} value={episode.episode}>{`S${pad2(episode.season ?? 1)}E${pad2(episode.episode ?? 1)}`}</option>)}</select></label></div>}
          <p className="identify-hint" aria-live="polite">{preview && preview.count ? t("follow.previewCount", { count: preview.count }) : t("follow.previewNone")}</p>
        </section>}
        {downloading && <>
          <section className="bulk-section"><div className="bulk-section-head"><ListFilter/><div><h3>{t("rules.title")}</h3></div></div>
            {legacyFollow && <p className="identify-hint follow-warning">{t("rules.legacyFollowNote")}</p>}
            {profilesState === "loading" && <p className="identify-hint">{t("common.loading")}</p>}
            {profilesState === "unavailable" && <p className="identify-hint follow-warning">{t("rules.unavailable")}</p>}
            {(exactSource || profilesState === "ready") && <div className="bulk-strategy rules-choice" role="radiogroup" aria-label={t("rules.title")}>
              {exactSource && <label className={exactSelected ? "selected" : ""}><input type="radio" name="download-rules" value="exact-source" checked={exactSelected} onChange={() => { setExactSelected(true); setRememberProfile(false); }}/><span><strong>{t("rules.selectedSource")}</strong><small>{exactSource.label}</small></span></label>}
              {profilesState === "ready" && profiles.map((profile) => <label key={profile.id} className={!exactSelected && profileId === profile.id ? "selected" : ""}><input type="radio" name="download-rules" value={profile.id} checked={!exactSelected && profileId === profile.id} onChange={() => { setExactSelected(false); setProfileId(profile.id); setRememberProfile(false); }}/><span><strong>{sourceProfileName(profile.nameKey, profile.name)}</strong><small>{profileSummary(profile, isMovie ? "movie" : "episode")}</small></span></label>)}
            </div>}
            {follow && waitsForAudio && <div className="bulk-language-grid rules-grace"><label><span>{graceLabel}</span><select aria-label={graceLabel} value={graceDays} onChange={(event) => setGraceDays(Number(event.target.value))}><option value={0}>{t("rules.waitNone")}</option>{[1, 2, 3, 7, 14].map((days) => <option key={days} value={days}>{t("rules.waitDays", { count: days })}</option>)}</select></label></div>}
            {showRemember && <label className="bulk-remember-profile"><input type="checkbox" aria-label={t(follow ? "rules.rememberForFollows" : "rules.rememberForDownloads")} checked={rememberProfile} onChange={(event) => setRememberProfile(event.target.checked)}/><span>{t(follow ? "rules.rememberForFollows" : "rules.rememberForDownloads")}</span></label>}
          </section>
          <section className="bulk-section"><div className="bulk-section-head"><FolderOpen/><div><h3>{t("saveTarget.where")}</h3><p>{t("saveTarget.whereHint")}</p></div></div><SaveTargetFields kind={isMovie ? "movie" : "series"} title={title} libraries={libraries} rule={undefined} value={target} onChange={setTarget}/></section>
          {follow && !isMovie && canRetain && <section className="bulk-section"><div className="bulk-section-head"><Trash2/><div><h3>{t("follow.retentionHeading")}</h3></div></div><div className="bulk-language-grid"><label><select aria-label={t("follow.retentionHeading")} value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))}><option value={0}>{t("follow.retentionKeep")}</option>{[1, 7, 30].map((days) => <option key={days} value={days}>{t("follow.retentionAfter", { count: days })}</option>)}</select></label></div><p className="identify-hint">{t("follow.retentionHint")}</p></section>}
        </>}
        {error && <p className="login-error" role="alert">{error}</p>}
      </div>
      <footer className="dialog-foot"><p className="identify-hint">{creating && !downloading ? t(isMovie ? "follow.movieNotifyHint" : "follow.modeNotifyHint") : follow ? t("follow.setupHint") : t("bulk.queueHint")}</p><button type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</button><button type="button" className="primary" disabled={busy || (downloading && (startMissing || (exactSelected ? !onExactSave : profilesState !== "ready" || !selectedProfile)))} onClick={() => void submit()}>{busy ? t("save.adding") : creating ? t(downloading ? "follow.followAndDownload" : "follow.followSave") : follow ? t("follow.setupSave") : t("bulk.add")}</button></footer>
    </div>
  </div>;
}
