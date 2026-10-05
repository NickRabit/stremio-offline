import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Bell, CalendarClock, FolderOpen, Languages, ListFilter, Subtitles, Trash2, X } from "lucide-react";
import { api, describeError } from "./api";
import { languageName, t, useI18n } from "./i18n";
import { SaveTargetFields } from "./SaveTargetFields";
import type { SaveTarget } from "./save-target";
import type { Addon, AudioMode, DownloadSelection, DownloadSourceStrategy, FollowAutoDownload, FollowDefaults, FollowPreview, FollowStartMode, FollowView, LibraryView, SubtitleMode } from "./types";

interface Episode { id: string; season?: number; episode?: number; title?: string; released?: string }

/** What a proposed start would fetch at once, worked out from the episodes on screen while
 *  the follow does not exist yet and the server cannot be asked. */
const localPreview = (episodes: Episode[], startMode: FollowStartMode, startSeason?: number, startEpisode?: number, aheadCount?: number): FollowPreview => {
  if (startMode === "new") return { count: 0, episodes: [] };
  const now = Date.now();
  // With no marker on hand, "ahead" starts at the first regular episode: the first N fill the
  // window, and the released ones among them would download now.
  if (startMode === "ahead") {
    const window = episodes
      .filter((episode) => episode.season != null && episode.season >= 1 && episode.episode != null)
      .sort((left, right) => (left.season ?? 0) - (right.season ?? 0) || (left.episode ?? 0) - (right.episode ?? 0))
      .slice(0, Math.max(0, aheadCount ?? 0));
    return { count: window.filter((episode) => episode.released && Date.parse(episode.released) <= now).length, episodes: [] };
  }
  const due = episodes.filter((episode) => {
    if (episode.season == null || episode.episode == null || !episode.released) return false;
    const released = Date.parse(episode.released);
    if (!Number.isFinite(released) || released > now) return false;
    return episode.season > (startSeason ?? 0) || (episode.season === startSeason && episode.episode >= (startEpisode ?? 0));
  });
  return { count: due.length, episodes: [] };
};

const pad2 = (value: number) => String(Math.max(0, Math.trunc(value))).padStart(2, "0");

