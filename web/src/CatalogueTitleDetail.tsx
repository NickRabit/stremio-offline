import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { api, describeError } from "./api";
import { catalogueGalleryImages, type GalleryImage } from "./gallery-images";
import { t, useI18n } from "./i18n";
import { LibraryTitleDetail } from "./LibraryTitleDetail";
import { defaultSource } from "./library-detail-sources";
import { useLibrarySources } from "./library-sources";
import type { Meta, Stream, Video } from "./types";

/** One catalogue title's detail: the same body the libraries draw, hosted for a title that only
 *  the catalogue knows. Its own rows are the streams the catalogue panel loads for that title;
 *  the other libraries and the account's own copies arrive through the shared chooser, read the
 *  moment it is opened and never while this detail is merely on screen. */
export interface CatalogueDetailTarget {
  type: "movie" | "series";
  id: string;
  name: string;
  poster?: string;
  /** The episode the catalogue had selected, and the exact video id it was listed under. */
  season?: number;
  episode?: number;
  videoId?: string;
  /** The row the catalogue played from, so the detail opens on the same version. */
  initialSource?: Stream;
  /** The catalogue's own metadata, which this detail never reads again. */
  initialMeta?: Meta;
  /** Opened from Continue watching: Play is pressed as soon as the rows arrive, on the row the
   *  title was last played from (`stableKey`) when it is still offered, else on the row Play
   *  offers. A title with nothing playable stays on screen. */
  resume?: { stableKey?: string };
}

/** The catalogue id a detail asks its own rows by: the exact video the catalogue lists wins, then
 *  the episode it constructed from the season and number, and a film is the title itself. */
export function catalogueStreamId(target: { id: string; season?: number; episode?: number; videoId?: string }): string {
  if (target.videoId) return target.videoId;
  return target.season != null && target.episode != null ? `${target.id}:${target.season}:${target.episode}` : target.id;
}

export interface CatalogueTitleDetailProps {
  target: CatalogueDetailTarget;
  /** The rows the catalogue panel already read for this exact selection. Given, they answer for
   *  the title and the providers are not asked a second time; a Home or favourite entry has none. */
  initialSources?: Stream[];
  /** Opens the app's gallery overlay over the pictures the metadata supplied. */
  onGallery?: (images: GalleryImage[], target: CatalogueDetailTarget) => void;
  /** The title's chips, drawn by the shared row: the catalogue's watch star, the kind, the trailer
   *  and the sites that know the title. The catalogue grows them itself, so they survive opening
   *  the full detail instead of being left behind in the panel. */
  chips?: ReactNode;
  /** The viewer's audio language, which the source chooser's recommended order prefers. */
  preferredLanguage?: string;
  /** Told what this detail holds whenever it changes: the metadata it drew, the episode it is on,
   *  and whether a row of it can play yet. The chips and the saved position the caller draws
   *  answer for that title, not for whatever the browse panel has selected. */
  onRead?: (state: { meta: Meta | null; target: CatalogueDetailTarget; pending: boolean; playable: boolean }) => void;
  /** The saved position of the source this detail has selected, keyed by its identity. */
  progress?: { position: number; duration: number; sourceKey: string };
  /** The stable key of the source the title was last played from, preselected when listed. */
  resumeStableKey?: string;
  /** Told whenever the selected version changes, so the caller can read that version's own state. */
  onSourceChange?: (stream: Stream | null) => void;
  /** Clears the saved position of the title this detail holds; true once the write succeeded. */
  onClearProgress?: (stream: Stream) => Promise<boolean>;
  /** Whether the episode on screen has anything left to resume, and the way to say it is seen:
   *  the store keeps resume positions, so "seen" is that nothing is left to resume. */
  watched?: boolean;
  watchedLabel?: string;
  onToggleWatched?: () => void;
  onPlay: (stream: Stream, target: CatalogueDetailTarget, fromBeginning: boolean) => void;
  onSaveToLibrary: (stream: Stream, target: CatalogueDetailTarget) => void;
  onSaveElsewhere: (stream: Stream, target: CatalogueDetailTarget) => void;
  saveSupported: (stream: Stream) => boolean;
  onDownloadToDevice: (stream: Stream, target: CatalogueDetailTarget) => void;
}

