import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, KeyRound, Library, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { api, describeError } from "./api";
import { t, useI18n } from "./i18n";
import type { AdminRemoteLibrary, LibraryType, MediaServerConnection, MediaServerProvider, MediaServerStatus, ProviderLibrary, UserAccount } from "./types";

const PROVIDER_KEY: Record<MediaServerProvider, "mediaServer.provider.jellyfin" | "mediaServer.provider.emby"> = {
  jellyfin: "mediaServer.provider.jellyfin",
  emby: "mediaServer.provider.emby",
};

const STATUS_KEY: Record<MediaServerStatus, "mediaServer.status.disabled" | "mediaServer.status.available" | "mediaServer.status.unavailable" | "mediaServer.status.reauthentication-required" | "mediaServer.status.identity-changed"> = {
  disabled: "mediaServer.status.disabled",
  available: "mediaServer.status.available",
  unavailable: "mediaServer.status.unavailable",
  "reauthentication-required": "mediaServer.status.reauthentication-required",
  "identity-changed": "mediaServer.status.identity-changed",
};

const TYPE_KEY = (type: LibraryType | "season" | "episode") =>
  type === "movie" ? "mediaServer.type.movie" : type === "series" ? "mediaServer.type.series"
  : type === "season" ? "mediaServer.type.season" : type === "episode" ? "mediaServer.type.episode" : "library.libraryTypeMixed";

const statusClass = (status: MediaServerStatus) => status === "available" ? "" : status === "disabled" ? "off" : "warn";

/** What the one removal dialog is about to take away: a whole connection or one attached library. */
type Removal = { kind: "connection"; connection: MediaServerConnection } | { kind: "library"; library: AdminRemoteLibrary };

/** The standard dialog shell: head with an X, a scrolling body, a footer of buttons. */
function Dialog({ title, cardClass, onClose, children, footer, busy }: {
  title: string; cardClass?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; busy?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  return <div className="identify-overlay" role="dialog" aria-modal="true" aria-label={title}
    onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className={`panel identify-card dialog-split ${cardClass ?? ""}`}>
      <div className="identify-head">
        <h2>{title}</h2>
        <button type="button" className="icon-button" aria-label={t("common.close")} disabled={busy} onClick={onClose}><X/></button>
      </div>
      <div className="dialog-body">{children}</div>
      {footer && <footer className="dialog-foot">{footer}</footer>}
    </div>
  </div>;
}

const Checkbox = ({ checked, disabled, onChange, children }: { checked: boolean; disabled?: boolean; onChange: (value: boolean) => void; children: ReactNode }) =>
  <label className="library-check">
    <span className="switch"><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)}/><span/></span>
    <span>{children}</span>
  </label>;

