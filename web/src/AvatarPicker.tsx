import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { api, describeError } from "./api";
import { Avatar } from "./Avatar";
import { squareAvatar } from "./avatar-image";
import { useDialogFocus } from "./dialog-focus";
import { useDialogViewport } from "./dialog-viewport";
import { t, useI18n } from "./i18n";
import type { Avatar as AvatarValue } from "./types";

export function AvatarPicker({ name, avatar, allowUpload, onPreset, onUpload, onClose }: {
  name: string;
  avatar?: AvatarValue;
  allowUpload: boolean;
  onPreset: (id: string | null) => Promise<AvatarValue | undefined>;
  onUpload: (image: Blob) => Promise<AvatarValue | undefined>;
  onClose: () => void;
}) {
  useI18n();
  const overlay = useRef<HTMLDivElement | null>(null);
  const upload = useRef<HTMLInputElement | null>(null);
  const [current, setCurrent] = useState<AvatarValue | undefined>(avatar);
  const [presets, setPresets] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useDialogFocus(overlay);
  useDialogViewport(overlay);

  useEffect(() => setCurrent(avatar), [avatar]);

  useEffect(() => {
    let alive = true;
    api.avatarPresets()
      .then((answer) => { if (alive) setPresets(answer.presets); })
      .catch((failure) => { if (alive) setError(describeError(failure)); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const choose = async (id: string | null) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await onPreset(id);
      setCurrent(id === null ? undefined : next ?? current);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  const uploadFile = async (file: Blob) => {
    setBusy(true);
    setError("");
    let image: Blob;
    try {
      image = await squareAvatar(file);
    } catch {
      setError(t("avatar.unreadable"));
      setBusy(false);
      return;
    }
    try {
      const next = await onUpload(image);
      if (next) setCurrent(next);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(<div
    ref={overlay}
    tabIndex={-1}
    className="identify-overlay avatar-picker"
    role="dialog"
    aria-modal="true"
    aria-label={t("avatar.pick")}
    onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
  >
    <div className="panel identify-card dialog-split avatar-picker-card">
      <div className="identify-head">
        <h2>{t("avatar.title")}</h2>
        <button type="button" className="icon-button" aria-label={t("common.close")} disabled={busy} onClick={onClose}><X/></button>
      </div>
      <div className="dialog-body">
        <div className="avatar-picker-current"><Avatar name={name} avatar={current} size={96}/><strong>{name}</strong></div>
        {presets === null && !error
          ? <div className="loading" role="status">{t("common.loading")}</div>
          : <div className="avatar-grid">
              {presets?.map((id) => <button
                key={id}
                type="button"
                aria-label={id.replaceAll("-", " ")}
                aria-pressed={current?.kind === "preset" && current.id === id}
                disabled={busy}
                onClick={() => void choose(id)}
              ><Avatar name={id} avatar={{ kind: "preset", id }} size={44}/></button>)}
            </div>}
        <div className="avatar-picker-actions">
          <button type="button" aria-pressed={!current} disabled={busy} onClick={() => void choose(null)}>{t("avatar.useInitial")}</button>
          {allowUpload && <>
            <button type="button" disabled={busy} onClick={() => upload.current?.click()}>{t("avatar.upload")}</button>
            <input
              ref={upload}
              className="file-input"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label={t("avatar.upload")}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void uploadFile(file);
              }}
            />
            <small>{t("avatar.uploadHint")}</small>
          </>}
        </div>
      </div>
      <footer className="dialog-foot">
        {error && <p className="login-error" role="alert">{error}</p>}
        <button type="button" onClick={onClose}>{t("common.close")}</button>
      </footer>
    </div>
  </div>, document.body);
}
