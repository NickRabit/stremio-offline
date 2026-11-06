import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { api, ApiError, describeError } from "./api";
import { useDialogFocus } from "./dialog-focus";
import { useDialogViewport } from "./dialog-viewport";
import { t, useI18n } from "./i18n";
import type { PairingInspection, Session } from "./types";

/** The code a TV put in its QR link (`?pair=`), if this page was opened from one. */
export const pairLinkCode = (search = location.search): string | null => {
  const value = new URLSearchParams(search).get("pair")?.trim();
  return value && value.length <= 16 ? value : null;
};

/** Takes the code out of the address, so a reload or a shared link does not reopen the dialog. */
export const clearPairLink = () => {
  const url = new URL(location.href);
  if (!url.searchParams.has("pair")) return;
  url.searchParams.delete("pair");
  history.replaceState(history.state, "", url);
};

export function PairDeviceDialog({ session, onClose, onNotify, initialCode }: {
  session: Session;
  onClose: () => void;
  onNotify: (message: string) => void;
  /** A code from a QR link: it is looked up at once, and approving still takes a click. */
  initialCode?: string;
}) {
  useI18n();
  const overlay = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const acting = useRef(false);
  const [code, setCode] = useState(initialCode ?? "");
  const [preview, setPreview] = useState<PairingInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [terminal, setTerminal] = useState(false);
  useDialogFocus(overlay);
  useDialogViewport(overlay);

  const cancelRequest = () => {
    request.current?.abort();
    request.current = null;
    generation.current += 1;
    acting.current = false;
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cancelRequest();
    };
  }, []);
  useEffect(() => {
    cancelRequest();
    setPreview(null);
    setError("");
    setTerminal(false);
    setBusy(false);
    acting.current = false;
  }, [session.username, session.role]);
  useEffect(() => {
    if (initialCode) inspect();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const close = () => {
    cancelRequest();
    onClose();
  };

  const edit = (value: string) => {
    cancelRequest();
    setCode(value);
    setPreview(null);
    setError("");
    setTerminal(false);
    setBusy(false);
  };

  const control = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (acting.current) return;
    cancelRequest();
    const current = generation.current;
    const controller = new AbortController();
    request.current = controller;
    acting.current = true;
    setBusy(true);
    setError("");
    try {
      await action(controller.signal);
      if (alive.current && current === generation.current) setTerminal(false);
    } catch (value) {
      if (controller.signal.aborted || !alive.current || current !== generation.current) return;
      setError(describeError(value));
      const status = value instanceof ApiError ? value.status : undefined;
      // The inspected code is gone or was inspected again elsewhere: its buttons can no longer succeed.
      if (status === 409 || status === 410) setPreview(null);
      setTerminal(status === 410);
    } finally {
      if (current === generation.current) {
        request.current = null;
        acting.current = false;
        if (alive.current) setBusy(false);
      }
    }
  };

  const inspect = () => {
    const wanted = code.trim();
    if (!wanted) return;
    void control(async (signal) => {
      const loaded = await api.inspectPairing(wanted, signal);
      if (!alive.current || signal.aborted) return;
      setPreview(loaded);
      setCode(loaded.code);
    });
  };

  const approve = () => {
    if (!preview) return;
    void control(async (signal) => {
      await api.approvePairing(preview.code, preview.nonce, signal);
      if (!alive.current || signal.aborted) return;
      onNotify(t("pair.success"));
      onClose();
    });
  };

  const deny = () => {
    if (!preview) return;
    void control(async (signal) => {
      await api.denyPairing(preview.code, preview.nonce, signal);
      if (alive.current && !signal.aborted) onClose();
    });
  };

  const retry = () => {
    edit("");
    requestAnimationFrame(() => input.current?.focus());
  };

  return createPortal(<div
    ref={overlay}
    tabIndex={-1}
    className="identify-overlay"
    role="dialog"
    aria-modal="true"
    aria-label={t("pair.title")}
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}
  >
    <div className="panel identify-card dialog-split pair-device-card">
      <div className="identify-head">
        <h2>{t("pair.title")}</h2>
        <button type="button" className="icon-button" aria-label={t("common.close")} onClick={close}><X/></button>
      </div>
      <div className="dialog-body">
        {!preview ? <>
          <p className="identify-hint">{t("pair.warning")}</p>
          <label>
            <span>{t("pair.code")}</span>
            <input
              ref={input}
              autoFocus
              value={code}
              onChange={(event) => edit(event.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              inputMode="text"
            />
          </label>
        </> : <>
          <p className="pair-confirm">{t("pair.confirm", { device: preview.deviceLabel, username: preview.username })}</p>
          <code className="pair-device-code">{`${preview.code.slice(0, 4)} ${preview.code.slice(4)}`}</code>
          <p className="identify-hint">{t("pair.warning")}</p>
          <p className="identify-hint">{t("pair.expires", { seconds: preview.expiresIn })}</p>
        </>}
      </div>
      <footer className="dialog-foot">
        {error && <p className="login-error" role="alert">{error}</p>}
        <button type="button" onClick={close}>{t("common.cancel")}</button>
        {preview ? <>
          <button type="button" disabled={busy} onClick={deny}>{t("pair.deny")}</button>
          <button type="button" className="primary" disabled={busy} onClick={approve}>{t("pair.approve")}</button>
        </> : terminal
          ? <button type="button" className="primary" disabled={busy} onClick={retry}>{t("common.retry")}</button>
          : <button type="button" className="primary" disabled={busy || !code.trim()} onClick={inspect}>
              {busy ? t("common.loading") : t("pair.inspect")}
            </button>}
      </footer>
    </div>
  </div>, document.body);
}
