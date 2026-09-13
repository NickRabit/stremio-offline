import { FormEvent, useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { api, describeError } from "./api";
import { t, useI18n } from "./i18n";
import type { IdentityPreview, Meta, Video } from "./types";

const hideBroken = (event: React.SyntheticEvent<HTMLImageElement>) => event.currentTarget.classList.add("broken");

const numbered = (videos: Video[]) => videos.filter((video) => typeof video.season === "number" && typeof video.episode === "number");

export function IdentifyDialog({ path, onClose, onApplied }: { path: string; onClose: () => void; onApplied: () => void }) {
  useI18n();
  const [identity, setIdentity] = useState<IdentityPreview | null>(null);
  const [title, setTitle] = useState("");
  const [year, setYear] = useState("");
  const [kind, setKind] = useState<"movie" | "series">("movie");
  const [scope, setScope] = useState<"unit" | "file">("unit");
  const [season, setSeason] = useState("");
  const [episode, setEpisode] = useState("");
  const [videos, setVideos] = useState<Video[]>([]);
  const [items, setItems] = useState<Meta[]>([]);
  const [picked, setPicked] = useState<Meta | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Only the scan's own suggestion is worth preselecting. Highlighting the first
  // row of any result list turns one careless click into a wrong binding.
  const preselect = (list: Meta[], suggestionId?: string) => list.find((item) => item.id === suggestionId) ?? null;

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void api.libraryIdentity(path).then(async (loaded) => {
      if (cancelled) return;
      const nextKind = loaded.kind === "series" ? "series" : "movie";
      setIdentity(loaded);
      setTitle(loaded.parsed.title);
      setYear(loaded.parsed.year != null ? String(loaded.parsed.year) : "");
      setKind(nextKind);
      setScope(loaded.bound?.episode != null ? "file" : "unit");
      setSeason(loaded.parsed.season != null ? String(loaded.parsed.season) : "");
      setEpisode(loaded.parsed.episode != null ? String(loaded.parsed.episode) : "");
      const result = await api.search(loaded.parsed.query || loaded.parsed.title, { type: nextKind });
      if (cancelled) return;
      setItems(result.items);
      setPicked(preselect(result.items, loaded.suggestion?.id ?? loaded.bound?.id));
    }).catch((value) => { if (!cancelled) setError(describeError(value)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [path]);

  // Episode rows come from the picked series, so the numbering the user confirms
  // is the catalogue's own rather than whatever the file name happens to say.
  const wantsEpisode = kind === "series" && scope === "file";
  useEffect(() => {
    if (!wantsEpisode || !picked?.id) { setVideos([]); return; }
    let cancelled = false;
    void api.meta(picked.type || "series", picked.id)
      .then((meta) => { if (!cancelled) setVideos(numbered(meta.videos ?? [])); })
      .catch(() => { if (!cancelled) setVideos([]); });
    return () => { cancelled = true; };
  }, [wantsEpisode, picked?.id, picked?.type]);

  const seasons = useMemo(() => [...new Set(videos.map((video) => Number(video.season)))].sort((a, b) => a - b), [videos]);
  const episodes = useMemo(
    () => videos.filter((video) => String(video.season) === (season || String(seasons[0] ?? ""))).sort((a, b) => Number(a.episode) - Number(b.episode)),
    [videos, season, seasons],
  );
  useEffect(() => {
    if (!seasons.length) return;
    if (!season || !seasons.includes(Number(season))) setSeason(String(seasons[0]));
  }, [seasons]);

  const search = async (event?: FormEvent) => {
    event?.preventDefault();
    setBusy(true); setError("");
    try {
      const query = year.trim() ? `${title.trim()} ${year.trim()}` : title.trim();
      const result = await api.search(query, { type: kind });
      setItems(result.items);
      setPicked(preselect(result.items, identity?.suggestion?.id ?? identity?.bound?.id));
    } catch (value) { setError(describeError(value)); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    if (!picked) return;
    setBusy(true); setError("");
    try {
      await api.matchLibraryItem({
        path,
        id: picked.id,
        type: picked.type || kind,
        scope,
        ...(wantsEpisode && episode.trim() ? { season: Number(season || 1), episode: Number(episode) } : {}),
      });
      onApplied();
    } catch (value) { setError(describeError(value)); setBusy(false); }
  };

  const canScope = Boolean(identity?.file);
  const unitName = identity && identity.key !== identity.path ? identity.key : (identity?.label ?? path);

  return <div className="identify-overlay" role="dialog" aria-modal="true" aria-label={t("library.identify")} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="panel identify-card" onSubmit={search}>
      <div className="identify-head">
        <h2>{t(identity?.match === "matched" ? "library.fixMatch" : "library.identify")}</h2>
        <button type="button" className="icon-button" aria-label={t("common.cancel")} onClick={onClose}><X/></button>
      </div>
      {identity?.bound?.id && <p className="identify-hint">{t("library.identifyBound", { name: identity.bound.name || identity.bound.id })}</p>}
      {identity?.match === "rejected" && <p className="identify-hint">{t("library.unmatchedLocked")}</p>}
      {canScope && <fieldset className="identify-scope">
        <legend>{t("library.identifyTarget")}</legend>
        <button type="button" className={scope === "unit" ? "primary" : ""} onClick={() => setScope("unit")}>{t("library.identifyScopeUnit", { name: unitName })}</button>
        <button type="button" className={scope === "file" ? "primary" : ""} onClick={() => setScope("file")}>{t("library.identifyScopeFile", { name: identity?.label ?? "" })}</button>
      </fieldset>}
      <label><span>{t("library.identifyTitle")}</span><input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus/></label>
      <div className="identify-row">
        <label><span>{t("library.identifyYear")}</span><input value={year} onChange={(event) => setYear(event.target.value)} inputMode="numeric"/></label>
        <fieldset className="identify-type">
          <legend>{t("library.identifyType")}</legend>
          <button type="button" className={kind === "movie" ? "primary" : ""} onClick={() => setKind("movie")}>{t("library.typeMovie")}</button>
          <button type="button" className={kind === "series" ? "primary" : ""} onClick={() => setKind("series")}>{t("library.typeSeries")}</button>
        </fieldset>
      </div>
      <button type="submit" className="primary" disabled={busy || !title.trim()}><Search/> {t("library.identifySearch")}</button>
      {error && <p className="login-error">{error}</p>}
      {busy && !items.length && <p className="identify-hint">{t("common.loading")}</p>}
      {!busy && !items.length && <p className="identify-hint">{t("library.identifyEmpty")}</p>}
      {items.length > 0 && <div className="identify-results">
        {items.map((item) => <button type="button" key={`${item.type}:${item.id}`} className={picked?.id === item.id ? "selected" : ""} onClick={() => setPicked(item)}>
          <span className="identify-poster">{item.poster ? <img src={item.poster} alt="" onError={hideBroken}/> : <span/>}</span>
          <span><strong>{item.name}</strong><small>{[item.releaseInfo || item.year, item.type].filter(Boolean).join(" · ")}</small></span>
        </button>)}
      </div>}
      {wantsEpisode && picked && <div className="identify-episode">
        <p className="identify-hint">{t("library.identifyEpisodeHint")}</p>
        <div className="identify-row">
          <label><span>{t("library.identifySeason")}</span>
            {seasons.length
              ? <select value={season} onChange={(event) => { setSeason(event.target.value); setEpisode(""); }}>
                  {seasons.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              : <input value={season} onChange={(event) => setSeason(event.target.value)} inputMode="numeric"/>}
          </label>
          <label><span>{t("library.identifyEpisode")}</span>
            {episodes.length
              ? <select value={episode} onChange={(event) => setEpisode(event.target.value)}>
                  <option value="">{t("library.identifyEpisodePick")}</option>
                  {episodes.map((video) => <option key={String(video.episode)} value={String(video.episode)}>
                    {video.episode}. {video.name || video.title || ""}
                  </option>)}
                </select>
              : <input value={episode} onChange={(event) => setEpisode(event.target.value)} inputMode="numeric"/>}
          </label>
        </div>
      </div>}
      <button type="button" className="primary" disabled={!picked || busy || (wantsEpisode && !episode.trim())} onClick={() => void apply()}>{t("library.identifyApply")}</button>
    </form>
  </div>;
}
