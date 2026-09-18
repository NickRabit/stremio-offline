import { FormEvent, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Check, Copy, ExternalLink, FileJson, PackagePlus, Plus, RefreshCw, ShieldCheck, SlidersHorizontal, Trash2, X } from "lucide-react";
import { api } from "./api";
import { copyText } from "./clipboard";
import { Heading, hideBroken } from "./settings-ui";
import { t, useI18n } from "./i18n";
import type { Addon, AddonDownloadSettings, LibraryView } from "./types";

const ROLES: Addon["role"][] = ["both", "catalog", "source"];

const roleLabel = (role: Addon["role"]) =>
  t(role === "catalog" ? "addons.roleCatalog" : role === "source" ? "addons.roleSource" : "addons.roleBoth");
const roleSummary = (role: Addon["role"]) =>
  t(role === "catalog" ? "addons.isCatalog" : role === "source" ? "addons.isSource" : "addons.isBoth");

const providesStreams = (addon: Addon) =>
  (addon.manifest.resources ?? []).some((resource) => typeof resource === "string" ? resource === "stream" : resource.name === "stream");

const emptyDownloadSettings = (): AddonDownloadSettings =>
  ({ movie: { subfolder: "", layout: "structured" }, series: { subfolder: "", layout: "structured" } });
const cloneDownloadSettings = (value: AddonDownloadSettings): AddonDownloadSettings =>
  ({ movie: { ...value.movie }, series: { ...value.series } });

/** The addon page: a summary card per addon and one dialog that owns its settings.
 *  Only the two list actions -- the on/off switch and the priority arrows -- write
 *  straight away; everything else is staged in the dialog and saved in one PATCH. */
