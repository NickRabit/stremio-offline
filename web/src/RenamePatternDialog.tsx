import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDialogFocus } from "./dialog-focus";
import { useDialogViewport } from "./dialog-viewport";
import { X } from "lucide-react";
import { api, ApiError, describeError } from "./api";
import { t, useI18n, type Key } from "./i18n";
import type { LibraryOp, RenameField, RenamePlanRow, RenameStatus } from "./types";

const DEFAULT_MOVIE = "{title} ({year})";
const DEFAULT_EPISODE = "{title} - S{season:2}E{episode:2}";
const STORAGE_KEY = "rename-patterns";
const FIELDS: RenameField[] = ["title", "year", "season", "episode"];
const CHUNK = 500;

const readStored = (): { movie: string; episode: string } => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { movie: DEFAULT_MOVIE, episode: DEFAULT_EPISODE };
    const parsed = JSON.parse(raw) as { movie?: unknown; episode?: unknown };
    if (typeof parsed.movie === "string" && typeof parsed.episode === "string") {
      return { movie: parsed.movie, episode: parsed.episode };
    }
  } catch { /* storage may be unavailable */ }
  return { movie: DEFAULT_MOVIE, episode: DEFAULT_EPISODE };
};

const writeStored = (movie: string, episode: string) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ movie, episode })); }
  catch { /* storage may be unavailable */ }
};

const groupOf = (status: RenameStatus) => status === "rename" ? 0 : status === "same" ? 2 : 1;

const sortedRows = (rows: RenamePlanRow[]) =>
  [...rows].sort((a, b) => groupOf(a.status) - groupOf(b.status) || a.from.localeCompare(b.from));

const fieldLabel = (field: RenameField) => t(`rename.field.${field}` as Key);

const newCell = (row: RenamePlanRow) => {
  if (row.status === "rename") {
    return <div className="rename-new">
      <span>{row.to}</span>
      {!row.isFile && <small>{t("rename.folder")}</small>}
      {row.sidecars > 0 && <small>{t("rename.sidecars", { count: row.sidecars })}</small>}
    </div>;
  }
  if (row.status === "same") return <span className="rename-same">{t("rename.same")}</span>;
  if (row.status === "unidentified") return <span className="rename-blocked">{t("rename.unidentified")}</span>;
  if (row.status === "missing") {
    const fields = (row.missing ?? []).map((field) => fieldLabel(field).toLowerCase()).join(", ");
    return <span className="rename-blocked">{t("rename.missing", { fields })}</span>;
  }
  return <span className="rename-blocked">{t(`rename.${row.status}` as Key)}</span>;
};

