import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, HardDrive, Library, Pause, Play, RefreshCw, Trash2, X } from "lucide-react";
import { api } from "./api";
import { bytes, fmtEta, speed, statusLabel } from "./download-format";
import { label } from "./languages";
import { queueDestination } from "./queue-target";
import { Heading } from "./settings-ui";
import { localeTag, serverText, t, type Key } from "./i18n";
import type { Download as DownloadJob, DeviceTransfer, DownloadDateField, DownloadPageSize, DownloadSort, DownloadStatusFilter, DownloadsViewPrefs, LibraryOrder, LibraryView, QueueHalt } from "./types";

/** `admin` gates the controls the role gate refuses outright. Reordering the queue and
 *  clearing the completed list are instance-wide -- one queue, everybody's bandwidth -- so an
 *  ordinary account may pause, resume, retry and remove its own job and nothing else.
 *  Rendering the rest for it offers buttons whose only outcome is an error. */
export function Downloads({ jobs, deviceTransfers, libraries, halt, admin, refresh, onError, onReveal, prefs, onPrefs }: { jobs: DownloadJob[]; deviceTransfers: DeviceTransfer[]; libraries: LibraryView[]; halt: QueueHalt | null; admin: boolean; refresh: () => Promise<void>; onError: (e: unknown) => void; onReveal: (target: string) => void; prefs: DownloadsViewPrefs; onPrefs: (prefs: DownloadsViewPrefs) => void }) {
  const [expandedJobs, setExpandedJobs] = useState<Record<string, boolean>>({});
  const [completedOpen, setCompletedOpen] = useState(false);
  const [pendingPage, setPendingPage] = useState(1);
  const [completedPage, setCompletedPage] = useState(1);

  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { status, sort, direction, dateField, pageSize } = prefs;
  useEffect(() => { setPendingPage(1); setCompletedPage(1); }, [query, status, sort, direction, dateField, from, to, pageSize]);
  useEffect(() => { if (query.trim() || status === "completed" || from || to) setCompletedOpen(true); }, [query, status, from, to]);
  const duration = (job: DownloadJob) => job.startedAt && job.completedAt ? Math.max(0, Date.parse(job.completedAt) - Date.parse(job.startedAt)) : undefined;
  const filtered = jobs.filter((job) => {
    const date = job[dateField] ? new Date(job[dateField]!) : undefined;
    const day = date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` : "";
    return (!status || job.status === status) && `${job.title} ${job.target} ${queueDestination(job.target, libraries).library ?? ""}`.toLocaleLowerCase(localeTag()).includes(query.trim().toLocaleLowerCase(localeTag())) && (!from || !!day && day >= from) && (!to || !!day && day <= to);
  }).sort((a, b) => {
    const value = (job: DownloadJob) => sort === "duration" ? duration(job) : sort === "order" ? job.order : sort === "titleSort" ? job.title : job[sort as "createdAt" | "startedAt" | "completedAt"];
    const av = value(a), bv = value(b);
    if (av == null || bv == null) return av == null ? bv == null ? a.order - b.order : 1 : -1;
    const delta = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), localeTag());
    return delta * (direction === "asc" ? 1 : -1) || a.order - b.order;
  });
  const activeFilters = [query.trim(), status, from, to].filter(Boolean).length;
  const formatDate = (value?: string) => value ? new Date(value).toLocaleString(localeTag(), { dateStyle: "short", timeStyle: "short" }) : "—";
  const active = jobs.filter((job) => job.status === "checking" || job.status === "downloading"); const totalSpeed = active.reduce((sum, job) => sum + job.speed, 0); const eta = (job: DownloadJob) => job.speed > 0 && job.total ? fmtEta((job.total - job.received) / job.speed) : "—";
  const action = async (operation: () => Promise<void>) => { try { await operation(); await refresh(); } catch (error) { onError(error); } };
  const groups = {
    active: filtered.filter((job) => job.status === "checking" || job.status === "downloading"),
    pending: filtered.filter((job) => job.status !== "checking" && job.status !== "downloading" && job.status !== "completed"),
    completed: filtered.filter((job) => job.status === "completed"),
  };
  useEffect(() => setPendingPage((page) => Math.min(page, Math.max(1, Math.ceil(groups.pending.length / pageSize)))), [groups.pending.length, pageSize]);
  useEffect(() => setCompletedPage((page) => Math.min(page, Math.max(1, Math.ceil(groups.completed.length / pageSize)))), [groups.completed.length, pageSize]);
  const renderJob = (job: DownloadJob) => <div className={`download-row ${expandedJobs[job.id] ? "details-expanded" : ""}`} data-status={job.status} key={job.id}><div className="download-job"><div className="queue-job-title">{job.status === "completed" && job.target ? <button className="link-button job-link" title={t("downloads.showInLibrary")} onClick={() => onReveal(job.target)}><span>{job.title}</span></button> : <strong>{job.title}</strong>}{job.follow && <span className="follow-job-pill">{t("follow.autoJob")}</span>}</div><div id={`queue-details-${job.id}`} className="queue-job-details">{job.target ? <>{queueDestination(job.target, libraries).library && <small className="queue-job-library"><Library aria-hidden="true"/> {queueDestination(job.target, libraries).library}</small>}<small>{queueDestination(job.target, libraries).path}</small></> : <small>{job.pending ? t("downloads.sourcePickedLater") : ""}</small>}{job.resolution && (job.resolution.audioLanguage || job.resolution.audioEvidence === "none") && <small>{job.resolution.audioEvidence === "none" ? t("downloads.audioUnverified", { count: job.resolution.checkedCandidates }) : `${t(job.resolution.fallbackUsed ? "downloads.checkedFallbackSource" : "downloads.checkedSource", { audio: label(job.resolution.audioLanguage), count: job.resolution.checkedCandidates })}${job.resolution.audioEvidence === "listing" ? ` · ${t("downloads.audioFromListing")}` : ""}`}{job.resolution.subtitleLanguage ? ` · ${t("downloads.subtitleReady", { language: label(job.resolution.subtitleLanguage) })}` : job.resolution.subtitleStatus === "missing" ? ` · ${t("downloads.subtitleMissing")}` : ""}</small>}<dl className="queue-times">{(["createdAt", "startedAt", "completedAt"] as const).map((field) => <div key={field}><dt>{t(`downloads.${field}`)}</dt><dd>{formatDate(job[field])}</dd></div>)}<div><dt>{t("downloads.duration")}</dt><dd>{duration(job) == null ? "—" : t("downloads.durationValue", { hours: Math.floor(duration(job)! / 3600000), minutes: Math.floor(duration(job)! / 60000) % 60, seconds: Math.floor(duration(job)! / 1000) % 60 })}</dd></div></dl></div>{job.pauseReason === "library" && <small className="queue-job-paused">{t("downloads.pausedLibrary")}</small>}{job.error && <small className="queue-job-error">{serverText(job.errorKey, job.error, job.errorVars)}</small>}</div><span className={`job-status ${job.status}`}>{statusLabel(job.status)}</span><div className="download-progress"><span>{job.status === "waiting" ? `${job.debridProgress ?? 0} %` : `${bytes(job.received)} / ${bytes(job.total)}`}</span><div className="progress"><i style={{width:`${job.status === "waiting" ? Math.min(100, job.debridProgress ?? 0) : job.total ? Math.min(100, job.received/job.total*100):0}%`}}/></div></div><span className="download-speed">{speed(job.speed)}{job.segments && job.segments > 1 ? <i className="segment-tag" title={t("downloads.segments", { count: job.segments })}>{`\u00d7${job.segments}`}</i> : null}<small>{eta(job)}</small></span><div className="queue-actions"><button className="queue-details-toggle" aria-expanded={!!expandedJobs[job.id]} aria-controls={`queue-details-${job.id}`} onClick={() => setExpandedJobs((current) => ({ ...current, [job.id]: !current[job.id] }))}>{t("downloads.details")}<ChevronDown aria-hidden="true"/></button>{job.status === "completed" && job.target && <button title={t("downloads.showInLibrary")} onClick={() => onReveal(job.target)}><HardDrive/></button>}{admin && job.status !== "completed" && job.status !== "downloading" && job.status !== "checking" && <><button className="queue-priority" title={t("downloads.moveUp")} disabled={sort !== "order" || direction !== "asc" || job.order === 0} onClick={() => action(() => api.moveDownload(job.id, -1))}><ArrowUp/></button><button className="queue-priority" title={t("downloads.moveDown")} disabled={sort !== "order" || direction !== "asc" || job.order === jobs.length - 1} onClick={() => action(() => api.moveDownload(job.id, 1))}><ArrowDown/></button></>}{job.status === "checking" || job.status === "downloading" || job.status === "queued" || job.status === "waiting" ? <button title={t("player.pause")} onClick={() => action(() => api.downloadAction(job.id,"pause"))}><Pause/></button> : job.status === "paused" ? <button title={t("library.continue")} onClick={() => action(() => api.downloadAction(job.id,"resume"))}><Play/></button> : job.status === "failed" ? <button title={t("downloads.retry")} onClick={() => action(() => api.downloadAction(job.id,"retry"))}><RefreshCw/></button> : null}<button className="danger" title={t("downloads.removeFromQueue")} onClick={() => action(() => api.removeDownload(job.id))}><Trash2/></button></div></div>;
  return <section className="downloads-page"><div className="download-title"><Heading eyebrow={t("downloads.eyebrow")} title={t("downloads.title")}/>{admin && <button disabled={!jobs.some((job) => job.status === "completed")} onClick={() => action(api.clearCompleted)}><Trash2/> {t("downloads.clearCompleted")}</button>}</div>{halt && <div className="queue-halt" role="status">{serverText(halt.messageKey, halt.message)} {t("downloads.haltResumes")}</div>}<details className="queue-filters"><summary>{t("downloads.filters")}<span>{activeFilters > 0 && t("downloads.activeFilters", { count: activeFilters })}{sort !== "order" || direction !== "asc" ? ` · ${t(`downloads.${sort}` as Key)} (${t(direction === "asc" ? "downloads.asc" : "downloads.desc")})` : ""}</span><ChevronDown aria-hidden="true"/></summary><div className="queue-tools">
    <label>{t("downloads.search")}<input value={query} onChange={(e) => setQuery(e.target.value)}/></label>
    <label>{t("downloads.filterStatus")}<select value={status} onChange={(e) => onPrefs({ ...prefs, status: e.target.value as DownloadStatusFilter })}><option value="">{t("downloads.all")}</option>{(["queued", "waiting", "checking", "downloading", "paused", "completed", "failed"] as const).map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}</select></label>
    <label>{t("downloads.sort")}<select value={sort} onChange={(e) => onPrefs({ ...prefs, sort: e.target.value as DownloadSort })}>{(["order", "titleSort", "createdAt", "startedAt", "completedAt", "duration"] as const).map((value) => <option key={value} value={value}>{t(`downloads.${value}`)}</option>)}</select></label>
    <label>{t("downloads.direction")}<select value={direction} onChange={(e) => onPrefs({ ...prefs, direction: e.target.value as LibraryOrder })}><option value="asc">{t("downloads.asc")}</option><option value="desc">{t("downloads.desc")}</option></select></label>
    <label>{t("downloads.dateField")}<select value={dateField} onChange={(e) => onPrefs({ ...prefs, dateField: e.target.value as DownloadDateField })}>{(["createdAt", "startedAt", "completedAt"] as const).map((value) => <option key={value} value={value}>{t(`downloads.${value}`)}</option>)}</select></label>
    <label className="queue-date">{t("downloads.from")}<input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)}/></label>
    <label className="queue-date">{t("downloads.to")}<input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)}/></label>
    <label>{t("downloads.pageSize")}<select value={pageSize} onChange={(event) => onPrefs({ ...prefs, pageSize: Number(event.target.value) as DownloadPageSize })}>{[20, 50, 100].map((size) => <option key={size}>{size}</option>)}</select></label>
    <button onClick={() => { setQuery(""); setFrom(""); setTo(""); onPrefs({ ...prefs, status: "" }); }}>{t("downloads.reset")}</button>
  </div></details>
    <div className="queue-blocks" role="region" aria-label={t("downloads.queueLabel")}>
      {deviceTransfers.length > 0 && <section id="queue-device" className="queue-block queue-block-device" aria-labelledby="queue-heading-device">
        <div className="queue-block-head">
          <h3 id="queue-heading-device"><span className="queue-state-dot" aria-hidden="true"/>{t("downloads.section.device")}<span className="queue-count">{deviceTransfers.length}</span></h3>
          {deviceTransfers.some((item) => item.state !== "running") && <button className="queue-device-clear" onClick={() => action(api.clearDeviceTransfers)}><Trash2/> {t("downloads.device.clear")}</button>}
        </div>
        <div className="downloads queue-block-list">
          {deviceTransfers.map((item) => <div className="download-row" data-status={deviceStatus(item.state)} data-kind="device" key={item.id}>
            <div className="download-job">
              <strong>{item.filename}</strong>
              <small>{item.source === "library" ? t("downloads.device.source.library") : item.source === "addon" ? t("downloads.device.source.addon", { addon: item.addonName ?? "" }) : t("downloads.device.source.hls")}</small>
              {admin && <small className="queue-job-user">{t("downloads.device.user", { username: item.username ?? "" })}</small>}
            </div>
            <span className={`job-status ${deviceStatus(item.state)}`}>{t(`downloads.device.state.${item.state}`)}</span>
            <div className="download-progress"><span>{item.total != null ? `${bytes(item.sent)} / ${bytes(item.total)}` : bytes(item.sent)}</span><div className={item.total != null ? "progress" : "progress indeterminate"}><i style={item.total != null ? { width: `${Math.min(100, (item.sent / item.total) * 100)}%` } : undefined}/></div></div>
            <span className="download-speed">{item.state === "running" ? speed(item.speed) : ""}</span>
            <div className="queue-actions">{item.state === "running" && <button className="danger" title={t("downloads.device.abort")} aria-label={t("downloads.device.abort")} onClick={() => action(() => api.abortDeviceTransfer(item.id))}><X/></button>}</div>
          </div>)}
        </div>
      </section>}
      {(["active", "pending", "completed"] as const).map((group) => {
        const items = groups[group];
        const isHistory = group === "completed";
        const pages = Math.max(1, Math.ceil(items.length / pageSize));
        const page = Math.min(isHistory ? completedPage : pendingPage, pages);
        const open = !isHistory || completedOpen;
        const visible = group === "active" ? items : items.slice((page - 1) * pageSize, page * pageSize);
        const changePage = (value: number) => {
          (isHistory ? setCompletedPage : setPendingPage)(value);
          document.getElementById(`queue-${group}`)?.scrollIntoView({ block: "start" });
        };
        return <section key={group} id={`queue-${group}`} className={`queue-block queue-block-${group}`} aria-labelledby={`queue-heading-${group}`}>
          <div className="queue-block-head">
            <h3 id={`queue-heading-${group}`}>{isHistory ? <button className="queue-history-toggle" aria-expanded={completedOpen} aria-controls="queue-completed-content" onClick={() => setCompletedOpen((value) => !value)}><Check aria-hidden="true"/>{t("downloads.section.completed")}<span className="queue-count">{items.length}</span><ChevronDown aria-hidden="true"/></button> : <><span className="queue-state-dot" aria-hidden="true"/>{t(`downloads.section.${group}`)}<span className="queue-count">{items.length}</span></>}</h3>
            {group === "active" && active.length > 0 && <span className="queue-live-speed">{speed(totalSpeed)}</span>}
          </div>
          {group === "pending" && items.some((job) => job.status === "paused" || job.status === "failed") && <p className="queue-block-hint">{t("downloads.pendingHint")}</p>}
          <div id={`queue-${group}-content`} hidden={!open}>
            {items.length ? <div className="downloads queue-block-list">{visible.map(renderJob)}</div> : <p className="queue-block-empty">{t(activeFilters ? "downloads.noMatches" : `downloads.empty.${group}`)}</p>}
            {group !== "active" && items.length > pageSize && <div className="queue-pagination"><span role="status">{t("downloads.page", { page, pages, count: items.length })}</span><button disabled={page <= 1} onClick={() => changePage(page - 1)}>{t("downloads.previous")}</button><button disabled={page >= pages} onClick={() => changePage(page + 1)}>{t("downloads.next")}</button></div>}
          </div>
        </section>;
      })}
    </div>
  </section>;

}

const deviceStatus = (state: DeviceTransfer["state"]) => state === "running" ? "downloading" : state === "completed" ? "completed" : "failed";
