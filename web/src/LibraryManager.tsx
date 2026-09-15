import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronRight, CornerLeftUp, FolderOpen, FolderPlus, HardDrive, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2, X } from "lucide-react";
import { api, describeError } from "./api";
import { t, useI18n } from "./i18n";
import { bytes, SettingControl, SettingsSectionHead } from "./settings-ui";
import type { GrantBrowse, LibraryEstimate, LibraryGrant, LibraryType, LibraryView } from "./types";

export const libraryTypeLabel = (type: LibraryType) =>
  t(type === "movie" ? "library.libraryTypeMovie" : type === "series" ? "library.libraryTypeSeries" : "library.libraryTypeMixed");

const TYPES: LibraryType[] = ["movie", "series", "mixed"];

/** Settings panel and, through the wrapper below, the dialog the library tools menu opens.
 *  Restricted mode keeps the list readable and drops every control: the writes are denied
 *  at the API, and a button that only ever answers 403 should not be on screen. */
export function LibraryManager({ restricted = false, onChanged, onError, onNotify }:
  { restricted?: boolean; onChanged?: () => void; onError: (error: unknown) => void; onNotify: (message: string) => void }) {
  useI18n();
  const [libraries, setLibraries] = useState<LibraryView[]>([]);
  const [picker, setPicker] = useState<{ reroot?: LibraryView } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => setLibraries(await api.libraries());
  useEffect(() => { void load().catch(onError); }, []);

  const patch = async (library: LibraryView, body: Parameters<typeof api.updateLibrary>[1], done: string) => {
    setBusy(true);
    try { await api.updateLibrary(library.id, body); await load(); onChanged?.(); onNotify(done); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  const rename = (library: LibraryView) => {
    const wanted = prompt(t("library.renamePrompt"), library.name);
    if (wanted && wanted !== library.name) void patch(library, { name: wanted }, t("library.updated"));
  };
  const scan = async (library: LibraryView) => {
    try { await api.startLibraryScan({ libraryId: library.id }); onNotify(t("library.scanStarted")); }
    catch (error) { onError(error); }
  };
  /** The list is shown in `order`, which nothing set until now. Moving a row rewrites the
   *  whole sequence: existing records can share an order or leave gaps, and swapping two
   *  numbers in that state does not always move anything. */
  const reorder = async (index: number, delta: number) => {
    const next = [...libraries];
    const other = next[index + delta];
    const moved = next[index];
    if (!other || !moved) return;
    next[index + delta] = moved;
    next[index] = other;
    setBusy(true);
    try {
      for (const [position, library] of next.entries()) {
        if (library.order !== position) await api.updateLibrary(library.id, { order: position });
      }
      await load();
      onChanged?.();
    } catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  const remove = async (library: LibraryView, forget: boolean) => {
    if (!confirm(t(forget ? "library.removeForgetConfirm" : "library.removeConfirm", { name: library.name }))) return;
    setBusy(true);
    try { await api.deleteLibrary(library.id, forget); await load(); onChanged?.(); onNotify(t("library.removed")); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  };

  return <div className="library-manager">
    {restricted
      ? <p className="identify-hint">{t("library.restrictedHint")}</p>
      : <div className="library-manager-actions">
        <button className="primary" onClick={() => setPicker({})}><Plus/> {t("library.addLibrary")}</button>
        <button onClick={() => void load().catch(onError)} disabled={busy}><RefreshCw/> {t("common.refresh")}</button>
      </div>}
    {libraries.map((library, index) => <article className={`library-admin-row${library.unreachable ? " unreachable" : ""}`} key={library.id}>
      <div className="library-admin-head">
        <div className="library-admin-title">
          <strong>{library.name}</strong>
          <small className="library-admin-root" title={library.root}>{library.root}</small>
        </div>
        <span className="library-admin-flags">
          {restricted && <i className="library-badge">{libraryTypeLabel(library.type)}</i>}
          {library.defaultMovie && <i className="library-badge">{t("library.defaultMovie")}</i>}
          {library.defaultSeries && <i className="library-badge">{t("library.defaultSeries")}</i>}
          {!library.enabled && <i className="library-badge off">{t("library.disabled")}</i>}
          {library.unreachable && <i className="library-badge warn">{t("library.unreachable")}</i>}
          {library.readOnly && <i className="library-badge warn">{t("library.readOnly")}</i>}
        </span>
        {!restricted && libraries.length > 1 && <span className="library-admin-order">
          <button type="button" className="icon-button" disabled={busy || index === 0}
            aria-label={t("library.orderUp", { name: library.name })} title={t("library.orderUp", { name: library.name })}
            onClick={() => void reorder(index, -1)}><ArrowUp/></button>
          <button type="button" className="icon-button" disabled={busy || index === libraries.length - 1}
            aria-label={t("library.orderDown", { name: library.name })} title={t("library.orderDown", { name: library.name })}
            onClick={() => void reorder(index, 1)}><ArrowDown/></button>
        </span>}
      </div>
      <small className="library-admin-counts">{t("library.libraryCounts", { titles: library.titles, files: library.files, size: bytes(library.bytes) })}</small>
      {!restricted && <div className="library-admin-controls">
        <label><span>{t("library.libraryType")}</span>
          <select aria-label={t("library.libraryType")} value={library.type} disabled={busy}
            onChange={(event) => void patch(library, { type: event.target.value as LibraryType }, t("library.updated"))}>
            {TYPES.map((type) => <option key={type} value={type}>{libraryTypeLabel(type)}</option>)}
          </select></label>
        <label className="library-check"><input type="checkbox" checked={library.enabled} disabled={busy}
          onChange={(event) => void patch(library, { enabled: event.target.checked }, t("library.updated"))}/> <span>{t("library.enabled")}</span></label>
        <label className="library-check"><input type="checkbox" checked={library.writeArtwork} disabled={busy || library.readOnly}
          onChange={(event) => void patch(library, { writeArtwork: event.target.checked }, t("library.updated"))}/> <span>{t("library.writeArtwork")}</span></label>
      </div>}
      {!restricted && <footer className="library-admin-footer">
        <div className="library-admin-buttons">
          <button className="library-admin-scan" onClick={() => void scan(library)}><Sparkles/> {t("library.scanThis")}</button>
          <button onClick={() => setPicker({ reroot: library })}><FolderOpen/> {t("library.reroot")}</button>
          <button onClick={() => void rename(library)}><Pencil/> {t("library.rename")}</button>
        </div>
        <details className="library-admin-danger">
          <summary><Trash2/> {t("library.removeOptions")}</summary>
          <div>
            {libraries.length > 1
              ? <>
                <button className="danger" onClick={() => void remove(library, false)}><Trash2/> {t("library.removeLibrary")}</button>
                <button className="danger" onClick={() => void remove(library, true)}><Trash2/> {t("library.removeForget")}</button>
              </>
              : <p className="identify-hint">{t("library.removeLastHint")}</p>}
          </div>
        </details>
      </footer>}
    </article>)}
    {!libraries.length && <p className="identify-hint">{t("library.emptyText")}</p>}
    {picker && <RootPicker reroot={picker.reroot} onClose={() => setPicker(null)} onError={onError} onLibrariesChanged={onChanged}
      onDone={async (message) => { setPicker(null); await load(); onChanged?.(); onNotify(message); }}/>}
  </div>;
}

/** The same panel behind an overlay, for the library tools menu. */
export function LibraryManagerDialog({ onClose, ...rest }: Parameters<typeof LibraryManager>[0] & { onClose: () => void }) {
  useI18n();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div className="identify-overlay" role="dialog" aria-modal="true" aria-label={t("library.libraries")}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="panel identify-card library-manager-card">
      <div className="identify-head">
        <h2>{t("library.libraries")}</h2>
        <button type="button" className="icon-button" aria-label={t("common.cancel")} onClick={onClose}><X/></button>
      </div>
      <LibraryManager {...rest} />
    </div>
  </div>;
}

/** Picks a root out of the granted folders, or grants a new one by hand: a server has no
 *  native dialog, so the path has to be typeable, and the estimate is what tells the user
 *  what the scan behind the confirmation will cost. */
function RootPicker({ reroot, onClose, onDone, onError, onLibrariesChanged }:
  { reroot?: LibraryView; onClose: () => void; onDone: (message: string) => void; onError: (error: unknown) => void; onLibrariesChanged?: () => void }) {
  useI18n();
  const [browse, setBrowse] = useState<GrantBrowse | null>(null);
  const [grants, setGrants] = useState<LibraryGrant[]>([]);
  const [selected, setSelected] = useState(reroot?.root ?? "");
  const [name, setName] = useState(reroot?.name ?? "");
  const [type, setType] = useState<LibraryType>(reroot?.type ?? "mixed");
  const [manual, setManual] = useState("");
  const [manualActive, setManualActive] = useState(false);
  const [newFolder, setNewFolder] = useState("");
  const [newFolderActive, setNewFolderActive] = useState(false);
  const [folderFilter, setFolderFilter] = useState("");
  const [folderFilterActive, setFolderFilterActive] = useState(false);
  // The selection can name a folder that is not on disk yet: the request that applies it
  // makes it, inside the grant the browsed folder sits in.
  const [pendingCreate, setPendingCreate] = useState(false);
  const [estimate, setEstimate] = useState<LibraryEstimate | null>(null);
  const [scanNow, setScanNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async (target = "") => {
    setBusy(true);
    try { setBrowse(await api.browseGrants(target)); setGrants(await api.libraryGrants()); setFolderFilter(""); setError(""); }
    catch (value) { setError(describeError(value)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    setEstimate(null);
    if (!selected || pendingCreate) return;
    let stale = false;
    void api.previewLibrary({ root: selected, type })
      .then((value) => { if (!stale) setEstimate(value); })
      .catch(() => undefined);
    return () => { stale = true; };
  }, [selected, type, pendingCreate]);

  const select = (target: string) => { setPendingCreate(false); setSelected(target); };
  /** The folder is named here and created by the request that adds the library, so a
   *  cancelled flow leaves nothing behind on disk. */
  const createFolder = () => {
    const name = newFolder.trim();
    if (!name || !browse?.path) return;
    // Both separators, the characters a name may not carry anywhere, and the two dot names:
    // the server would turn them into something else rather than refuse them.
    if (name === "." || name === ".." || /[/\\:*?"<>|]/.test(name)) { setError(t("library.newFolderInvalid")); return; }
    setError("");
    setNewFolder("");
    setName((current) => current || name);
    setPendingCreate(true);
    setSelected(`${browse.path.replace(/\/+$/, "")}/${name}`);
  };

  const grant = async () => {
    const wanted = manual.trim();
    if (!wanted) return;
    setBusy(true);
    try {
      await api.grantLibraryRoot(wanted);
      setManual("");
      select(wanted);
      await load(wanted);
    } catch (value) { setError(describeError(value)); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const library = reroot
        ? await api.updateLibrary(reroot.id, { root: selected, ...(pendingCreate ? { create: true } : {}) })
        : await api.createLibrary({ name: name.trim(), type, root: selected, ...(pendingCreate ? { create: true } : {}) });
      if (scanNow) await api.startLibraryScan({ libraryId: library.id });
      onDone(t(reroot ? "library.rerooted" : "library.created"));
    } catch (value) { setError(describeError(value)); setBusy(false); }
  };

  // The grant the browsed folder sits in, longest match: revoking it is the only way back
  // from a folder that was granted by mistake, and an operator grant is rebuilt on boot.
  const currentGrant = browse?.path
    ? grants.filter((grant) => browse.path === grant.path || browse.path.startsWith(grant.path.endsWith("/") ? grant.path : `${grant.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0]
    : undefined;
  const revoke = async (grant: LibraryGrant) => {
    if (!confirm(t("library.revokeGrantConfirm", { path: grant.path }))) return;
    setBusy(true);
    try { await api.revokeLibraryGrant(grant.path); select(""); await load(""); onLibrariesChanged?.(); }
    catch (value) { setError(describeError(value)); }
    finally { setBusy(false); }
  };
  const crumbs = browse && browse.path ? browse.path.split("/") : [];
  const visibleEntries = browse?.entries.filter((entry) => entry.name.toLocaleLowerCase().includes(folderFilter.trim().toLocaleLowerCase())) ?? [];
  return <div className="identify-overlay" role="dialog" aria-modal="true" aria-label={t("library.chooseFolder")}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="panel identify-card dialog-split library-picker-card">
      <div className="identify-head">
        <h2>{reroot ? t("library.reroot") : t("library.addLibrary")}</h2>
        <button type="button" className="icon-button" aria-label={t("common.cancel")} onClick={onClose}><X/></button>
      </div>
      <div className="dialog-body">
      {!reroot && <section className="library-picker-section library-picker-details">
        <div className="library-picker-section-head">
          <h3>{t("library.detailsHeading")}</h3>
          <p>{t("library.detailsHint")}</p>
        </div>
        <div className="library-picker-fields">
        <label><span>{t("library.libraryName")}</span>
          <input value={name} autoComplete="off" aria-label={t("library.libraryName")} placeholder={t("library.libraryNameHint")} onChange={(event) => setName(event.target.value)}/></label>
        <label><span>{t("library.libraryType")}</span>
          <select aria-label={t("library.libraryType")} value={type} onChange={(event) => setType(event.target.value as LibraryType)}>
            {TYPES.map((value) => <option key={value} value={value}>{libraryTypeLabel(value)}</option>)}
          </select></label>
        </div>
      </section>}
      <section className="library-picker-section">
        <div className="library-picker-section-head">
          <h3>{t("library.folderHeading")}</h3>
          <p>{t("library.folderHint")}</p>
        </div>
        <nav className="move-crumbs" aria-label={t("library.chooseFolder")}>
          <button type="button" onClick={() => void load("")}><HardDrive/> {t("library.rootFolder")}</button>
          {crumbs.map((part, index) => <span key={part + index}>
            <ChevronRight aria-hidden="true"/>
            <button type="button" onClick={() => void load(crumbs.slice(0, index + 1).join("/"))}>{part}</button>
          </span>)}
        </nav>
        <label className="library-folder-filter">
          <Search aria-hidden="true"/>
          <input type="search" name="library-folder-filter" value={folderFilter} readOnly={!folderFilterActive} autoComplete="off"
            data-1p-ignore="true" data-lpignore="true" spellCheck={false} onFocus={() => { setFolderFilterActive(true); setFolderFilter(""); }}
            aria-label={t("library.filterFolders")} placeholder={t("library.filterFoldersHint")}
            onChange={(event) => setFolderFilter(event.target.value)}/>
        </label>
        <div className="move-list">
          {browse?.path && <button type="button" className="move-up" onClick={() => void load(browse.parent ?? "")}><CornerLeftUp/> {t("library.moveUp")}</button>}
          {visibleEntries.map((entry) => <div className={`move-row${selected === entry.path ? " picked" : ""}`} key={entry.path}>
            <button type="button" onClick={() => void load(entry.path)}>
              <FolderOpen/> <span>{entry.name}{entry.libraryRoot && <i className="library-badge">{t("library.rootFolder")}</i>}</span>
              <ChevronRight/>
            </button>
            <button type="button" className="move-row-pick" aria-label={t("library.selectFolder", { name: entry.name })}
              title={t("library.selectFolder", { name: entry.name })} onClick={() => select(entry.path)}><Check/></button>
          </div>)}
          {!busy && browse && !browse.entries.length && <p className="identify-hint">{t("library.pickerEmpty")}</p>}
          {!busy && browse && !!browse.entries.length && !visibleEntries.length && <p className="identify-hint">{t("library.noFilteredFolders")}</p>}
        </div>
        {browse?.path
          ? <button type="button" className="library-picker-use" onClick={() => select(browse.path)}>
            <FolderOpen/> {t("library.useThisFolder")}
          </button>
          : <p className="identify-hint">{t("library.pickerGrantHint")}</p>}
        {browse?.path && <div className="library-picker-manual library-picker-create">
          <input value={newFolder} readOnly={!newFolderActive} autoComplete="off" data-1p-ignore="true" data-lpignore="true"
            onFocus={() => { setNewFolderActive(true); setNewFolder(""); }} aria-label={t("library.newFolder")} placeholder={t("library.newFolderHint")}
            onChange={(event) => setNewFolder(event.target.value)}/>
          <button type="button" onClick={createFolder} disabled={busy || !newFolder.trim()}><FolderPlus/> {t("library.newFolder")}</button>
        </div>}
        <details className="library-picker-advanced">
          <summary>{t("library.folderNotListed")}</summary>
          <p>{t("library.grantExplanation")}</p>
          <div className="library-picker-manual">
            <input value={manual} readOnly={!manualActive} autoComplete="off" data-1p-ignore="true" data-lpignore="true"
              onFocus={() => { setManualActive(true); setManual(""); }} aria-label={t("library.grantFolder")} placeholder={t("library.grantHint")}
              onChange={(event) => setManual(event.target.value)}/>
            <button type="button" onClick={() => void grant()} disabled={busy || !manual.trim()}>{t("library.grantFolder")}</button>
          </div>
          {currentGrant?.source === "user" && <button type="button" className="danger" onClick={() => void revoke(currentGrant)} disabled={busy}>
            <Trash2/> {t("library.revokeGrant")}
          </button>}
        </details>
      </section>
      </div>
      <footer className="library-picker-footer dialog-foot">
        <div className={`library-picker-selection${selected ? " selected" : ""}`} aria-live="polite">
          <span>{t("library.selectedFolder")}</span>
          <strong title={selected}>{selected || t("library.pickerNothingSelected")}</strong>
          {pendingCreate && <p>{t("library.newFolderPending")}</p>}
          {estimate && <p className="library-picker-estimate">
            {t("library.estimate", { titles: estimate.titles, files: estimate.files })}
            {estimate.identified ? ` · ${t("library.estimateIdentified", { count: estimate.identified })}` : ""}
            {estimate.truncated ? ` · ${t("library.estimateTruncated")}` : ""}
          </p>}
          {selected && <label className="library-scan-now"><input type="checkbox" checked={scanNow} onChange={(event) => setScanNow(event.target.checked)}/> <span>{t("library.scanNow")}</span></label>}
        </div>
        {error && <p className="login-error">{error}</p>}
        <button type="button" className="primary" disabled={busy || !selected || (!reroot && !name.trim())} onClick={() => void apply()}>
          {reroot ? t("library.rerootConfirm") : t("library.addConfirm")}
        </button>
      </footer>
    </div>
  </div>;
}