/** Settings -> Libraries: connect Jellyfin/Emby and grant attached libraries. Administrator only. */
export function MediaServerManager({ onError }: { onError: (error: unknown) => void }) {
  useI18n();
  const [connections, setConnections] = useState<MediaServerConnection[] | null>(null);
  const [keyConfigured, setKeyConfigured] = useState(true);
  const [libraries, setLibraries] = useState<AdminRemoteLibrary[]>([]);
  const [loadError, setLoadError] = useState("");
  const [users, setUsers] = useState<UserAccount[] | null>(null);
  const [usersError, setUsersError] = useState("");
  // One mutation at a time: a conflicting control is disabled while any of them runs.
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [discovering, setDiscovering] = useState<MediaServerConnection | null>(null);
  const [editing, setEditing] = useState<AdminRemoteLibrary | null>(null);
  const [renaming, setRenaming] = useState<MediaServerConnection | null>(null);
  const [reauthenticating, setReauthenticating] = useState<MediaServerConnection | null>(null);
  const [removing, setRemoving] = useState<Removal | null>(null);
  // The control that opened the removal dialog gets focus back when it closes, the way the
  // account menu hands focus back to its trigger.
  const removeTrigger = useRef<HTMLElement | null>(null);

  const load = async () => {
    const [servers, list] = await Promise.all([api.mediaServers(), api.adminRemoteLibraries()]);
    setConnections(servers.connections);
    setKeyConfigured(servers.keyConfigured);
    setLibraries(list);
    return list;
  };
  const boot = async () => {
    setBusy(true);
    setLoadError("");
    try { await load(); }
    catch (error) { setLoadError(describeError(error)); }
    finally { setBusy(false); }
  };
  const loadUsers = async () => {
    setUsersError("");
    try { setUsers(await api.users()); }
    catch (error) { setUsers(null); setUsersError(describeError(error)); }
  };
  useEffect(() => { void boot(); void loadUsers(); }, []);

  /** A list-level mutation reports through the toast. */
  const runList = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  /** A dialog mutation keeps its failure inside the dialog it belongs to. */
  const runDialog = async (action: () => Promise<void>) => {
    setBusy(true);
    setDialogError("");
    try { await action(); return true; }
    catch (error) { setDialogError(describeError(error)); return false; }
    finally { setBusy(false); }
  };
  const openDialog = () => setDialogError("");

  const providerOf = (connectionId: string) => connections?.find((connection) => connection.id === connectionId);
  const siblingsOf = (connectionId: string) =>
    [...libraries.filter((library) => library.connectionId === connectionId)].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  const toggleConnection = (connection: MediaServerConnection) =>
    runList(async () => { await api.updateMediaServer(connection.id, { enabled: !connection.enabled }); await load(); });
  const requestRemove = (removal: Removal) => {
    removeTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openDialog();
    setRemoving(removal);
  };
  // Only one overlay at a time: the library editor steps aside before the removal dialog opens
  // and Cancel puts it back, so neither is ever drawn on top of the other.
  const requestRemoveLibrary = (library: AdminRemoteLibrary) => { setEditing(null); requestRemove({ kind: "library", library }); };
  const restoreRemoveFocus = () => { if (removeTrigger.current?.isConnected) removeTrigger.current.focus(); };
  const dismissRemoval = () => {
    const current = removing;
    setRemoving(null);
    if (current?.kind === "library") setEditing(current.library);
    restoreRemoveFocus();
  };
  const confirmRemoval = (forget: boolean) => {
    const current = removing;
    if (!current) return;
    void runDialog(async () => {
      if (current.kind === "connection") await api.deleteMediaServer(current.connection.id, forget);
      else await api.deleteRemoteLibrary(current.library.id, forget);
      await load();
    }).then((done) => { if (done) { setRemoving(null); restoreRemoveFocus(); } });
  };
  const reorderLibrary = (library: AdminRemoteLibrary, delta: number) => runDialog(async () => {
    const siblings = siblingsOf(library.connectionId);
    const index = siblings.findIndex((row) => row.id === library.id);
    const other = siblings[index + delta];
    const moved = siblings[index];
    if (!other || !moved) return;
    const arranged = [...siblings];
    arranged[index + delta] = moved;
    arranged[index] = other;
    for (const [position, row] of arranged.entries()) {
      if (row.order !== position) await api.updateRemoteLibrary(row.id, { order: position });
    }
    const list = await load();
    setEditing((current) => current ? list.find((row) => row.id === current.id) ?? current : current);
  });

  return <div className="media-server-manager">
    {!keyConfigured && <p className="notice" role="alert">{t("mediaServer.keyMissing")}</p>}
    <div className="library-manager-actions">
      <button className="primary" disabled={busy} onClick={() => { openDialog(); setConnecting(true); }}><Plus/> {t("mediaServer.add")}</button>
      <button disabled={busy} onClick={() => void boot()}><RefreshCw/> {t("common.refresh")}</button>
    </div>
    {loadError && <div className="remote-error" role="alert">
      <span>{loadError}</span>
      <button type="button" disabled={busy} onClick={() => void boot()}>{t("mediaServer.retry")}</button>
    </div>}
    {connections === null && !loadError && <p className="identify-hint" role="status">{t("common.loading")}</p>}
    {connections && !connections.length && !loadError && <p className="identify-hint">{t("mediaServer.empty")}</p>}
    {connections && connections.length > 0 && <div className="media-server-connections">
      {connections.map((connection) => <article className="library-admin-row" key={connection.id}>
        <div className="library-admin-head">
          <div className="library-admin-title">
            <strong>{connection.name}</strong>
            <small className="library-admin-root" title={connection.baseUrl}>{connection.baseUrl}</small>
          </div>
          <span className="library-admin-flags">
            <i className="library-badge">{t(PROVIDER_KEY[connection.provider])}</i>
            <i className={`library-badge ${statusClass(connection.status)}`}>{t(STATUS_KEY[connection.status])}</i>
          </span>
        </div>
        <div className="library-admin-controls">
          <Checkbox checked={connection.enabled} disabled={busy} onChange={() => void toggleConnection(connection)}>{t("library.enabled")}</Checkbox>
        </div>
        <footer className="library-admin-footer">
          <button disabled={busy} onClick={() => { openDialog(); setDiscovering(connection); }}><Library/> {t("mediaServer.libraries")}</button>
          <button disabled={busy} onClick={() => { openDialog(); setRenaming(connection); }}><Pencil/> {t("mediaServer.rename")}</button>
          <button disabled={busy} onClick={() => { openDialog(); setReauthenticating(connection); }}><KeyRound/> {t("mediaServer.reauthenticate")}</button>
          <button className="danger" disabled={busy} onClick={() => requestRemove({ kind: "connection", connection })}><Trash2/> {t("mediaServer.remove")}</button>
        </footer>
      </article>)}
    </div>}
    {libraries.length > 0 && <section className="media-server-attached">
      <h3>{t("mediaServer.remoteTitle")}</h3>
      <div className="library-manager">
        {[...libraries].sort((a, b) => a.connectionId.localeCompare(b.connectionId) || a.order - b.order || a.id.localeCompare(b.id)).map((library) => <article className={`library-admin-row${library.enabled ? "" : " unreachable"}`} key={library.id}>
          <div className="library-admin-head">
            <div className="library-admin-title">
              <strong>{library.name}</strong>
              <small className="library-admin-root">{providerOf(library.connectionId)?.name ?? ""}</small>
            </div>
            <span className="library-admin-flags">
              <i className="library-badge">{t(TYPE_KEY(library.type))}</i>
              {!library.enabled && <i className="library-badge off">{t("library.disabled")}</i>}
              {!library.allowedUsers.length && <i className="library-badge warn">{t("users.administrator")}</i>}
            </span>
          </div>
          <footer className="library-admin-footer">
            <button disabled={busy} onClick={() => { openDialog(); setEditing(library); }}><Pencil/> {t("mediaServer.libraryTitle")}</button>
          </footer>
        </article>)}
      </div>
    </section>}
    {connecting && <ConnectionDialog onClose={() => setConnecting(false)}
      onDone={async () => { setConnecting(false); await boot(); }}/>}
    {discovering && <DiscoverDialog connection={discovering} attached={libraries} busy={busy} error={dialogError} onClose={() => setDiscovering(null)}
      onAttach={(library) => runDialog(async () => { await api.attachMediaServerLibrary(discovering.id, { remoteId: library.id, name: library.name }); await load(); })}/>}
    {renaming && <FormDialog title={t("mediaServer.rename")} busy={busy} error={dialogError} onClose={() => setRenaming(null)}
      submitLabel={t("common.save")} canSubmit={(name) => Boolean(name.trim()) && name.trim() !== renaming.name}
      submit={(name) => runDialog(async () => { await api.updateMediaServer(renaming.id, { name: name.trim() }); await load(); })}>
      {(name, setName) => <label className="media-server-field"><span>{t("mediaServer.name")}</span>
        <input value={name} autoComplete="off" aria-label={t("mediaServer.name")} disabled={busy} onChange={(event) => setName(event.target.value)}/>
        <small className="identify-hint">{t("mediaServer.renameHint")}</small>
      </label>}
    </FormDialog>}
    {reauthenticating && <FormDialog title={t("mediaServer.reauthenticate")} busy={busy} error={dialogError} onClose={() => setReauthenticating(null)}
      hint={t("mediaServer.reauthenticateHint")} submitLabel={t("mediaServer.reauthenticateAction")}
      canSubmit={(username, password) => Boolean(username.trim()) && Boolean(password)}
      submit={(username, password) => runDialog(async () => { await api.reauthenticateMediaServer(reauthenticating.id, { username: username.trim(), password }); await load(); })}>
      {(username, setUsername, password, setPassword) => <>
        <label><span>{t("mediaServer.username")}</span>
          <input value={username} autoComplete="username" aria-label={t("mediaServer.username")} disabled={busy} onChange={(event) => setUsername(event.target.value)}/>
        </label>
        <label><span>{t("mediaServer.password")}</span>
          <input type="password" value={password} autoComplete="new-password" aria-label={t("mediaServer.password")} disabled={busy} onChange={(event) => setPassword(event.target.value)}/>
        </label>
      </>}
    </FormDialog>}
    {editing && <RemoteLibraryDialog library={editing} users={users} usersError={usersError} busy={busy} error={dialogError}
      onRetryUsers={() => void loadUsers()} onClose={() => setEditing(null)}
      onSave={(patch) => runDialog(async () => { await api.updateRemoteLibrary(editing.id, patch); await load(); })}
      onRequestRemove={() => requestRemoveLibrary(editing)}
      onReorder={(delta) => reorderLibrary(editing, delta)}/>}
    {removing && <RemoveDialog removal={removing} busy={busy} error={dialogError} onDismiss={dismissRemoval} onConfirm={confirmRemoval}/>}
  </div>;
}

