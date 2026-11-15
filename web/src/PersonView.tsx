import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Film } from "lucide-react";
import { api, ApiError, describeError } from "./api";
import { ArtworkProximity } from "./artwork-proximity";
import { hideBroken } from "./settings-ui";
import { t, useI18n } from "./i18n";
import { TileArt } from "./TileArt";
import type { PersonFilmography, PersonTitle, TileShape } from "./types";

const PAGE = 40;

export type PersonOpenTitle = {
  type: "movie" | "series";
  id: string;
  name: string;
  poster?: string;
};

export function PersonView({ person, language, shape, initialScroll, onBack, onUnavailable, onOpenTitle, onNotify }: {
  person: { id: number; name: string };
  language: string;
  shape: TileShape;
  initialScroll?: number;
  onBack: () => void;
  onUnavailable: (name: string) => void;
  onOpenTitle: (title: PersonOpenTitle, notice?: "noImdb") => void;
  onNotify: (text: string) => void;
}) {
  useI18n();
  const pageRef = useRef<HTMLElement>(null);
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const appliedScroll = useRef(false);
  const [filmography, setFilmography] = useState<PersonFilmography | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const openingAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setFilmography(null);
    void api.person(person.id, language, controller.signal).then((answer) => {
      if (controller.signal.aborted) return;
      setFilmography(answer);
      setLoading(false);
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.messageKey === "err.personUnavailable") {
        onUnavailableRef.current(person.name);
        return;
      }
      setError(describeError(failure));
      setLoading(false);
    });
    return () => controller.abort();
  }, [person.id, person.name, language, retry]);

  useEffect(() => () => { openingAbort.current?.abort(); }, []);

  useEffect(() => {
    appliedScroll.current = false;
  }, [person.id, initialScroll]);

  useEffect(() => {
    if (appliedScroll.current || initialScroll == null || loading || error || !filmography) return;
    appliedScroll.current = true;
    const apply = () => {
      const node = pageRef.current;
      if (node) node.scrollTop = initialScroll;
      window.scrollTo(0, initialScroll);
    };
    apply();
    const handle = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(handle);
  }, [filmography, loading, error, initialScroll]);

  useEffect(() => {
    const node = pageRef.current;
    if (!node) return;
    node.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onBackRef.current();
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, [person.id]);

  const displayName = filmography?.name ?? person.name;
  const photo = filmography?.photo;

  const openTitle = (title: PersonTitle) => {
    if (openingId) return;
    if (title.id.startsWith("tt")) {
      onOpenTitle({ type: title.type, id: title.id, name: title.name, ...(title.poster ? { poster: title.poster } : {}) });
      return;
    }
    if (!title.id.startsWith("tmdb:")) {
      onOpenTitle({ type: title.type, id: title.id, name: title.name, ...(title.poster ? { poster: title.poster } : {}) });
      return;
    }
    const key = `${title.type}:${title.id}`;
    setOpeningId(key);
    openingAbort.current?.abort();
    const controller = new AbortController();
    openingAbort.current = controller;
    void api.personTitle(title.type, title.tmdbId, controller.signal).then((answer) => {
      if (controller.signal.aborted) return;
      setOpeningId(null);
      if (answer.imdb === "none") {
        onOpenTitle({ type: title.type, id: title.id, name: title.name, ...(title.poster ? { poster: title.poster } : {}) }, "noImdb");
        return;
      }
      onOpenTitle({ type: title.type, id: answer.id, name: title.name, ...(title.poster ? { poster: title.poster } : {}) });
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      setOpeningId(null);
      onNotify(describeError(failure));
    });
  };

  return <section ref={pageRef} className="person-view" tabIndex={-1}
    aria-label={t("person.label", { name: displayName })}>
    <ArtworkProximity scroller={pageRef}>
      <header className="person-head">
        <span className="person-portrait">{photo
          ? <img src={photo} alt="" onError={hideBroken}/>
          : displayName.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word.charAt(0)).join("").toLocaleUpperCase()}</span>
        <h2>{displayName}</h2>
        <button type="button" className="person-back" onClick={onBack}><ChevronLeft/> {t("person.back")}</button>
      </header>
      {loading && <p className="person-status" role="status">{t("person.loading")}</p>}
      {error && <div className="person-status" role="alert">
        <p>{error}</p>
        <button type="button" onClick={() => setRetry((value) => value + 1)}>{t("person.retry")}</button>
      </div>}
      {!loading && !error && filmography && filmography.sections.length === 0 && <p className="person-status">{t("person.empty")}</p>}
      {!loading && !error && filmography?.sections.map((section) =>
        <PersonSection key={section.key} section={section} shape={shape} openingId={openingId} onOpen={openTitle}/>)}
    </ArtworkProximity>
  </section>;
}

function PersonSection({ section, shape, openingId, onOpen }: {
  section: PersonFilmography["sections"][number];
  shape: TileShape;
  openingId: string | null;
  onOpen: (title: PersonTitle) => void;
}) {
  const [shown, setShown] = useState(() =>
    typeof IntersectionObserver === "undefined" ? section.titles.length : Math.min(PAGE, section.titles.length));
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      setShown(section.titles.length);
      return;
    }
    setShown(Math.min(PAGE, section.titles.length));
  }, [section.titles]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const node = sentinel.current;
    if (!node || shown >= section.titles.length) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setShown(section.titles.length);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [section.titles, shown]);

  const visible = section.titles.slice(0, shown);
  return <section className="person-section" data-section={section.key}>
    <h3>{t(section.key === "acting" ? "person.acting" : "person.crew")}</h3>
    <div className={`browse-grid following-grid tile-shape-${shape}`}>
      {visible.map((title) => {
        const key = `${title.type}:${title.id}:${title.tmdbId}`;
        const opening = openingId === `${title.type}:${title.id}`;
        const line = [title.year, t(title.type === "movie" ? "person.movie" : "person.series"), title.role]
          .filter((part) => Boolean(part && String(part).trim()))
          .join(" · ");
        return <button type="button" className="browse-item" key={key} disabled={opening} aria-busy={opening || undefined}
          onClick={() => onOpen(title)}>
          <span className="browse-art"><TileArt shape={shape} poster={title.poster} fallback={<Film/>}/></span>
          <strong>{title.name}</strong>
          {opening ? <small>{t("person.opening")}</small> : line ? <small>{line}</small> : null}
          {title.inLibrary ? <small className="in-library">{t("person.inLibrary")}</small> : null}
        </button>;
      })}
    </div>
    {shown < section.titles.length ? <div className="person-sentinel" ref={sentinel} data-section={section.key}/> : null}
  </section>;
}