export function AddonManager({ addons, libraries = [], restricted = false, onChanged, onNotify, onError }:
  { addons: Addon[]; libraries?: LibraryView[]; restricted?: boolean; onChanged: () => Promise<void>; onNotify: (message: string) => void; onError: (error: unknown) => void }) {
  useI18n();
  const [url, setUrl] = useState(""); const [role, setRole] = useState<Addon["role"]>("both");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const editing = addons.find((addon) => addon.key === editingKey) ?? null;

  // A manifest is only read when the addon is added, so nothing here notices when the
  // provider adds a catalogue or stops serving a resource. This asks them all again.
  const refreshAll = async () => {
    setRefreshing(true);
    try {
      const { changed, failed } = await api.refreshAddons();
      await onChanged();
      const done = changed ? t("addons.refreshAllDone", { count: changed }) : t("addons.refreshAllNone");
      onNotify(failed ? `${done} ${t("addons.refreshAllFailed", { count: failed })}` : done);
    } catch (error) { onError(error); }
    finally { setRefreshing(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try { await api.addAddon(url, role); setUrl(""); await onChanged(); onNotify(t("addons.added")); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  const toggle = async (addon: Addon, enabled: boolean) => {
    try { await api.toggleAddon(addon.key, enabled); await onChanged(); }
    catch (error) { onError(error); }
  };
  const move = async (addon: Addon, direction: -1 | 1) => {
    try { await api.moveAddon(addon.key, direction); await onChanged(); }
    catch (error) { onError(error); }
  };

  const needle = filter.trim().toLowerCase();
  const matches = (addon: Addon) => !needle || addon.manifest.name.toLowerCase().includes(needle);
  const groups = [
    { key: "sources", title: t("addons.streamSources"), text: t("addons.streamSourcesText"), ordered: true, list: addons.filter((addon) => addon.role !== "catalog") },
    { key: "catalogs", title: t("addons.catalogsTitle"), text: t("addons.catalogsText"), ordered: false, list: addons.filter((addon) => addon.role === "catalog") },
  ].filter((group) => group.list.length > 0);
  const anyMatch = groups.some((group) => group.list.some(matches));

  return <section><Heading eyebrow={t("addons.eyebrow")} title={t("addons.title")}/>
    <p className="lead">{t("addons.leadBefore")} <code>manifest.json</code>. {t("addons.leadAfter")}</p>
    {restricted && <p className="notice">{t("restricted.notice")}</p>}
    {!restricted && <form className="panel addon-form" onSubmit={submit}>
      <label><span>{t("addons.manifestUrl")}</span>
        <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…/manifest.json" required/></label>
      <label><span>{t("addons.role")}</span>
        <select value={role} onChange={(event) => setRole(event.target.value as Addon["role"])}>
          {ROLES.map((value) => <option key={value} value={value}>{roleLabel(value)}</option>)}
        </select></label>
      <button className="primary" disabled={busy}><Plus/> {t("common.add")}</button>
    </form>}
    {addons.length > 0 && <div className="addon-tools">
      {addons.length > 8 && <input className="addon-filter" value={filter} aria-label={t("addons.filter")}
        placeholder={t("addons.filterPlaceholder")} onChange={(event) => setFilter(event.target.value)}/>}
      {!restricted && <button disabled={refreshing} onClick={() => void refreshAll()}><RefreshCw/> {t(refreshing ? "common.loading" : "addons.refreshAll")}</button>}
    </div>}
    {groups.map((group) => {
      const visible = group.list.filter(matches);
      if (!visible.length) return null;
      return <div className="addon-group" key={group.key}>
        <div className="subhead"><h3>{group.title}</h3><span>{group.text}</span></div>
        <div className="addon-grid">{visible.map((addon) => <AddonRow key={addon.key} addon={addon} restricted={restricted}
          index={group.ordered ? group.list.indexOf(addon) : -1} total={group.list.length} reorderable={group.ordered && !needle}
          onToggle={(enabled) => void toggle(addon, enabled)} onMove={(direction) => void move(addon, direction)}
          onEdit={() => setEditingKey(addon.key)}/>)}</div>
      </div>;
    })}
    {needle && !anyMatch && <p className="identify-hint">{t("addons.filterNoMatch")}</p>}
    {editing && <AddonEditDialog key={editing.key} addon={editing} libraries={libraries}
      onClose={() => setEditingKey(null)} onChanged={onChanged} onNotify={onNotify} onError={onError}
      onRemoved={() => setEditingKey(null)}/>}
  </section>;
}

/** The summary: everything needed to pick an addon out of a long list, and nothing to set. */
function AddonRow({ addon, restricted, index, total, reorderable, onToggle, onMove, onEdit }:
  { addon: Addon; restricted: boolean; index: number; total: number; reorderable: boolean;
    onToggle: (enabled: boolean) => void; onMove: (direction: -1 | 1) => void; onEdit: () => void }) {
  const catalogs = addon.manifest.catalogs?.length ?? 0;
  return <article className={`panel addon-card${addon.enabled ? "" : " disabled"}`}>
    <div className="addon-head">
      {addon.manifest.logo ? <img src={addon.manifest.logo} alt="" onError={hideBroken}/> : <div className="addon-logo"><PackagePlus/></div>}
      <div className="addon-body">
        <div className="addon-title"><h3 title={addon.manifest.name}>{addon.manifest.name}</h3>
          {addon.essential && <span className="addon-essential" title={t("addons.essential")}><ShieldCheck/></span>}</div>
        <p title={addon.manifest.description || addon.displayUrl}>{addon.manifest.description || addon.displayUrl}</p>
      </div>
      {!restricted && <label className="switch" title={addon.essential ? t("addons.essential") : undefined}>
        <input aria-label={t("addons.enabledFor", { addon: addon.manifest.name })} type="checkbox" checked={addon.enabled}
          disabled={addon.essential} onChange={(event) => onToggle(event.target.checked)}/><span/></label>}
    </div>
    <span className="addon-badges">
      <i className="library-badge">{addon.manifest.version}</i>
      <i className="library-badge">{roleSummary(addon.role)}</i>
      {catalogs > 0 && <i className="library-badge">{t("addons.badgeCatalogs", { count: catalogs })}</i>}
      {addon.manifest.behaviorHints?.p2p && <i className="library-badge p2p">P2P</i>}
      {addon.role !== "source" && !addon.globalSearch && <i className="library-badge">{t("addons.badgeNoGlobalSearch")}</i>}
      {!addon.enabled && <i className="library-badge off">{t("addons.badgeOff")}</i>}
    </span>
    {!restricted && <footer className="addon-card-footer">
      {index >= 0 && total > 1 && <span className="addon-order">
        <button type="button" className="icon-button" disabled={!reorderable || index === 0}
          title={reorderable ? t("addons.higherPriority") : t("addons.orderFiltered")}
          aria-label={t("addons.higherPriority")} onClick={() => onMove(-1)}><ArrowUp/></button>
        <button type="button" className="icon-button" disabled={!reorderable || index === total - 1}
          title={reorderable ? t("addons.lowerPriority") : t("addons.orderFiltered")}
          aria-label={t("addons.lowerPriority")} onClick={() => onMove(1)}><ArrowDown/></button>
      </span>}
      <button type="button" onClick={onEdit}><SlidersHorizontal/> {t("addons.editAddon")}</button>
    </footer>}
  </article>;
}

type Draft = {
  url: string; role: Addon["role"]; globalSearch: boolean; showInContinueWatching: boolean;
  downloadSettings: AddonDownloadSettings;
};

/** Everything an addon can be set to, staged in one draft and written with one PATCH.
 *  The address is fetched on open: the list hides it because a personalised URL carries
 *  a token, so the field cannot be filled from the addon the page already has. */
function AddonEditDialog({ addon, libraries, onClose, onChanged, onNotify, onError, onRemoved }:
  { addon: Addon; libraries: LibraryView[]; onClose: () => void; onChanged: () => Promise<void>;
    onNotify: (message: string) => void; onError: (error: unknown) => void; onRemoved: () => void }) {
  useI18n();
  const stored = addon.downloadSettings ?? emptyDownloadSettings();
  const [draft, setDraft] = useState<Draft>(() => ({
    url: "", role: addon.role, globalSearch: addon.globalSearch,
    showInContinueWatching: addon.showInContinueWatching !== false,
    downloadSettings: cloneDownloadSettings(stored),
  }));
  // The address as the server knows it. Until it arrives the URL field stages nothing.
  const [loadedUrl, setLoadedUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const streams = providesStreams(addon);

  useEffect(() => {
    let alive = true;
    api.exportAddon(addon.key)
      .then((full) => { if (!alive) return; const value = String(full.manifestUrl ?? ""); setLoadedUrl(value); setDraft((current) => ({ ...current, url: value })); })
      .catch((error) => { if (alive) onError(error); });
    return () => { alive = false; };
  }, [addon.key]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const changeRule = (kind: "movie" | "series", patch: Partial<AddonDownloadSettings["movie"]>) =>
    setDraft((current) => ({ ...current, downloadSettings: { ...current.downloadSettings, [kind]: { ...current.downloadSettings[kind], ...patch } } }));

  const urlChanged = Boolean(loadedUrl) && draft.url.trim() !== loadedUrl;
  const storageChanged = streams && JSON.stringify(draft.downloadSettings) !== JSON.stringify(stored);
  const dirty = urlChanged || draft.role !== addon.role || draft.globalSearch !== addon.globalSearch
    || draft.showInContinueWatching !== (addon.showInContinueWatching !== false) || storageChanged;
  const valid = !urlChanged || Boolean(draft.url.trim());

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  const save = () => run(async () => {
    const patch: Parameters<typeof api.updateAddon>[1] = {};
    if (urlChanged) patch.url = draft.url.trim();
    if (draft.role !== addon.role) patch.role = draft.role;
    if (draft.globalSearch !== addon.globalSearch) patch.globalSearch = draft.globalSearch;
    if (draft.showInContinueWatching !== (addon.showInContinueWatching !== false)) patch.showInContinueWatching = draft.showInContinueWatching;
    if (storageChanged) patch.downloadSettings = draft.downloadSettings;
    await api.updateAddon(addon.key, patch);
    await onChanged();
    onNotify(t("addons.updated"));
    onClose();
  });
  const refresh = () => run(async () => {
    const result = await api.refreshAddon(addon.key);
    await onChanged();
    onNotify(result.changed
      ? t("addons.refreshedTo", { addon: result.addon.manifest.name, version: result.version })
      : t("addons.refreshUpToDate", { addon: addon.manifest.name }));
  });
  const exportManifest = () => run(async () => {
    const full = await api.exportAddon(addon.key);
    const href = URL.createObjectURL(new Blob([JSON.stringify(full, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = href; link.download = `${addon.manifest.name.replace(/[^\w.-]+/g, "-")}.json`;
    link.click(); URL.revokeObjectURL(href);
    onNotify(t("addons.manifestSaved"));
  });
  const remove = () => {
    if (!confirm(t("addons.removeConfirm", { name: addon.manifest.name }))) return;
    void run(async () => { await api.deleteAddon(addon.key); await onChanged(); onNotify(t("addons.removed")); onRemoved(); });
  };

  // Where a rule may point: the same set the server accepts, in the same order, so the
  // "Default" entry names the library the queue would fall back to.
  const offered = (kind: "movie" | "series") => libraries
    .filter((library) => library.enabled && !library.unreachable && !library.readOnly && (library.type === kind || library.type === "mixed"))
    .sort((a, b) => a.order - b.order);
  const defaultLibrary = (kind: "movie" | "series") => {
    const available = offered(kind);
    return available.find((library) => (kind === "movie" ? library.defaultMovie : library.defaultSeries)) ?? available[0];
  };
  // A rule may name a library that is no longer offered (switched off, unplugged, removed).
  // It stays visible and stays selected: silently rewriting somebody's rule would be worse.
  const strayLibrary = (kind: "movie" | "series") => {
    const wanted = draft.downloadSettings[kind].libraryId;
    return wanted && !offered(kind).some((library) => library.id === wanted) ? libraries.find((library) => library.id === wanted) : undefined;
  };
  const preview = (kind: "movie" | "series") => {
    const rule = draft.downloadSettings[kind];
    const folder = rule.subfolder.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    const root = `${(libraries.find((library) => library.id === rule.libraryId) ?? defaultLibrary(kind))?.root ?? t("addons.noLibraryRoot")}${folder ? `/${folder}` : ""}`;
    if (kind === "movie") return rule.layout === "flat" ? `${root}/${t("addons.sampleMovie")}.mkv` : `${root}/${t("addons.sampleMovie")}/${t("addons.sampleMovie")}.mkv`;
    return rule.layout === "flat" ? `${root}/${t("addons.sampleShow")} - S01E01 - ${t("addons.sampleEpisode")}.mkv` : `${root}/${t("addons.sampleShow")}/01 ${t("addons.sampleSeasonFolder")}/01 - ${t("addons.sampleEpisode")}.mkv`;
  };

  const check = (key: "globalSearch" | "showInContinueWatching", labelText: string, hint: string) =>
    <label className="library-check" title={hint}>
      <span className="switch"><input type="checkbox" aria-label={labelText} checked={draft[key]} disabled={busy}
        onChange={(event) => update({ [key]: event.target.checked } as Partial<Draft>)}/><span/></span>
      <span>{labelText}</span>
    </label>;

  return <div className="identify-overlay" role="dialog" aria-modal="true" aria-label={t("addons.editAddon")}
    onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="panel identify-card addon-edit-card" onSubmit={(event) => { event.preventDefault(); if (dirty && valid) void save(); }}>
      <div className="identify-head">
        <h2>{addon.manifest.name}</h2>
        <button type="button" className="icon-button" aria-label={t("common.close")} disabled={busy} onClick={onClose}><X/></button>
      </div>
      <div className="dialog-body addon-edit-body">
        <section className="addon-edit-section">
          <div className="library-picker-section-head"><h3>{t("addons.sectionIdentity")}</h3><p>{t("addons.manifestAddressHint")}</p></div>
          <label className="manifest-field"><span>URL</span>
            <input value={draft.url} disabled={busy || !loadedUrl} spellCheck={false} placeholder={t("common.loading")}
              aria-label={t("addons.manifestUrl")} onChange={(event) => update({ url: event.target.value })}/></label>
          <label className="manifest-field"><span>{t("addons.role")}</span>
            <select value={draft.role} disabled={busy} aria-label={t("addons.role")} onChange={(event) => update({ role: event.target.value as Addon["role"] })}>
              {ROLES.filter((value) => !(addon.essential && value === "source")).map((value) => <option key={value} value={value}>{roleLabel(value)}</option>)}
            </select></label>
          {addon.configurable && <a className="addon-configure" href={configureUrl(loadedUrl)} target="_blank" rel="noreferrer noopener">
            <ExternalLink/> {t("addons.configure")}</a>}
        </section>
        {addon.role !== "source" && <section className="addon-edit-section">
          <div className="library-picker-section-head"><h3>{t("addons.sectionBehaviour")}</h3></div>
          <div className="library-edit-controls">
            {check("globalSearch", t("addons.globalSearch"), t("addons.globalSearchHint"))}
            {check("showInContinueWatching", t("addons.showInContinueWatching"), t("addons.showInContinueWatchingHint"))}
          </div>
        </section>}
        {streams && <section className="addon-edit-section">
          <div className="library-picker-section-head"><h3>{t("addons.whereToStore")}</h3><p>{t("addons.whereToStoreHint")}</p></div>
          <div className="download-rule-grid">{(["movie", "series"] as const).map((kind) => {
            const kindLabel = t(kind === "movie" ? "catalog.movies" : "catalog.series");
            const rule = draft.downloadSettings[kind];
            const chosen = libraries.find((library) => library.id === rule.libraryId);
            const stray = strayLibrary(kind);
            const fallback = defaultLibrary(kind);
            return <div className="download-rule" key={kind}><b>{kindLabel}</b>
              <label><span>{t("addons.saveTo")}</span>
                <select aria-label={t("addons.saveToLabel", { kind: kindLabel })} value={rule.libraryId ?? ""} disabled={busy}
                  onChange={(event) => changeRule(kind, { libraryId: event.target.value || undefined })}>
                  <option value="">{fallback ? t("addons.saveToDefaultNamed", { name: fallback.name }) : t("addons.saveToDefault")}</option>
                  {offered(kind).map((library) => <option key={library.id} value={library.id}>{library.name}</option>)}
                  {stray && <option value={stray.id}>{t("addons.saveToUnavailable", { name: stray.name })}</option>}
                </select></label>
              <label className="folder-label"><span>{t("addons.subfolder")}</span>
                <div className="folder-field"><code>{chosen?.root ?? fallback?.root ?? ""}/</code>
                  <input aria-label={t("addons.subfolderLabel", { kind: kindLabel })} value={rule.subfolder} disabled={busy}
                    placeholder={t("addons.subfolderPlaceholder")} onChange={(event) => changeRule(kind, { subfolder: event.target.value })}/></div></label>
              <label><span>{t("addons.layout")}</span>
                <select aria-label={t("addons.layoutLabel", { kind: kindLabel })} value={rule.layout} disabled={busy}
                  onChange={(event) => changeRule(kind, { layout: event.target.value as "flat" | "structured" })}>
                  <option value="structured">{t("addons.layoutStructured")}</option><option value="flat">{t("addons.layoutFlat")}</option>
                </select></label>
              <small className="path-preview">{t("addons.example")} <code>{preview(kind)}</code></small></div>;
          })}</div>
        </section>}
        <section className="addon-edit-section">
          <div className="library-picker-section-head"><h3>{t("addons.sectionActions")}</h3></div>
          <div className="addon-edit-actions">
            <button type="button" disabled={busy} onClick={() => void refresh()}><RefreshCw/> {t("addons.refresh")}</button>
            <button type="button" disabled={busy || !loadedUrl} onClick={() => void run(async () => { await copyText(draft.url); onNotify(t("addons.urlCopied")); })}><Copy/> {t("addons.copyUrl")}</button>
            <button type="button" disabled={busy} onClick={() => void exportManifest()}><FileJson/> {t("addons.exportJson")}</button>
          </div>
          {!addon.essential && <details className="library-admin-danger">
            <summary><Trash2/> {t("addons.removeOptions")}</summary>
            <div><button type="button" className="danger" disabled={busy} onClick={remove}><Trash2/> {t("addons.removeAddon")}</button></div>
          </details>}
          {addon.essential && <p className="identify-hint">{t("addons.essential")}</p>}
        </section>
      </div>
      <footer className="dialog-footer addon-edit-footer">
        <button type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
        <button className="primary" disabled={busy || !dirty || !valid}><Check/> {t(busy ? "common.saving" : "addons.saveChanges")}</button>
      </footer>
    </form>
  </div>;
}

/** Stremio serves the configuration page next to the manifest. An address we cannot parse
 *  yet (the dialog is still fetching it) leaves the link pointing nowhere useful. */
function configureUrl(manifestUrl: string) {
  if (!manifestUrl) return "#";
  try { return new URL("./configure", manifestUrl).toString(); }
  catch { return "#"; }
}
