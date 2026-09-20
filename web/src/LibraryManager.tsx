import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronRight, CornerLeftUp, FolderOpen, FolderPlus, HardDrive, Plus, RefreshCw, Search, SlidersHorizontal, Sparkles, Trash2, X } from "lucide-react";
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
  const [editing, setEditing] = useState<LibraryView | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const rows = await api.libraries();
    setLibraries(rows);
    return rows;
  };
  useEffect(() => { void load().catch(onError); }, []);

  const patch = async (library: LibraryView, body: Parameters<typeof api.updateLibrary>[1], done = t("library.updated")) => {
    setBusy(true);
    try { await api.updateLibrary(library.id, body); await load(); onChanged?.(); onNotify(done); return true; }
    catch (error) { onError(error); return false; }
    finally { setBusy(false); }
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
    if (!confirm(t(forget ? "library.removeForgetConfirm" : "library.removeConfirm", { name: library.name }))) return false;
    setBusy(true);
    try { await api.deleteLibrary(library.id, forget); await load(); onChanged?.(); onNotify(t("library.removed")); return true; }
    catch (error) { onError(error); return false; }
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
          <i className="library-badge">{libraryTypeLabel(library.type)}</i>
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
      {!restricted && <footer className="library-admin-footer">
        <button onClick={() => setEditing(library)} disabled={busy}><SlidersHorizontal/> {t("library.editLibrary")}</button>
      </footer>}
    </article>)}
    {!libraries.length && <p className="identify-hint">{t("library.emptyText")}</p>}
    {editing && <LibraryEditDialog key={`${editing.id}:${editing.root}`} library={editing} libraryCount={libraries.length} onClose={() => setEditing(null)}
      onSave={async (body) => { if (await patch(editing, body)) setEditing(null); }}
      onScan={() => scan(editing)} onReroot={() => setPicker({ reroot: editing })}
      onRemove={async (forget) => { if (await remove(editing, forget)) setEditing(null); }}/>
    }
    {picker && <RootPicker reroot={picker.reroot} onClose={() => setPicker(null)} onError={onError} onLibrariesChanged={onChanged}
      onDone={async (message) => { setPicker(null); const rows = await load(); const updated = rows.find((row) => row.id === picker.reroot?.id); if (updated) setEditing(updated); onChanged?.(); onNotify(message); }}/>
    }
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
    <div className="panel identify-card dialog-split library-manager-card">
      <div className="identify-head">
        <h2>{t("library.libraries")}</h2>
        <button type="button" className="icon-button" aria-label={t("common.close")} onClick={onClose}><X/></button>
      </div>
      <div className="dialog-body">
        <LibraryManager {...rest} />
      </div>
    </div>
  </div>;
}

type LibrarySettingsPatch = Parameters<typeof api.updateLibrary>[1];