export function SeriesDownloadDialog({ type, label, title, episodes, audioLanguage, subtitleLanguage, languages, libraries, addons, follow, canRetain = false, onClose, onSubmit }: {
  type: string;
  label: string;
  title: string;
  episodes: Episode[];
  audioLanguage: string;
  subtitleLanguage: string;
  languages: Array<{ code: string; name: string }>;
  libraries: LibraryView[];
  addons: Addon[];
  /** Administrators may delete watched episodes automatically; nobody else sees the choice. */
  canRetain?: boolean;
  /** Set when the dialog edits a follow's automatic rule instead of queueing a batch. Without
   *  `followId` it is the first step of following: how to follow comes first, and the follow
   *  is created only when the person confirms. */
  follow?: { followId?: string; initial?: FollowAutoDownload; create?: { metaId: string; name: string; poster?: string }; onFollowed?: (follow: FollowView) => void };
  onClose: () => void;
  onSubmit?: (selection: DownloadSelection, target?: SaveTarget) => Promise<void>;
}) {
  useI18n();
  const initial = follow?.initial;
  const startAudio = initial?.selection.audioLanguage ?? audioLanguage;
  const startSubtitle = initial?.selection.subtitleLanguage ?? subtitleLanguage;
  const [sources, setSources] = useState<Array<{ key: string; name: string }>>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  // A follow keeps its sources in the order the owner set, so priority is the default there.
  const [sourceStrategy, setSourceStrategy] = useState<DownloadSourceStrategy>(follow ? initial?.selection.sourceStrategy ?? "priority" : "largest");
  const [audio, setAudio] = useState(startAudio);
  const [audioFallback, setAudioFallback] = useState(initial?.selection.fallbackAudioLanguage ?? (startAudio === "en" ? "" : "en"));
  const [audioMode, setAudioMode] = useState<AudioMode>(initial?.selection.audioMode ?? "listed");
  const [graceDays, setGraceDays] = useState(initial?.graceDays ?? 0);
  const [retentionDays, setRetentionDays] = useState<number>(initial?.retention?.afterWatchedDays ?? 0);
  const [subtitleMode, setSubtitleMode] = useState<SubtitleMode>(initial?.selection.subtitleMode ?? "optional");
  const [subtitle, setSubtitle] = useState(startSubtitle);
  const [subtitleFallback, setSubtitleFallback] = useState(initial?.selection.fallbackSubtitleLanguage ?? (startSubtitle === "en" ? "" : "en"));
  const [target, setTarget] = useState<SaveTarget | null>(() => {
    const settings = initial?.selection.targetSettings;
    return settings?.libraryId ? { libraryId: settings.libraryId, subfolder: settings.subfolder, layout: settings.layout } : null;
  });
  const [startMode, setStartMode] = useState<FollowStartMode>(initial?.startMode ?? "new");
  const [startSeason, setStartSeason] = useState<number | undefined>(initial?.startSeason);
  const [startEpisode, setStartEpisode] = useState<number | undefined>(initial?.startEpisode);
  const [aheadCount, setAheadCount] = useState<number>(initial?.aheadCount ?? 3);
  const [preview, setPreview] = useState<FollowPreview | null>(null);
  const creating = Boolean(follow?.create);
  // A film has no episodes to start from and is saved by the film rules.
  const isMovie = type === "movie";
  const [followMode, setFollowMode] = useState<"notify" | "download">("notify");
  const downloading = !creating || followMode === "download";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** Set by any control the user changes: a defaults answer that lands later is then dropped. */
  const touched = useRef(false);
  const [defaults, setDefaults] = useState<FollowDefaults | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  useEffect(() => {
    let cancelled = false;
    const first = episodes[0];
    if (!first) return;
    api.streamSources(type, first.id).then((items) => {
      if (cancelled) return;
      setSources(items);
      const preferred = (initial?.selection.addonKeys ?? []).filter((key) => items.some((item) => item.key === key));
      setChosen(preferred.length ? preferred : items.map((item) => item.key));
    }).catch((value) => { if (!cancelled) setError(describeError(value)); });
    return () => { cancelled = true; };
  }, [type, episodes, initial]);

  // Create mode opens with the choices of the previous follow. The source list decides which
  // addon keys are still usable, so the answer waits for it before it is applied.
  useEffect(() => {
    if (!creating) return;
    let stale = false;
    api.followDefaults()
      .then((answer) => { if (!stale && answer && !touched.current) setDefaults(answer); })
      .catch(() => undefined);
    return () => { stale = true; };
  }, [creating]);

  useEffect(() => {
    if (!defaults || touched.current || !sources.length) return;
    setDefaults(null);
    setFollowMode(defaults.mode);
    if (defaults.mode !== "download") return;
    if (defaults.startMode) setStartMode(defaults.startMode);
    if (defaults.aheadCount) setAheadCount(defaults.aheadCount);
    setGraceDays(defaults.graceDays ?? 0);
    if (defaults.selection) {
      const keys = defaults.selection.addonKeys.filter((key) => sources.some((item) => item.key === key));
      if (keys.length) setChosen(keys);
      setSourceStrategy(defaults.selection.sourceStrategy);
      setAudio(defaults.selection.audioLanguage);
      setAudioFallback(defaults.selection.fallbackAudioLanguage ?? (defaults.selection.audioLanguage === "en" ? "" : "en"));
      setAudioMode(defaults.selection.audioMode);
      setSubtitleMode(defaults.selection.subtitleMode);
      if (defaults.selection.subtitleLanguage) setSubtitle(defaults.selection.subtitleLanguage);
      setSubtitleFallback(defaults.selection.fallbackSubtitleLanguage ?? (defaults.selection.subtitleLanguage !== "en" ? "en" : ""));
    }
    if (defaults.target) setTarget({ libraryId: defaults.target.libraryId, subfolder: defaults.target.subfolder ?? "", layout: defaults.target.layout ?? "structured" });
  }, [defaults, sources]);

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

  const toggle = (key: string) => setChosen((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  const move = (key: string, direction: -1 | 1) => setChosen((current) => {
    const index = current.indexOf(key); const next = index + direction;
    if (index < 0 || next < 0 || next >= current.length) return current;
    const copy = [...current]; [copy[index], copy[next]] = [copy[next], copy[index]]; return copy;
  });
  const orderedSources = [...sources].sort((a, b) => {
    const left = chosen.indexOf(a.key), right = chosen.indexOf(b.key);
    if (left < 0 || right < 0) return left < 0 ? 1 : -1;
    return left - right;
  });
  // The destination defaults to the rule of the first addon in the chosen order.
  const rule = addons.find((addon) => addon.key === chosen[0])?.downloadSettings;
  const languageOptions = () => languages.map(({ code }) => <option key={code} value={code}>{languageName(code)}</option>);
  const startSeasons = [...new Set(episodes.map((episode) => episode.season).filter((value): value is number => typeof value === "number"))].sort((a, b) => a - b);
  const startSeasonEpisodes = episodes.filter((episode) => episode.season === startSeason && typeof episode.episode === "number").sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
  const startMissing = follow && !isMovie && startMode === "from" && (startSeason == null || startEpisode == null);
  const chooseFrom = () => {
    setStartMode("from");
    if (startSeason == null) {
      const season = startSeasons[0];
      setStartSeason(season);
      setStartEpisode(episodes.find((episode) => episode.season === season)?.episode);
    }
  };

  const submit = async () => {
    if (downloading && !chosen.length) return;
    setBusy(true); setError("");
    try {
      if (follow?.create && followMode === "notify") {
        follow.onFollowed?.(await api.follow({ type, id: follow.create.metaId, name: follow.create.name, poster: follow.create.poster }));
        void api.saveFollowDefaults({ mode: "notify" }).catch(() => undefined);
        onClose();
        return;
      }
      const selection: DownloadSelection = {
        addonKeys: chosen, sourceStrategy, audioLanguage: audio,
        fallbackAudioLanguage: audioFallback && audioFallback !== audio ? audioFallback : undefined,
        audioMode,
        subtitleMode,
        subtitleLanguage: subtitleMode === "off" ? undefined : subtitle,
        fallbackSubtitleLanguage: subtitleMode !== "off" && subtitleFallback !== subtitle ? subtitleFallback || undefined : undefined,
      };
      if (follow) {
        const created = follow.create ? await api.follow({ type, id: follow.create.metaId, name: follow.create.name, poster: follow.create.poster }) : undefined;
        const followId = created?.id ?? follow.followId!;
        const updated = await api.updateFollow(followId, {
          ...(canRetain ? { retention: retentionDays > 0 ? { afterWatchedDays: retentionDays } : null } : {}),
          autoDownload: {
            startMode,
            ...(startMode === "from" && startSeason != null && startEpisode != null ? { startSeason, startEpisode } : {}),
            ...(startMode === "ahead" ? { aheadCount } : {}),
            graceDays,
            selection,
            ...(target ? { target } : {}),
          },
        });
        if (created) follow.onFollowed?.(updated);
      } else if (onSubmit) {
        await onSubmit(selection, target ?? undefined);
      }
      // Remembering the choices is a courtesy; a refusal here must never block the follow.
      if (creating && followMode === "download") void api.saveFollowDefaults({
        mode: "download", startMode, ...(startMode === "ahead" ? { aheadCount } : {}), graceDays,
        selection: {
          addonKeys: selection.addonKeys, sourceStrategy: selection.sourceStrategy, audioLanguage: selection.audioLanguage,
          ...(selection.fallbackAudioLanguage ? { fallbackAudioLanguage: selection.fallbackAudioLanguage } : {}),
          audioMode, subtitleMode: selection.subtitleMode,
          ...(selection.subtitleLanguage ? { subtitleLanguage: selection.subtitleLanguage } : {}),
          ...(selection.fallbackSubtitleLanguage ? { fallbackSubtitleLanguage: selection.fallbackSubtitleLanguage } : {}),
        },
        ...(target ? { target } : {}),
      }).catch(() => undefined);
      onClose();
    } catch (value) { setError(describeError(value)); }
    finally { setBusy(false); }
  };

  return <div className="identify-overlay" role="dialog" aria-modal="true" aria-labelledby="bulk-dialog-title" onChangeCapture={() => { touched.current = true; }} onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="panel identify-card dialog-split bulk-card">
      <div className="identify-head bulk-head"><div><span className="bulk-eyebrow">{label}</span><h2 id="bulk-dialog-title">{creating ? t(isMovie ? "follow.createTitleMovie" : "follow.createTitle") : follow ? t("follow.setupTitle") : t("bulk.title")}</h2></div><button className="icon-button" aria-label={t("common.cancel")} disabled={busy} onClick={onClose}><X/></button></div>
      <div className="dialog-body bulk-body">
        {creating && <section className="bulk-section">
          <div className="bulk-section-head"><Bell/><div><h3>{t("follow.howHeading")}</h3></div></div>
          <div className="bulk-strategy" role="radiogroup" aria-label={t("follow.howHeading")}>
            {(["notify", "download"] as const).map((mode) => <label key={mode} className={followMode === mode ? "selected" : ""}>
              <input type="radio" name="follow-mode" value={mode} checked={followMode === mode} onChange={() => setFollowMode(mode)}/>
              <span><strong>{t(mode === "notify" ? (isMovie ? "follow.movieNotify" : "follow.modeNotify") : (isMovie ? "follow.movieDownload" : "follow.modeDownload"))}</strong><small>{t(mode === "notify" ? (isMovie ? "follow.movieNotifyHint" : "follow.modeNotifyHint") : (isMovie ? "follow.movieDownloadHint" : "follow.modeDownloadHint"))}</small></span>
            </label>)}
          </div>
        </section>}
        {follow && downloading && !isMovie && <section className="bulk-section">
          <div className="bulk-section-head"><CalendarClock/><div><h3>{t("follow.startHeading")}</h3></div></div>
          <div className="bulk-strategy" role="radiogroup" aria-label={t("follow.startHeading")}>
            <label className={startMode === "new" ? "selected" : ""}>
              <input type="radio" name="follow-start" value="new" checked={startMode === "new"} onChange={() => setStartMode("new")}/>
              <span><strong>{t("follow.startNew")}</strong></span>
            </label>
            <label className={startMode === "from" ? "selected" : ""}>
              <input type="radio" name="follow-start" value="from" checked={startMode === "from"} onChange={chooseFrom}/>
              <span><strong>{t("follow.startFromLabel")}</strong></span>
            </label>
            <label className={startMode === "ahead" ? "selected" : ""}>
              <input type="radio" name="follow-start" value="ahead" checked={startMode === "ahead"} onChange={() => setStartMode("ahead")}/>
              <span><strong>{t("follow.startAhead")}</strong>
                <select aria-label={t("follow.startAhead")} value={aheadCount} onChange={(event) => { setStartMode("ahead"); setAheadCount(Number(event.target.value)); }}>
                  {Array.from({ length: 10 }, (_unused, index) => index + 1).map((count) => <option key={count} value={count}>{t("follow.aheadCount", { count })}</option>)}
                </select>
              </span>
            </label>
          </div>
          {startMode === "from" && <div className="bulk-language-grid">
            <label><span>{t("episodes.season")}</span><select value={startSeason ?? ""} onChange={(event) => { const season = Number(event.target.value); setStartSeason(season); setStartEpisode(episodes.find((episode) => episode.season === season)?.episode); }}>{startSeasons.map((season) => <option key={season} value={season}>{t("episodes.seasonNumber", { season })}</option>)}</select></label>
            <label><span>{t("episodes.heading")}</span><select value={startEpisode ?? ""} onChange={(event) => setStartEpisode(Number(event.target.value))}>{startSeasonEpisodes.map((episode) => <option key={episode.id} value={episode.episode}>{`S${pad2(episode.season ?? 1)}E${pad2(episode.episode ?? 1)}`}</option>)}</select></label>
          </div>}
          <p className="identify-hint" aria-live="polite">{preview && preview.count ? t("follow.previewCount", { count: preview.count }) : t("follow.previewNone")}</p>
        </section>}
        {downloading && <>
        <section className="bulk-section">
          <div className="bulk-section-head"><ListFilter/><div><h3>{t("bulk.sourceStrategy")}</h3><p>{t("bulk.sourceStrategyHint")}</p></div></div>
          <div className="bulk-strategy" role="radiogroup" aria-label={t("bulk.sourceStrategy")}>
            {(["largest", "priority"] as DownloadSourceStrategy[]).map((strategy) => <label key={strategy} className={sourceStrategy === strategy ? "selected" : ""}>
              <input type="radio" name="source-strategy" value={strategy} checked={sourceStrategy === strategy} onChange={() => setSourceStrategy(strategy)}/>
              <span><strong>{t(strategy === "largest" ? "bulk.strategyLargest" : "bulk.strategyPriority")}</strong><small>{t(strategy === "largest" ? "bulk.strategyLargestHint" : "bulk.strategyPriorityHint")}</small></span>
            </label>)}
          </div>
          <fieldset className="bulk-sources"><legend>{t("bulk.sources")}</legend><p className="identify-hint">{t("bulk.sourcesHint")}</p>
            {orderedSources.map((source) => { const index = chosen.indexOf(source.key); return <div key={source.key} className={index >= 0 ? "selected" : ""}>
              <label><input type="checkbox" checked={index >= 0} onChange={() => toggle(source.key)}/>{sourceStrategy === "priority" && index >= 0 && <b>{index + 1}</b>}<span>{source.name}</span></label>
              {index >= 0 && sourceStrategy === "priority" && <span><button className="icon-button" aria-label={t("bulk.moveSourceUp", { name: source.name })} disabled={index === 0} onClick={() => move(source.key, -1)}><ArrowUp/></button><button className="icon-button" aria-label={t("bulk.moveSourceDown", { name: source.name })} disabled={index === chosen.length - 1} onClick={() => move(source.key, 1)}><ArrowDown/></button></span>}
            </div>})}
            {!sources.length && !error && <p className="identify-hint" aria-live="polite">{t("common.loading")}</p>}
          </fieldset>
        </section>
        <section className="bulk-section">
          <div className="bulk-section-head"><Languages/><div><h3>{t("bulk.audioSettings")}</h3><p>{t("bulk.audioSettingsHint")}</p></div></div>
          <div className="bulk-language-grid bulk-audio-grid">
            <label><span>{t("bulk.audioMode")}</span><select value={audioMode} onChange={(event) => setAudioMode(event.target.value as AudioMode)}>
              <option value="listed">{t("bulk.audioModeListed")}</option>
              <option value="preferred">{t("bulk.audioModePreferred")}</option>
              <option value="strict">{t("bulk.audioModeStrict")}</option>
            </select></label>
            <label><span>{t("bulk.audio")}</span><select value={audio} onChange={(event) => setAudio(event.target.value)}>{languageOptions()}</select></label>
            <label><span>{t("bulk.audioFallback")}</span><select value={audioFallback} onChange={(event) => setAudioFallback(event.target.value)}><option value="">{t("bulk.noFallback")}</option>{languageOptions()}</select></label>
          </div>
          <p className="identify-hint bulk-mode-hint">{t(audioMode === "listed" ? "bulk.audioModeHintListed" : audioMode === "preferred" ? "bulk.audioModeHintPreferred" : "bulk.audioModeHintStrict")}</p>
          {follow && <><div className="bulk-language-grid">
            <label><span>{t("follow.graceLabel")}</span><select value={graceDays} onChange={(event) => setGraceDays(Number(event.target.value))}>
              <option value={0}>{t("follow.graceNone")}</option>
              {[3, 7, 14].map((days) => <option key={days} value={days}>{t("follow.graceDays", { count: days })}</option>)}
            </select></label>
          </div>
          <p className="identify-hint">{t("follow.graceHint")}</p></>}
        </section>
        {follow && downloading && !isMovie && canRetain && <section className="bulk-section">
          <div className="bulk-section-head"><Trash2/><div><h3>{t("follow.retentionHeading")}</h3></div></div>
          <div className="bulk-language-grid">
            <label><select aria-label={t("follow.retentionHeading")} value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))}>
              <option value={0}>{t("follow.retentionKeep")}</option>
              {[1, 7, 30].map((days) => <option key={days} value={days}>{t("follow.retentionAfter", { count: days })}</option>)}
            </select></label>
          </div>
          <p className="identify-hint">{t("follow.retentionHint")}</p>
        </section>}
        <section className="bulk-section">
          <div className="bulk-section-head"><Subtitles/><div><h3>{t("bulk.subtitleSettings")}</h3><p>{t("bulk.subtitleSettingsHint")}</p></div></div>
          <div className="bulk-language-grid bulk-subtitle-grid">
            <label><span>{t("bulk.subtitles")}</span><select value={subtitleMode} onChange={(event) => setSubtitleMode(event.target.value as SubtitleMode)}><option value="off">{t("bulk.subtitlesOff")}</option><option value="optional">{t("bulk.subtitlesOptional")}</option><option value="required">{t("bulk.subtitlesRequired")}</option></select></label>
            <label><span>{t("bulk.subtitleLanguage")}</span><select disabled={subtitleMode === "off"} value={subtitle} onChange={(event) => setSubtitle(event.target.value)}>{languageOptions()}</select></label>
            <label><span>{t("bulk.subtitleFallback")}</span><select disabled={subtitleMode === "off"} value={subtitleFallback} onChange={(event) => setSubtitleFallback(event.target.value)}><option value="">{t("bulk.noFallback")}</option>{languageOptions()}</select></label>
          </div>
          {subtitleMode === "optional" && <p className="identify-hint bulk-subtitle-hint">{t("bulk.subtitlePriorityHint")}</p>}
        </section>
        <section className="bulk-section">
          <div className="bulk-section-head"><FolderOpen/><div><h3>{t("saveTarget.where")}</h3><p>{t("saveTarget.whereHint")}</p></div></div>
          <SaveTargetFields kind={isMovie ? "movie" : "series"} title={title} libraries={libraries} rule={rule} value={target} onChange={setTarget}/>
        </section>
        </>}
        {error && <p className="login-error" role="alert">{error}</p>}
      </div>
      <footer className="dialog-foot"><p className="identify-hint">{creating && !downloading ? t(isMovie ? "follow.movieNotifyHint" : "follow.modeNotifyHint") : follow ? t("follow.setupHint") : t("bulk.queueHint")}</p><button type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</button><button type="button" className="primary" disabled={busy || (downloading && (!chosen.length || !sources.length || startMissing))} onClick={() => void submit()}>{busy ? t("save.adding") : creating ? t(downloading ? "follow.followAndDownload" : "follow.followSave") : follow ? t("follow.setupSave") : t("bulk.add")}</button></footer>
    </div>
  </div>;
}
