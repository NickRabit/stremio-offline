import { useEffect, useState } from "react";
import { ChevronDown, Copy, Download, FileText, RefreshCw, Trash2 } from "lucide-react";
import { api, logDownloadUrl } from "./api";
import { copyText } from "./clipboard";
import { statusLabel } from "./download-format";
import { groupLog, parseLog, type LogGroup, type LogLine } from "./log-groups";
import { localeTag, serverText, t, type Key } from "./i18n";
import { bytes, SettingsSectionHead } from "./settings-ui";
import type { BuildInfo, Diagnostics, Settings as AppSettings, Download as DownloadJob } from "./types";

const LOG_LEVELS = [["", "diag.levelAll"], ["INFO", "diag.levelInfo"], ["WARN", "diag.levelWarn"], ["ERROR", "diag.levelError"]] as const satisfies ReadonlyArray<readonly [string, Key]>;
const PERIODS = [[1, "diag.periodHour"], [24, "diag.periodDay"], [168, "diag.periodWeek"], [0, "diag.periodAll"]] as const satisfies ReadonlyArray<readonly [number, Key]>;
const duration = (seconds: number) => seconds >= 86400 ? `${Math.floor(seconds / 86400)} d ${Math.floor((seconds % 86400) / 3600)} h`
  : seconds >= 3600 ? `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min` : `${Math.max(1, Math.round(seconds / 60))} min`;
const since = (at: string) => {
  const seconds = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  return seconds < 90 ? t("diag.justNow") : t("diag.ago", { duration: duration(seconds) });
};
const clock = (at: string) => at ? new Date(at).toLocaleTimeString(localeTag()) : "";

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return <div className="fact"><dt>{term}</dt><dd>{children}</dd></div>;
}

/** One group of identical messages. It unfolds into the last occurrences with their
 * context, so the ordinary view stays short and the detail is at hand. */
function Issue({ group }: { group: LogGroup }) {
  const [open, setOpen] = useState(false);
  return <li className={`issue ${group.level.toLowerCase()}`}>
    <button className="issue-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className={`level-chip ${group.level.toLowerCase()}`}>{group.level}</span>
      <span className="issue-message">{group.message}</span>
      <span className="issue-count" title={t("diag.sinceCount", { count: group.count, time: clock(group.first) })}>{group.count}×</span>
      <span className="issue-when">{since(group.last)}</span>
      <ChevronDown className={open ? "rotated" : ""}/>
    </button>
    {open && <div className="issue-detail">
      {group.samples.map((sample, index) => <div key={`${sample.at}:${index}`}>
        <span>{clock(sample.at)}</span>
        {sample.context ? <code>{sample.context}</code> : <code className="empty">{t("diag.noContext")}</code>}
      </div>)}
    </div>}
  </li>;
}

/** Diagnostics should first answer "is something broken?" and only then offer the raw log.
 * That does not interest an ordinary user, so both the panel and the log stay hidden until asked for. */