export function RenamePatternDialog({ paths, onClose, onStart }: {
  paths: string[]; onClose: () => void; onStart: (operations: LibraryOp[]) => void;
}) {
  useI18n();
  const overlay = useRef<HTMLDivElement>(null);
  useDialogFocus(overlay);
  useDialogViewport(overlay);
  const movieRef = useRef<HTMLInputElement>(null);
  const episodeRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const skipDebounce = useRef(true);
  const caret = useRef<{ target: "movie" | "episode"; pos: number } | null>(null);
  const [moviePattern, setMoviePattern] = useState(() => readStored().movie);
  const [episodePattern, setEpisodePattern] = useState(() => readStored().episode);
  const [rows, setRows] = useState<RenamePlanRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState("");

  const title = t("rename.title", { items: t("library.bulkItems", { count: paths.length }) });

  const requestPlan = (movie: string, episode: string) => {
    const id = ++generation.current;
    setLoading(true);
    setInvalid(false);
    setError("");
    void api.renamePlan({ items: paths, moviePattern: movie, episodePattern: episode })
      .then((result) => {
        if (id !== generation.current) return;
        setRows(result.rows);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (id !== generation.current) return;
        setLoading(false);
        // The rows on screen belong to the patterns before this edit: left there, Apply would
        // rename by a pattern the inputs no longer show.
        setRows(null);
        if (caught instanceof ApiError && caught.messageKey === "err.renamePatternInvalid") {
          setInvalid(true);
          return;
        }
        if (caught instanceof ApiError && caught.messageKey === "err.tooManyItems") {
          setError(t("rename.tooMany", { max: 2000 }));
          return;
        }
        setError(describeError(caught));
      });
  };

  useEffect(() => {
    requestPlan(moviePattern, episodePattern);
    return () => { generation.current += 1; };
  }, [paths]);

  useEffect(() => {
    if (skipDebounce.current) {
      skipDebounce.current = false;
      return;
    }
    generation.current += 1;
    setLoading(true);
    setInvalid(false);
    setError("");
    const timer = window.setTimeout(() => requestPlan(moviePattern, episodePattern), 400);
    return () => clearTimeout(timer);
  }, [moviePattern, episodePattern]);

  useEffect(() => {
    writeStored(moviePattern, episodePattern);
  }, [moviePattern, episodePattern]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useLayoutEffect(() => {
    if (!caret.current) return;
    const input = caret.current.target === "movie" ? movieRef.current : episodeRef.current;
    const pos = caret.current.pos;
    caret.current = null;
    if (!input) return;
    input.focus();
    input.setSelectionRange(pos, pos);
  });

  const insertField = (target: "movie" | "episode", field: RenameField) => {
    const input = target === "movie" ? movieRef.current : episodeRef.current;
    const current = target === "movie" ? moviePattern : episodePattern;
    const token = `{${field}}`;
    const start = input?.selectionStart ?? current.length;
    const end = input?.selectionEnd ?? start;
    const next = current.slice(0, start) + token + current.slice(end);
    caret.current = { target, pos: start + token.length };
    if (target === "movie") setMoviePattern(next);
    else setEpisodePattern(next);
  };

  const preview = rows && !invalid ? sortedRows(rows) : null;
  const renameCount = (rows ?? []).filter((row) => row.status === "rename").length;
  const sameCount = (rows ?? []).filter((row) => row.status === "same").length;
  const blockedCount = (rows ?? []).filter((row) => row.status !== "rename" && row.status !== "same").length;
  const applyDisabled = loading || invalid || renameCount === 0;

  const apply = () => {
    const renaming = (rows ?? []).filter((row) => row.status === "rename");
    const operations: LibraryOp[] = [];
    for (let index = 0; index < renaming.length; index += CHUNK) {
      const chunk = renaming.slice(index, index + CHUNK);
      operations.push({
        op: "rename",
        items: chunk.map((row) => row.key),
        names: Object.fromEntries(chunk.map((row) => [row.key, row.to!])),
      });
    }
    writeStored(moviePattern, episodePattern);
    onStart(operations);
    onClose();
  };

  const fieldButtons = (target: "movie" | "episode") =>
    <div className="rename-fields">
      {FIELDS.map((field) => <button type="button" key={field}
        aria-label={t("rename.insertField", { field: fieldLabel(field) })}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => insertField(target, field)}>{fieldLabel(field)}</button>)}
    </div>;

  return <div ref={overlay} tabIndex={-1} className="identify-overlay" role="dialog" aria-modal="true" aria-label={title}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="panel identify-card dialog-split rename-card">
      <div className="identify-head">
        <h2>{title}</h2>
        <button type="button" className="icon-button" aria-label={t("common.close")} onClick={onClose}><X/></button>
      </div>
      <div className="dialog-body">
        <div className="rename-patterns">
          <label className="rename-pattern">
            <span>{t("rename.moviePattern")}</span>
            <input ref={movieRef} value={moviePattern} autoComplete="off" spellCheck={false}
              aria-label={t("rename.moviePattern")}
              onChange={(event) => setMoviePattern(event.target.value)}/>
            {fieldButtons("movie")}
          </label>
          <label className="rename-pattern">
            <span>{t("rename.episodePattern")}</span>
            <input ref={episodeRef} value={episodePattern} autoComplete="off" spellCheck={false}
              aria-label={t("rename.episodePattern")}
              onChange={(event) => setEpisodePattern(event.target.value)}/>
            {fieldButtons("episode")}
          </label>
        </div>
        <p className="identify-hint">{t("rename.hint")}</p>
        {invalid && <p className="login-error">{t("rename.invalidPattern")}</p>}
        {error && <p className="login-error">{error}</p>}
        {loading && <p className="identify-hint">{t("rename.loading")}</p>}
        {preview && <>
          <div className="rename-chips">
            <i className="library-badge">{t("rename.countRename", { count: renameCount })}</i>
            <i className="library-badge">{t("rename.countSame", { count: sameCount })}</i>
            <i className="library-badge">{t("rename.countBlocked", { count: blockedCount })}</i>
          </div>
          <table className="rename-table">
            <thead><tr><th>{t("rename.colNow")}</th><th>{t("rename.colNew")}</th></tr></thead>
            <tbody>
              {preview.map((row) => <tr key={row.key}>
                <td className="rename-now">{row.from}</td>
                <td>{newCell(row)}</td>
              </tr>)}
            </tbody>
          </table>
        </>}
      </div>
      <footer className="dialog-foot">
        <p className="identify-hint">{t("rename.footerNote")}</p>
        <button type="button" onClick={onClose}>{t("common.cancel")}</button>
        <button type="button" className="primary" disabled={applyDisabled} onClick={apply}>
          {t("rename.apply", { count: renameCount })}
        </button>
      </footer>
    </div>
  </div>;
}
