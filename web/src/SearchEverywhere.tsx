import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Film, FolderOpen, HardDrive, Search, X } from "lucide-react";
import { describeError } from "./api";
import { ShapeToggle } from "./app-chrome";
import { TileArt } from "./TileArt";
import { useDialogFocus } from "./dialog-focus";
import { useDialogViewport } from "./dialog-viewport";
import { t, type Key } from "./i18n";
import { parseSearchScope } from "./search-scope";
import { SearchScopeOptions } from "./SearchScopeOptions";
import { Heading } from "./settings-ui";
import type {
  SearchClusterView,
  SearchMember,
  SearchMemberPage,
  SearchableCatalog,
  SearchSourceClass,
  SearchSourceState,
  TileShape,
} from "./types";
import type { SearchEverywhereController } from "./useSearchEverywhere";

const STATE_KEY: Record<SearchSourceState, Key> = {
  queued: "searchAll.state.queued",
  loading: "searchAll.state.loading",
  ready: "searchAll.state.ready",
  exhausted: "searchAll.state.exhausted",
  stalled: "searchAll.state.stalled",
  failed: "searchAll.state.failed",
  timedOut: "searchAll.state.timedOut",
  indexing: "searchAll.state.indexing",
  unavailable: "searchAll.state.unavailable",
};

const SOURCE_OPTIONS: Array<{ value: SearchSourceClass | "all"; label: Key }> = [
  { value: "all", label: "searchAll.sourceAll" },
  { value: "catalog", label: "searchAll.sourceCatalog" },
  { value: "local", label: "searchAll.sourceLocal" },
  { value: "remote", label: "searchAll.sourceRemote" },
];

const kindLabel = (kind: SearchClusterView["kind"]): string => {
  if (kind === "movie") return t("catalog.oneMovie");
  if (kind === "series") return t("catalog.oneSeries");
  if (kind === "episode") return t("mediaServer.type.episode");
  if (kind === "season") return t("mediaServer.type.season");
  if (kind === "folder") return t("mediaServer.type.folder");
  return t("mediaServer.tabFiles");
};

const episodeText = (member: SearchMember): string | null => {
  if (member.season == null || member.episode == null) return null;
  if (member.episodeEnd != null && member.episodeEnd > member.episode) {
    return t("searchAll.episodeRange", { season: member.season, episode: member.episode, end: member.episodeEnd });
  }
  return t("searchAll.episodeLabel", { season: member.season, episode: member.episode });
};

/** One title, the way every other grid draws one: its picture, its name and a caption. A list is
 *  about titles, not about sources, so no card names the addon or library it came from; a copy
 *  that is already in a library only earns a small mark. */
function SearchCard({ cluster, shape, onInteract, onOpen }: {
  cluster: SearchClusterView;
  shape: TileShape;
  onInteract: () => void;
  onOpen: (button: HTMLButtonElement) => void;
}) {
  const caption = [
    cluster.year,
    kindLabel(cluster.kind),
    cluster.episodeCount ? t("searchAll.episodes", { count: cluster.episodeCount }) : undefined,
  ].filter(Boolean).join(" · ");
  const folder = cluster.kind === "folder";
  return <button type="button" className="browse-item" title={cluster.title} data-search-card data-primary-member={cluster.primaryMemberKey}
    data-member-keys={cluster.memberKeys.join(" ")} onFocus={onInteract}
    onClick={(event) => { onInteract(); onOpen(event.currentTarget); }}>
    <span className="browse-art">
      <TileArt shape={shape} poster={cluster.poster} wide={cluster.background} fallback={folder ? <FolderOpen/> : <Film/>}/>
      {cluster.hasLocal && <i className="fav-mark" title={t("searchAll.badgeLocal")} aria-label={t("searchAll.badgeLocal")}><HardDrive/></i>}
    </span>
    <strong>{cluster.title}</strong>
    <small>{caption}</small>
  </button>;
}

