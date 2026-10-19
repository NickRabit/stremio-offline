import { useRef, useState } from "react";
import { ChevronRight, Download as DownloadIcon, Pause, Play, RectangleHorizontal, RectangleVertical, RefreshCw, Search } from "lucide-react";
import { api } from "./api";
import { Empty } from "./app-chrome";
import { bytes, speed, statusLabel } from "./download-format";
import { attentionCount, blocked, homeQueue, queueAction, queueGroup } from "./home-rows";
import type { ShowAllTarget } from "./home-cards";
import { homeAllRowsEmpty, homeCatalogShelves, homeFeedTitle, homeRowsFor, isHomeCatalogRow, type HomeRows } from "./home-state";
import { HomeShelf } from "./HomeShelf";
import type { HomeCardActions } from "./HomeCard";
import { t } from "./i18n";
import type { Download, LibraryView, TileShape } from "./types";
import type { HomeCard, HomeOrderEntry, HomeRowId } from "../../server/src/home";

const BLOCKED_KEY = { storage: "home.blocked.storage", library: "home.blocked.library", permission: "home.blocked.permission" } as const;
const ACTION_LABEL = { retry: "downloads.retry", resume: "library.continue", pause: "player.pause", open: "nav.downloads" } as const;
const ACTION_ICON = { retry: <RefreshCw />, resume: <Play />, pause: <Pause />, open: <ChevronRight /> };

function stateOf(job: Download): { text: string; tone: string } {
  if (blocked(job)) {
    const key = job.pauseReason === "storage" || job.pauseReason === "library" || job.pauseReason === "permission" ? BLOCKED_KEY[job.pauseReason] : "home.blocked.library";
    return { text: t(key), tone: "warn" };
  }
  return { text: statusLabel(job.status), tone: job.status === "failed" ? "bad" : job.status === "downloading" ? "run" : "" };
}

/** Bytes received over the size when the size is known, the rate while it runs, and never an
 *  estimate the queue did not state. */
function metaOf(job: Download): string {
  const parts: string[] = [];
  if (job.total != null) parts.push(`${bytes(job.received)} / ${bytes(job.total)}`);
  if (job.status === "downloading") parts.push(speed(job.speed));
  return parts.join(" · ");
}

const percentOf = (job: Download) => job.total != null && job.total > 0 ? Math.min(100, (job.received / job.total) * 100) : null;

