import { useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, ListFilter, ListOrdered, Server, X } from "lucide-react";
import { api, describeError } from "./api";
import { useDialogFocus } from "./dialog-focus";
import { useDialogViewport } from "./dialog-viewport";
import { t, useI18n } from "./i18n";
import { galleryPayload, gridArt } from "./meta";
import { catalogueGalleryImages } from "./gallery-images";
import { SaveTargetFields } from "./SaveTargetFields";
import type { SaveTarget } from "./save-target";
import { resolveSourceProfile, usableProfile } from "./SeriesDownloadDialog";
import { profileSummary, sourceProfileName } from "./source-profile-copy";
import type {
  BulkDownloadOrigin,
  BulkPrepareResponse,
  CatalogueBulkRequest,
  LibraryView,
  Meta,
  PreparedBulkEpisode,
  ProfileSelection,
  RemoteBulkRequest,
  SeriesBulkRequest,
  SourceProfile,
} from "./types";

const pad = (value: number) => String(Math.max(0, Math.trunc(value))).padStart(2, "0");
const episodeCode = (episode: PreparedBulkEpisode) =>
  episode.season === undefined || episode.episode === undefined ? "" : `S${pad(episode.season)}E${pad(episode.episode)}`;
const inScope = (episode: PreparedBulkEpisode, scope: "season" | "series", season: number | undefined, specials: boolean) =>
  scope === "season"
    ? episode.season === season
    : episode.season !== undefined && (episode.season >= 1 || (specials && episode.season === 0));
const episodeOrder = (left: PreparedBulkEpisode, right: PreparedBulkEpisode) =>
  (left.season ?? Number.MAX_SAFE_INTEGER) - (right.season ?? Number.MAX_SAFE_INTEGER)
  || (left.episode ?? Number.MAX_SAFE_INTEGER) - (right.episode ?? Number.MAX_SAFE_INTEGER);

