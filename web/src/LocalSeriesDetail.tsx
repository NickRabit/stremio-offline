import { useEffect, useState } from "react";
import { CirclePlay, Film, Images, ListRestart, Play } from "lucide-react";
import { api, describeError } from "./api";
import { ClampedDescription, CrewLine, DetailFavoriteButton, DetailIcon, DetailRatings, DetailTrailerButton, ratingsFrom } from "./detail-copy";
import { DetailHero, LIBRARY_HERO_EMPTY_GRADIENT, LIBRARY_HERO_GRADIENT, useBackdrop } from "./DetailHero";
import { catalogueGalleryImages, mergeGallery, posterAndWide, type GalleryImage } from "./gallery-images";
import { t, useI18n } from "./i18n";
import { LibraryItem } from "./library-item";
import { boundRef } from "./LocalLibraryDetail";
import { bytes, hideBroken } from "./settings-ui";
import { TileArt } from "./TileArt";
import { TitleChips } from "./TitleChips";
import { useTitleEnrichment, type CatalogueRef } from "./title-enrichment";
import { synopsisOf, TitleExtraFacts, TitleExtrasRows, trailerFromExtras } from "./TitleExtras";
import { useTitleExtras } from "./title-extras";
import type { BrowseFile, BrowseFolder, IdentityPreview, TileShape, Trailer } from "./types";

interface Props {
  folder: BrowseFolder;
  favorite: boolean;
  onToggleFavorite: (favorite: boolean) => void;
  /** Opens one episode's own detail: its versions, its sources and everything else a file has. */
  onOpenEpisode: (file: BrowseFile) => void;
  /** Plays one episode straight away; `fromBeginning` drops its saved position. */
  onPlayEpisode: (file: BrowseFile, fromBeginning: boolean, catalogue: CatalogueRef | null) => void;
  uiLanguage: string;
  secureMode: boolean;
  onTrailer: (trailer: Trailer) => void;
  onGallery?: (images: GalleryImage[], path: string, ref?: CatalogueRef | null) => void;
  tileShape: TileShape;
  /** Bumped when a play ends, so the saved positions are read again. */
  revision?: number;
}

const finished = (file: BrowseFile) => Boolean(file.progress && file.progress.duration > 0 && file.progress.position / file.progress.duration >= 0.9);

/** One file per episode, in season and episode order with the specials last: of several copies the
 *  one last watched stands for it, else the largest, the way a media server folds its versions. */
