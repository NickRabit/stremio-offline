import { FormEvent, useState } from "react";
import { CirclePlay, KeyRound, Languages, LogOut, ShieldAlert } from "lucide-react";
import { api, describeError } from "./api";
import type { Session } from "./types";
import { SettingControl, SettingsSectionHead } from "./settings-ui";
import { LOCALES, LOCALE_NAMES, useI18n, type Locale } from "./i18n";
import { PairDeviceDialog } from "./PairDeviceDialog";

export function LoginScreen({ setup, onSession }: { setup: boolean; onSession: (session: Session) => void }) {
  const { t, locale, setLocale } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(""); setBusy(true);
    try {
      if (setup) {
        if (username.trim().length < 3) throw new Error(t("auth.usernameTooShort"));
        if (password.length < 6) throw new Error(t("auth.passwordTooShort"));
        if (password !== repeat) throw new Error(t("auth.passwordMismatch"));
        onSession(await api.setup(username.trim(), password, locale));
      } else {
        const signedIn = await api.login(username.trim(), password, remember);
        const current = await api.me().catch(() => null);
        onSession(current && !("setup" in current) && current.username === signedIn.username ? current : signedIn);
      }
    } catch (value) { setError(describeError(value)); }
    finally { setBusy(false); }
  };

  return <div className="login-screen">
    <form className="panel login-card" onSubmit={submit}>
      <div className="login-brand"><div className="brand-mark"><CirclePlay/></div><div><small>{t("auth.brandEyebrow")}</small><h1>Stremio <span>Offline</span></h1></div></div>

      {setup
        ? <p className="login-warning"><ShieldAlert/> {t("auth.setupLead")}</p>
        : <p className="login-lead">{t("auth.signInLead")}</p>}

      {setup && <label><span><Languages/> {t("auth.language")}</span>
        <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)} aria-label={t("auth.language")}>
          {LOCALES.map((code) => <option key={code} value={code}>{LOCALE_NAMES[code]}</option>)}
        </select></label>}

      <label><span>{t("auth.username")}</span>
        <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus required/></label>

      <label><span>{t("auth.password")}</span>
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)}
          autoComplete={setup ? "new-password" : "current-password"} required/></label>

      {setup && <label><span>{t("auth.passwordRepeat")}</span>
        <input type="password" value={repeat} onChange={(event) => setRepeat(event.target.value)} autoComplete="new-password" required/></label>}

      {!setup && <label className="login-remember">
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)}/>
        <span>{t("auth.remember")}</span></label>}

      {error && <p className="login-error">{error}</p>}
      <button className="primary" disabled={busy}><KeyRound/> {setup ? t("auth.createAccount") : t("auth.signIn")}</button>
    </form>
  </div>;
}

/** The way out of a password an administrator chose. The server refuses everything but this
 *  form, reading one's own name and signing out, so rendering the application would be
 *  rendering a shell whose every request comes back refused with nothing to explain it. The
 *  current password is the one that was just used to sign in, and is asked for again because
 *  the endpoint verifies it. */
export function PasswordChangeRequired({ session, onSession }: {
  session: Session; onSession: (session: Session) => void;
}) {
  const { t } = useI18n();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (newPassword.length < 6) return setError(t("auth.newPasswordTooShort"));
    if (newPassword !== repeat) return setError(t("auth.passwordMismatch"));
    setBusy(true);
    try { onSession(await api.changeCredentials({ currentPassword, newPassword })); }
    catch (caught) { setError(describeError(caught)); }
    finally { setBusy(false); }
  };

  const signOut = async () => { try { await api.logout(false); } finally { location.reload(); } };

  return <div className="login-screen">
    <form className="panel login-card" onSubmit={submit}>
      <div className="login-brand"><div className="brand-mark"><CirclePlay/></div><div><small>{t("auth.brandEyebrow")}</small><h1>Stremio <span>Offline</span></h1></div></div>
      <p className="login-warning"><ShieldAlert/> {t("auth.mustChangeLead", { username: session.username })}</p>

      <label><span>{t("auth.currentPassword")}</span>
        <input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)}
          autoComplete="current-password" autoFocus required/></label>

      <label><span>{t("auth.newPassword")}</span>
        <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)}
          autoComplete="new-password" required/></label>

      <label><span>{t("auth.passwordRepeat")}</span>
        <input type="password" value={repeat} onChange={(event) => setRepeat(event.target.value)}
          autoComplete="new-password" required/></label>

      {error && <p className="login-error">{error}</p>}
      <button className="primary" disabled={busy}><KeyRound/> {t("auth.changeCredentials")}</button>
      <button type="button" onClick={() => void signOut()}><LogOut/> {t("auth.signOut")}</button>
    </form>
  </div>;
}

