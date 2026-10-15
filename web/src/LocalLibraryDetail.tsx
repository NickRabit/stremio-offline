import { useEffect, useRef, useState } from "react";
import { api, describeError } from "./api";
import { bytes } from "./settings-ui";
import { t, useI18n } from "./i18n";
import { LibraryTitleDetail } from "./LibraryTitleDetail";
import { sourceIdentity } from "./library-detail-sources";
import { useLibrarySources } from "./library-sources";
import { sourceProgressOwner } from "./source-progress";
import { TitleChips } from "./TitleChips";
import { catalogueGalleryImages, mergeGallery, posterAndWide, type GalleryImage } from "./gallery-images";
import { canQueue, isLocalStream } from "./streams";
import { useTitleEnrichment, type CatalogueRef } from "./title-enrichment";
import type { BrowseFile, BrowseFolder, IdentityPreview, Stream, Trailer } from "./types";

export type LocalDetailItem = ({ kind: "folder" } & BrowseFolder) | ({ kind: "file" } & BrowseFile);

/** A row a library detail offers beside its own files: an addon answer or a copy another media
 *  server holds, with everything its own playback and saves need captured at the click. */
export interface AlternativePlay {
  stream: Stream;
  title: string;
  poster?: string;
  /** The catalogue key an addon answer plays and records under; absent for another library's copy. */
  catalogue: CatalogueRef | null;
  media: Record<string, unknown>;
  kind: "movie" | "series";
  fromBeginning?: boolean;
}

interface Props {
  item: LocalDetailItem;
  favorite: boolean;
  progress?: { position: number; duration: number };
  progressRevision?: number;
  onToggleFavorite: (favorite: boolean) => void;
  /** Forgets one file's saved position; true once the owner's write and refresh succeeded. */
  onResetProgress: (path: string) => Promise<boolean>;
  onPlay: (stream: Stream, fromBeginning?: boolean) => void;
  onOpenFolder?: () => void;
  /** The reader's interface language, so the catalogue is asked in it. */
  uiLanguage: string;
  /** Secure Mode, which decides how the trailer chip behaves. */
  secureMode: boolean;
  /** The app owns the trailer overlay; the chip only asks for it. */
  onTrailer: (trailer: Trailer) => void;
  /** Opens the app's gallery overlay; a path asks it to merge the stored pictures in first. */
  onGallery?: (images: GalleryImage[], path: string, ref?: CatalogueRef | null) => void;
  /** The account the extra sources are read for, so another account's answers are never kept. */
  accountScope?: string;
  /** Starts an addon or another library's copy, which the library's own player cannot hold. */
  onPlayAlternative?: (request: AlternativePlay) => void;
  /** Queues an addon or another library's copy; a row of this library's own files is never
   *  offered a second copy of itself. */
  onSaveAlternative?: (request: AlternativePlay) => void;
  /** The viewer's audio language, which the recommended order of the chooser prefers. */
  preferredLanguage?: string;
  /** Whether a debrid token is configured, so a torrent row may be offered a copy at all. */
  realDebridConfigured?: boolean;
}

/** The local counterpart of a remote title's detail: it discovers the exact file and, when the
 *  file or its folder is bound to a title, the other copies of that same title, then hands them to
 *  the shared shell. The catalogue hero, the synopsis and the source picker are the ones a remote
 *  library uses. */