export function Home({ jobs, addons, admin, onShowDownloads, onAction, rows, order, shape, onToggleShape, onRetry, onShowAll, onPlay, onOpenCatalogue, onShuffle, onVisible, onOpenCatalog, onReveal, onForgotten, onError, onOpenSearch }: {
  jobs: Download[];
  libraries: LibraryView[];
  addons: import("./types").Addon[];
  onShowDownloads: () => void;
  onAction: (job: Download, action: "pause" | "resume" | "retry") => Promise<void>;
  admin: boolean;
  rows: HomeRows;
  /** The shelves the server says this account has, in its own order. Until the first answer
   *  arrives the page draws the addon feeds this client knows about. */
  order?: HomeOrderEntry[];
  shape: TileShape;
  onToggleShape: () => void;
  onRetry: (row: HomeRowId) => void;
  onShowAll: (target: ShowAllTarget) => void;
  onPlay: (card: HomeCard) => void;
  onOpenCatalogue: (card: HomeCard) => void;
  onShuffle: (row: HomeRowId, shuffle: number) => void;
  /** An addon shelf neared the screen and should load. */
  onVisible?: (row: HomeRowId) => void;
  /** An addon shelf's heading was chosen: show its catalogue in full. */
  onOpenCatalog?: (row: HomeRowId) => void;
  onReveal: (path: string) => void;
  onForgotten: () => void;
  onError: (error: unknown) => void;
  onOpenSearch?: () => void;
}) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const shuffleCount = useRef<Record<string, number>>({});
  const latest = useRef({
    onShowDownloads, onAction, onRetry, onShowAll, onPlay, onOpenCatalogue, onShuffle,
    onVisible, onOpenCatalog, onReveal, onForgotten, onError,
  });
  latest.current = {
    onShowDownloads, onAction, onRetry, onShowAll, onPlay, onOpenCatalogue, onShuffle,
    onVisible, onOpenCatalog, onReveal, onForgotten, onError,
  };
  // Stable per row, so a shelf's observer and cards are not rebuilt on every render.
  const rowCallbacks = useRef(new Map<HomeRowId, { shuffle: () => void; visible: () => void; open: () => void }>());
  const actions = useRef<HomeCardActions>({
    play: (card) => latest.current.onPlay(card),
    open: (card) => latest.current.onOpenCatalogue(card),
    reveal: (path) => latest.current.onReveal(path),
    forget: (card) => {
      if (card.kind === "remote") {
        if (!window.confirm(t("home.forgetConfirm", { title: card.title }))) return;
        // Forgetting a remote card clears its position only; the favourite and watched flags stay.
        void api.saveRemoteState(card.libraryId, card.itemId, { position: 0, duration: 0 }).then(latest.current.onForgotten, latest.current.onError);
        return;
      }
      if (card.kind !== "resume-file" && card.kind !== "resume-catalogue") return;
      if (!window.confirm(t("home.forgetConfirm", { title: card.title }))) return;
      void api.forgetManyProgress(card.forgetKeys).then(latest.current.onForgotten, latest.current.onError);
    },
  }).current;
  const retry = useRef((row: HomeRowId) => latest.current.onRetry(row)).current;
  const showAll = useRef((target: ShowAllTarget) => latest.current.onShowAll(target)).current;
  const callbacksOf = (row: HomeRowId) => {
    let callbacks = rowCallbacks.current.get(row);
    if (!callbacks) {
      callbacks = {
        shuffle: () => {
          shuffleCount.current[row] = (shuffleCount.current[row] ?? 0) + 1;
          latest.current.onShuffle(row, shuffleCount.current[row]!);
        },
        visible: () => latest.current.onVisible?.(row),
        open: () => latest.current.onOpenCatalog?.(row),
      };
      rowCallbacks.current.set(row, callbacks);
    }
    return callbacks;
  };
  const catalogTitles = new Map(homeCatalogShelves(addons).map((shelf) => [shelf.id, homeFeedTitle(shelf.id, shelf.title)]));
  for (const entry of order ?? []) if (entry.title) catalogTitles.set(entry.id, homeFeedTitle(entry.id, entry.title));
  const askedRows = order?.length ? order.map((entry) => entry.id) : homeRowsFor(admin, addons);
  const items = homeQueue(jobs);
  const attention = attentionCount(jobs);
  const cards = items.filter((job) => queueGroup(job) === "attention");
  // A personal layout can hide `confirm`; the server then builds no row for it, so the chip
  // and its error line follow the order rather than a row the account no longer shows.
  const confirm = askedRows.includes("confirm") ? rows.confirm : undefined;

  const heading = <div className="heading home-heading">
    <div className="home-heading-copy"><small>{t("home.eyebrow")}</small><h2>{t("home.title")}</h2></div>
    <div className="home-heading-actions">
      {confirm?.status === "ok" && (confirm.total ?? 0) > 0 && <button className="home-confirm-chip" onClick={() => onShowAll("confirm")}>{t("home.confirmChip", { count: confirm.total ?? 0 })}</button>}
      {onOpenSearch && <button type="button" className="home-search-action" onClick={onOpenSearch}><Search/> {t("searchAll.homeAction")}</button>}
      <button className="shape-toggle" title={t(shape === "wide" ? "home.shapePoster" : "home.shapeWide")} aria-pressed={shape === "wide"} onClick={onToggleShape}>{shape === "wide" ? <RectangleVertical/> : <RectangleHorizontal/>}</button>
    </div>
  </div>;

  const confirmError = confirm?.status === "error"
    ? <div className="home-note bad"><span>{t("home.rowFailed")}</span><button className="home-retry" onClick={() => onRetry("confirm")}>{t("home.retry")}</button></div>
    : null;

  if (!items.length && homeAllRowsEmpty(rows, askedRows)) return <>{heading}{confirmError}<Empty icon={<DownloadIcon/>} title={t("home.emptyTitle")} text={t("home.emptyText")}/></>;

  const run = (job: Download, action: ReturnType<typeof queueAction>) => {
    if (action === "open") { latest.current.onShowDownloads(); return; }
    setBusy((current) => new Set(current).add(job.id));
    void latest.current.onAction(job, action)
      .catch(() => undefined)
      .finally(() => setBusy((current) => { const next = new Set(current); next.delete(job.id); return next; }));
  };

  const summary = [t("home.downloadsSummary", { count: items.length }), attention > 0 ? t("home.attention", { count: attention }) : ""].filter(Boolean).join(" · ");
  return <>
    {heading}
    {confirmError}
    {askedRows.filter((row) => row !== "confirm").map((row) => <HomeShelf key={row} row={row} title={catalogTitles.get(row)} state={rows[row]} shape={shape} actions={actions} onRetry={retry} onShowAll={showAll} onShuffle={row === "tonight" || isHomeCatalogRow(row) ? callbacksOf(row).shuffle : undefined} onVisible={onVisible && isHomeCatalogRow(row) ? callbacksOf(row).visible : undefined} onOpenCatalog={onOpenCatalog && isHomeCatalogRow(row) ? callbacksOf(row).open : undefined}/>)}
    {items.length > 0 && <section className="home-row">
      <div className="subhead">
        <div className="home-head"><h3>{t("home.downloads")}</h3><span className="count">{summary}</span></div>
        <button className="resume-show-all" onClick={() => latest.current.onShowDownloads()}>{t("library.showAll")}<ChevronRight/></button>
      </div>
      {cards.length > 0 && <div className="hq">
        {cards.map((job) => {
          const { text, tone } = stateOf(job);
          const action = queueAction(job);
          const percent = percentOf(job);
          return <div className={`hq-card${queueGroup(job) === "attention" ? job.status === "failed" ? " failed" : " attention" : ""}`} key={job.id}>
            <button className="hq-title" title={job.title} onClick={() => latest.current.onShowDownloads()}>{job.title}</button>
            <div className={`hq-state ${tone}`}>{text}</div>
            <div className={`hq-bar ${tone}`}>{percent != null && <i style={{ width: `${percent}%` }}/>}</div>
            <div className="hq-foot">
              <span className="hq-meta">{metaOf(job)}</span>
              <button title={t(`home.action.${action}`, { title: job.title })} aria-label={t(`home.action.${action}`, { title: job.title })} disabled={busy.has(job.id)} onClick={() => run(job, action)}>{ACTION_ICON[action]}{t(ACTION_LABEL[action])}</button>
            </div>
          </div>;
        })}
      </div>}
    </section>}
  </>;
}