/** A two-field dialog whose values live here, so a shared busy flag and error can sit in its footer. */
function FormDialog({ title, children, hint, submitLabel, busy, error, canSubmit, submit, onClose }: {
  title: string; children: (first: string, setFirst: (value: string) => void, second: string, setSecond: (value: string) => void) => ReactNode;
  hint?: string; submitLabel: string; busy: boolean; error: string;
  canSubmit: (first: string, second: string) => boolean; submit: (first: string, second: string) => Promise<boolean>; onClose: () => void;
}) {
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  return <Dialog title={title} cardClass="media-server-card" busy={busy} onClose={onClose}
    footer={<>
      {error && <p className="login-error" role="alert">{error}</p>}
      {hint && <p className="identify-hint">{hint}</p>}
      <button type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
      <button type="button" className="primary" disabled={busy || !canSubmit(first, second)}
        onClick={() => void submit(first, second).then((done) => { if (done) { setSecond(""); onClose(); } })}>
        {busy ? t("common.saving") : submitLabel}
      </button>
    </>}>
    <div className="media-server-form">{children(first, setFirst, second, setSecond)}</div>
  </Dialog>;
}

/** The one confirmation both removals share. Access is revoked as soon as it goes through;
 *  the optional tick decides only whether the local history and favorites are dropped too. */