export function DiagnosticsSection({ build, onNotify, onError }: { build: BuildInfo | null; onNotify: (message: string) => void; onError: (error: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<Diagnostics | null>(null);
  const [issues, setIssues] = useState<LogGroup[]>([]);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [hours, setHours] = useState(24);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("");
  const [tail, setTail] = useState(200);
  const [wrap, setWrap] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  // What the server writes down, as opposed to the level above, which only filters what it wrote.
  const [recording, setRecording] = useState("INFO");

  const changeRecording = async (level: string) => {
    const previous = recording;
    setRecording(level);
    try { await api.updateSettings({ logLevel: level as AppSettings["logLevel"] }); onNotify(t("diag.recordLevelSaved", { level })); }
    catch (error) { setRecording(previous); onError(error); }
  };

  const loadOverview = async () => {
    setBusy(true);
    try {
      const [diagnostics, text, saved] = await Promise.all([
        api.diagnostics(), api.logs({ tail: 500, level: "WARN", hours, search: query, inline: true }), api.settings(),
      ]);
      setInfo(diagnostics);
      setRecording(saved.logLevel ?? "INFO");
      setIssues(groupLog(parseLog(text)));
    } catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  const loadLog = async () => {
    setBusy(true);
    try { setLines(parseLog(await api.logs({ tail, level, hours, search: query, inline: true }))); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  // Typing in the search box should not hit the server on every letter.
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 400); return () => clearTimeout(timer); }, [search]);
  // The overview loads even while collapsed; otherwise the header chip would claim "no errors" without looking.
  useEffect(() => { void loadOverview(); }, [hours, query]);
  useEffect(() => { if (open && showLog) void loadLog(); }, [open, showLog, level, tail, hours, query]);

  const refresh = async () => { await loadOverview(); if (showLog) await loadLog(); };
  const copyLog = async () => { try { await copyText(await api.logs()); onNotify(t("diag.logCopied")); } catch (error) { onError(error); } };
  const clearLog = async () => {
    if (!confirm(t("diag.clearLogConfirm"))) return;
    try { await api.clearLogs(); onNotify(t("diag.logCleared")); setLines([]); await loadOverview(); }
    catch (error) { onError(error); }
  };

  const vaapi = info?.playback.vaapi;
  const nvenc = info?.playback.nvenc;
  const videotoolbox = info?.playback.videotoolbox;
  const mediafoundation = info?.playback.mediafoundation;
  const sessions = info?.playback.sessions ?? [];
  const failed = info?.downloads.failed ?? [];
  const troubled = info?.outbound ?? [];
  const queue = Object.entries(info?.downloads.byStatus ?? {});
  const reports = issues.reduce((sum, issue) => sum + issue.count, 0);
  const worst = issues.some((issue) => issue.level === "ERROR") ? "error" : issues.length ? "warn" : "ok";

  return <section className="panel settings-section diagnostics-section">
    <button className="diagnostics-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      <SettingsSectionHead icon={<FileText/>} title={t("diag.title")} text={t("diag.subtitle")}/>
      {!open && info && <span className={`state-chip ${worst}`}>{worst === "ok" ? t("diag.noErrors") : t("diag.reportCount", { count: reports })}</span>}
      <ChevronDown className={open ? "rotated" : ""}/>
    </button>

    {open && <div className="diagnostics-body">
      <dl className="diagnostics-facts">
        <Fact term={t("diag.version")}>{info?.version ?? build?.version ?? "—"}{build?.commit ? <small> · {build.commit.slice(0, 7)}</small> : null}</Fact>
        <Fact term={t("diag.uptime")}>{info ? duration(info.uptimeSeconds) : "—"}</Fact>
        <Fact term={t("diag.conversion")}>{info?.playback.ffmpeg.version ? `FFmpeg ${info.playback.ffmpeg.version}` : "—"}<small>{vaapi?.device ? ` · GPU ${vaapi.device}` : nvenc?.available ? " · NVENC" : videotoolbox?.available ? " · VideoToolbox" : mediafoundation?.available ? ` · Media Foundation${mediafoundation.hardware ? "" : ` (${t("diag.software")})`}` : ` · ${t("diag.software")}`}</small></Fact>
        <Fact term={t("diag.playback")}>{sessions.length ? t("diag.sessionCount", { count: sessions.length }) : t("diag.noSessions")}</Fact>
        <Fact term={t("diag.queue")}>{queue.length ? queue.map(([status, count]) => `${statusLabel(status as DownloadJob["status"])} ${count}`).join(", ") : t("diag.queueEmpty")}</Fact>
        {(info?.storage ?? []).map((disk) => <Fact key={disk.path} term={t("diag.freeSpace", { path: disk.path })}>{bytes(disk.freeBytes)}<small>{disk.totalBytes ? ` ${t("diag.ofTotal", { total: bytes(disk.totalBytes) })}` : ""}</small></Fact>)}
      </dl>

      {sessions.length > 0 && <ul className="diagnostics-list">{sessions.map((session) => <li key={session.id}>
        <strong>{session.title ?? session.id}</strong>
        <span>{session.mode}{session.hardware ? " · GPU" : ""} · {session.video ?? "?"}/{session.audio ?? "?"} · {t("diag.atSecond", { seconds: Math.round(session.offset) })} · {t("diag.idleFor", { seconds: session.idleSeconds })}</span>
      </li>)}</ul>}

      {info?.downloads.halt && <ul className="diagnostics-list"><li>
        <strong>{t("diag.queueHalted")}</strong><span>{serverText(info.downloads.halt.messageKey, info.downloads.halt.message)}</span>
      </li></ul>}

      {failed.length > 0 && <ul className="diagnostics-list">{failed.map((job) => <li key={job.id}>
        <strong>{job.title}</strong><span>{job.error ? serverText(job.errorKey, job.error) : t("diag.errorWithoutDetail")}</span>
      </li>)}</ul>}

      {troubled.length > 0 && <ul className="diagnostics-list">{troubled.map((host) => <li key={host.host}>
        <strong>{host.host}</strong>
        <span>{host.state === "open" ? t("diag.hostOpen", { seconds: host.opensInSeconds ?? 0 })
          : host.state === "half-open" ? t("diag.hostHalfOpen")
          : t("diag.hostFailures", { count: host.failures })}{host.rejected ? ` · ${t("diag.hostRejected", { count: host.rejected })}` : ""}</span>
      </li>)}</ul>}

      <div className="diagnostics-filters">
        <label><span>{t("stats.periodGroup")}</span><select aria-label={t("stats.periodGroup")} value={hours} onChange={(event) => setHours(Number(event.target.value))}>{PERIODS.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}</select></label>
        <label className="grow"><span>{t("diag.searchMessages")}</span><input type="search" placeholder={t("diag.searchPlaceholder")} value={search} onChange={(event) => setSearch(event.target.value)}/></label>
        <button disabled={busy} onClick={() => void refresh()}><RefreshCw/> {t("common.refresh")}</button>
      </div>

      <div className="issues-head">
        <h4>{t("diag.recentIssues")}</h4>
        {issues.length > 0 && <span className={`state-chip ${worst}`}>{t("diag.reportCount", { count: reports })}</span>}
      </div>
      {issues.length ? <ul className="issues">{issues.slice(0, 12).map((issue) => <Issue key={issue.key} group={issue}/>)}</ul>
        : <p className="issues-empty">{t("diag.noIssues")}</p>}

      <div className="log-toggle">
        <button onClick={() => setShowLog(!showLog)} aria-expanded={showLog}><ChevronDown className={showLog ? "rotated" : ""}/> {t(showLog ? "diag.hideLog" : "diag.showLog")}</button>
        <a className="button" href={logDownloadUrl(showLog ? { tail, level, hours, search: query } : {})}
          title={showLog ? t("diag.downloadShown") : t("diag.downloadAll")} download="stremio-offline.log"><Download/> {t("common.download")}</a>
        <button onClick={() => void copyLog()}><Copy/> {t("common.copy")}</button>
        <button className="danger" onClick={() => void clearLog()}><Trash2/> {t("diag.clearLog")}</button>
      </div>

      {showLog && <div className="log-panel">
        <div className="log-filters">
          <label><span>{t("diag.level")}</span><select aria-label={t("diag.logLevel")} value={level} onChange={(event) => setLevel(event.target.value)}>{LOG_LEVELS.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}</select></label>
          <label><span>{t("diag.lines")}</span><select aria-label={t("diag.lineCount")} value={tail} onChange={(event) => setTail(Number(event.target.value))}>{[100, 200, 500, 1000].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label><span>{t("diag.recordLevel")}</span><select aria-label={t("diag.recordLevelLabel")} value={recording} onChange={(event) => void changeRecording(event.target.value)}>
            {LOG_LEVELS.filter(([value]) => value).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
          </select></label>
          <label className="log-wrap"><input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)}/><span>{t("diag.wrapLines")}</span></label>
        </div>
        <div className={`log-viewer${wrap ? " wrap" : ""}`} aria-label={t("diag.serverLog")}>
          {lines.length ? lines.map((line, index) => <div className={`log-line ${line.level.toLowerCase()}`} key={`${line.at}:${index}`}>
            <span className="log-time">{clock(line.at)}</span>
            <span className={`level-chip ${line.level.toLowerCase()}`}>{line.level || "—"}</span>
            <span className="log-message">{line.message}</span>
            {line.context && <span className="log-context">{line.context}</span>}
          </div>) : <div className="log-line">{busy ? t("common.loading") : t("diag.noLines")}</div>}
        </div>
        <p>{t("diag.logPrivacy")}{info?.logRetentionDays ? ` ${t("diag.logRetention", { days: info.logRetentionDays })}` : ""}</p>
      </div>}
    </div>}
  </section>;
}
