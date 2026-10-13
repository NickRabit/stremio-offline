import { useEffect, useRef, useState } from "react";
import { Check, Star } from "lucide-react";
import { api, describeError } from "./api";
import { bytes } from "./settings-ui";
import { t, useI18n } from "./i18n";
import { LibraryTitleDetail } from "./LibraryTitleDetail";
import type { BrowseFile, BrowseFolder, IdentityPreview, Stream } from "./types";

export type LocalDetailItem = ({ kind: "folder" } & BrowseFolder) | ({ kind: "file" } & BrowseFile);

interface Props {
  item: LocalDetailItem;
  favorite: boolean;
  progress?: { position: number; duration: number };
  onToggleFavorite: (favorite: boolean) => void;
  onResetProgress: () => void;
  onPlay: (stream: Stream) => void;
}

/** The local counterpart of a remote title's detail: it discovers the exact file and, when the
 *  file or its folder is bound to a title, the other copies of that same title, then hands them to
 *  the shared shell. The catalogue hero, the synopsis and the source picker are the ones a remote
 *  library uses. */
export function LocalLibraryDetail({ item, favorite, progress, onToggleFavorite, onResetProgress, onPlay }: Props) {
  useI18n();
  const [sources, setSources] = useState<Stream[] | null>(null);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  const epoch = useRef(0);
  const isFile = item.kind === "file";

  useEffect(() => {
    const controller = new AbortController();
    const mine = ++epoch.current;
    const live = () => mine === epoch.current && !controller.signal.aborted;
    setSources(null);
    setError("");
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

  const libraryName = sources?.find((stream) => stream.libraryName)?.libraryName;
  const episode = isFile && item.season != null;
  const title = item.catalogName || (isFile ? item.label : item.name);
  const chips = [
    <span className="pill" key="type">{t(episode ? "episodes.one" : "catalog.oneMovie")}</span>,
    libraryName ? <span className="pill" key="library">{libraryName}</span> : null,
  ];
  const facts = [item.year, sources?.length === 1 && item.size ? bytes(item.size) : ""].filter(Boolean).join(" · ");

  return <div className="library-local-detail" data-path={item.path} tabIndex={-1}><LibraryTitleDetail
    identityKey={item.path}
    title={title}
    {...(episode ? { subtitle: t("mediaServer.episodeLabel", { season: item.season ?? 0, episode: item.episode ?? 0 }) } : {})}
    {...(item.poster ? { poster: item.poster } : {})}
    {...(item.wide ? { wide: item.wide } : {})}
    {...(facts ? { facts } : {})}
    {...(item.description ? { description: item.description } : {})}
    chips={chips}
    actions={<>
      <button type="button" aria-pressed={favorite} onClick={() => onToggleFavorite(!favorite)}>
        <Star fill={favorite ? "currentColor" : "none"}/> {t("mediaServer.favorite")}
      </button>
      {progress && <button type="button" onClick={onResetProgress}><Check/> {t("library.markUnwatched")}</button>}

    </>}
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