export function AccountSettings({ session, onSession, onNotify, onError, restricted = false }: {
  session: Session; onSession: (session: Session) => void;
  onNotify: (text: string) => void; onError: (error: unknown) => void; restricted?: boolean;
}) {
  const { t } = useI18n();
  const [username, setUsername] = useState(session.username);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [pinPassword, setPinPassword] = useState("");
  const [newPin, setNewPin] = useState("");
  const [pinBusy, setPinBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword.length < 6) return onError(new Error(t("auth.newPasswordTooShort")));
    setBusy(true);
    try {
      onSession(await api.changeCredentials({ username: username.trim(), currentPassword, newPassword }));
      setCurrentPassword(""); setNewPassword("");
      onNotify(t("auth.credentialsChanged"));
    } catch (error) { onError(error); }
    finally { setBusy(false); }
  };

  const signOut = async (everywhere: boolean) => {
    if (everywhere && !confirm(t("auth.signOutEverywhereConfirm"))) return;
    try { await api.logout(everywhere); } finally { location.reload(); }
  };

  const savePin = async () => {
    if (!/^[0-9]{4,8}$/.test(newPin)) {
      onError(new Error(t("err.pinFormat")));
      return;
    }
    setPinBusy(true);
    try {
      const answer = await api.setOwnPin({ currentPassword: pinPassword, pin: newPin });
      onSession({ ...session, hasPin: answer.hasPin });
      setPinPassword("");
      setNewPin("");
      onNotify(t("profiles.pinSaved"));
    } catch (error) { onError(error); }
    finally { setPinBusy(false); }
  };

  const removePin = async () => {
    setPinBusy(true);
    try {
      const answer = await api.setOwnPin({ currentPassword: pinPassword, pin: null });
      onSession({ ...session, hasPin: answer.hasPin });
      setPinPassword("");
      setNewPin("");
      onNotify(t("profiles.pinRemoved"));
    } catch (error) { onError(error); }
    finally { setPinBusy(false); }
  };

  return <>
    <form className="panel settings-section" onSubmit={submit}>
      <SettingsSectionHead icon={<KeyRound/>} title={t("auth.sectionTitle")} text={t("auth.signedInAs", { username: session.username })}/>
      {!restricted && <>
        <SettingControl title={t("auth.username")} text={t("auth.usernameHint")}>
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required/>
        </SettingControl>
        <SettingControl title={t("auth.currentPassword")} text={t("auth.currentPasswordHint")}>
          <input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required/>
        </SettingControl>
        <SettingControl title={t("auth.newPassword")} text={t("auth.newPasswordHint")}>
          <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" required/>
        </SettingControl>
      </>}
      <div className="setting-actions">
        {!restricted && <button className="primary" disabled={busy}><KeyRound/> {t("auth.changeCredentials")}</button>}
        <button type="button" onClick={() => void signOut(false)}><LogOut/> {t("auth.signOut")}</button>
        {!restricted && <button type="button" className="danger" onClick={() => void signOut(true)}><ShieldAlert/> {t("auth.signOutEverywhere")}</button>}
        {!restricted && <button type="button" disabled={busy} onClick={() => setPairing(true)}>{t("pair.title")}</button>}
      </div>
      {!restricted && <small className="setting-note">{t("auth.sessionNote")}</small>}
    </form>
    {!restricted && (session.canSwitch || session.hasPin) && <section className="panel settings-section profile-own-pin">
      <SettingsSectionHead icon={<KeyRound/>} title={t("profiles.ownPin")} text={t("profiles.ownPinHint")}/>
      <SettingControl title={t("auth.currentPassword")} text={t("auth.currentPasswordHint")}>
        <input type="password" value={pinPassword} onChange={(event) => setPinPassword(event.target.value)} autoComplete="current-password"/>
      </SettingControl>
      <SettingControl title={t("profiles.newPin")} text={t("profiles.pinHint")}>
        <input type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={newPin} onChange={(event) => setNewPin(event.target.value)}/>
      </SettingControl>
      <div className="setting-actions">
        <button type="button" className="primary" disabled={pinBusy || !pinPassword || !newPin} onClick={() => void savePin()}>
          {t(session.hasPin ? "profiles.changePin" : "profiles.setPin")}
        </button>
        {session.hasPin && <button type="button" className="danger" disabled={pinBusy || !pinPassword} onClick={() => void removePin()}>
          {t("profiles.removePin")}
        </button>}
      </div>
    </section>}
    {!restricted && pairing && <PairDeviceDialog session={session} onClose={() => setPairing(false)} onNotify={onNotify}/>}
  </>;
}
