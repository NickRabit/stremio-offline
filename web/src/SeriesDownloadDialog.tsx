import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Download, Languages, ListFilter, Subtitles, X } from "lucide-react";
import { api, describeError } from "./api";
import { languageName, t, useI18n } from "./i18n";
import type { AudioMode, DownloadSelection, DownloadSourceStrategy, SubtitleMode } from "./types";

interface Episode { id: string; season?: number; episode?: number; title?: string }

export function SeriesDownloadDialog({ type, label, episodes, audioLanguage, subtitleLanguage, languages, onClose, onSubmit }: {
  type: string;
  label: string;
  episodes: Episode[];
  audioLanguage: string;
  subtitleLanguage: string;
  languages: Array<{ code: string; name: string }>;
  onClose: () => void;
  onSubmit: (selection: DownloadSelection) => Promise<void>;
}) {
  useI18n();
  const [sources, setSources] = useState<Array<{ key: string; name: string }>>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [sourceStrategy, setSourceStrategy] = useState<DownloadSourceStrategy>("largest");
  const [audio, setAudio] = useState(audioLanguage);
  const [audioFallback, setAudioFallback] = useState(audioLanguage === "en" ? "" : "en");
  const [audioMode, setAudioMode] = useState<AudioMode>("listed");
  const [subtitleMode, setSubtitleMode] = useState<SubtitleMode>("optional");
  const [subtitle, setSubtitle] = useState(subtitleLanguage);
  const [subtitleFallback, setSubtitleFallback] = useState(subtitleLanguage === "en" ? "" : "en");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
      setSources(items); setChosen(items.map((item) => item.key));
    }).catch((value) => { if (!cancelled) setError(describeError(value)); });
    return () => { cancelled = true; };
  }, [type, episodes]);

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
  const languageOptions = () => languages.map(({ code }) => <option key={code} value={code}>{languageName(code)}</option>);

  const submit = async () => {
    if (!chosen.length) return;
    setBusy(true); setError("");
    try {
      await onSubmit({
        addonKeys: chosen, sourceStrategy, audioLanguage: audio,
        fallbackAudioLanguage: audioFallback && audioFallback !== audio ? audioFallback : undefined,
        audioMode,
        subtitleMode,
        subtitleLanguage: subtitleMode === "off" ? undefined : subtitle,
        fallbackSubtitleLanguage: subtitleMode !== "off" && subtitleFallback !== subtitle ? subtitleFallback || undefined : undefined,
      });
      onClose();
    } catch (value) { setError(describeError(value)); }
    finally { setBusy(false); }
  };

  return <div className="identify-overlay" role="dialog" aria-modal="true" aria-labelledby="bulk-dialog-title" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="panel identify-card bulk-card">
      <div className="identify-head bulk-head"><div><span className="bulk-eyebrow">{label}</span><h2 id="bulk-dialog-title">{t("bulk.title")}</h2></div><button className="icon-button" aria-label={t("common.cancel")} disabled={busy} onClick={onClose}><X/></button></div>
      <div className="bulk-body">
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
        </section>
        <section className="bulk-section">
          <div className="bulk-section-head"><Subtitles/><div><h3>{t("bulk.subtitleSettings")}</h3><p>{t("bulk.subtitleSettingsHint")}</p></div></div>
          <div className="bulk-language-grid bulk-subtitle-grid">
            <label><span>{t("bulk.subtitles")}</span><select value={subtitleMode} onChange={(event) => setSubtitleMode(event.target.value as SubtitleMode)}><option value="off">{t("bulk.subtitlesOff")}</option><option value="optional">{t("bulk.subtitlesOptional")}</option><option value="required">{t("bulk.subtitlesRequired")}</option></select></label>
            <label><span>{t("bulk.subtitleLanguage")}</span><select disabled={subtitleMode === "off"} value={subtitle} onChange={(event) => setSubtitle(event.target.value)}>{languageOptions()}</select></label>
            <label><span>{t("bulk.subtitleFallback")}</span><select disabled={subtitleMode === "off"} value={subtitleFallback} onChange={(event) => setSubtitleFallback(event.target.value)}><option value="">{t("bulk.noFallback")}</option>{languageOptions()}</select></label>
          </div>
          {subtitleMode === "optional" && <p className="identify-hint bulk-subtitle-hint">{t("bulk.subtitlePriorityHint")}</p>}
        </section>
        {error && <p className="login-error" role="alert">{error}</p>}
      </div>
      <div className="bulk-footer"><p className="identify-hint">{t("bulk.queueHint")}</p><div><button disabled={busy} onClick={onClose}>{t("common.cancel")}</button><button className="primary" disabled={busy || !chosen.length || !sources.length} onClick={() => void submit()}><Download/> {busy ? t("save.adding") : t("bulk.add")}</button></div></div>
    </div>
  </div>;
}