function RemoveDialog({ removal, busy, error, onDismiss, onConfirm }: {
  removal: Removal; busy: boolean; error: string; onDismiss: () => void; onConfirm: (forget: boolean) => void;
}) {
  const [forget, setForget] = useState(false);
  const name = removal.kind === "connection" ? removal.connection.name : removal.library.name;
  return <Dialog title={t("mediaServer.removeTitle", { name })} cardClass="media-server-card" busy={busy} onClose={onDismiss}
    footer={<>
      {error && <p className="login-error" role="alert">{error}</p>}
      <button type="button" autoFocus disabled={busy} onClick={onDismiss}>{t("common.cancel")}</button>
      <button type="button" className="danger" disabled={busy} onClick={() => onConfirm(forget)}>{t("common.remove")}</button>
    </>}>
    <p className="identify-hint">{t(removal.kind === "connection" ? "mediaServer.removeConnectionHint" : "mediaServer.removeLibraryHint", { name })}</p>
    <Checkbox checked={forget} disabled={busy} onChange={setForget}>{t("mediaServer.forgetLocal")}</Checkbox>
    <p className="identify-hint">{t("mediaServer.forgetLocalHint")}</p>
    <p className="identify-hint">{t("mediaServer.removeHistoryHint")}</p>
  </Dialog>;
}

function ConnectionDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [provider, setProvider] = useState<MediaServerProvider>("jellyfin");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [allowLan, setAllowLan] = useState(false);
  const [allowLoopback, setAllowLoopback] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!name.trim() || !baseUrl.trim() || !username.trim() || !password) return;
    setBusy(true);
    setError("");
    try {
      await api.createMediaServer({ provider, name: name.trim(), baseUrl: baseUrl.trim(), allowLan, allowLoopback, username: username.trim(), password });
      setPassword("");
      await onDone();
    } catch (value) { setError(describeError(value)); }
    finally { setBusy(false); }
  };

  return <Dialog title={t("mediaServer.add")} cardClass="media-server-card" busy={busy} onClose={onClose}
    footer={<>
      {error && <p className="login-error" role="alert">{error}</p>}
      <button type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
      <button type="submit" form="media-server-connect" className="primary" disabled={busy || !name.trim() || !baseUrl.trim() || !username.trim() || !password}>{busy ? t("mediaServer.connecting") : t("mediaServer.connect")}</button>
    </>}>
    <form id="media-server-connect" className="media-server-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label><span>{t("mediaServer.provider")}</span>
        <select value={provider} aria-label={t("mediaServer.provider")} disabled={busy} onChange={(event) => setProvider(event.target.value as MediaServerProvider)}>
          <option value="jellyfin">{t("mediaServer.provider.jellyfin")}</option>
          <option value="emby">{t("mediaServer.provider.emby")}</option>
        </select>
      </label>
      <label><span>{t("mediaServer.name")}</span>
        <input value={name} autoComplete="off" placeholder={t("mediaServer.namePlaceholder")} aria-label={t("mediaServer.name")} disabled={busy} onChange={(event) => setName(event.target.value)}/>
      </label>
      <label><span>{t("mediaServer.baseUrl")}</span>
        <input value={baseUrl} autoComplete="off" spellCheck={false} inputMode="url" placeholder={t("mediaServer.baseUrlPlaceholder")} aria-label={t("mediaServer.baseUrl")} disabled={busy} onChange={(event) => setBaseUrl(event.target.value)}/>
        <small className="identify-hint">{t("mediaServer.baseUrlHint")}</small>
      </label>
      <label><span>{t("mediaServer.username")}</span>
        <input value={username} autoComplete="username" aria-label={t("mediaServer.username")} disabled={busy} onChange={(event) => setUsername(event.target.value)}/>
      </label>
      <label><span>{t("mediaServer.password")}</span>
        <input type="password" value={password} autoComplete="new-password" aria-label={t("mediaServer.password")} disabled={busy} onChange={(event) => setPassword(event.target.value)}/>
      </label>
      <Checkbox checked={allowLan} disabled={busy} onChange={setAllowLan}>{t("mediaServer.allowLan")}</Checkbox>
      <p className="identify-hint">{t("mediaServer.allowLanHint")}</p>
      <details className="media-server-advanced" open={advanced} onToggle={(event) => setAdvanced((event.currentTarget as HTMLDetailsElement).open)}>
        <summary>{t("mediaServer.advanced")}</summary>
        <Checkbox checked={allowLoopback} disabled={busy} onChange={setAllowLoopback}>{t("mediaServer.allowLoopback")}</Checkbox>
        <p className="identify-hint">{t("mediaServer.allowLoopbackHint")}</p>
      </details>
    </form>
  </Dialog>;
}