export function SeriesBulkDialog({ request, libraries, downloadSourceProfileId, onQueued, onClose }: {
  request: SeriesBulkRequest;
  libraries: LibraryView[];
  downloadSourceProfileId?: string;
  onQueued: (added: number, skipped: number) => void;
  onClose: () => void;
}) {
  useI18n();
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog);
  useDialogViewport(dialog);
  const remote = !("media" in request);
  const [profiles, setProfiles] = useState<SourceProfile[] | null>(null);
  const [profilesFailed, setProfilesFailed] = useState(false);
  const [profileId, setProfileId] = useState("");
  const [scope, setScope] = useState<"season" | "series">(request.scope);
  const [season, setSeason] = useState<number | undefined>(request.scope === "season" ? request.season : undefined);
  const [includeSpecials, setIncludeSpecials] = useState(false);
  const [sourceMode, setSourceMode] = useState<"library" | "catalogue">(remote ? "library" : "catalogue");
  const [target, setTarget] = useState<SaveTarget | null>(null);
  const [answer, setAnswer] = useState<BulkPrepareResponse | null>(null);
  const [resolvedCatalogueId, setResolvedCatalogueId] = useState<string | undefined>(undefined);
  const [preparedKey, setPreparedKey] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [catalogueMeta, setCatalogueMeta] = useState<Meta | null>(null);
  const [skippedOpen, setSkippedOpen] = useState(false);
  const [commitError, setCommitError] = useState("");
  const [committing, setCommitting] = useState(false);
  const [addedBeforeError, setAddedBeforeError] = useState(0);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [nonce, setNonce] = useState(0);
  const prepareAbort = useRef<AbortController | null>(null);
  const cache = useRef(new Map<string, BulkPrepareResponse>());
  const forcePrepare = useRef(false);
  const catalogueAttempt = useRef<string | null>(null);
  const profile = profiles?.find((candidate) => candidate.id === profileId);
  const catalogueId = remote ? resolvedCatalogueId : undefined;

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    void api.sourceProfiles()
      .then((items) => {
        if (!live) return;
        const offered = items.filter(usableProfile);
        setProfiles(offered);
        const preferred = resolveSourceProfile(offered, downloadSourceProfileId, false);
        if (preferred) setProfileId(preferred.id);
      })
      .catch(() => { if (live) { setProfiles([]); setProfilesFailed(true); } });
    return () => { live = false; controller.abort(); };
  }, [downloadSourceProfileId]);

  useEffect(() => {
    if (!remote || sourceMode !== "catalogue" || !catalogueId || catalogueMeta) return;
    if (catalogueAttempt.current === catalogueId) return;
    catalogueAttempt.current = catalogueId;
    setSourceError("");
    void api.meta("series", catalogueId)
      .then(setCatalogueMeta)
      .catch((error) => setSourceError(describeError(error)));
  }, [remote, sourceMode, catalogueId, catalogueMeta]);

  const preparedOrigin = useMemo(() => {
    if (!remote) {
      const catalogue = request as CatalogueBulkRequest;
      return {
        origin: { kind: "catalogue" as const, media: catalogue.media, episodes: catalogue.episodes },
        title: catalogue.title,
      };
    }
    const remoteRequest = request as RemoteBulkRequest;
    if (sourceMode === "library") {
      return {
        origin: { kind: "remote" as const, libraryId: remoteRequest.libraryId, seriesItemId: remoteRequest.seriesItemId },
        title: remoteRequest.title,
      };
    }
    if (!catalogueId || !catalogueMeta) return null;
    return {
      origin: {
        kind: "catalogue" as const,
        media: { id: catalogueId, metaType: "series", ...gridArt(catalogueMeta, catalogueMeta), gallery: galleryPayload(catalogueGalleryImages(catalogueMeta)) },
        episodes: (catalogueMeta.videos ?? []).flatMap((video) => {
          const id = video.id == null ? "" : String(video.id).trim();
          return id ? [{
            id,
            ...(video.season !== undefined ? { season: video.season } : {}),
            ...(video.episode !== undefined ? { episode: video.episode } : {}),
            ...(video.title || video.name ? { title: video.title || video.name } : {}),
            ...(video.released ? { released: String(video.released) } : {}),
          }] : [];
        }),
      },
      title: catalogueMeta.name || remoteRequest.title,
    };
  }, [remote, request, sourceMode, catalogueId, catalogueMeta]);

  const prepareKey = useMemo(() => JSON.stringify({
    origin: preparedOrigin?.origin ?? null,
    profile: profile ? { id: profile.id, revision: profile.revision } : null,
    target,
  }), [preparedOrigin, profile, target]);

  useEffect(() => {
    if (!profile || !preparedOrigin) {
      setPreparing(Boolean(remote && sourceMode === "catalogue" && catalogueId && !catalogueMeta && !sourceError));
      return;
    }
    const cached = cache.current.get(prepareKey);
    if (cached && !forcePrepare.current) {
      setAnswer(cached);
      setPreparedKey(prepareKey);
      setPrepareError("");
      setPreparing(false);
      return;
    }
    forcePrepare.current = false;
    prepareAbort.current?.abort();
    const controller = new AbortController();
    prepareAbort.current = controller;
    setAnswer(null);
    setPreparedKey("");
    setPrepareError("");
    setPreparing(true);
    let live = true;
    const timer = window.setTimeout(() => {
      const selection: ProfileSelection = { profile: { profileId: profile.id, revision: profile.revision } };
      void api.prepareBulk({
        scope: "series",
        specials: true,
        title: preparedOrigin.title,
        selection,
        ...(target ? { target } : {}),
        origin: preparedOrigin.origin,
      }, controller.signal).then((response) => {
        if (!live || controller.signal.aborted) return;
        cache.current.set(prepareKey, response);
        if (response.series.catalogueId) setResolvedCatalogueId(response.series.catalogueId);
        setAnswer(response);
        setPreparedKey(prepareKey);
        setPreparing(false);
      }).catch((error) => {
        if (!live || controller.signal.aborted) return;
        setPrepareError(describeError(error));
        setPreparing(false);
      });
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [prepareKey, profile, preparedOrigin, target, nonce, remote, sourceMode, catalogueId, catalogueMeta, sourceError]);

  useEffect(() => () => prepareAbort.current?.abort(), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || committing) return;
      event.preventDefault();
      prepareAbort.current?.abort();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [committing, onClose]);

  const seasons = useMemo(() => [...new Set((answer?.episodes ?? []).map((episode) => episode.season)
    .filter((value): value is number => value !== undefined))]
    .sort((left, right) => (left === 0 ? 1 : right === 0 ? -1 : left - right)), [answer]);
  const hasSpecials = seasons.includes(0);

  useEffect(() => {
    if (scope !== "season" || !answer) return;
    if (season !== undefined && seasons.includes(season)) return;
    setSeason(seasons.find((value) => value >= 1) ?? seasons[0]);
  }, [scope, answer, seasons, season]);

  const filtered = useMemo(() => (answer?.episodes ?? [])
    .filter((episode) => inScope(episode, scope, season, includeSpecials))
    .sort(episodeOrder), [answer, scope, season, includeSpecials]);
  const ready = filtered.filter((episode) => episode.status === "ready");
  const skipped = filtered.filter((episode) => episode.status !== "ready");
  const counts = {
    ready: ready.length,
    inTarget: filtered.filter((episode) => episode.status === "inTarget").length,
    queued: filtered.filter((episode) => episode.status === "queued").length,
    unreleased: filtered.filter((episode) => episode.status === "unreleased").length,
    unnumbered: filtered.filter((episode) => episode.status === "unnumbered" || episode.status === "invalid").length,
  };
  const matches = answer !== null && preparedKey === prepareKey;
  const complete = matches && answer.listing.complete;
  const canQueue = complete && counts.ready > 0 && !committing && !preparing;
  const summary = counts.ready === 0
    ? t("seriesBulk.nothing")
    : [
      t("seriesBulk.ready", { count: counts.ready }),
      counts.inTarget ? t("seriesBulk.inTarget", { count: counts.inTarget }) : "",
      counts.queued ? t("seriesBulk.queued", { count: counts.queued }) : "",
      counts.unreleased ? t("seriesBulk.unreleased", { count: counts.unreleased }) : "",
      counts.unnumbered ? t("seriesBulk.unnumbered", { count: counts.unnumbered }) : "",
    ].filter(Boolean).join(" · ");
  const reason = (episode: PreparedBulkEpisode) => episode.status === "inTarget"
    ? t("seriesBulk.reasonInTarget")
    : episode.status === "queued"
      ? t("seriesBulk.reasonQueued")
      : episode.status === "unreleased"
        ? t("seriesBulk.reasonUnreleased")
        : t("seriesBulk.reasonUnnumbered");
  const targetName = matches ? answer.target.libraryName : "";
  const commit = async () => {
    if (!profile || !canQueue) return;
    const selection: ProfileSelection = { profile: { profileId: profile.id, revision: profile.revision } };
    const librarySource = remote && sourceMode === "library";
    const origin: BulkDownloadOrigin | undefined = librarySource
      ? { kind: "remote", libraryId: request.libraryId, seriesItemId: request.seriesItemId }
      : undefined;
    const media = preparedOrigin?.origin.kind === "catalogue" ? preparedOrigin.origin.media : undefined;
    setCommitting(true);
    setCommitError("");
    setAddedBeforeError(0);
    setDone(0);
    setTotal(ready.length);
    let added = 0;
    let skippedCount = 0;
    try {
      for (let offset = 0; offset < ready.length; offset += 500) {
        const batch = ready.slice(offset, offset + 500).map((episode) => ({
          id: episode.id,
          ...(episode.season !== undefined ? { season: episode.season } : {}),
          ...(episode.episode !== undefined ? { episode: episode.episode } : {}),
          ...(episode.title ? { title: episode.title } : {}),
          ...(librarySource && episode.remoteItemId ? { remoteItemId: episode.remoteItemId } : {}),
        }));
        const result = await api.downloadBulk(preparedOrigin?.title ?? request.title, "series", batch, selection, media, target ?? undefined, origin);
        added += result.added;
        skippedCount += result.skipped;
        setDone(Math.min(ready.length, offset + batch.length));
      }
      onQueued(added, skippedCount);
      onClose();
    } catch (error) {
      setCommitError(describeError(error));
      setAddedBeforeError(added);
      setCommitting(false);
    }
  };
  const close = () => {
    if (committing) return;
    prepareAbort.current?.abort();
    onClose();
  };

  return <div ref={dialog} tabIndex={-1} className="identify-overlay" role="dialog" aria-modal="true" aria-labelledby="series-bulk-title"
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="panel identify-card dialog-split bulk-card series-bulk-card">
      <div className="identify-head bulk-head">
        <div><span className="bulk-eyebrow">{request.title}</span><h2 id="series-bulk-title">{t("seriesBulk.title")}</h2></div>
        <button type="button" className="icon-button" aria-label={t("common.close")} disabled={committing} onClick={close}><X/></button>
      </div>
      <div className="dialog-body bulk-body">
        <section className="bulk-section">
          <div className="bulk-section-head"><ListOrdered/><div><h3>{t("seriesBulk.what")}</h3></div></div>
          <div className="bulk-strategy" role="radiogroup" aria-label={t("seriesBulk.what")}>
            <label className={scope === "season" ? "selected" : ""}>
              <input type="radio" name="series-bulk-scope" value="season" checked={scope === "season"} onChange={() => setScope("season")}/>
              <span><strong>{t("seriesBulk.season")}</strong></span>
            </label>
            <label className={scope === "series" ? "selected" : ""}>
              <input type="radio" name="series-bulk-scope" value="series" checked={scope === "series"} onChange={() => setScope("series")}/>
              <span><strong>{t("seriesBulk.wholeSeries")}</strong></span>
            </label>
          </div>
          {scope === "season" && <div className="bulk-language-grid">
            <label><span>{t("seriesBulk.season")}</span><select aria-label={t("seriesBulk.season")} value={season ?? ""}
              onChange={(event) => setSeason(Number(event.target.value))}>
              {seasons.map((value) => <option key={value} value={value}>{value === 0 ? t("episodes.specials") : t("episodes.seasonNumber", { season: value })}</option>)}
            </select></label>
          </div>}
          {scope === "series" && hasSpecials && <label className="bulk-remember-profile">
            <input type="checkbox" checked={includeSpecials} onChange={(event) => setIncludeSpecials(event.target.checked)}/>
            <span>{t("seriesBulk.includeSpecials")}</span>
          </label>}
        </section>

        {remote && <section className="bulk-section">
          <div className="bulk-section-head"><Server/><div><h3>{t("seriesBulk.source")}</h3></div></div>
          <div className="bulk-strategy rules-choice" role="radiogroup" aria-label={t("seriesBulk.source")}>
            <label className={sourceMode === "library" ? "selected" : ""}>
              <input type="radio" name="series-bulk-source" value="library" checked={sourceMode === "library"} onChange={() => setSourceMode("library")}/>
              <span><strong>{t("seriesBulk.fromLibrary", {
                provider: t(request.provider === "emby" ? "mediaServer.provider.emby" : "mediaServer.provider.jellyfin"),
                library: request.libraryName,
              })}</strong><small>{t("seriesBulk.fromLibraryHint")}</small></span>
            </label>
            {catalogueId && <label className={sourceMode === "catalogue" ? "selected" : ""}>
              <input type="radio" name="series-bulk-source" value="catalogue" checked={sourceMode === "catalogue"} onChange={() => setSourceMode("catalogue")}/>
              <span><strong>{t("seriesBulk.fromCatalogue")}</strong><small>{t("seriesBulk.fromCatalogueHint")}</small></span>
            </label>}
          </div>
          {sourceError && <p className="login-error" role="alert">{sourceError}</p>}
        </section>}

        <section className="bulk-section">
          <div className="bulk-section-head"><ListFilter/><div><h3>{t("rules.title")}</h3></div></div>
          {profiles === null && <p className="identify-hint">{t("common.loading")}</p>}
          {(profilesFailed || profiles?.length === 0) && <p className="identify-hint follow-warning">{t("rules.unavailable")}</p>}
          {profiles && profiles.length > 0 && <div className="bulk-strategy rules-choice" role="radiogroup" aria-label={t("rules.title")}>
            {profiles.map((candidate) => <label key={candidate.id} className={profileId === candidate.id ? "selected" : ""}>
              <input type="radio" name="series-bulk-rules" value={candidate.id} checked={profileId === candidate.id} onChange={() => setProfileId(candidate.id)}/>
              <span><strong>{sourceProfileName(candidate.nameKey, candidate.name)}</strong><small>{profileSummary(candidate, "episode")}</small></span>
            </label>)}
          </div>}
          {remote && sourceMode === "library" && <p className="identify-hint">{t("seriesBulk.remoteRulesHint")}</p>}
        </section>

        <section className="bulk-section">
          <div className="bulk-section-head"><FolderOpen/><div><h3>{t("saveTarget.where")}</h3><p>{t("saveTarget.whereHint")}</p></div></div>
          <SaveTargetFields kind="series" title={preparedOrigin?.title ?? request.title} libraries={libraries} rule={undefined} value={target} onChange={setTarget}/>
          {targetName && <p className="identify-hint">{t("seriesBulk.savesTo", { library: targetName })}</p>}
        </section>

        <section className="bulk-section series-bulk-summary" aria-live="polite">
          {preparing
            ? <p className="identify-hint"><span className="loading-spinner"/>{t("seriesBulk.preparing")}</p>
            : matches && <p className="identify-hint series-bulk-count">{summary}</p>}
          <p className="identify-hint">{t("seriesBulk.sourcesLater")}</p>
          {skipped.length > 0 && <>
            <button type="button" className="link-button" aria-expanded={skippedOpen} onClick={() => setSkippedOpen((value) => !value)}>
              {skippedOpen ? t("seriesBulk.hideSkipped") : t("seriesBulk.showSkipped", { count: skipped.length })}
            </button>
            {skippedOpen && <ul className="series-bulk-skipped">{skipped.map((episode) => <li key={`${episode.id}:${episode.season}:${episode.episode}`}>
              {[episodeCode(episode), episode.title, reason(episode)].filter(Boolean).join(" · ")}
            </li>)}</ul>}
          </>}
          {answer && answer.listing.complete === false && <div className="series-bulk-incomplete">
            <p className="login-error" role="alert">{t("seriesBulk.incomplete")}</p>
            <button type="button" onClick={() => {
              cache.current.delete(prepareKey);
              forcePrepare.current = true;
              setNonce((value) => value + 1);
            }}>{t("home.retry")}</button>
          </div>}
          {prepareError && <p className="login-error" role="alert">{prepareError}</p>}
        </section>
      </div>
      <footer className="dialog-foot">
        {commitError
          ? <p className="login-error" role="alert">{commitError}{addedBeforeError > 0 && ` ${t("seriesBulk.partlyAdded", { count: addedBeforeError })}`}</p>
          : <p className="identify-hint">{committing ? t("seriesBulk.adding", { done, total }) : t("seriesBulk.skipHint")}</p>}
        <button type="button" disabled={committing} onClick={close}>{t("common.cancel")}</button>
        <button type="button" className="primary" disabled={!canQueue} onClick={() => void commit()}>
          {t("seriesBulk.add", { count: counts.ready })}
        </button>
      </footer>
    </div>
  </div>;
}