/** One provider's answer: its rows, or the failure that kept them away. A provider that failed
 *  never hides the rows the others answered. */
type ProviderAnswer = { rows: Stream[] } | { error: unknown };

/** The pad an episode's own numbering is written with, the way the catalogue writes it. */
const pad = (value: number) => String(value).padStart(2, "0");

/** One row per source id: an addon that repeats a source under two labels is still one thing. */
const dedupe = (streams: Stream[]): Stream[] => {
  const seen = new Set<string>();
  return streams.filter((stream) => stream.sourceId.trim().length > 0 && !seen.has(stream.sourceId) && (seen.add(stream.sourceId), true));
};

export function CatalogueTitleDetail(props: CatalogueTitleDetailProps) {
  const { target, initialSources, onGallery, chips, preferredLanguage, onRead, progress, resumeStableKey, onSourceChange, onClearProgress, watched, watchedLabel, onToggleWatched, onPlay, onSaveToLibrary, onSaveElsewhere, saveSupported, onDownloadToDevice } = props;
  const { locale } = useI18n();
  const { type, id, name } = target;
  const incomingId = catalogueStreamId(target);
  const [snapshot, setSnapshot] = useState<Meta | null>(target.initialMeta ?? null);
  const [metaError, setMetaError] = useState("");
  const [metaNonce, setMetaNonce] = useState(0);
  const [pickedEpisode, setPickedEpisode] = useState<Video | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSeason, setPickerSeason] = useState<number | null>(null);
  const [rows, setRows] = useState<Stream[] | null>(null);
  const [sourceError, setSourceError] = useState("");
  const [nonce, setNonce] = useState(0);
  const [chooserOpen, setChooserOpen] = useState(false);
  const resumed = useRef(false);

  // The catalogue's snapshot is already the answer; a title that only Home or a favourite knows
  // reads its metadata here, and a failure says so with a retry instead of an empty detail.
  useEffect(() => {
    if (target.initialMeta) { setSnapshot(target.initialMeta); setMetaError(""); return; }
    let live = true;
    setSnapshot(null); setMetaError("");
    api.meta(type, id, locale)
      .then((meta) => { if (live) setSnapshot(meta); })
      .catch((error) => { if (live) setMetaError(describeError(error)); });
    return () => { live = false; };
  }, [type, id, target.initialMeta, metaNonce, locale]);

  // Another title opens here: nothing of the first one's own choice survives it.
  useEffect(() => {
    setPickedEpisode(null); setPickerOpen(false); setPickerSeason(null); setSourceError("");
    resumed.current = false;
  }, [type, id]);

  const videos = snapshot?.videos ?? [];
  /** The episode the detail opened on: the exact video the catalogue listed, or the one its season
   *  and number name, kept even before the metadata that would describe it has landed. */
  const opening = useMemo((): Video | null => {
    if (type !== "series" || (!target.videoId && (target.season == null || target.episode == null))) return null;
    const listed = target.videoId
      ? videos.find((video) => video.id != null && String(video.id) === String(target.videoId))
      : videos.find((video) => video.season === target.season && video.episode === target.episode);
    return listed ?? {
      ...(target.videoId ? { id: target.videoId } : {}),
      ...(target.season != null ? { season: target.season } : {}),
      ...(target.episode != null ? { episode: target.episode } : {}),
    };
  }, [type, target.videoId, target.season, target.episode, videos]);
  const episode = pickedEpisode ?? opening;
  // A series without an episode asks for nothing: its id is not a film, and no row exists yet to
  // play. The picker below is the one way on.
  const waitingEpisode = type === "series" && episode === null;
  const streamId = type === "series"
    ? catalogueStreamId({
        id,
        ...(episode?.season != null ? { season: episode.season } : {}),
        ...(episode?.episode != null ? { episode: episode.episode } : {}),
        ...(episode?.id != null ? { videoId: String(episode.id) } : {}),
      })
    : id;
  const effective: CatalogueDetailTarget = {
    type, id, name,
    ...(target.poster ? { poster: target.poster } : {}),
    ...(episode ? {
      ...(episode.season != null ? { season: episode.season } : {}),
      ...(episode.episode != null ? { episode: episode.episode } : {}),
      ...(episode.id != null ? { videoId: String(episode.id) } : {}),
    } : {}),
  };
  // The rows the catalogue read answer for the selection they were read for; another episode is
  // asked for afresh, so one episode's list can never stand in for another's.
  const handed = initialSources !== undefined && streamId === incomingId ? initialSources : undefined;
  // The same goes for the row the detail was opened on: it belongs to the episode it was picked
  // for and is never offered, let alone selected, under another one.
  const seed = streamId === incomingId ? target.initialSource : undefined;

  useEffect(() => {
    if (waitingEpisode) { setRows(null); setSourceError(""); return; }
    if (handed !== undefined) { setRows(handed); setSourceError(""); return; }
    const controller = new AbortController();
    let live = true;
    setRows(null); setSourceError("");
    void (async () => {
      try {
        const providers = await api.streamSources(type, streamId, controller.signal);
        const answers = await Promise.all(providers.map(async (provider): Promise<ProviderAnswer> => {
          try { return { rows: await api.streams(type, streamId, provider.key, controller.signal) }; }
          catch (error) { return { error }; }
        }));
        if (!live) return;
        const failed = answers.filter((answer): answer is { error: unknown } => "error" in answer);
        // Every provider failing is not an empty title: the list keeps its retry and says why.
        if (providers.length > 0 && failed.length === providers.length) {
          setRows([]);
          setSourceError(describeError(failed[0]!.error));
          return;
        }
        setRows(dedupe(answers.flatMap((answer) => "rows" in answer ? answer.rows : [])));
      } catch (error) {
        if (!live) return;
        setRows([]);
        setSourceError(describeError(error));
      }
    })();
    return () => { live = false; controller.abort(); };
  }, [type, streamId, nonce, handed, waitingEpisode]);

  const extra = useLibrarySources({
    scope: `catalogue:${type}:${streamId}`,
    open: chooserOpen,
    catalogue: waitingEpisode ? null : { type, id: streamId },
    nameHint: name,
    libraries: null,
    localCopies: true,
  });

  // What this detail holds is the caller's business too: its chips, its saved position and the
  // episode after the one it plays all belong to the title read here.
  const latest = useRef({ snapshot, rows, effective });
  latest.current = { snapshot, rows, effective };
  const report = useRef(onRead);
  report.current = onRead;
  const episodeKey = `${effective.type}:${catalogueStreamId(effective)}`;
  useEffect(() => {
    const read = latest.current;
    report.current?.({ meta: read.snapshot, target: read.effective, pending: read.rows === null, playable: (read.rows ?? []).some((stream) => stream.playable) });
  }, [episodeKey, snapshot, rows]);

  // Continue watching plays once, the first time the rows are known: an addon that renames or
  // resizes the row it answered with must not leave the card that asked to play doing nothing.
  useEffect(() => {
    if (!target.resume || resumed.current || rows === null) return;
    resumed.current = true;
    const key = target.resume.stableKey;
    const pick = (key ? rows.find((stream) => stream.playable && stream.stableKey === key) : undefined) ?? defaultSource(rows);
    if (pick) onPlay(pick, latest.current.effective, false);
  }, [target.resume, rows, onPlay]);

  const gallery = useMemo(() => catalogueGalleryImages(snapshot), [snapshot]);
  const backdrops = useMemo(() => [snapshot?.background, snapshot?.poster, target.poster], [snapshot, target.poster]);
  const facts = snapshot
    ? [String(snapshot.releaseInfo ?? snapshot.year ?? ""), ...(snapshot.genres ?? []).slice(0, 3)]
      .map((value) => value.trim()).filter(Boolean).join(" · ")
    : "";
  const seasons = [...new Set(videos.map((video) => video.season).filter((value): value is number => typeof value === "number"))]
    .sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
  const activeSeason = pickerSeason ?? episode?.season ?? seasons.find((value) => value > 0) ?? seasons[0] ?? 0;
  const visibleEpisodes = videos.filter((video) => seasons.length <= 1 || video.season === activeSeason);
  const sameEpisode = (video: Video) => episode?.id != null && video.id != null && String(video.id) === String(episode.id);

  const episodes = type !== "series" ? undefined : <div className="catalogue-episodes">
    {waitingEpisode || pickerOpen ? <>
      <div className="subhead episode-head"><h3>{t("episodes.heading")}</h3>
        <div className="episode-tools">
          {seasons.length > 1 && <select className="season-select" aria-label={t("episodes.season")} value={activeSeason}
            onChange={(event) => setPickerSeason(Number(event.target.value))}>
            {seasons.map((value) => <option key={value} value={value}>{value === 0 ? t("episodes.specials") : t("episodes.seasonNumber", { season: value })}</option>)}
          </select>}
          <span>{visibleEpisodes.length}</span>
        </div>
      </div>
      {snapshot === null && !metaError ? <div className="loading" role="status">{t("common.loading")}</div>
        : !videos.length ? <p className="identify-hint">{t("mediaServer.noEpisodes")}</p>
          : <div className="episode-list">{visibleEpisodes.map((video, index) => <button type="button" key={String(video.id ?? index)}
            className={sameEpisode(video) ? "selected" : ""} onClick={() => { setPickedEpisode(video); setPickerOpen(false); }}>
            <b>{video.season != null ? `${pad(video.season)}×${pad(video.episode ?? 0)}` : index + 1}</b>
            <span>{video.title || video.name || t("episodes.one")}</span>
            <ChevronRight/>
          </button>)}</div>}
    </> : episode ? <div className="episode-current">
      <small>{t("episodes.chosen")}</small>
      <b>{episode.season != null ? `${pad(episode.season)}×${pad(episode.episode ?? 0)}` : t("episodes.part")}</b>
      <span>{episode.title || episode.name || t("episodes.one")}</span>
      <button type="button" onClick={() => setPickerOpen(true)}>{t("episodes.change")}</button>
    </div> : null}
  </div>;

  return <div className="catalogue-title-detail">
    {metaError && <div className="remote-error" role="alert">
      <span>{metaError}</span>
      <button type="button" onClick={() => setMetaNonce((value) => value + 1)}>{t("home.retry")}</button>
    </div>}
    <LibraryTitleDetail
      identityKey={`${type}:${streamId}`}
      {...(resumeStableKey ? { resumeStableKey } : {})}
      title={name}
      {...(episode && episode.season != null && episode.episode != null
        ? { subtitle: t("mediaServer.episodeLabel", { season: episode.season, episode: episode.episode }) } : {})}
      {...(snapshot?.poster ?? target.poster ? { poster: snapshot?.poster ?? target.poster } : {})}
      backdrops={backdrops}
      gallery={gallery}
      {...(onGallery ? { onGallery: (images: GalleryImage[]) => onGallery(images, effective) } : {})}
      {...(facts ? { facts } : {})}
      {...(snapshot?.description ? { description: snapshot.description } : {})}
      descriptionLoading={snapshot === null && !metaError}
      {...(chips ? { chips } : {})}
      sources={rows}
      {...(seed ? { initialSource: seed } : {})}
      episodes={episodes}
      {...(waitingEpisode ? { placeholder: null } : {})}
      {...(waitingEpisode ? {} : { sourceGroups: { groups: extra.groups, retry: extra.retry }, onOpenSources: () => setChooserOpen(true) })}
      nativeSourceLabel={t("sources.heading")}
      {...(preferredLanguage ? { preferredLanguage } : {})}
      {...(progress ? { progress } : {})}
      {...(onSourceChange ? { onSourceChange } : {})}
      {...(onClearProgress ? { onClearProgress } : {})}
      {...(onToggleWatched ? { watched: watched ?? false, onToggleWatched } : {})}
      {...(watchedLabel ? { watchedLabel } : {})}
      {...(sourceError ? { sourceError } : {})}
      onRetry={() => setNonce((value) => value + 1)}
      onPlay={(stream, fromBeginning) => onPlay(stream, effective, fromBeginning ?? false)}
      onSaveToLibrary={(stream) => onSaveToLibrary(stream, effective)}
      onSaveElsewhere={(stream) => onSaveElsewhere(stream, effective)}
      saveSupported={saveSupported}
      onDownloadToDevice={(stream) => onDownloadToDevice(stream, effective)}
    />
  </div>;
}