export function LocalLibraryDetail({ item, favorite, progress, progressRevision = 0, onToggleFavorite, onResetProgress, onPlay, onOpenFolder, uiLanguage, secureMode, onTrailer, onGallery, accountScope = "", onPlayAlternative, onSaveAlternative, preferredLanguage, realDebridConfigured = false }: Props) {
  useI18n();
  const [sources, setSources] = useState<Stream[] | null>(null);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  const [identity, setIdentity] = useState<IdentityPreview | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [selected, setSelected] = useState<Stream | null>(null);
  const [saved, setSaved] = useState<{ sourceKey: string; position: number; duration: number } | null>(null);
  const epoch = useRef(0);
  const progressEpoch = useRef(0);
  const isFile = item.kind === "file";
  const selectedKey = selected ? sourceIdentity(selected) : null;
  const currentSelection = useRef(selectedKey);
  currentSelection.current = selectedKey;
  // The identity the source resolution already found: the film, or the exact episode of its show.
  // Nothing is asked about a title without one, and a loose number never stands in for a season.
  const bound = boundRef(identity);
  const catalogue = identity ? sourceRef(identity, item) : null;
  // Where the selected row's own saved position lives: the file the viewer clicked, the copy's own
  // remote item, or the exact catalogue key of the addon answer. Nothing is guessed from the row
  // the detail was opened on.
  const owner = selected ? sourceProgressOwner(selected, catalogue) : null;
  const ownerKey = owner?.key ?? null;
  const extra = useLibrarySources({
    scope: `${accountScope}\u0000${item.path}`,
    open: chooserOpen,
    catalogue,
    ...(identity?.bound?.type === "series" ? { nameHint: identity.bound.name } : {}),
    libraries: null,
    localCopies: false,
  });

  useEffect(() => {
    const controller = new AbortController();
    const mine = ++epoch.current;
    const live = () => mine === epoch.current && !controller.signal.aborted;
    setSources(null);
    setError("");
    setIdentity(null);
    const run = async () => {
      try {
        if (isFile) {
          // The clicked file is the one authoritative source; extra copies are a bonus, and a
          // failed lookup must never hide a file that plays.
          let direct: Stream | null = null;
          let failure: unknown;
          try {
            const source = await api.librarySource(item.path, controller.signal);
            direct = { ...source, localPath: item.path, behaviorHints: { ...source.behaviorHints, videoSize: item.size } };
          } catch (value) { failure = value; }
          if (!live()) return;
          let copies: Stream[] = [];
          try {
            const preview = await api.libraryIdentity(item.path, controller.signal);
            if (!live()) return;
            setIdentity(preview);
            const id = preview.bound ? episodeId(preview, item) : null;
            if (id) copies = await api.localStreams(preview.bound!.type, id, controller.signal);
          } catch { /* the extra copies are best effort; the exact file still plays */ }
          if (!live()) return;
          const byPath = new Map<string, Stream>();
          if (direct) byPath.set(item.path, direct);
          for (const copy of copies) {
            if (!copy.localPath) continue;
            const existing = byPath.get(copy.localPath);
            if (!existing) byPath.set(copy.localPath, copy);
            else if (!existing.libraryName && copy.libraryName) byPath.set(copy.localPath, { ...existing, libraryName: copy.libraryName });
          }
          const merged = [...byPath.values()];
          if (!merged.length) { setError(describeError(failure)); setSources([]); return; }
          setSources(merged);
          return;
        }
        // A matched movie folder stands for one title, so its copies are that title's versions and
        // a failure here is a real one: a single guessed file must never be passed off as them.
        const preview = await api.libraryIdentity(item.path, controller.signal);
        if (!live()) return;
        setIdentity(preview);
        if (!preview.bound || preview.bound.type !== "movie") { setSources([]); return; }
        const copies = await api.localStreams("movie", preview.bound.id, controller.signal);
        if (!live()) return;
        setSources(copies);
      } catch (value) {
        if (!live()) return;
        setError(describeError(value));
        setSources([]);
      }
    };
    void run();
    return () => { controller.abort(); if (epoch.current === mine) epoch.current += 1; };
  }, [item.path, nonce]);

  const selectedPath = owner?.kind === "file" ? owner.path : undefined;
  const selectedRemote = owner?.kind === "remote" ? owner.item : null;

  // The played version's own saved position, never another's: the clicked file's value stands in
  // at once, then the authoritative read replaces it. A local copy reads its file key, a copy in
  // another library its own remote state, an addon row the generic key of the same episode. A
  // remote answer belongs to this version only when it reports the same media source, and a failed
  // read keeps only what already belonged to this same version, so nothing of another one can
  // flash over it.
  useEffect(() => {
    if (!selectedKey || !ownerKey || !owner) { setSaved(null); return; }
    const controller = new AbortController();
    const mine = ++progressEpoch.current;
    const live = () => mine === progressEpoch.current && !controller.signal.aborted;
    const initial = isFile && selectedPath === item.path && progress && progress.position > 0
      ? { sourceKey: selectedKey, position: progress.position, duration: progress.duration }
      : null;
    setSaved(initial);
    // A remote state that reports another media source is another version of the item and counts
    // as nothing here: the selected row starts without a position it never had.
    const read: Promise<{ position: number; duration: number } | null> = owner.kind === "remote"
      ? api.remoteState(owner.item.libraryId, owner.item.itemId, controller.signal)
        .then((value) => value && value.mediaSourceId === owner.item.mediaSourceId ? value : null)
      : api.progressOf(owner.progressKey, controller.signal);
    void read
      .then((entry) => {
        if (!live()) return;
        const own = entry && entry.position > 0 ? entry : { position: 0, duration: 0 };
        setSaved({ sourceKey: selectedKey, position: own.position, duration: own.duration });
      })
      .catch(() => undefined);
    return () => { controller.abort(); if (progressEpoch.current === mine) progressEpoch.current += 1; };
  }, [ownerKey, owner?.kind, selectedPath, selectedRemote?.libraryId, selectedRemote?.itemId, selectedRemote?.mediaSourceId, selectedKey, progressRevision]);

  const clearSelectedProgress = async (stream: Stream): Promise<boolean> => {
    const key = sourceIdentity(stream);
    const own = sourceProgressOwner(stream, catalogue);
    let done = false;
    if (own?.kind === "file") done = await onResetProgress(own.path);
    else if (own?.kind === "remote") {
      try { await api.saveRemoteState(own.item.libraryId, own.item.itemId, { position: 0, duration: 0, mediaSourceId: own.item.mediaSourceId }); done = true; }
      catch { done = false; }
    } else if (own?.kind === "catalogue") {
      try { await api.forgetProgress(own.progressKey); done = true; }
      catch { done = false; }
    }
    if (done && currentSelection.current === key) {
      progressEpoch.current += 1;
      setSaved({ sourceKey: key, position: 0, duration: 0 });
    }
    return done;
  };

  // The catalogue identity the source resolution already found: the series of an episode, or the
  // film itself. Its metadata supplies a backdrop and never replaces the file's own synopsis.
  const enrichment = useTitleEnrichment({ kind: "local", path: item.path }, bound, uiLanguage);
  const episode = isFile && item.season != null;
  const title = item.catalogName || (isFile ? item.label : item.name);
  /** The subject an alternative row is saved under: the identity the file already carries, never
   *  the file's own path. */
  const alternativeMedia = (): Record<string, unknown> => {
    const bound = identity?.bound;
    if (!bound) return {};
    if (bound.type === "movie") return { kind: "movie", title: bound.name ?? title, id: bound.id, metaType: "movie" };
    const season = isFile ? item.season ?? identity?.parsed?.season ?? bound.season : identity?.parsed?.season ?? bound.season;
    const episode = isFile ? item.episode ?? identity?.parsed?.episode ?? bound.episode : identity?.parsed?.episode ?? bound.episode;
    return {
      kind: "episode", title: bound.name ?? title,
      ...(typeof season === "number" ? { season } : {}), ...(typeof episode === "number" ? { episode } : {}),
      episodeTitle: title, ...(catalogue ? { id: bound.id, metaType: "series" } : {}),
    };
  };
  const chips = <TitleChips kind={t(episode ? "episodes.one" : "catalog.oneMovie")} trailer={enrichment.trailer} links={enrichment.links}
    onTrailer={onTrailer} secureMode={secureMode}/>;
  const facts = [item.year, sources?.length === 1 && item.size ? bytes(item.size) : ""].filter(Boolean).join(" · ");
  // Prefer full-resolution backdrops; unmatched files can still use their existing preview.
  const backdrops = [enrichment.meta?.background, item.wide, item.poster];
  // The file's own poster and wide artwork merge with the exact catalogue pictures; the saved
  // downloads are read only when the corner image is clicked.
  const gallery = mergeGallery(posterAndWide(item.poster, item.wide), catalogueGalleryImages(enrichment.meta));

  return <div className="library-local-detail" data-path={item.path} tabIndex={-1}><LibraryTitleDetail
    identityKey={item.path}
    title={title}
    {...(episode ? { subtitle: t("mediaServer.episodeLabel", { season: item.season ?? 0, episode: item.episode ?? 0 }) } : {})}
    poster={item.poster}
    backdrops={backdrops}
    gallery={gallery}
    {...(onGallery ? { onGallery: (images) => onGallery(images, item.path, bound) } : {})}
    {...(facts ? { facts } : {})}
    {...(item.description ? { description: item.description } : {})}
    chips={chips}
    favorite={favorite}
    onToggleFavorite={onToggleFavorite}
    {...(!isFile && onOpenFolder ? { onOpenFolder } : {})}
    sources={sources}
    {...(error ? { sourceError: error } : {})}
    onRetry={() => setNonce((value) => value + 1)}
    onSourceChange={setSelected}
    {...(saved && saved.sourceKey === selectedKey ? { progress: saved } : {})}
    onClearProgress={clearSelectedProgress}
    {...(catalogue ? { sourceGroups: { groups: extra.groups, retry: extra.retry }, onOpenSources: () => setChooserOpen(true) } : {})}
    {...(catalogue && onSaveAlternative ? {
      onSaveToLibrary: (stream: Stream) => onSaveAlternative({
        stream, title, ...(item.poster ? { poster: item.poster } : {}), catalogue, media: alternativeMedia(),
        kind: identity?.bound?.type === "series" ? "series" : "movie",
      }),
      // A file of this library is never queued as a copy of itself, and only a source the server
      // proved the account may copy is offered at all: a click always reaches a real decision.
      saveSupported: (stream: Stream) => canQueue(stream, realDebridConfigured),
    } : {})}
    {...(preferredLanguage ? { preferredLanguage } : {})}
    onPlay={(stream, fromBeginning) => {
      // The library's own file plays through the library player; a row that belongs to an addon or
      // to another media server is handed on as the source it really is, with its own identity.
      if (isLocalStream(stream) || stream.localPath) { onPlay(stream, fromBeginning); return; }
      onPlayAlternative?.({
        stream, title, ...(item.poster ? { poster: item.poster } : {}), catalogue, media: alternativeMedia(),
        kind: identity?.bound?.type === "series" ? "series" : "movie", ...(fromBeginning ? { fromBeginning: true } : {}),
      });
    }}/></div>;
}