/** One addon answers the same title from several of its catalogues; the chooser lists it once. */
const distinctMembers = (members: SearchMember[]): SearchMember[] => {
  const seen = new Set<string>();
  return members.filter((member) => {
    if (member.locator.kind !== "catalog") return true;
    const key = `${member.locator.addonKey}|${member.locator.type}|${member.locator.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
const addonLabel = (member: SearchMember): string =>
  member.locator.kind === "catalog" ? member.sourceLabel.split(" · ")[0]! : member.sourceLabel;

function MemberChooser({ cluster, members, anchorKey, onOpenMember, onOpenCanonical, onClose }: {
  cluster: SearchClusterView;
  members: SearchEverywhereController["members"];
  anchorKey: string;
  onOpenMember: (member: SearchMember, anchorKey: string, libraryFirst?: boolean) => Promise<void> | void;
  onOpenCanonical: (canonical: NonNullable<SearchMemberPage["canonical"]>, anchorKey: string, libraryFirst?: boolean) => Promise<void> | void;
  onClose: () => void;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<SearchMemberPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [canonicalError, setCanonicalError] = useState<string | null>(null);
  useDialogFocus(overlay);
  useDialogViewport(overlay);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void members(cluster.primaryMemberKey).then((answer) => {
      if (!live) return;
      setPage(answer);
      setLoadError(null);
    }).catch((error: unknown) => {
      if (live) setLoadError(describeError(error));
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => { live = false; };
  }, [cluster.primaryMemberKey, members]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const loadMore = async () => {
    if (page?.nextFrom == null) return;
    setLoading(true);
    try {
      const next = await members(cluster.primaryMemberKey, page.nextFrom);
      setPage((current) => current ? {
        ...next,
        members: [...current.members, ...next.members],
      } : next);
      setLoadError(null);
    } catch (error) {
      setLoadError(describeError(error));
    } finally {
      setLoading(false);
    }
  };

  const open = async (member: SearchMember) => {
    setBusy(member.memberKey);
    setRowErrors((current) => {
      const next = { ...current };
      delete next[member.memberKey];
      return next;
    });
    try {
      const libraryFirst = cluster.hasLocal || cluster.hasRemote;
      if (libraryFirst) await onOpenMember(member, member.memberKey, true);
      else await onOpenMember(member, member.memberKey);
    } catch (error) {
      setRowErrors((current) => ({ ...current, [member.memberKey]: describeError(error) }));
    } finally {
      setBusy(null);
    }
  };

  const openCanonical = async () => {
    if (!page?.canonical) return;
    setBusy("canonical");
    setCanonicalError(null);
    try {
      const libraryFirst = cluster.hasLocal || cluster.hasRemote;
      if (libraryFirst) await onOpenCanonical(page.canonical, anchorKey, true);
      else await onOpenCanonical(page.canonical, anchorKey);
    } catch (error) {
      setCanonicalError(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  return createPortal(<div ref={overlay} tabIndex={-1} className="identify-overlay" role="dialog" aria-modal="true"
    aria-label={t("searchAll.chooserTitle", { title: cluster.title })}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="panel identify-card dialog-split search-chooser">
      <div className="identify-head">
        <h2>{t("searchAll.chooserTitle", { title: cluster.title })}</h2>
        <button type="button" className="icon-button" aria-label={t("common.close")} onClick={onClose}><X/></button>
      </div>
      <div className="dialog-body">
        {loadError && <p className="login-error" role="alert">{loadError}</p>}
        {loading && !page && <p className="search-chooser-note">{t("common.loading")}</p>}
        {page && <div className="search-member-list">
          {distinctMembers(page.members).map((member) => {
            const episode = episodeText(member);
            return <div className="search-member-row" key={member.memberKey}>
              <div className="search-member-copy">
                <strong>{member.title}</strong>
                <span>{[member.year, episode].filter((value) => value != null).join(" · ")}</span>
                <small>{addonLabel(member)}</small>
                {member.conflict && <em>{t("searchAll.conflict")}</em>}
                {rowErrors[member.memberKey] && <p className="login-error" role="alert">{rowErrors[member.memberKey]}</p>}
              </div>
              <button type="button" disabled={busy !== null} onClick={() => void open(member)}>{t("searchAll.openMember")}</button>
            </div>;
          })}
        </div>}
        {page?.nextFrom != null && <div className="load-more">
          <button type="button" disabled={loading} onClick={() => void loadMore()}>
            {loading ? t("common.loadingMore") : t("searchAll.loadMore")}
          </button>
        </div>}
        {page?.canonical && <div className="search-title-page">
          <button type="button" disabled={busy !== null} onClick={() => void openCanonical()}>{t("searchAll.openTitlePage")}</button>
          {canonicalError && <p className="login-error" role="alert">{canonicalError}</p>}
        </div>}
      </div>
      <footer className="dialog-foot"><button type="button" onClick={onClose}>{t("common.close")}</button></footer>
    </div>
  </div>, document.body);
}

export function SearchEverywhere({ search, shape, onToggleShape, searchable, onOpenMember, onOpenCanonical }: {
  search: SearchEverywhereController;
  shape: TileShape;
  onToggleShape: () => void;
  searchable: SearchableCatalog[];
  onOpenMember: (member: SearchMember, anchorKey: string, libraryFirst?: boolean) => Promise<void> | void;
  onOpenCanonical: (canonical: NonNullable<SearchMemberPage["canonical"]>, anchorKey: string, libraryFirst?: boolean) => Promise<void> | void;
}) {
  const root = useRef<HTMLElement>(null);
  const previousPosition = useRef(0);
  const composing = useRef(false);
  const membersRef = useRef(search.members);
  membersRef.current = search.members;
  const members = useCallback((memberKey: string, from = 0) => membersRef.current(memberKey, from), []);
  const [chooser, setChooser] = useState<SearchClusterView | null>(null);
  const clusters = useMemo(() => new Map((search.snapshot?.clusters ?? []).map((cluster) => [cluster.key, cluster])), [search.snapshot]);
  const unidentified = useMemo(() => new Map((search.snapshot?.unidentified ?? []).map((cluster) => [cluster.key, cluster])), [search.snapshot]);
  const mainCards = search.order.flatMap((key) => {
    const cluster = clusters.get(key);
    return cluster ? [cluster] : [];
  });
  const unidentifiedCards = search.unidentifiedOrder.flatMap((key) => {
    const cluster = unidentified.get(key);
    return cluster ? [cluster] : [];
  });
  const waiting = search.committed
    ? search.snapshot?.sources.filter((source) => source.state === "queued" || source.state === "loading" || source.state === "indexing").length
      ?? (search.sources.length || 3)
    : 0;
  const canLoadMore = search.snapshot?.sources.some((source) => source.hasMore) ?? false;
  const busy = Boolean(search.committed) && (!search.snapshot || search.previousQuery);

  // Further pages arrive as the viewer nears the end, the way every other grid fills. The page
  // itself scrolls here, so the window's position decides; a source already loading is not asked
  // again, which keeps one scroll from stacking requests.
  const tail = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef(search.loadMore);
  loadMoreRef.current = search.loadMore;
  const markInteractedRef = useRef(search.markInteracted);
  markInteractedRef.current = search.markInteracted;
  const ready = canLoadMore && waiting === 0 && !search.previousQuery;
  useEffect(() => {
    if (!ready) return;
    const check = (byScroll: boolean) => {
      const element = tail.current;
      if (!element) return;
      const margin = Math.min(600, window.innerHeight);
      if (element.getBoundingClientRect().top <= window.innerHeight + margin) {
        if (byScroll) markInteractedRef.current();
        loadMoreRef.current();
      }
    };
    check(false);
    const onScroll = () => check(true);
    const onResize = () => check(false);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, [ready, search.snapshot?.revision]);

  useEffect(() => {
    const onScroll = () => {
      search.setScrollTop(window.scrollY);
      if (window.scrollY > 200) search.markInteracted();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [search.setScrollTop]);

  useEffect(() => {
    if (!search.focusAnchor || chooser) return;
    const cards = [...(root.current?.querySelectorAll<HTMLElement>("[data-search-card]") ?? [])];
    if (!cards.length) return;
    const found = cards.findIndex((card) => (card.dataset.memberKeys ?? "").split(" ").includes(search.focusAnchor!));
    const index = found >= 0 ? found : Math.min(previousPosition.current, cards.length - 1);
    const card = cards[index];
    if (!card) return;
    previousPosition.current = index;
    if (found < 0) search.setFocusAnchor(card.dataset.primaryMember ?? null);
    card.focus({ preventScroll: true });
  }, [search.focusAnchor, search.order, search.unidentifiedOrder, chooser]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!composing.current) search.submit();
  };

  /** A title with an id every source shares opens its one title page, which lists the library
   *  copies and the addon rows and picks among them by the usual rules. Only a title without such
   *  an id, gathered from several places, asks where to open it. */
  const openCluster = async (button: HTMLButtonElement, cluster: SearchClusterView) => {
    previousPosition.current = [...(root.current?.querySelectorAll<HTMLElement>("[data-search-card]") ?? [])].indexOf(button);
    const libraryFirst = cluster.hasLocal || cluster.hasRemote;
    try {
      const page = await members(cluster.primaryMemberKey);
      if (page.canonical) {
        if (libraryFirst) await onOpenCanonical(page.canonical, cluster.primaryMemberKey, true);
        else await onOpenCanonical(page.canonical, cluster.primaryMemberKey);
        return;
      }
      const distinct = distinctMembers(page.members);
      if (distinct.length === 1 && page.nextFrom == null) {
        if (libraryFirst) await onOpenMember(distinct[0]!, distinct[0]!.memberKey, true);
        else await onOpenMember(distinct[0]!, distinct[0]!.memberKey);
        return;
      }
    } catch { /* the chooser reports what failed */ }
    search.markInteracted();
    setChooser(cluster);
  };

  const catalogOnly = search.sources.length === 1 && search.sources[0] === "catalog";
  const scopeValue = search.scope?.catalogId && search.scope.catalogType
    ? `catalog:${search.scope.addonKey}:${search.scope.catalogType}:${search.scope.catalogId}`
    : search.scope?.addonKey ? `addon:${search.scope.addonKey}` : "";
  const chooseScope = (value: string) => {
    const next = parseSearchScope(value);
    search.setScope(next.addonKey ? {
      addonKey: next.addonKey,
      ...(next.catalogType ? { catalogType: next.catalogType } : {}),
      ...(next.catalogId ? { catalogId: next.catalogId } : {}),
    } : null);
  };

  return <section className="search-everywhere" ref={root}>
    <Heading eyebrow={t("searchAll.eyebrow")} title={t("searchAll.title")}/>
    <form className="search-everywhere-form" role="search" onSubmit={submit}>
      <div className="search-input">
        <Search/>
        <input data-search-input role="searchbox" autoComplete="off" aria-label={t("searchAll.placeholder")}
          placeholder={t("searchAll.placeholder")} value={search.draft}
          onChange={(event) => search.setDraft(event.target.value)}
          onCompositionStart={() => { composing.current = true; search.compositionStart(); }}
          onCompositionEnd={(event) => { composing.current = false; search.compositionEnd(event.currentTarget.value); }}/>
      </div>
      <button className="primary" type="submit"><Search/> {t("searchAll.submit")}</button>
      {search.committed && <button type="button" onClick={search.clear}><X/> {t("common.cancel")}</button>}
    </form>
    <div className="filterbar section-filter search-filters">
      <div className="library-shelf-segments" role="group" aria-label={t("searchAll.sourcesToggle")}>
        {SOURCE_OPTIONS.map((option) => {
          const active = option.value === "all" ? search.sources.length === 0 : search.sources.length === 1 && search.sources[0] === option.value;
          return <button key={option.value} type="button" className={active ? "active" : ""} aria-pressed={active}
            onClick={() => search.setSources(option.value === "all" ? [] : [option.value])}>{t(option.label)}</button>;
        })}
      </div>
      {catalogOnly && <label><span>{t("catalog.searchScope")}</span>
        <select aria-label={t("catalog.searchScope")} value={scopeValue} onChange={(event) => chooseScope(event.target.value)}>
          <SearchScopeOptions searchable={searchable}/>
        </select>
      </label>}
      <div className="library-shelf-segments" role="group" aria-label={t("catalog.type")}>
        {([
          ["all", "searchAll.kindAll"],
          ["movie", "searchAll.kindMovies"],
          ["series", "searchAll.kindSeries"],
        ] as const).map(([value, key]) => <button key={value} type="button" className={search.kind === value ? "active" : ""} aria-pressed={search.kind === value}
          onClick={() => search.setKind(value)}>{t(key)}</button>)}
      </div>
      <ShapeToggle shape={shape} onToggle={onToggleShape}/>
    </div>
    <div className="search-source-strip">
      <div className="search-source-summary" aria-live="polite" role="status">
        {waiting > 0 ? t("searchAll.statusLoading", { count: waiting }) : t("searchAll.statusDone")}
      </div>
      <details>
        <summary>{t("searchAll.sourcesToggle")}</summary>
        <div className="search-source-list">
          {(search.snapshot?.sources ?? []).map((source) => <div className={`search-source-state${source.stale ? " stale" : ""}`} key={source.id}>
            <strong>{source.label}</strong>
            <span>{t(STATE_KEY[source.state])}</span>
            {source.stale && <small>{t("searchAll.stale")}</small>}
            {source.errorCode && <small className="search-source-error">{source.errorCode}</small>}
            {source.retryable && <button type="button" onClick={() => search.retry(source.id)}>{t("searchAll.retry")}</button>}
          </div>)}
        </div>
      </details>
    </div>
    {search.error && <p className="search-error" role="alert">{search.error}</p>}
    {search.previousQuery && <p className="search-previous-label">{t("searchAll.previousQuery")}</p>}
    <div className={`browse-grid section-grid search-results tile-shape-${shape}${search.previousQuery ? " previous-query" : ""}`} aria-busy={busy || undefined}>
      {mainCards.map((cluster) => <SearchCard key={cluster.key} cluster={cluster} shape={shape}
        onInteract={search.markInteracted} onOpen={(button) => void openCluster(button, cluster)}/>)}
      {search.snapshot && !busy && !mainCards.length && !unidentifiedCards.length && <p className="search-empty">{t("searchAll.empty")}</p>}
    </div>
    {(canLoadMore || waiting > 0) && search.snapshot && <div ref={tail} className="load-more" aria-hidden="true">
      {waiting > 0 && <span>{t("common.loadingMore")}</span>}
    </div>}
    {search.snapshot?.limitReached && <p className="search-limit">{t("searchAll.limitReached")}</p>}
    {unidentifiedCards.length > 0 && <details className="search-unidentified">
      <summary>{t("searchAll.unidentified", { count: unidentifiedCards.length })}</summary>
      <div className={`browse-grid section-grid search-results tile-shape-${shape}`}>
        {unidentifiedCards.map((cluster) => <SearchCard key={cluster.key} cluster={cluster} shape={shape}
          onInteract={search.markInteracted} onOpen={(button) => void openCluster(button, cluster)}/>)}
      </div>
    </details>}
    {chooser && <MemberChooser cluster={chooser} members={members} anchorKey={search.focusAnchor ?? chooser.primaryMemberKey}
      onOpenMember={onOpenMember} onOpenCanonical={onOpenCanonical} onClose={() => setChooser(null)}/>}
  </section>;
}
