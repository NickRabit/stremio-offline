import { useEffect, useRef, useState } from "react";
import { api, describeError } from "./api";
import { bytes } from "./settings-ui";
import { t, useI18n } from "./i18n";
import { LibraryTitleDetail } from "./LibraryTitleDetail";
import { TitleChips } from "./TitleChips";
import { catalogueGalleryImages, mergeGallery, posterAndWide, type GalleryImage } from "./gallery-images";
import { useTitleEnrichment, type CatalogueRef } from "./title-enrichment";
import type { BrowseFile, BrowseFolder, IdentityPreview, Stream, Trailer } from "./types";

export type LocalDetailItem = ({ kind: "folder" } & BrowseFolder) | ({ kind: "file" } & BrowseFile);

interface Props {
  item: LocalDetailItem;
  favorite: boolean;
  progress?: { position: number; duration: number };
  onToggleFavorite: (favorite: boolean) => void;
  onResetProgress: () => void;
  onPlay: (stream: Stream) => void;
  onOpenFolder?: () => void;
  /** The reader's interface language, so the catalogue is asked in it. */
  uiLanguage: string;
  /** Secure Mode, which decides how the trailer chip behaves. */
  secureMode: boolean;
  /** The app owns the trailer overlay; the chip only asks for it. */
  onTrailer: (trailer: Trailer) => void;
  /** Opens the app's gallery overlay; a path asks it to merge the stored pictures in first. */
  onGallery?: (images: GalleryImage[], path: string, ref?: CatalogueRef | null) => void;
}

/** The local counterpart of a remote title's detail: it discovers the exact file and, when the
 *  file or its folder is bound to a title, the other copies of that same title, then hands them to
 *  the shared shell. The catalogue hero, the synopsis and the source picker are the ones a remote
 *  library uses. */
export function LocalLibraryDetail({ item, favorite, progress, onToggleFavorite, onResetProgress, onPlay, onOpenFolder, uiLanguage, secureMode, onTrailer, onGallery }: Props) {
  useI18n();
  const [sources, setSources] = useState<Stream[] | null>(null);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  const [bound, setBound] = useState<CatalogueRef | null>(null);
  const epoch = useRef(0);
  const isFile = item.kind === "file";

  useEffect(() => {
    const controller = new AbortController();
    const mine = ++epoch.current;
    const live = () => mine === epoch.current && !controller.signal.aborted;
    setSources(null);
    setError("");
    setBound(null);
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
            const identity = await api.libraryIdentity(item.path, controller.signal);
            if (!live()) return;
            setBound(boundRef(identity));
            const id = identity.bound ? episodeId(identity, item) : null;
            if (id) copies = await api.localStreams(identity.bound!.type, id, controller.signal);
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
        const identity = await api.libraryIdentity(item.path, controller.signal);
        if (!live()) return;
        setBound(boundRef(identity));
        if (!identity.bound || identity.bound.type !== "movie") { setSources([]); return; }
        const copies = await api.localStreams("movie", identity.bound.id, controller.signal);
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

  // The catalogue identity the source resolution already found: the series of an episode, or the
  // film itself. Its metadata supplies a backdrop and never replaces the file's own synopsis.
  const enrichment = useTitleEnrichment({ kind: "local", path: item.path }, bound, uiLanguage);
  const episode = isFile && item.season != null;
  const title = item.catalogName || (isFile ? item.label : item.name);
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
    {...(progress ? { watchedLabel: t("library.markUnwatched"), onToggleWatched: onResetProgress } : {})}
    {...(!isFile && onOpenFolder ? { onOpenFolder } : {})}
    sources={sources}
    {...(error ? { sourceError: error } : {})}
    onRetry={() => setNonce((value) => value + 1)}
    onPlay={onPlay}/></div>;
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
export function boundRef(identity: IdentityPreview): CatalogueRef | null {
  const bound = identity.bound;
  if (!bound || (bound.type !== "movie" && bound.type !== "series")) return null;
  return { type: bound.type, id: bound.id };
}
