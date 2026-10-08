import { useState } from "react";
import { ChevronRight, Download as DownloadIcon, Pause, Play, RefreshCw } from "lucide-react";
import { Empty } from "./app-chrome";
import { bytes, speed, statusLabel } from "./download-format";
import { attentionCount, blocked, homeQueue, queueAction, queueGroup } from "./home-rows";
import { t } from "./i18n";
import { Heading } from "./settings-ui";
import type { Download, LibraryView } from "./types";

const BLOCKED_KEY = { storage: "home.blocked.storage", library: "home.blocked.library", permission: "home.blocked.permission" } as const;
const ACTION_LABEL = { retry: "downloads.retry", resume: "library.continue", pause: "player.pause", open: "home.openDownloads" } as const;
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

export function Home({ jobs, onShowDownloads, onAction }: {
  jobs: Download[];
  libraries: LibraryView[];
  onShowDownloads: () => void;
  onAction: (job: Download, action: "pause" | "resume" | "retry") => Promise<void>;
  admin: boolean;
}) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const items = homeQueue(jobs);
  const attention = attentionCount(jobs);

  if (!items.length) return <><Heading eyebrow={t("home.eyebrow")} title={t("home.title")}/><Empty icon={<DownloadIcon/>} title={t("home.emptyTitle")} text={t("home.emptyText")}/></>;

  const run = (job: Download, action: ReturnType<typeof queueAction>) => {
    if (action === "open") { onShowDownloads(); return; }
    setBusy((current) => new Set(current).add(job.id));
    void onAction(job, action)
      .catch(() => undefined)
      .finally(() => setBusy((current) => { const next = new Set(current); next.delete(job.id); return next; }));
  };

  const summary = [t("home.downloadsSummary", { count: items.length }), attention > 0 ? t("home.attention", { count: attention }) : ""].filter(Boolean).join(" · ");
  return <>
    <Heading eyebrow={t("home.eyebrow")} title={t("home.title")}/>
    <section className="home-row">
      <div className="subhead">
        <div className="home-head"><h3>{t("home.downloads")}</h3><span className="count">{summary}</span></div>
        <button className="resume-show-all" onClick={onShowDownloads}>{t("library.showAll")}<ChevronRight/></button>
      </div>
      <div className="hq">
        {items.map((job) => {
          const { text, tone } = stateOf(job);
          const action = queueAction(job);
          const percent = percentOf(job);
          return <div className={`hq-card${queueGroup(job) === "attention" ? job.status === "failed" ? " failed" : " attention" : ""}`} key={job.id}>
            <button className="hq-title" title={job.title} onClick={onShowDownloads}>{job.title}</button>
            <div className={`hq-state ${tone}`}>{text}</div>
            <div className={`hq-bar ${tone}`}>{percent != null && <i style={{ width: `${percent}%` }}/>}</div>
            <div className="hq-foot">
              <span className="hq-meta">{metaOf(job)}</span>
              <button title={t(`home.action.${action}`, { title: job.title })} aria-label={t(`home.action.${action}`, { title: job.title })} disabled={busy.has(job.id)} onClick={() => run(job, action)}>{ACTION_ICON[action]}{t(ACTION_LABEL[action])}</button>
            </div>
          </div>;
        })}
      </div>
    </section>
  </>;
}