export function episodeFiles(files: BrowseFile[]): BrowseFile[] {
  const groups = new Map<string, BrowseFile[]>();
  for (const file of files) {
    const key = file.season != null && file.episode != null ? `${file.season}:${file.episode}` : file.path;
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  const pick = (copies: BrowseFile[]) => copies.reduce((best, file) => {
    const watched = (file.progress?.position ?? 0) > 0;
    const bestWatched = (best.progress?.position ?? 0) > 0;
    if (watched !== bestWatched) return watched ? file : best;
    return file.size > best.size ? file : best;
  });
  const order = (file: BrowseFile) => [file.season === 0 ? 1 : 0, file.season ?? Number.MAX_SAFE_INTEGER, file.episode ?? Number.MAX_SAFE_INTEGER] as const;
  return [...groups.values()].map(pick).sort((left, right) => {
    const a = order(left);
    const b = order(right);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || left.path.localeCompare(right.path);
  });
}

/** Where the viewer left off: the last episode they started, or the one after it once finished. */
export function nextEpisode(episodes: BrowseFile[]): BrowseFile | undefined {
  let touched = -1;
  episodes.forEach((file, index) => { if ((file.progress?.position ?? 0) > 0) touched = index; });
  if (touched < 0) return episodes[0];
  const last = episodes[touched]!;
  return finished(last) ? episodes[touched + 1] ?? last : last;
}

/** The episode's own title read out of a file name such as `Show - S01E02 - Title`. */
export function episodeName(file: BrowseFile): string {
  const match = /^.*?\b(?:S\d{1,3}\s*E\d{1,4}|\d{1,2}x\d{1,3})\b[\s._\-–—]*/i.exec(file.label);
  const rest = match ? file.label.slice(match[0].length).replace(/\s*\(\d+\)$/, "").trim() : "";
  return rest || file.label;
}

/** Every video under a show's folder, its season folders included, read level by level. */
async function seriesFiles(path: string, depth = 0): Promise<BrowseFile[]> {
  const found: BrowseFile[] = [];
  for (let skip = 0; ;) {
    const page = await api.browse({ path, skip, limit: 120 });
    for (const item of page.items) {
      if (item.kind === "file") found.push(item);
      else if (item.kind === "folder" && depth < 3) found.push(...await seriesFiles(item.path, depth + 1));
    }
    skip += page.items.length;
    if (!page.items.length || skip >= page.total || found.length >= 4000) return found;
  }
}

/**
 * A show on disk, drawn the way a Jellyfin or Emby series is: the hero with its ratings and people,
 * then every episode grouped by season. A tile opens that episode's own detail; Continue plays the
 * episode the viewer is in the middle of.
 */
export function LocalSeriesDetail({ folder, favorite, onToggleFavorite, onOpenEpisode, onPlayEpisode, uiLanguage, secureMode, onTrailer, onGallery, tileShape, revision = 0 }: Props) {
  useI18n();
  const [files, setFiles] = useState<BrowseFile[] | null>(null);
  const [error, setError] = useState("");
  const [identity, setIdentity] = useState<IdentityPreview | null>(null);
  useEffect(() => {
    let live = true;
    setError("");
    void seriesFiles(folder.path)
      .then((found) => { if (live) setFiles(found); })
      .catch((reason) => { if (live) { setFiles([]); setError(describeError(reason)); } });
    return () => { live = false; };
  }, [folder.path, revision]);
  useEffect(() => {
    let live = true;
    void api.libraryIdentity(folder.path).then((answer) => { if (live) setIdentity(answer); }, () => undefined);
    return () => { live = false; };
  }, [folder.path]);

  const bound = boundRef(identity);
  const enrichment = useTitleEnrichment({ kind: "local", path: folder.path }, bound, uiLanguage);
  const titleExtras = useTitleExtras(bound?.type, bound?.id);
  const pieces = TitleExtraFacts({ extras: titleExtras.extras, language: uiLanguage, name: folder.catalogName || folder.name });
  const scores = ratingsFrom(titleExtras.extras, enrichment.meta);
  const backdrop = useBackdrop([enrichment.meta?.background, folder.wide, folder.poster]);
  const gallery = mergeGallery(posterAndWide(folder.poster, folder.wide), catalogueGalleryImages(enrichment.meta));

  const episodes = files ? episodeFiles(files) : [];
  const next = nextEpisode(episodes);
  const resuming = Boolean(next?.progress && next.progress.position > 0 && !finished(next));
  const seasons = [...new Set(episodes.map((file) => file.season ?? 0))];
  const facts = [folder.year, t("library.fileCount", { count: folder.fileCount }), folder.size ? bytes(folder.size) : ""].filter(Boolean).join(" · ");
  const label = (file: BrowseFile) => file.season != null
    ? `${t("mediaServer.episodeLabel", { season: file.season, episode: file.episode ?? 0 })} · ${episodeName(file)}`
    : file.label;

  return <div className="remote-detail library-title-detail remote-series-detail local-series-detail" data-path={folder.path}
    style={backdrop ? { backgroundImage: `${LIBRARY_HERO_GRADIENT},url(${backdrop})` } : { backgroundImage: LIBRARY_HERO_EMPTY_GRADIENT }}>
    <DetailHero className="library-detail-hero"
      chips={<TitleChips kind={t("catalog.oneSeries")} links={enrichment.links} onTrailer={onTrailer} secureMode={secureMode}/>}
      gallery={gallery.length && onGallery ? <button type="button" className={`gallery-open ${gallery[0]!.shape === "wide" ? "wide" : "poster"}`}
        title={t("gallery.openHint")} onClick={() => onGallery(gallery, folder.path, bound)}>
        <img key={gallery[0]!.url} src={gallery[0]!.url} alt="" onError={hideBroken}/><span><Images/> {gallery.length > 1 ? t("gallery.stillCount", { count: gallery.length }) : t("gallery.enlarge")}</span>
      </button> : undefined}
      copy={<>
        <h2>{folder.catalogName || folder.name}</h2>
        {pieces.originalLine}
        {facts && <p className="meta-line">{facts}</p>}
        <DetailRatings age={pieces.ageBadge} imdb={scores.imdb} tmdb={scores.tmdb} tmdbVotes={scores.tmdbVotes}/>
        {pieces.nextLine}
        <ClampedDescription text={synopsisOf(folder.description, titleExtras.extras) || t("catalog.noDescription")}/>
        <CrewLine people={titleExtras.extras?.people}/>
        <div className="library-detail-actions">
          {next && <div className="actions library-detail-play">
            <button type="button" className="primary" onClick={() => onPlayEpisode(next, false, bound)}>
              <CirclePlay/> {t(resuming ? "library.continue" : "player.play")} · {t("mediaServer.episodeLabel", { season: next.season ?? 0, episode: next.episode ?? 0 })}
            </button>
          </div>}
          <div className="detail-secondary">
            {resuming && next && <DetailIcon icon={<ListRestart/>} label={t("detail.action.fromStart")} aria-label={t("player.playFromStart")} title={t("player.playFromStart")}
              onClick={() => onPlayEpisode(next, true, bound)}/>}
            <DetailTrailerButton trailer={enrichment.trailer ?? trailerFromExtras(titleExtras.extras, uiLanguage)} secureMode={secureMode} onTrailer={onTrailer}/>
            <DetailFavoriteButton favorite={favorite} onToggle={onToggleFavorite}/>
          </div>
        </div>
      </>}/>
    <div className="subhead remote-episodes-head"><h3>{t("mediaServer.episodes")}</h3><span>{folder.catalogName || folder.name}</span></div>
    {error && <div className="remote-error" role="alert"><span>{error}</span></div>}
    {files === null && <div className="loading" role="status">{t("common.loading")}</div>}
    {seasons.map((season) => <div className="remote-season-group" key={season}>
      <div className="remote-season">{t("mediaServer.seasonLabel", { season })}</div>
      <div className="browse-grid">
        {episodes.filter((file) => (file.season ?? 0) === season).map((file) => <LibraryItem key={file.path} dataPath={file.path}
          onOpen={() => onOpenEpisode(file)}
          art={<>
            <TileArt shape={tileShape} poster={file.poster} wide={file.wide} fallback={<Film/>}/>
            {file.progress && <i className="resume-bar"><i style={{ width: `${Math.min(100, Math.round(file.progress.position / (file.progress.duration || 1) * 100))}%` }}/></i>}
          </>}
          title={label(file)} meta={[file.year, file.size ? bytes(file.size) : ""].filter(Boolean).join(" · ")}
          action={<><Play/> {t("player.play")}</>}/>)}
      </div>
    </div>)}
    <TitleExtrasRows extras={titleExtras.extras} loading={titleExtras.loading} secureMode={secureMode} onTrailer={onTrailer}/>
  </div>;
}
