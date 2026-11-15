import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronLeft, Search } from "lucide-react";
import { api, ApiError, describeError } from "./api";
import { ShapeToggle } from "./app-chrome";
import { t, useI18n } from "./i18n";
import { SearchTile } from "./SearchEverywhere";
import { Heading, hideBroken } from "./settings-ui";
import type { PersonFilmography, PersonTitle, TileShape } from "./types";

const PAGE = 40;
const PLACEHOLDERS = 12;

export type PersonOpenTitle = {
  type: "movie" | "series";
  id: string;
  name: string;
  poster?: string;
};

type KindFilter = "all" | "movie" | "series";

const KINDS = [
  ["all", "searchAll.kindAll"],
  ["movie", "searchAll.kindMovies"],
  ["series", "searchAll.kindSeries"],
] as const;

export function PersonView({ person, language, shape, initialScroll, fromTitle, backLabel, onBack, onUnavailable, onOpenTitle, onNotify, onSearchText, onToggleShape }: {
  person: { id: number; name: string };
  language: string;
  shape: TileShape;
  initialScroll?: number;
  fromTitle?: string;
  backLabel?: string;
  onBack: () => void;
  onUnavailable: (name: string) => void;
  onOpenTitle: (title: PersonOpenTitle, notice?: "noImdb") => void;
  onNotify: (text: string) => void;
  onSearchText: (query: string) => void;
  onToggleShape: () => void;
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
  const [query, setQuery] = useState(person.name);
  const [kind, setKind] = useState<KindFilter>("all");
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
  const sections = (filmography?.sections ?? [])
    .map((section) => ({ ...section, titles: section.titles.filter((title) => kind === "all" || title.type === kind) }))
    .filter((section) => section.titles.length > 0);
  const answerEmpty = filmography != null && filmography.sections.every((section) => section.titles.length === 0);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const text = query.trim();
    if (text) onSearchText(text);
  };

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
      <button type="button" className="search-return" onClick={onBack}>
        <ChevronLeft/> {backLabel ?? (fromTitle ? t("person.backTo", { title: fromTitle }) : t("person.back"))}
      </button>
      <Heading eyebrow={t("searchAll.eyebrow")} title={t("searchAll.title")}/>
      <form className="search-everywhere-form" role="search" onSubmit={submitSearch}>
        <div className="search-input">
          <Search/>
          <input aria-label={t("searchAll.placeholder")} autoComplete="off" placeholder={t("searchAll.placeholder")}
            value={query} onChange={(event) => setQuery(event.target.value)}/>
        </div>
        <button className="primary" type="submit"><Search/> {t("searchAll.submit")}</button>
      </form>
      <div className="filterbar section-filter search-filters">
        <div className="search-filter-group">
          <span aria-hidden="true">{t("catalog.type")}</span>
          <div className="library-shelf-segments" role="group" aria-label={t("catalog.type")}>
            {KINDS.map(([value, key]) => <button key={value} type="button" className={kind === value ? "active" : ""} aria-pressed={kind === value}
              onClick={() => setKind(value)}>{t(key)}</button>)}
          </div>
        </div>
        <ShapeToggle shape={shape} onToggle={onToggleShape}/>
      </div>
      <div className="person-card">
        {photo
          ? <img src={photo} alt="" onError={hideBroken}/>
          : <span aria-hidden="true"/>}
        <div>
          <h2>{displayName}</h2>
          {filmography && <p>{t(filmography.knownFor === "acting" ? "person.acting" : "person.crew")} · {t("person.titleCount", { count: filmography.total })}</p>}
        </div>
        {filmography && <button type="button" className="person-text-search" onClick={() => onSearchText(filmography.name)}><Search/> {t("person.searchAsText", { name: filmography.name })}</button>}
      </div>
      {loading && <div className={`browse-grid section-grid search-results tile-shape-${shape}`} aria-hidden="true">
        {Array.from({ length: PLACEHOLDERS }, (_, index) => <div className="browse-item" key={index}>
          <span className="browse-art person-placeholder"/>
        </div>)}
      </div>}
      {error && <p className="search-error" role="alert">
        {error} <button type="button" onClick={() => setRetry((value) => value + 1)}>{t("person.retry")}</button>
      </p>}
      {answerEmpty && <p className="search-empty">{t("person.empty")}</p>}
      {!loading && !error && sections.map((section) =>
        <PersonSection key={section.key} section={section} shape={shape} openingId={openingId} onOpen={openTitle}/>)}
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
  const label = t(section.key === "acting" ? "person.acting" : "person.crew");
  return <section data-section={section.key}>
    <h3>{label} <span>{section.titles.length}</span></h3>
    <div className={`browse-grid section-grid search-results tile-shape-${shape}`}>
      {visible.map((title) => {
        const opening = openingId === `${title.type}:${title.id}`;
        const caption = opening
          ? t("person.opening")
          : [title.year, t(title.type === "movie" ? "person.movie" : "person.series"), ...(title.jobs ?? []).map((job) => t(`detail.role.${job}`)), title.character]
            .filter(Boolean).join(" · ");
        return <SearchTile key={`${title.type}:${title.id}:${title.tmdbId}`} title={title.name} poster={title.poster} background={title.background}
          caption={caption} shape={shape} local={title.inLibrary === true} busy={opening} onClick={() => onOpen(title)}/>;
      })}
    </div>
    {shown < section.titles.length ? <div className="person-sentinel" ref={sentinel} data-section={section.key}/> : null}
  </section>;
}
