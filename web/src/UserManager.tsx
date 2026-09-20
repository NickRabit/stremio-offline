import { useEffect, useState, type ReactNode } from "react";
import { Plus, RefreshCw, Trash2, X } from "lucide-react";
import { api } from "./api";
import { t, localeTag, useI18n } from "./i18n";
import { libraryTypeLabel } from "./LibraryManager";
import type { Addon, LibraryView, Session, UserAccount, UserPermissions, UserRole } from "./types";

const roleLabel = (role: UserRole) => t(role === "admin" ? "users.administrator" : "users.ordinary");
const addonRoleLabel = (role: Addon["role"]) =>
  t(role === "catalog" ? "addons.roleCatalog" : role === "source" ? "addons.roleSource" : "addons.roleBoth");

/** The comparison the server makes between two names: NFKC, trimmed, case-folded. */
const sameName = (left: string, right: string) =>
  left.normalize("NFKC").trim().toLowerCase() === right.normalize("NFKC").trim().toLowerCase();
const lastSeenText = (at?: string) =>
  at ? t("users.lastSeen", { when: new Date(at).toLocaleString(localeTag(), { dateStyle: "medium", timeStyle: "short" }) }) : t("users.never");
const enabledAdmins = (accounts: UserAccount[]) => accounts.filter((row) => row.role === "admin" && !row.disabled);
const isLastAdmin = (account: UserAccount, accounts: UserAccount[]) =>
  account.role === "admin" && !account.disabled && enabledAdmins(accounts).length <= 1;

/** The accounts of this instance. Only an administrator renders it; an ordinary user is
 *  never shown the rows, let alone offered a control the API would refuse. */
export function UserManager({ session, restricted = false, onChanged, onNotify, onError }: {
  session: Session; restricted?: boolean; onChanged?: () => void;
  onNotify: (message: string) => void; onError: (error: unknown) => void;
}) {
  useI18n();
  const [accounts, setAccounts] = useState<UserAccount[]>([]);
  const [libraries, setLibraries] = useState<LibraryView[]>([]);
  const [addons, setAddons] = useState<Addon[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [rows, nextLibraries, nextAddons] = await Promise.all([api.users(), api.libraries(), api.addons()]);
    setAccounts(rows);
    setLibraries(nextLibraries);
    setAddons(nextAddons);
    setLoaded(true);
    return rows;
  };
  // An ordinary user is refused by all three reads, so the component asks for none of them
  // and renders nothing rather than a failure.
  useEffect(() => {
    if (session.role !== "admin") return;
    void load().catch(onError);
  }, [session.role]);

  if (session.role !== "admin") return null;

  const editing = accounts.find((row) => row.id === editingId) ?? null;
  const replace = (next: UserAccount) => setAccounts((rows) => rows.map((row) => row.id === next.id ? next : row));

  const remove = async (account: UserAccount) => {
    if (!confirm(t("users.deleteConfirm", { name: account.username }))) return;
    setBusy(true);
    try {
      await api.deleteUser(account.id);
      setEditingId(null);
      await load();
      onChanged?.();
      onNotify(t("users.deleted"));
    } catch (error) { onError(error); }
    finally { setBusy(false); }
  };

  return <div className="user-manager">
    {restricted
      ? <p className="identify-hint">{t("users.restrictedHint")}</p>
      : <div className="library-manager-actions">
        <button className="primary" onClick={() => setCreating(true)}><Plus/> {t("users.addAccount")}</button>
        <button onClick={() => void load().catch(onError)} disabled={busy}><RefreshCw/> {t("common.refresh")}</button>
      </div>}
    {accounts.map((account) => <article className="library-admin-row user-admin-row" key={account.id}>
      <div className="library-admin-head user-admin-head">
        <div className="library-admin-title user-admin-title">
          <strong>{account.username}</strong>
          <small className="user-admin-state">
            {roleLabel(account.role)}
            {account.disabled && <i className="library-badge off">{t("users.disabled")}</i>}
            {account.mustChangePassword && <i className="library-badge warn">{t("users.mustChangePassword")}</i>}
          </small>
        </div>
      </div>
      <small className="library-admin-counts">{account.role === "admin"
        ? t("users.seesEverything")
        : t("users.counts", { libraries: account.libraries, addons: account.addons })}</small>
      <small className="user-admin-seen">{lastSeenText(account.lastSeenAt)}</small>
      {!restricted && <footer className="library-admin-footer">
        {/* The lists are re-read as the dialog opens. They were loaded when Settings mounted,
            and what an addon's switch says is an administrator's to change from another page
            -- a badge that reports "off" for something switched on since is worse than no
            badge at all. */}
        <button onClick={() => { setEditingId(account.id); void load().catch(onError); }} disabled={busy}>{t("users.edit")}</button>
      </footer>}
    </article>)}
    {loaded && !accounts.length && <p className="identify-hint">{t("users.empty")}</p>}
    {(creating || editing) && <UserEditDialog account={editing} accounts={accounts} libraries={libraries} addons={addons}
      session={session} onClose={() => { setCreating(false); setEditingId(null); }}
      onCreated={async (created) => { setAccounts((rows) => [...rows, created]); setCreating(false); setEditingId(created.id); onChanged?.(); }}
      onUpdated={replace} onLibraryUpdated={(library) => setLibraries((rows) => rows.map((row) => row.id === library.id ? library : row))}
      onAddonUpdated={(addon) => setAddons((rows) => rows.map((row) => row.key === addon.key ? addon : row))}
      onChanged={onChanged} onRemove={remove} onNotify={onNotify} onError={onError}/>}
  </div>;
}

