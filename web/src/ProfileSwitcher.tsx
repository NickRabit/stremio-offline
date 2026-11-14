import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, KeyRound, Lock, X } from "lucide-react";
import { api, ApiError, describeError } from "./api";
import { useDialogFocus } from "./dialog-focus";
import { useDialogViewport } from "./dialog-viewport";
import { clearHomeCache } from "./home-cache";
import { t, useI18n, type Key } from "./i18n";
import type { ProfileEntry } from "./types";

type Step = "confirm" | "choose" | "unlock";
type UnlockMode = "pin" | "password";

const initial = (name: string) => name.trim().slice(0, 1).toLocaleUpperCase();
const mappedError = (error: ApiError) => {
  const key = error.messageKey;
  return key === "err.badPin" || key === "err.badCredentials" || key === "err.profileUnavailable"
    ? t(key as Key)
    : null;
};

export function ProfileSwitcher({ onClose, confirmStop, onSwitched = () => {
  clearHomeCache();
  location.reload();
} }: {
  onClose: () => void;
  confirmStop: boolean;
  onSwitched?: () => void;
}) {
  useI18n();
  const overlay = useRef<HTMLDivElement | null>(null);
  const field = useRef<HTMLInputElement | null>(null);
  const [step, setStep] = useState<Step>(confirmStop ? "confirm" : "choose");
  const [profiles, setProfiles] = useState<ProfileEntry[] | null>(null);
  const [selected, setSelected] = useState<ProfileEntry | null>(null);
  const [mode, setMode] = useState<UnlockMode>("password");
  const [secret, setSecret] = useState("");
  const [hint, setHint] = useState("");
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  useDialogFocus(overlay);
  useDialogViewport(overlay);

  useEffect(() => {
    let alive = true;
    api.profiles()
      .then((answer) => { if (alive) setProfiles(answer.profiles); })
      .catch((value) => { if (alive) setError(describeError(value)); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  useEffect(() => {
    if (step === "unlock") field.current?.focus({ preventScroll: true });
  }, [mode, selected?.id, step]);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => {
      const next = Math.max(0, remaining - 1);
      setRemaining(next);
      setError(next > 0 ? t("err.tooManyAttempts", { seconds: next }) : "");
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [remaining]);

  const clearField = () => {
    setSecret("");
    field.current?.focus({ preventScroll: true });
  };

  const switchTo = async (profile: ProfileEntry, body: { pin?: string; password?: string }) => {
    setBusy(true);
    setError("");
    try {
      await api.switchProfile({ id: profile.id, ...body });
      setSecret("");
      onSwitched();
    } catch (value) {
      clearField();
      if (!(value instanceof ApiError)) {
        setError(describeError(value));
        return;
      }
      if (value.messageKey === "err.pinLocked") {
        setMode("password");
        setHint(t("profiles.pinLocked"));
        setError("");
      } else if (value.status === 429) {
        const seconds = Math.max(1, Number(value.vars?.seconds) || 1);
        setRemaining(seconds);
        setError(t("err.tooManyAttempts", { seconds }));
      } else {
        setError(mappedError(value) ?? describeError(value));
      }
    } finally {
      setBusy(false);
    }
  };

  const choose = (profile: ProfileEntry) => {
    setRemaining(0);
    setError("");
    setSelected(profile);
    setSecret("");
    const locked = profile.pinLocked === true;
    const nextMode: UnlockMode = profile.unlock === "pin" && !locked ? "pin" : "password";
    setMode(nextMode);
    setHint(locked ? t("profiles.pinLocked") : "");
    if (profile.unlock === "none") {
      void switchTo(profile, {});
      return;
    }
    setStep("unlock");
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!selected || busy || remaining > 0 || !secret) return;
    void switchTo(selected, mode === "pin" ? { pin: secret } : { password: secret });
  };

  const usePassword = () => {
    setMode("password");
    setSecret("");
    setError("");
    setHint("");
    field.current?.focus({ preventScroll: true });
  };

  const back = () => {
    setRemaining(0);
    setStep("choose");
    setSelected(null);
    setSecret("");
    setHint("");
    setError("");
  };

  const title = step === "unlock" && selected
    ? <div className="profile-head-back">
        <button type="button" className="icon-button" aria-label={t("profiles.back")} disabled={busy} onClick={back}><ChevronLeft/></button>
        <h2>{selected.username}</h2>
      </div>
    : <h2>{t("profiles.switch")}</h2>;

  return createPortal(<div
    ref={overlay}
    tabIndex={-1}
    className="identify-overlay profile-switcher"
    role="dialog"
    aria-modal="true"
    aria-label={t("profiles.switch")}
    onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
  >
    <form className="panel identify-card dialog-split profile-card" onSubmit={submit}>
      <div className="identify-head">
        {title}
        <button type="button" className="icon-button" aria-label={t("common.close")} disabled={busy} onClick={onClose}><X/></button>
      </div>

      {step === "confirm" ? <>
        <div className="dialog-body"><p className="identify-hint">{t("profiles.stopWarning")}</p></div>
        <footer className="dialog-foot">
          <button type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
          <button type="button" className="primary" disabled={busy} onClick={() => setStep("choose")}>{t("profiles.stopConfirm")}</button>
        </footer>
      </> : step === "choose" ? <>
        <div className="dialog-body">
          {profiles === null && !error && <div className="loading" role="status">{t("common.loading")}</div>}
          {profiles && profiles.length > 0 && <div className="profile-list">
            {profiles.map((profile) => profile.current
              ? <div className="profile-row current" aria-current="true" key={profile.id}>
                  <span className="profile-face">{initial(profile.username)}</span>
                  <strong>{profile.username}</strong>
                  <small>{t("profiles.current")}</small>
                </div>
              : <button type="button" className="profile-row" key={profile.id} disabled={busy} onClick={() => choose(profile)}>
                  <span className="profile-face">{initial(profile.username)}</span>
                  <strong>{profile.username}</strong>
                  {profile.unlock === "pin" && <Lock aria-label={t("profiles.needsPin")}/>}
                  {profile.unlock === "password" && <KeyRound aria-label={t("profiles.needsPassword")}/>}
                </button>)}
          </div>}
          {/* The entry point is drawn from what the session knew at start; an administrator may
              have taken this account, or the last other one, out of the group since. */}
          {profiles && !profiles.some((profile) => !profile.current) && <p className="identify-hint">{t("profiles.empty")}</p>}
        </div>
        <footer className="dialog-foot">
          {error && <p className="login-error" role="alert">{error}</p>}
          <button type="button" onClick={onClose}>{t("common.close")}</button>
        </footer>
      </> : selected && <>
        <div className="dialog-body">
          <div className="profile-unlock">
            <span className="profile-face">{initial(selected.username)}</span>
            <p className="profile-hint">{mode === "pin" ? t("profiles.needsPin") : t("profiles.needsPassword")}</p>
            <label className="profile-field">
              <span>{mode === "pin"
                ? t("profiles.pinFor", { name: selected.username })
                : t("profiles.passwordFor", { name: selected.username })}</span>
              <input
                ref={field}
                className={mode === "pin" ? "profile-pin" : "profile-password"}
                type="password"
                value={secret}
                disabled={busy}
                autoComplete={mode === "pin" ? "off" : "current-password"}
                inputMode={mode === "pin" ? "numeric" : undefined}
                pattern={mode === "pin" ? "[0-9]*" : undefined}
                maxLength={mode === "pin" ? 8 : undefined}
                onChange={(event) => setSecret(event.target.value)}
              />
            </label>
            {mode === "pin" && <button type="button" className="profile-link" disabled={busy} onClick={usePassword}>
              {t("profiles.usePassword")}
            </button>}
          </div>
          {hint && <p className="login-error" role="alert">{hint}</p>}
        </div>
        <footer className="dialog-foot">
          {error && <p className="login-error" role="alert">{error}</p>}
          <button type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
          <button type="submit" className="primary" disabled={busy || remaining > 0 || !secret}>{t("profiles.submit")}</button>
        </footer>
      </>}
    </form>
  </div>, document.body);
}