function DiscoverDialog({ connection, attached, busy, error, onClose, onAttach }: {
  connection: MediaServerConnection; attached: AdminRemoteLibrary[]; busy: boolean; error: string;
  onClose: () => void; onAttach: (library: ProviderLibrary) => Promise<boolean>;
}) {
  const [items, setItems] = useState<ProviderLibrary[] | null>(null);
  const [discoverError, setDiscoverError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setDiscoverError("");
    setItems(null);
    void api.discoverMediaServerLibraries(connection.id, controller.signal)
      .then((answer) => { if (!controller.signal.aborted) setItems(answer.items); })
      .catch((value) => {
        if (controller.signal.aborted || (value instanceof DOMException && value.name === "AbortError")) return;
        setDiscoverError(describeError(value));
      });
    return () => controller.abort();
  }, [connection.id, attempt]);

  const attachedIds = new Set(attached.filter((library) => library.connectionId === connection.id).map((library) => library.remoteId));

  return <Dialog title={t("mediaServer.discoverTitle")} cardClass="media-server-card" busy={busy} onClose={onClose}
    footer={<><p className="identify-hint">{t("mediaServer.discoverHint")}</p><button type="button" disabled={busy} className="primary" onClick={onClose}>{t("common.close")}</button></>}>
    {error && <p className="login-error" role="alert">{error}</p>}
    {discoverError && <div className="remote-error" role="alert">
      <span>{discoverError}</span>
      <button type="button" disabled={busy} onClick={() => setAttempt((value) => value + 1)}>{t("mediaServer.retry")}</button>
    </div>}
    {items === null && !discoverError && <p className="identify-hint" role="status">{t("mediaServer.discovering")}</p>}
    {items && !items.length && <p className="identify-hint">{t("mediaServer.noProviderLibraries")}</p>}
    {items && items.length > 0 && <div className="media-server-discover">{items.map((library) => <div className="media-server-discover-row" key={library.id}>
      <span><strong>{library.name}</strong><small>{t(TYPE_KEY(library.type))}</small></span>
      {attachedIds.has(library.id)
        ? <span className="media-server-attached-tag"><Check/> {t("mediaServer.attached")}</span>
        : <button disabled={busy} onClick={() => void onAttach(library)}>{t("mediaServer.attach")}</button>}
    </div>)}</div>}
  </Dialog>;
}

