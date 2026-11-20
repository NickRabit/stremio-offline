import { useEffect, useRef, useState } from "react";
import { useDialogFocus } from "./dialog-focus";
import { useDialogViewport } from "./dialog-viewport";
import { X } from "lucide-react";
import { api, describeError } from "./api";
import { serverText, t, useI18n } from "./i18n";
import {
  chunkKeys, defaultDestinations, eligibleChildren, groupCounts, joinLibraryRoot, movableKeys, preselectTarget, sortedItems, summaryLines,
  targetErrors, targetName, type FolderNameError, type SplitDestination, type SplitTarget,
} from "./library-split";
import type { LibraryView, SplitPlan, SplitPlanItem } from "./types";

const KINDS = ["movie", "series"] as const;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const STEP_NAME = { 1: "split.stepLibraries", 2: "split.stepItems", 3: "split.stepSummary" } as const;

type Line = { id: string; text: string };
type Phase = "form" | "progress";

export function LibrarySplitDialog({ library, onClose, onApplied }: {
  library: LibraryView; onClose: () => void; onApplied: () => void;
}) {
  useI18n();
  const overlay = useRef<HTMLDivElement>(null);
  useDialogFocus(overlay);
  useDialogViewport(overlay);
  const [plan, setPlan] = useState<SplitPlan | null>(null);
  const [loadError, setLoadError] = useState("");
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [phase, setPhase] = useState<Phase>("form");
  const [movie, setMovie] = useState<SplitTarget>({ mode: "new", name: "" });
  const [series, setSeries] = useState<SplitTarget>({ mode: "new", name: "" });
  const [setDefaults, setSetDefaults] = useState(true);
  const [copyAccess, setCopyAccess] = useState(true);
  const [destinations, setDestinations] = useState<Record<string, SplitDestination>>({});
  const [lines, setLines] = useState<Line[]>([]);
  const [showRetry, setShowRetry] = useState(false);
  const [moving, setMoving] = useState(false);
  const applied = useRef(false);
  const notified = useRef(false);
  const closed = useRef(false);
  const intervalRef = useRef<number | null>(null);

  const stopPolling = () => {
    if (intervalRef.current != null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const hydrate = (next: SplitPlan) => {
    const nextMovie = preselectTarget(next, "movie");
    const nextSeries = preselectTarget(next, "series");
    setPlan(next);
    setMovie(nextMovie);
    setSeries(nextSeries);
    setDestinations(defaultDestinations(next));
    setStep(1);
    setPhase("form");
    setLines([]);
    setShowRetry(false);
    setMoving(false);
    setLoadError("");
  };

  const loadPlan = async () => {
    setLoadError("");
    try { hydrate(await api.librarySplitPlan(library.id)); }
    catch (error) { setLoadError(describeError(error)); }
  };

  useEffect(() => {
    closed.current = false;
    let stale = false;
    setLoadError("");
    void api.librarySplitPlan(library.id)
      .then((next) => { if (!stale) hydrate(next); })
      .catch((error) => { if (!stale) setLoadError(describeError(error)); });
    return () => {
      stale = true;
      closed.current = true;
      stopPolling();
    };
  }, [library.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const notifyApplied = () => {
    if (notified.current) return;
    notified.current = true;
    onApplied();
  };
  /** Something reached the server. A change that lands after the dialog was closed still has to
   *  reach the list behind it, or a library created meanwhile never shows up there. */
  const markApplied = () => {
    applied.current = true;
    if (closed.current) notifyApplied();
  };

  const close = () => {
    stopPolling();
    closed.current = true;
    if (applied.current) notifyApplied();
    onClose();
  };

  const errors = plan ? targetErrors(plan, movie, series) : {};
  // The root the plan was computed for, never the list's older copy: if the root was changed
  // meanwhile, the plan's titles live under the new one.
  const parentRoot = plan?.library.root ?? "";
  const showCopy = (library.visibleTo?.length ?? 0) > 0;
  const counts = plan ? groupCounts(plan) : null;
  const leaveLabel = t("split.leave", { name: library.name });

  const goNext = () => {
    if (!plan) return;
    if (step === 1) {
      if (errors.movie || errors.series || errors.same) return;
      // Destinations are kinds, not libraries, so they survive a change of target; the plan's
      // load set the defaults, and choices made in step 2 are kept across a visit to step 1.
      setStep(2);
      return;
    }
    if (step === 2) setStep(3);
  };

  const retry = () => {
    stopPolling();
    // The old plan describes a state some of the work already changed: it must not be startable
    // again while the new one loads, nor after loading it failed.
    setPlan(null);
    setStep(1);
    setPhase("form");
    setLines([]);
    setShowRetry(false);
    setMoving(false);
    void loadPlan();
  };

  const upsert = (id: string, text: string) => {
    setLines((current) => {
      const at = current.findIndex((line) => line.id === id);
      if (at < 0) return [...current, { id, text }];
      return current.map((line, index) => index === at ? { id, text } : line);
    });
  };

  const apply = async () => {
    if (!plan || phase === "progress") return;
    if (errors.movie || errors.series || errors.same) return;
    setPhase("progress");
    setLines([]);
    setShowRetry(false);
    setMoving(false);
    const ids: Record<"movie" | "series", string> = { movie: "", series: "" };
    try {
      for (const kind of KINDS) {
        const target = kind === "movie" ? movie : series;
        if (target.mode === "child") { ids[kind] = target.id; continue; }
        // Always a folder this request makes (`fresh`): a library laid over a folder that holds
        // titles -- one that appeared since the plan was read included -- would take them without
        // the records a move carries. The grants travel in the same request, so a run that stops
        // after this library leaves it shared the way it was asked for.
        const name = targetName(target);
        const root = joinLibraryRoot(parentRoot, name);
        upsert(`create-${kind}`, t("split.progressCreating", { name }));
        const made = await api.createLibrary({
          name, type: kind, root, create: true, fresh: true, within: library.id,
          // The source library's id, not the accounts this page saw: the server copies the grants
          // as they are when it writes, so one removed meanwhile is not given back.
          ...(copyAccess && showCopy ? { grantsFrom: library.id } : {}),
          autoScanMetadata: library.autoScanMetadata, writeArtwork: library.writeArtwork,
        });
        markApplied();
        if (closed.current) return;
        ids[kind] = made.id;
        upsert(`create-${kind}`, t("split.progressCreated", { name }));
      }
      if (setDefaults) {
        await api.updateLibrary(ids.movie, { defaultMovie: true });
        await api.updateLibrary(ids.series, { defaultSeries: true });
        markApplied();
        if (closed.current) return;
        upsert("settings", t("split.progressSettings"));
      }
      const jobs: Record<"movie" | "series", string[]> = { movie: [], series: [] };
      for (const kind of KINDS) {
        const keys = movableKeys(plan, destinations, kind);
        for (const chunk of chunkKeys(keys)) {
          const queued = await api.startLibraryOp({
            op: "move", items: chunk, target: ids[kind], confirmTypeMismatch: true,
          });
          markApplied();
          jobs[kind].push(queued.id);
        }
      }
      if (closed.current) return;
      await watchJobs(plan, jobs, { movie: targetName(movie), series: targetName(series) });
    } catch (error) {
      if (closed.current) return;
      upsert("failed", t("split.progressStepFailed", { reason: describeError(error) }));
      setShowRetry(true);
    }
  };

  const watchJobs = async (
    currentPlan: SplitPlan,
    jobs: Record<"movie" | "series", string[]>,
    names: Record<"movie" | "series", string>,
  ) => {
    const tracked = [...jobs.movie, ...jobs.series];
    if (!tracked.length) {
      upsert("done", t("split.done"));
      return;
    }
    const labels = new Map(currentPlan.items.flatMap((item) => [item.key, ...(item.files ?? [])].map((key) => [key, item.label] as const)));
    let finished = false;
    const tick = async () => {
      if (closed.current || finished) return;
      const { jobs: current } = await api.libraryOps();
      if (closed.current || finished) return;
      const byId = new Map(current.map((job) => [job.id, job]));
      let allTerminal = true;
      // A cancelled job, or one that ended before reaching every item, records nothing for the
      // items it never took up: they are still waiting in the parent and need a retry, not "done".
      let incomplete = false;
      const failed: Line[] = [];
      for (const kind of KINDS) {
        if (!jobs[kind].length) continue;
        let done = 0, total = 0, running = false;
        for (const id of jobs[kind]) {
          const job = byId.get(id);
          if (!job || !TERMINAL.has(job.status)) {
            allTerminal = false;
            running = true;
          }
          if (!job) continue;
          if (TERMINAL.has(job.status) && (job.status === "cancelled" || job.done + job.failed < job.total)) incomplete = true;
          done += job.done;
          total += job.total;
          for (const result of job.results) {
            if (result.ok) continue;
            failed.push({
              id: `fail-${kind}-${result.path}`,
              text: t("split.progressFailedItem", {
                item: labels.get(result.path) ?? result.path,
                reason: serverText(result.errorKey, result.error ?? ""),
              }),
            });
          }
        }
        upsert(`move-${kind}`, t(running ? "split.progressMoving" : "split.progressMoved", {
          name: names[kind], done, total,
        }));
      }
      if (!allTerminal) return;
      finished = true;
      stopPolling();
      setMoving(false);
      if (failed.length) {
        setLines((currentLines) => {
          const seen = new Set(currentLines.map((line) => line.id));
          return [...currentLines, ...failed.filter((line) => !seen.has(line.id))];
        });
      }
      if (failed.length || incomplete) setShowRetry(true);
      if (!incomplete) upsert("done", t("split.done"));
    };
    setMoving(true);
    await tick();
    if (!closed.current && !finished) {
      intervalRef.current = window.setInterval(() => { void tick(); }, 1500);
    }
  };

  const title = t("split.title", { name: library.name });
  const headStep = phase === "progress"
    ? t("split.progressTitle")
    : plan ? `${t("split.step", { step })} · ${t(STEP_NAME[step])}` : "";

  return <div ref={overlay} tabIndex={-1} className="identify-overlay" role="dialog" aria-modal="true" aria-label={title}
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="panel identify-card dialog-split library-split-card">
      <div className="identify-head">
        <div className="library-split-head">
          <h2>{title}</h2>
          {headStep && <p className="identify-hint">{headStep}</p>}
        </div>
        <button type="button" className="icon-button" aria-label={t("common.close")} onClick={close}><X/></button>
      </div>
      <div className="dialog-body">
        {phase === "progress" ? <>
          <ul className="library-split-progress">
            {lines.map((line) => <li key={line.id}>{line.text}</li>)}
          </ul>
          {showRetry && <p className="identify-hint">{t("split.retryHint")}</p>}
          {showRetry && <button type="button" onClick={() => void retry()}>{t("common.retry")}</button>}
        </> : !plan && !loadError ? <p className="identify-hint">{t("split.loading")}</p>
          : loadError ? <p className="login-error">{loadError}</p>
          : plan && step === 1 ? <>
            <p>{t("split.intro", {
              movies: t("split.movieCount", { count: plan.counts.movies }),
              series: t("split.seriesCount", { count: plan.counts.series }),
              root: plan.library.root,
            })}</p>
            <KindBlock kind="movie" heading={t("split.moviesHeading")} plan={plan} target={movie} error={errors.movie}
              onChange={setMovie}/>
            <KindBlock kind="series" heading={t("split.seriesHeading")} plan={plan} target={series} error={errors.series}
              onChange={setSeries}/>
            {errors.same && <p className="login-error">{t("split.sameTarget")}</p>}
            <div className="library-split-checks">
              <label className="library-check">
                <span className="switch"><input type="checkbox" checked={setDefaults}
                  onChange={(event) => setSetDefaults(event.target.checked)}/><span/></span>
                <span>{t("split.setDefaults")}</span>
              </label>
              <p className="identify-hint">{t("split.setDefaultsHint")}</p>
              {showCopy && <label className="library-check">
                <span className="switch"><input type="checkbox" checked={copyAccess}
                  onChange={(event) => setCopyAccess(event.target.checked)}/><span/></span>
                <span>{t("split.copyAccess", { name: library.name })}</span>
              </label>}
            </div>
          </> : plan && step === 2 ? <>
            {counts && <div className="library-split-chips">
              {counts.identified > 0 && <i className="library-badge">{t("split.groupIdentified", { count: counts.identified })}</i>}
              {counts.guessed > 0 && <i className="library-badge">{t("split.groupGuessed", { count: counts.guessed })}</i>}
              {counts.undecided > 0 && <i className="library-badge">{t("split.groupUndecided", { count: counts.undecided })}</i>}
              {counts.busy > 0 && <i className="library-badge">{t("split.groupBusy", { count: counts.busy })}</i>}
            </div>}
            <table className="library-split-table">
              <thead><tr><th>{t("split.colItem")}</th><th>{t("split.colTarget")}</th></tr></thead>
              <tbody>
                {sortedItems(plan).map((item) => <ItemRow key={item.key} item={item}
                  destination={destinations[item.key] ?? "leave"} movieName={targetName(movie)} seriesName={targetName(series)}
                  leaveLabel={leaveLabel} onChange={(value) => setDestinations((current) => ({ ...current, [item.key]: value }))}/>)}
              </tbody>
            </table>
          </> : plan && step === 3 ? <ul className="library-split-summary">
            {summaryLines(plan, movie, series, destinations, setDefaults, library.name, parentRoot).map((line) =>
              <li key={line}>{line}</li>)}
          </ul> : null}
      </div>
      <footer className="dialog-foot">
        {phase === "progress" ? <>
          {moving && <p className="identify-hint">{t("split.backgroundNote")}</p>}
          <button type="button" onClick={close}>{t("common.close")}</button>
        </> : <>
          {step === 1
            ? <button type="button" onClick={close}>{t("common.cancel")}</button>
            : <button type="button" onClick={() => setStep(step === 3 ? 2 : 1)}>{t("split.back")}</button>}
          <button type="button" className="primary" disabled={!plan}
            onClick={() => { if (step === 3) void apply(); else goNext(); }}>
            {step === 3 ? t("split.start") : t("split.next")}
          </button>
        </>}
      </footer>
    </div>
  </div>;
}

function KindBlock({ kind, heading, plan, target, error, onChange }: {
  kind: "movie" | "series"; heading: string; plan: SplitPlan; target: SplitTarget;
  error?: FolderNameError; onChange: (target: SplitTarget) => void;
}) {
  const group = `split-${kind}`;
  const defaultName = kind === "movie" ? t("split.defaultMoviesName") : t("split.defaultSeriesName");
  return <fieldset className="library-split-block">
    <legend>{heading}</legend>
    {eligibleChildren(plan, kind).map((child) => <label key={child.id} className="library-split-option">
      <input type="radio" name={group} checked={target.mode === "child" && target.id === child.id}
        onChange={() => onChange({ mode: "child", id: child.id, name: child.name })}/>
      <span>{t("split.targetExisting", { name: child.name })}</span>
    </label>)}
    <label className="library-split-option">
      <input type="radio" name={group} checked={target.mode === "new"}
        onChange={() => onChange({ mode: "new", name: target.mode === "new" ? target.name : defaultName })}/>
      <span>{t("split.targetNew")}</span>
    </label>
    {target.mode === "new" && <label className="library-split-folder">
      <span>{t("split.folderName")}</span>
      <input value={target.name} autoComplete="off" aria-label={t("split.folderName")}
        onChange={(event) => onChange({ mode: "new", name: event.target.value })}/>
    </label>}
    {error && <p className="login-error">{t(error === "nameTaken" ? "split.nameTaken" : "split.nameInvalid")}</p>}
  </fieldset>;
}

function ItemRow({ item, destination, movieName, seriesName, leaveLabel, onChange }: {
  item: SplitPlanItem; destination: SplitDestination;
  movieName: string; seriesName: string; leaveLabel: string;
  onChange: (value: SplitDestination) => void;
}) {
  const busyText = item.busy === "download" ? t("split.busyDownload")
    : item.busy === "operation" ? t("split.busyOperation") : "";
  return <tr>
    <td>
      <div className="library-split-item">
        <span>{item.label}</span>
        {item.basis === "guessed" && !item.busy && <i className="library-badge">{t("split.guessed")}</i>}
        {item.kind === "unknown" && !item.busy && <i className="library-badge">{t("split.unidentified")}</i>}
      </div>
    </td>
    <td>
      {item.busy ? busyText
        : <select aria-label={t("split.colTarget")} value={destination}
          onChange={(event) => onChange(event.target.value as SplitDestination)}>
          <option value="movie">{movieName}</option>
          <option value="series">{seriesName}</option>
          <option value="leave">{leaveLabel}</option>
        </select>}
    </td>
  </tr>;
}