/** Everything an administrator decides about one person. Each block writes on its own, the
 *  way the rest of Settings does, so the dialog has no save button to press. */
function UserEditDialog({ account, accounts, libraries, addons, session, onClose, onCreated, onUpdated,
  onLibraryUpdated, onAddonUpdated, onChanged, onRemove, onNotify, onError }: {
  account: UserAccount | null; accounts: UserAccount[]; libraries: LibraryView[]; addons: Addon[]; session: Session;
  onClose: () => void; onCreated: (created: UserAccount) => Promise<void>; onUpdated: (next: UserAccount) => void;
  onLibraryUpdated: (library: LibraryView) => void; onAddonUpdated: (addon: Addon) => void;
  onChanged?: () => void; onRemove: (account: UserAccount) => Promise<void>;
  onNotify: (message: string) => void; onError: (error: unknown) => void;
}) {
  useI18n();
  const creating = !account;
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("user");
  const [permissions, setPermissions] = useState<UserPermissions>({ downloadToLibrary: false, downloadToDevice: true });
  const [busy, setBusy] = useState(false);
  /** What a new account will be granted the moment it exists. Everything switched on is
   *  ticked to begin with, because an account that can see nothing is a support call rather
   *  than a safe default -- but the ticks are shown and can be cleared, so the grant is the
   *  administrator's decision either way and nothing is written they cannot see. Something
   *  switched off starts unticked, since granting it would promise what does not work, and
   *  can still be ticked for when it comes back.
   *
   *  Only the departures from that default are held, not the ticks themselves: the lists
   *  arrive from the server and a snapshot taken at mount would be empty if the dialog
   *  opened first, silently granting nothing. */
  /** One pane at a time. Four blocks stacked in a scrolling column meant a grant list was a
   *  small box scrolling inside a long page that also scrolled -- two scrollbars fighting over
   *  one gesture, and on a phone held sideways the whole thing was a squeeze. A pane fills the
   *  dialog instead, so each list scrolls where the eye already is. */
  const [tab, setTab] = useState<"account" | "libraries" | "addons" | "downloads">("account");
  const [override, setOverride] = useState<Record<string, boolean>>({});
  // One map over two namespaces, so a library id and an addon key are kept apart.
  const willGrant = (key: string, enabled: boolean) => override[key] ?? enabled;
  const pick = (key: string, on: boolean) => setOverride((current) => ({ ...current, [key]: on }));
  const libraryKey = (id: string) => `library:${id}`;
  const addonKey = (key: string) => `addon:${key}`;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  // Both views of one account: what it is now, and what a new one is being asked to be.
  const currentRole = creating ? role : account.role;
  const currentPermissions = creating ? permissions : account.permissions;
  const locked = Boolean(account && isLastAdmin(account, accounts));
  const self = Boolean(account && sameName(account.username, session.username));

  const patch = (body: { role?: UserRole; disabled?: boolean; permissions?: Partial<UserPermissions> }) => {
    if (!account) return Promise.resolve();
    return run(async () => { onUpdated(await api.updateUser(account.id, body)); });
  };
  const canApply = () => password.length >= 6 && (!creating || name.trim().length >= 3);
  const applyPassword = () => void run(async () => {
    if (creating) {
      const created = await api.createUser({
        username: name.trim(), password, role,
        permissions: { downloadToLibrary: permissions.downloadToLibrary, downloadToDevice: permissions.downloadToDevice },
      });
      setPassword("");
      // The account exists from here on, so a grant that fails must not look like a creation
      // that failed. Each write is reported through the parent as it lands, and the dialog
      // reopens on the account either way, where the ticks show what actually took.
      if (created.role !== "admin") {
        for (const library of libraries) {
          if (!willGrant(libraryKey(library.id), library.enabled)) continue;
          onLibraryUpdated(await api.updateLibrary(library.id, { visibleTo: [...new Set([...(library.visibleTo ?? []), created.id])] }));
        }
        for (const addon of addons) {
          if (!willGrant(addonKey(addon.key), addon.enabled)) continue;
          onAddonUpdated(await api.updateAddon(addon.key, { allowedUsers: [...new Set([...(addon.allowedUsers ?? []), created.id])] }));
        }
      }
      await onCreated(created);
      onNotify(t("users.added"));
      return;
    }
    if (!account) return;
    onUpdated(await api.setUserPassword(account.id, password));
    setPassword("");
    onNotify(t("users.passwordSet"));
  });
  const setDownload = (key: keyof UserPermissions, value: boolean) => {
    if (creating) { setPermissions((current) => ({ ...current, [key]: value })); return; }
    void patch({ permissions: key === "downloadToLibrary" ? { downloadToLibrary: value } : { downloadToDevice: value } });
  };
  /** A tick writes to the resource, not to the account: the grant list lives on the library
   *  and on the addon, and the whole list goes back so a refusal leaves the row as it was. */
  const setLibraryGrant = (library: LibraryView, granted: boolean) => {
    if (!account) return;
    void run(async () => {
      const current = library.visibleTo ?? [];
      const next = granted ? [...new Set([...current, account.id])] : current.filter((entry) => entry !== account.id);
      onLibraryUpdated(await api.updateLibrary(library.id, { visibleTo: next }));
      onChanged?.();
    });
  };
  const setAddonGrant = (addon: Addon, granted: boolean) => {
    if (!account) return;
    void run(async () => {
      const current = addon.allowedUsers ?? [];
      const next = granted ? [...new Set([...current, account.id])] : current.filter((entry) => entry !== account.id);
      onAddonUpdated(await api.updateAddon(addon.key, { allowedUsers: next }));
    });
  };

  /** An administrator sees every library and addon by role and downloads without a
   *  permission, so those three panes would each hold one sentence. They are left out, and a
   *  strip of one tab is not drawn at all. */
  const tabs = currentRole === "admin"
    ? [{ id: "account" as const, label: t("users.accountHeading"), count: undefined }]
    : [
      { id: "account" as const, label: t("users.accountHeading"), count: undefined },
      { id: "libraries" as const, label: t("users.librariesHeading"), count: libraries.length },
      { id: "addons" as const, label: t("users.addonsHeading"), count: addons.length },
      { id: "downloads" as const, label: t("users.downloadsHeading"), count: undefined },
    ];
  // Promoting somebody while their addons are on screen must not leave the dialog empty.
  useEffect(() => { if (!tabs.some((entry) => entry.id === tab)) setTab("account"); }, [currentRole]);

  /** The tab already names the pane, so repeating it inside is noise -- and on a phone held
   *  sideways it is noise that costs a row of the list. Kept for the one case with no strip. */
  const heading = (text: string) =>
    tabs.length > 1 ? null : <div className="library-picker-section-head"><h3>{text}</h3></div>;
  const grant = (label: string, badge: ReactNode, checked: boolean, ariaLabel: string, onChange: (value: boolean) => void) =>
    <label className="user-grant-row" key={ariaLabel}>
      <input type="checkbox" checked={checked} disabled={busy} aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.checked)}/>
      <span className="user-grant-name">{label}</span>
      {badge}
    </label>;
  const switchFor = (label: string, hint: string, checked: boolean, disabled: boolean, onChange: (value: boolean) => void) =>
    <label className="user-switch">
      <span className="switch"><input type="checkbox" checked={checked} disabled={busy || disabled} aria-label={label}
        onChange={(event) => onChange(event.target.checked)}/><span/></span>
      <span><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
    </label>;

  return <div className="identify-overlay" role="dialog" aria-modal="true" aria-label={t("users.editAccount")}
    onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="panel identify-card dialog-split user-edit-card">
      <div className="identify-head">
        <h2>{creating ? t("users.addAccount") : account.username}</h2>
        <button type="button" className="icon-button" aria-label={t("common.close")} disabled={busy} onClick={onClose}><X/></button>
      </div>
      {tabs.length > 1 && <div className="user-edit-tabs" role="tablist" aria-label={t("users.editAccount")}>
        {tabs.map(({ id, label, count }) =>
          <button key={id} type="button" role="tab" id={`user-tab-${id}`} aria-controls={`user-pane-${id}`}
            aria-selected={tab === id} className={tab === id ? "active" : undefined} onClick={() => setTab(id)}>
            {label}{count === undefined ? null : <i>{count}</i>}
          </button>)}
      </div>}
      <div className="dialog-body user-edit-body" role="tabpanel" id={`user-pane-${tab}`} aria-labelledby={`user-tab-${tab}`}>
        {tab === "account" && <section className="user-edit-section">
          {heading(t("users.accountHeading"))}
          <div className="user-edit-fields">
            <label className="user-edit-field"><span>{t("auth.username")}</span>
              {creating
                ? <input value={name} autoComplete="off" aria-label={t("auth.username")} placeholder={t("auth.usernameHint")}
                    onChange={(event) => setName(event.target.value)}/>
                : <input value={account.username} readOnly aria-label={t("auth.username")}/>}
            </label>
            <label className="user-edit-field"><span>{t("users.role")}</span>
              <select value={currentRole} disabled={busy || locked} aria-label={t("users.role")}
                onChange={(event) => { const next = event.target.value as UserRole; if (creating) setRole(next); else void patch({ role: next }); }}>
                <option value="admin">{t("users.administrator")}</option>
                <option value="user">{t("users.ordinary")}</option>
              </select>
            </label>
          </div>
          {account && switchFor(t("users.enabled"), "", !account.disabled, locked, (value) => void patch({ disabled: !value }))}
          {locked && <p className="identify-hint">{t("users.lastAdminHint")}</p>}
          <div className="user-edit-password">
            <label className="user-edit-field"><span>{t(creating ? "auth.password" : "users.password")}</span>
              <input type="password" value={password} autoComplete="new-password" aria-label={t(creating ? "auth.password" : "users.password")}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (canApply()) applyPassword(); } }}/>
            </label>
            <button type="button" className={creating ? "primary" : undefined} disabled={busy || !canApply()}
              onClick={applyPassword}>{t(creating ? "auth.createAccount" : "users.password")}</button>
          </div>
          <p className="identify-hint">{t(creating ? "users.newAccountHint" : "users.passwordHint")}</p>
          {/* An administrator has no grant panes, so the account pane is where the dialog says
              why: otherwise the tabs simply vanish on promotion with nothing in their place. */}
          {currentRole === "admin" && <p className="identify-hint">{t("users.seesEverything")}</p>}
          {account && <div className="user-edit-danger">
            <button type="button" className="danger" disabled={busy || locked || self} onClick={() => void onRemove(account)}>
              <Trash2/> {t("users.deleteAccount")}</button>
            {self && !locked && <p className="identify-hint">{t("users.selfDeleteHint")}</p>}
          </div>}
        </section>}
        {tab === "libraries" && <section className="user-edit-section">
          {heading(t("users.librariesHeading"))}
          {currentRole === "admin"
            ? <p className="identify-hint">{t("users.seesEverything")}</p>
            : <><div className="user-grant-list">{libraries.map((library) =>
                grant(library.name, <><i className="library-badge">{libraryTypeLabel(library.type)}</i>
                  {!library.enabled && <i className="library-badge off">{t("library.disabled")}</i>}</>,
                  account ? (library.visibleTo ?? []).includes(account.id) : willGrant(libraryKey(library.id), library.enabled),
                  t("users.grantLibrary", { library: library.name }),
                  (value) => account ? setLibraryGrant(library, value) : pick(libraryKey(library.id), value)))}</div>
              {creating && <p className="identify-hint">{t("users.grantsOnCreate")}</p>}</>}
        </section>}
        {tab === "addons" && <section className="user-edit-section">
          {heading(t("users.addonsHeading"))}
          {currentRole === "admin"
            ? <p className="identify-hint">{t("users.seesEverything")}</p>
            : <div className="user-grant-list">{addons.map((addon) =>
                grant(addon.manifest.name, <><i className="library-badge">{addonRoleLabel(addon.role)}</i>
                  {!addon.enabled && <i className="library-badge off">{t("addons.badgeOff")}</i>}</>,
                  account ? (addon.allowedUsers ?? []).includes(account.id) : willGrant(addonKey(addon.key), addon.enabled),
                  t("users.grantAddon", { addon: addon.manifest.name }),
                  (value) => account ? setAddonGrant(addon, value) : pick(addonKey(addon.key), value)))}</div>}
        </section>}
        {tab === "downloads" && currentRole !== "admin" && <section className="user-edit-section">
          {heading(t("users.downloadsHeading"))}
          <div className="user-edit-switches">
            {switchFor(t("users.downloadToLibrary"), t("users.downloadToLibraryHint"), currentPermissions.downloadToLibrary, false,
              (value) => setDownload("downloadToLibrary", value))}
            {switchFor(t("users.downloadToDevice"), t("users.downloadToDeviceHint"), currentPermissions.downloadToDevice, false,
              (value) => setDownload("downloadToDevice", value))}
          </div>
        </section>}
      </div>
    </div>
  </div>;
}