function RemoteLibraryDialog({ library, users, usersError, busy, error, onRetryUsers, onClose, onSave, onRequestRemove, onReorder }: {
  library: AdminRemoteLibrary; users: UserAccount[] | null; usersError: string; busy: boolean; error: string;
  onRetryUsers: () => void; onClose: () => void;
  onSave: (patch: { name: string; enabled: boolean; showOnHome: boolean; showInContinueWatching: boolean; allowedUsers: string[] }) => Promise<boolean>;
  onRequestRemove: () => void; onReorder: (delta: number) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(() => ({
    name: library.name, enabled: library.enabled,
    showOnHome: library.showOnHome, showInContinueWatching: library.showInContinueWatching,
    allowedUsers: new Set(library.allowedUsers),
  }));
  const loaded = users !== null;
  const dirty = draft.name.trim() !== library.name || draft.enabled !== library.enabled
    || draft.showOnHome !== library.showOnHome || draft.showInContinueWatching !== library.showInContinueWatching
    || [...draft.allowedUsers].sort().join(",") !== [...library.allowedUsers].sort().join(",");

  const toggleUser = (id: string, on: boolean) => setDraft((current) => {
    const next = new Set(current.allowedUsers);
    if (on) next.add(id); else next.delete(id);
    return { ...current, allowedUsers: next };
  });
  return <Dialog title={t("mediaServer.libraryEditTitle")} cardClass="media-server-library-card" busy={busy} onClose={onClose}
    footer={<>
      {error && <p className="login-error" role="alert">{error}</p>}
      <button type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
      <button type="button" className="primary" disabled={busy || !loaded || !dirty || !draft.name.trim()}
        onClick={() => void onSave({
          name: draft.name.trim(), enabled: draft.enabled,
          showOnHome: draft.showOnHome, showInContinueWatching: draft.showInContinueWatching,
          allowedUsers: [...draft.allowedUsers],
        }).then((done) => { if (done) onClose(); })}>{t("common.save")}</button>
    </>}>
    <section className="library-edit-section">
      <div className="library-picker-section-head"><h3>{t("mediaServer.availabilityHeading")}</h3></div>
      <label className="media-server-field"><span>{t("mediaServer.libraryName")}</span>
        <input value={draft.name} autoComplete="off" aria-label={t("mediaServer.libraryName")} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}/>
      </label>
      <div className="library-edit-controls">
        <Checkbox checked={draft.enabled} disabled={busy} onChange={(value) => setDraft((current) => ({ ...current, enabled: value }))}>{t("library.enabled")}</Checkbox>
      </div>
      <div className="library-admin-order media-server-order">
        <button type="button" className="icon-button" disabled={busy} aria-label={t("mediaServer.orderUp", { name: library.name })} title={t("mediaServer.orderUp", { name: library.name })} onClick={() => void onReorder(-1)}><ArrowUp/></button>
        <button type="button" className="icon-button" disabled={busy} aria-label={t("mediaServer.orderDown", { name: library.name })} title={t("mediaServer.orderDown", { name: library.name })} onClick={() => void onReorder(1)}><ArrowDown/></button>
      </div>
    </section>
    <section className="library-edit-section">
      <div className="library-picker-section-head"><h3>{t("mediaServer.presentationHeading")}</h3></div>
      <div className="library-edit-controls">
        <Checkbox checked={draft.showOnHome} disabled={busy} onChange={(value) => setDraft((current) => ({ ...current, showOnHome: value }))}>{t("library.showOnHome")}</Checkbox>
        <Checkbox checked={draft.showInContinueWatching} disabled={busy} onChange={(value) => setDraft((current) => ({ ...current, showInContinueWatching: value }))}>{t("library.showInContinueWatching")}</Checkbox>
      </div>
    </section>
    <section className="library-edit-section">
      <div className="library-picker-section-head"><h3>{t("mediaServer.grantsHeading")}</h3></div>
      {usersError && <div className="remote-error" role="alert">
        <span>{usersError}</span>
        <button type="button" disabled={busy} onClick={onRetryUsers}>{t("mediaServer.retry")}</button>
      </div>}
      {!loaded && !usersError && <p className="identify-hint" role="status">{t("common.loading")}</p>}
      {users && <>
        <p className="identify-hint">{draft.allowedUsers.size ? t("mediaServer.grantsHint") : t("mediaServer.grantsAdminsOnly")}</p>
        <div className="media-server-grants">
          {users.filter((user) => user.role !== "admin").map((user) => <Checkbox key={user.id} checked={draft.allowedUsers.has(user.id)} disabled={busy} onChange={(value) => toggleUser(user.id, value)}>
            {user.disabled ? t("mediaServer.grantDisabled", { username: user.username }) : user.username}
          </Checkbox>)}
          {/* Administrators reach every library, so they are shown but never granted. */}
          {users.filter((user) => user.role === "admin").map((user) => <div className="media-server-grant-info" key={user.id}>
            <span>{user.username}</span>
            <i className="library-badge">{t("users.administrator")}</i>
          </div>)}
        </div>
      </>}
    </section>
    <section className="library-edit-section">
      <div className="library-picker-section-head"><h3>{t("library.actionsHeading")}</h3></div>
      <button type="button" className="danger" disabled={busy} onClick={onRequestRemove}><Trash2/> {t("mediaServer.removeLibrary")}</button>
    </section>
  </Dialog>;
}
