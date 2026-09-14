import { useEffect, useState } from "react";
import { ChevronRight, CornerLeftUp, FolderOpen, FolderPlus, HardDrive, Pencil, Plus, RefreshCw, Sparkles, Trash2, X } from "lucide-react";
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
    {libraries.map((library) => <article className={`library-admin-row${library.unreachable ? " unreachable" : ""}`} key={library.id}>
      <div className="library-admin-head">
        <strong>{library.name}</strong>
        <span className="library-admin-flags">
          <i className="library-badge">{libraryTypeLabel(library.type)}</i>
          {library.defaultMovie && <i className="library-badge">{t("library.defaultMovie")}</i>}
          {library.defaultSeries && <i className="library-badge">{t("library.defaultSeries")}</i>}
          {!library.enabled && <i className="library-badge off">{t("library.disabled")}</i>}
          {library.unreachable && <i className="library-badge warn">{t("library.unreachable")}</i>}
          {library.readOnly && <i className="library-badge warn">{t("library.readOnly")}</i>}
        </span>
      </div>
      <small className="library-admin-root" title={library.root}>{library.root}</small>
      <small>{t("library.libraryCounts", { titles: library.titles, files: library.files, size: bytes(library.bytes) })}</small>
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
      {!restricted && <div className="library-admin-buttons">
        <button onClick={() => void rename(library)}><Pencil/> {t("library.rename")}</button>
        <button onClick={() => void scan(library)}><Sparkles/> {t("library.scanThis")}</button>
        <button onClick={() => setPicker({ reroot: library })}><FolderOpen/> {t("library.reroot")}</button>
        <button className="danger" onClick={() => void remove(library, false)}><Trash2/> {t("library.removeLibrary")}</button>
        <button className="danger" onClick={() => void remove(library, true)}><Trash2/> {t("library.removeForget")}</button>
      </div>}
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
  const [newFolder, setNewFolder] = useState("");
  // The selection can name a folder that is not on disk yet: the create request makes it,
  // inside the grant the browsed folder sits in. Re-rooting never creates anything.
  const [pendingCreate, setPendingCreate] = useState(false);
  const [estimate, setEstimate] = useState<LibraryEstimate | null>(null);
  const [scanNow, setScanNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async (target = "") => {
    setBusy(true);
    try { setBrowse(await api.browseGrants(target)); setGrants(await api.libraryGrants()); setError(""); }
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
        ? await api.updateLibrary(reroot.id, { root: selected })
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
  return <div className="identify-overlay" role="dialog" aria-modal="true" aria-label={t("library.chooseFolder")}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="panel identify-card library-picker-card">
      <div className="identify-head">
        <h2>{reroot ? t("library.reroot") : t("library.addLibrary")}</h2>
        <button type="button" className="icon-button" aria-label={t("common.cancel")} onClick={onClose}><X/></button>
      </div>
      <nav className="move-crumbs" aria-label={t("library.chooseFolder")}>
        <button type="button" onClick={() => void load("")}><HardDrive/> {t("library.rootFolder")}</button>
        {crumbs.map((part, index) => <span key={part + index}>
          <ChevronRight aria-hidden="true"/>
          <button type="button" onClick={() => void load(crumbs.slice(0, index + 1).join("/"))}>{part}</button>
        </span>)}
      </nav>
      <div className="move-list">
        {browse?.path && <button type="button" className="move-up" onClick={() => void load(browse.parent ?? "")}><CornerLeftUp/> {t("library.moveUp")}</button>}
        {browse?.entries.map((entry) => <button type="button" key={entry.path} onClick={() => void load(entry.path)}>
          <FolderOpen/> <span>{entry.name}{entry.libraryRoot && <i className="library-badge">{t("library.rootFolder")}</i>}</span>
          <ChevronRight/>
        </button>)}
        {!busy && browse && !browse.entries.length && <p className="identify-hint">{t("library.pickerEmpty")}</p>}
      </div>
      {!reroot && browse?.path && <div className="library-picker-manual">
        <input value={newFolder} aria-label={t("library.newFolder")} placeholder={t("library.newFolderHint")}
          onChange={(event) => setNewFolder(event.target.value)}/>
        <button type="button" onClick={createFolder} disabled={busy || !newFolder.trim()}><FolderPlus/> {t("library.newFolder")}</button>
      </div>}
      <div className="library-picker-manual">
        <input value={manual} aria-label={t("library.grantFolder")} placeholder={t("library.grantHint")}
          onChange={(event) => setManual(event.target.value)}/>
        <button type="button" onClick={() => void grant()} disabled={busy || !manual.trim()}>{t("library.grantFolder")}</button>
      </div>
      {currentGrant?.source === "user" && <button type="button" className="danger" onClick={() => void revoke(currentGrant)} disabled={busy}>
        <Trash2/> {t("library.revokeGrant")}
      </button>}
      <button type="button" className="library-picker-use" disabled={!browse?.path} onClick={() => select(browse!.path)}>
        <FolderOpen/> {t("library.useThisFolder")}
      </button>
      <p className="identify-hint">{selected || t("library.pickerNothingSelected")}</p>
      {pendingCreate && <p className="identify-hint">{t("library.newFolderPending")}</p>}
      {estimate && <p className="identify-hint">
        {t("library.estimate", { titles: estimate.titles, files: estimate.files })}
        {estimate.identified ? ` · ${t("library.estimateIdentified", { count: estimate.identified })}` : ""}
        {estimate.truncated ? ` · ${t("library.estimateTruncated")}` : ""}
      </p>}
      {selected && <label className="library-scan-now"><input type="checkbox" checked={scanNow} onChange={(event) => setScanNow(event.target.checked)}/> <span>{t("library.scanNow")}</span></label>}
      {!reroot && selected && <div className="library-picker-fields">
        <label><span>{t("library.libraryName")}</span>
          <input value={name} aria-label={t("library.libraryName")} placeholder={t("library.libraryNameHint")} onChange={(event) => setName(event.target.value)}/></label>
        <label><span>{t("library.libraryType")}</span>
          <select aria-label={t("library.libraryType")} value={type} onChange={(event) => setType(event.target.value as LibraryType)}>
            {TYPES.map((value) => <option key={value} value={value}>{libraryTypeLabel(value)}</option>)}
          </select></label>
      </div>}
      {error && <p className="login-error">{error}</p>}
      <button type="button" className="primary" disabled={busy || !selected} onClick={() => void apply()}>
        {reroot ? t("library.rerootConfirm") : t("library.addConfirm")}
      </button>
    </div>
  </div>;
}