function LibraryEditDialog({ library, libraryCount, onClose, onSave, onScan, onReroot, onRemove }:
  { library: LibraryView; libraryCount: number; onClose: () => void; onSave: (patch: LibrarySettingsPatch) => Promise<void>; onScan: () => Promise<void>; onReroot: () => void; onRemove: (forget: boolean) => Promise<void> }) {
  useI18n();
  const [draft, setDraft] = useState(() => ({
    name: library.name, type: library.type, enabled: library.enabled, writeArtwork: library.writeArtwork,
    mosaic: library.mosaic !== false, showInContinueWatching: library.showInContinueWatching !== false,
    defaultMovie: library.defaultMovie, defaultSeries: library.defaultSeries,
  }));
  const [busy, setBusy] = useState(false);
  const serves = (kind: "movie" | "series") => draft.type === kind || draft.type === "mixed";
  const dirty = draft.name.trim() !== library.name || draft.type !== library.type || draft.enabled !== library.enabled
    || draft.writeArtwork !== library.writeArtwork || draft.mosaic !== (library.mosaic !== false)
    || draft.showInContinueWatching !== (library.showInContinueWatching !== false)
    || draft.defaultMovie !== library.defaultMovie || draft.defaultSeries !== library.defaultSeries;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  const update = (patch: Partial<typeof draft>) => setDraft((current) => ({ ...current, ...patch }));
  const setType = (type: LibraryType) => update({ type, ...(type === "movie" ? { defaultSeries: false } : type === "series" ? { defaultMovie: false } : {}) });
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); }
    finally { setBusy(false); }
  };
  const save = async () => {
    const name = draft.name.trim();
    if (!name || !dirty) return;
    const patch: LibrarySettingsPatch = {};
    if (name !== library.name) patch.name = name;
    if (draft.type !== library.type) patch.type = draft.type;
    if (draft.enabled !== library.enabled) patch.enabled = draft.enabled;
    if (draft.writeArtwork !== library.writeArtwork) patch.writeArtwork = draft.writeArtwork;
    if (draft.mosaic !== (library.mosaic !== false)) patch.mosaic = draft.mosaic;
    if (draft.showInContinueWatching !== (library.showInContinueWatching !== false)) patch.showInContinueWatching = draft.showInContinueWatching;
    if (draft.defaultMovie !== library.defaultMovie) patch.defaultMovie = draft.defaultMovie;
    if (draft.defaultSeries !== library.defaultSeries) patch.defaultSeries = draft.defaultSeries;
    await run(() => onSave(patch));
  };
  const toggle = (key: "enabled" | "writeArtwork" | "mosaic" | "showInContinueWatching" | "defaultMovie" | "defaultSeries", label: string, disabled = false, title?: string) =>
    <label className="library-check" title={title}>
      <span className="switch"><input type="checkbox" checked={draft[key]} disabled={busy || disabled}
        onChange={(event) => update({ [key]: event.target.checked } as Partial<typeof draft>)}/><span/></span>
      <span>{label}</span>
    </label>;

  return <div className="identify-overlay" role="dialog" aria-modal="true" aria-label={t("library.editLibrary")}
    onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="panel identify-card dialog-split library-edit-card" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="identify-head">
        <h2>{t("library.editLibrary")}</h2>
        <button type="button" className="icon-button" aria-label={t("common.close")} disabled={busy} onClick={onClose}><X/></button>
      </div>
      <div className="dialog-body library-edit-body">
        <section className="library-edit-section">
          <div className="library-picker-section-head"><h3>{t("library.detailsHeading")}</h3></div>
          <div className="library-picker-fields">
            <label><span>{t("library.libraryName")}</span><input value={draft.name} autoComplete="off" aria-label={t("library.libraryName")} onChange={(event) => update({ name: event.target.value })}/></label>
            <label><span>{t("library.libraryType")}</span><select value={draft.type} aria-label={t("library.libraryType")} disabled={busy} onChange={(event) => setType(event.target.value as LibraryType)}>{TYPES.map((type) => <option key={type} value={type}>{libraryTypeLabel(type)}</option>)}</select></label>
          </div>
          <div className="library-edit-folder"><span>{t("library.folderHeading")}</span><strong title={library.root}>{library.root}</strong><button type="button" disabled={busy} onClick={onReroot}><FolderOpen/> {t("library.reroot")}</button></div>
        </section>
        <section className="library-edit-section">
          <div className="library-picker-section-head"><h3>{t("library.availabilityHeading")}</h3></div>
          <div className="library-edit-controls">
            {toggle("enabled", t("library.enabled"))}
            <div className="library-edit-defaults"><strong>{t("library.defaultDestinations")}</strong>
              {toggle("defaultMovie", t("library.defaultMovie"), !serves("movie"), !serves("movie") ? t("library.defaultTypeHint") : undefined)}
              {toggle("defaultSeries", t("library.defaultSeries"), !serves("series"), !serves("series") ? t("library.defaultTypeHint") : undefined)}
            </div>
          </div>
        </section>
        <section className="library-edit-section">
          <div className="library-picker-section-head"><h3>{t("library.presentationHeading")}</h3></div>
          <div className="library-edit-controls">
            {toggle("writeArtwork", t("library.writeArtwork"), library.readOnly)}
            {toggle("mosaic", t("library.mosaic"))}
            {toggle("showInContinueWatching", t("library.showInContinueWatching"))}
          </div>
        </section>
        <section className="library-edit-section">
          <div className="library-picker-section-head"><h3>{t("library.actionsHeading")}</h3></div>
          <button type="button" className="library-admin-scan" disabled={busy} onClick={() => void run(onScan)}><Sparkles/> {t("library.scanThis")}</button>
          <details className="library-admin-danger">
            <summary><Trash2/> {t("library.removeOptions")}</summary>
            <div>{libraryCount > 1
              ? <><button type="button" className="danger" disabled={busy} onClick={() => void run(() => onRemove(false))}><Trash2/> {t("library.removeLibrary")}</button>
                <button type="button" className="danger" disabled={busy} onClick={() => void run(() => onRemove(true))}><Trash2/> {t("library.removeForget")}</button></>
              : <p className="identify-hint">{t("library.removeLastHint")}</p>}</div>
          </details>
        </section>
      </div>
      <footer className="dialog-foot library-edit-footer"><button type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</button><button className="primary" disabled={busy || !dirty || !draft.name.trim()}>{t("library.saveChanges")}</button></footer>
    </form>
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
  // Pointing at a folder and moving the tree into it are two different intentions with the
  // same destination, so they are one choice rather than two buttons that look alike.
  const [carryContent, setCarryContent] = useState(false);
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
      if (reroot && carryContent) {
        // The library follows its content, so there is nothing to scan yet and nothing to
        // report beyond the job having started.
        await api.rerootLibrary(reroot.id, { root: selected, ...(pendingCreate ? { create: true } : {}) });
        onDone(t("library.rerootMoveStarted"));
        return;
      }
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
  // Why the confirm is dead, in the user's words. It used to be `disabled` and nothing else,
  // and at phone height the field it was waiting on is scrolled out of sight.
  const blocked = !selected ? t("library.pickerNeedsFolder")
    : !reroot && !name.trim() ? t("library.pickerNeedsName")
    : "";
  const crumbs = browse && browse.path ? browse.path.split("/") : [];
  const visibleEntries = browse?.entries.filter((entry) => entry.name.toLocaleLowerCase().includes(folderFilter.trim().toLocaleLowerCase())) ?? [];
  return <div className="identify-overlay" role="dialog" aria-modal="true" aria-label={t("library.chooseFolder")}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="panel identify-card dialog-split library-picker-card">
      <div className="identify-head">
        <h2>{reroot ? t("library.reroot") : t("library.addLibrary")}</h2>
        <button type="button" className="icon-button" aria-label={t("common.close")} onClick={onClose}><X/></button>
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
      {/* Everything that appears, disappears or resizes lives in the body. In the footer it
          resized the footer, and the folder list above it moved under the cursor: picking a
          folder made the list 49px shorter, because the estimate and the scan switch arrived
          underneath it. At 667x375 it had eaten the dialog -- 313px of footer, 14px of body,
          and the confirm button off the bottom of the screen. */}
      <section className="library-picker-section library-picker-outcome">
        {reroot && <fieldset className="library-reroot-choice">
          <legend>{t("library.rerootWhat")}</legend>
          <label><input type="radio" name="reroot-mode" checked={!carryContent} onChange={() => setCarryContent(false)}/>
            <span><strong>{t("library.rerootPointOnly")}</strong>{t("library.rerootPointOnlyHint")}</span></label>
          <label><input type="radio" name="reroot-mode" checked={carryContent} onChange={() => setCarryContent(true)}/>
            <span><strong>{t("library.rerootMove")}</strong>{t("library.rerootMoveHint")}</span></label>
        </fieldset>}
        <div className={`library-picker-selection${selected ? " selected" : ""}`} aria-live="polite">
          <span>{t("library.selectedFolder")}</span>
          <strong title={selected}>{selected || t("library.pickerNothingSelected")}</strong>
          {pendingCreate && <p>{t(reroot ? "library.newFolderPendingReroot" : "library.newFolderPending")}</p>}
          {estimate && <p className="library-picker-estimate">
            {t("library.estimate", { titles: estimate.titles, files: estimate.files })}
            {estimate.identified ? ` · ${t("library.estimateIdentified", { count: estimate.identified })}` : ""}
            {estimate.truncated ? ` · ${t("library.estimateTruncated")}` : ""}
          </p>}
          {selected && !(reroot && carryContent) && <label className="library-scan-now">
            <span className="switch"><input type="checkbox" checked={scanNow} onChange={(event) => setScanNow(event.target.checked)}/><span/></span>
            <span>{t("library.scanNow")}</span></label>}
        </div>
      </section>
      </div>
      <footer className="library-picker-footer dialog-foot">
        {error && <p className="login-error">{error}</p>}
        <div className="library-picker-actions">
          {/* One line, always present, never taller: what will be confirmed, or why it
              cannot be. The folder stays next to the button that acts on it -- that part of
              the old footer was right -- while everything that changes height moved into
              the body, which is what had made this footer 313px of a 375px dialog. And a
              primary that is dead for a reason scrolled out of sight was the picker's
              oldest complaint, so the same line carries the reason. */}
          <p className={`library-picker-status${blocked ? " blocked" : ""}`} title={blocked || selected} aria-live="polite">
            {blocked || selected}
          </p>
          <button type="button" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
          <button type="button" className="primary" disabled={busy || Boolean(blocked)} onClick={() => void apply()}>
            {reroot ? (carryContent ? t("library.rerootMoveConfirm") : t("library.rerootConfirm")) : t("library.addConfirm")}
          </button>
        </div>
      </footer>
    </div>
  </div>;
}
