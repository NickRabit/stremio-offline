import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { api, describeError } from "./api";
import { t, useI18n } from "./i18n";
import { LibraryTitleDetail } from "./LibraryTitleDetail";
import { useLibrarySources } from "./library-sources";
import type { Stream } from "./types";

/** One catalogue title's detail: the same body the libraries draw, hosted for a title that only
 *  the catalogue knows. Its own rows are the streams the catalogue panel loads for that title;
 *  the other libraries and the account's own copies arrive through the shared chooser, read the
 *  moment it is opened and never while this detail is merely on screen. */
/** The catalogue id a detail asks its own rows by: an episode is the exact video the catalogue
 *  lists, a film is the title itself. */
export function catalogueStreamId(target: { id: string; season?: number; episode?: number }): string {
  return target.season != null && target.episode != null ? `${target.id}:${target.season}:${target.episode}` : target.id;
}

export function CatalogueTitleDetail(props: {
  type: "movie" | "series";
  id: string;
  name: string;
  poster?: string;
  season?: number;
  episode?: number;
  onPlay: (stream: Stream, fromBeginning: boolean) => void;
  onSaveToLibrary: (stream: Stream) => void;
  onSaveElsewhere: (stream: Stream) => void;
  saveSupported: (stream: Stream) => boolean;
  onDownloadToDevice: (stream: Stream) => void;
  onClose: () => void;
}) {
  useI18n();
  const { type, id, name, poster, season, episode } = props;
  // An episode is asked about by the exact video the catalogue lists, exactly as the panel asks.
  const streamId = catalogueStreamId({ id, ...(season != null ? { season } : {}), ...(episode != null ? { episode } : {}) });
  const [rows, setRows] = useState<Stream[] | null>(null);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  const [chooserOpen, setChooserOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setRows(null);
    setError("");
    const run = async () => {
      try {
        const providers = await api.streamSources(type, streamId, controller.signal);
        const parts = await Promise.all(providers.map((provider) =>
          api.streams(type, streamId, provider.key, controller.signal).catch(() => [] as Stream[])));
        if (!live) return;
        const seen = new Set<string>();
        setRows(parts.flat().filter((stream) => stream.sourceId.trim().length > 0 && !seen.has(stream.sourceId) && (seen.add(stream.sourceId), true)));
      } catch (value) {
        if (!live) return;
        setError(describeError(value));
        setRows([]);
      }
    };
    void run();
    return () => { live = false; controller.abort(); };
  }, [type, streamId, nonce]);

  const extra = useLibrarySources({
    scope: `catalogue:${type}:${streamId}`,
    open: chooserOpen,
    catalogue: { type, id: streamId },
    ...(season != null ? { nameHint: name } : {}),
    libraries: null,
    localCopies: true,
  });

  return <div className="catalogue-title-detail">
    <div className="browse-head"><div className="browse-bar">
      <nav className="crumbs" aria-label={t("library.breadcrumbs")}>
        <button type="button" className="library-back" aria-label={t("mediaServer.back")} title={t("mediaServer.back")} onClick={props.onClose}><ChevronLeft/></button>
        <button type="button" disabled>{name}</button>
      </nav>
    </div></div>
    <LibraryTitleDetail
      identityKey={`${type}:${streamId}`}
      title={name}
      {...(season != null && episode != null ? { subtitle: t("mediaServer.episodeLabel", { season, episode }) } : {})}
      {...(poster ? { poster } : {})}
      sources={rows}
      sourceGroups={{ groups: extra.groups, retry: extra.retry }}
      onOpenSources={() => setChooserOpen(true)}
      nativeSourceLabel={t("sources.heading")}
      {...(error ? { sourceError: error } : {})}
      onRetry={() => setNonce((value) => value + 1)}
      onPlay={(stream, fromBeginning) => props.onPlay(stream, fromBeginning ?? false)}
      onSaveToLibrary={(stream) => props.onSaveToLibrary(stream)}
      onSaveElsewhere={(stream) => props.onSaveElsewhere(stream)}
      saveSupported={props.saveSupported}
      onDownloadToDevice={(stream) => props.onDownloadToDevice(stream)}
    />
  </div>;
}
