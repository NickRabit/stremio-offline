import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { api, describeError } from "./api";
import { useDialogViewport } from "./dialog-viewport";
import { t, useI18n } from "./i18n";
import type { IdentityPreview, Video } from "./types";

const hideBroken = (event: React.SyntheticEvent<HTMLImageElement>) => event.currentTarget.classList.add("broken");

const numbered = (videos: Video[]) => videos.filter((video) => typeof video.season === "number" && typeof video.episode === "number");

/** Which provider offered a row. The trusted ones are what the scan would have used; the
 *  catalogue fan-out is the explicit "more from addons" answer, never a default. */
type RowSource = "tmdb" | "cinemeta" | "addons";
interface Row { id: string; type: string; name: string; releaseInfo?: string; poster?: string; source: RowSource }

const sourceLabel = (source: RowSource): string =>
  source === "tmdb" ? t("library.matchSourceTmdb") : source === "cinemeta" ? t("library.matchSourceCinemeta") : t("library.matchSourceAddon");

export function IdentifyDialog({ path, paths, onClose, onApplied }: { path: string; paths?: string[]; onClose: () => void; onApplied: (id?: string) => void }) {
  useI18n();
  const overlay = useRef<HTMLDivElement>(null);
  useDialogViewport(overlay);
  const [identity, setIdentity] = useState<IdentityPreview | null>(null);
  const [title, setTitle] = useState("");
  const [year, setYear] = useState("");
  const [kind, setKind] = useState<"movie" | "series">("movie");
  const [scope, setScope] = useState<"unit" | "file">("unit");
  const [season, setSeason] = useState("");
  const [episode, setEpisode] = useState("");
  const [videos, setVideos] = useState<Video[]>([]);
  const [items, setItems] = useState<Row[]>([]);
  const [picked, setPicked] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [widening, setWidening] = useState(false);
  const [error, setError] = useState("");
  /** The title the trusted search read for the fields in front of the user. Widening the
   *  search or asking again uses what was typed, not what was found. */
  const lastQuery = useRef({ title: "", year: "", kind: "movie" as "movie" | "series" });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Only the scan's own suggestion is worth preselecting. Highlighting the first
  // row of any result list turns one careless click into a wrong binding.
  const preselect = (list: Row[], suggestionId?: string) => list.find((item) => item.id === suggestionId) ?? null;

  const searchTrusted = async (query: string, type: "movie" | "series", year?: number) => {
    const result = await api.librarySearch({ path, query, type, ...(year != null ? { year } : {}) });
    return result.items.map((item): Row => ({
      id: item.id, type: item.type || type, name: item.name, source: item.source,
      ...(item.releaseInfo ? { releaseInfo: item.releaseInfo } : {}),
      ...(item.poster ? { poster: item.poster } : {}),
    }));
  };

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
      lastQuery.current = { title: loaded.parsed.title, year: loaded.parsed.year != null ? String(loaded.parsed.year) : "", kind: nextKind };
      const rows = await searchTrusted(loaded.parsed.query || loaded.parsed.title, nextKind, loaded.parsed.year);
      if (cancelled) return;
      setItems(rows);
      setPicked(preselect(rows, loaded.suggestion?.id ?? loaded.bound?.id));
    }).catch((value) => { if (!cancelled) setError(describeError(value)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [path]);

  // Episode rows come from the picked series, so the numbering the user confirms
  // is the catalogue's own rather than whatever the file name happens to say.
  const wantsEpisode = !paths?.length && kind === "series" && scope === "file";
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
    // On a phone the keyboard covers the results the search is about to load.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setBusy(true); setError("");
    try {
      const parsedYear = Number.parseInt(year.trim(), 10);
      const rows = await searchTrusted(title.trim(), kind, Number.isFinite(parsedYear) ? parsedYear : undefined);
      lastQuery.current = { title, year, kind };
      setItems(rows);
      setPicked(preselect(rows, identity?.suggestion?.id ?? identity?.bound?.id));
    } catch (value) { setError(describeError(value)); }
    finally { setBusy(false); }
  };

  /** The wider catalogue search stays available, but only when it is asked for. */
  const searchAddons = async () => {
    const { title: asked, year: askedYear, kind: askedKind } = lastQuery.current;
    const query = askedYear.trim() ? `${asked.trim()} ${askedYear.trim()}` : asked.trim();
    if (!query) return;
    setBusy(true); setWidening(true); setError("");
    try {
      const result = await api.search(query, { type: askedKind });
      setItems(result.items.map((item): Row => ({
        id: item.id, type: item.type || askedKind, name: item.name, source: "addons",
        ...(item.releaseInfo ? { releaseInfo: String(item.releaseInfo) } : item.year ? { releaseInfo: String(item.year) } : {}),
        ...(item.poster ? { poster: item.poster } : {}),
      })));
      setPicked(null);
    } catch (value) { setError(describeError(value)); }
    finally { setBusy(false); setWidening(false); }
  };

  const apply = async () => {
    if (!picked) return;
    setBusy(true); setError("");
    try {
      let operationId: string | undefined;
      if (paths?.length) operationId = (await api.startLibraryOp({ op: "match", items: paths, id: picked.id, type: picked.type || kind })).id;
      else await api.matchLibraryItem({
          path, id: picked.id, type: picked.type || kind, scope,
          ...(wantsEpisode && episode.trim() ? { season: Number(season || 1), episode: Number(episode) } : {}),
        });
      onApplied(operationId);
    } catch (value) { setError(describeError(value)); setBusy(false); }
  };

  const canScope = Boolean(identity?.file) && !paths?.length;
  const unitName = identity && identity.key !== identity.path ? identity.key : (identity?.label ?? path);

  return <div className="identify-overlay" ref={overlay} role="dialog" aria-modal="true" aria-label={t("library.identify")} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="panel identify-card dialog-split" onSubmit={search}>
      <div className="identify-head">
        <h2>{t(identity?.match === "matched" ? "library.fixMatch" : "library.identify")}</h2>
        <button type="button" className="icon-button" aria-label={t("common.cancel")} onClick={onClose}><X/></button>
      </div>
      <div className="dialog-body">
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
      {title.trim() && !widening && <button type="button" className="identify-wider" disabled={busy} onClick={() => void searchAddons()}>
        {t("library.searchMoreCatalogs")}
      </button>}
      {error && <p className="login-error">{error}</p>}
      {busy && !items.length && <p className="identify-hint">{t("common.loading")}</p>}
      {!busy && !items.length && <p className="identify-hint">{t("library.identifyEmpty")}</p>}
      {items.length > 0 && <div className="identify-results">
        {items.map((item) => <button type="button" key={`${item.type}:${item.id}`} className={picked?.id === item.id ? "selected" : ""} onClick={() => setPicked(item)}>
          <span className="identify-poster">{item.poster ? <img src={item.poster} alt="" onError={hideBroken}/> : <span/>}</span>
          <span><strong>{item.name}</strong><small>{[item.releaseInfo, item.type, sourceLabel(item.source)].filter(Boolean).join(" · ")}</small></span>
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
      </div>
      <footer className="dialog-foot">
        <button type="button" className="primary" disabled={!picked || busy || (wantsEpisode && !episode.trim())} onClick={() => void apply()}>{t("library.identifyApply")}</button>
      </footer>
    </form>
  </div>;
}