/** The exact catalogue request an episode's extra sources are asked by: its parent show with its
 *  own numbering appended, and only when both numbers are really there. A film asks by its own
 *  id; anything else has no title to ask about. */
export function sourceRef(identity: IdentityPreview, item: LocalDetailItem): CatalogueRef | null {
  const bound = identity.bound;
  if (!bound) return null;
  if (bound.type === "movie") return { type: "movie", id: bound.id };
  if (bound.type !== "series") return null;
  const id = episodeId(identity, item);
  if (!id) return null;
  const season = (item.kind === "file" ? item.season : undefined) ?? identity.parsed?.season ?? bound.season;
  const episode = (item.kind === "file" ? item.episode : undefined) ?? identity.parsed?.episode ?? bound.episode;
  if (typeof season !== "number" || !Number.isInteger(season) || season < 0) return null;
  if (typeof episode !== "number" || !Number.isInteger(episode) || episode < 1) return null;
  return { type: "series", id };
}

/** The catalogue id of the exact episode a file holds, or the title id of a film. Nothing is
 *  guessed from a loose number: without both numbers there is no episode to ask for. */
export function episodeId(identity: IdentityPreview, item: LocalDetailItem): string | null {
  const bound = identity.bound;
  if (!bound) return null;
  if (bound.type === "movie") return bound.id;
  if (bound.type !== "series") return null;
  const season = (item.kind === "file" ? item.season : undefined) ?? identity.parsed?.season ?? bound.season;
  const episode = (item.kind === "file" ? item.episode : undefined) ?? identity.parsed?.episode ?? bound.episode;
  if (season == null || episode == null) return null;
  return `${bound.id}:${season}:${episode}`;
}

/** The catalogue identity a bound library item already carries, so the enrichment never has to
 *  resolve it a second time. A binding that is neither a film nor a show is not a title. */
export function boundRef(identity: IdentityPreview | null): CatalogueRef | null {
  const bound = identity?.bound;
  if (!bound || (bound.type !== "movie" && bound.type !== "series")) return null;
  return { type: bound.type, id: bound.id };
}
