import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { describeError } from "./api";
import { useDialogFocus } from "./dialog-focus";
import { useDialogViewport } from "./dialog-viewport";
import { t, useI18n } from "./i18n";
import { SaveTargetFields } from "./SaveTargetFields";
import type { SaveKind, SaveTarget } from "./save-target";
import type { AddonDownloadSettings, LibraryView } from "./types";

/** The "Save to…" dialog: the addon's rule or a destination the user picks, with a preview of
 *  where the title lands. Same shell as the move dialog, so the two feel like one thing. */
export function SaveTargetDialog({ label, kind, title, season, libraries, rule, children, ruleUnavailable = false, submitDisabled = false, onClose, onSubmit }: {
  label: string;
  kind: SaveKind;
  title: string;
  season?: number;
  libraries: LibraryView[];
  rule: AddonDownloadSettings | undefined;
  /** Extra controls above the destination, such as a version chooser for a native copy. */
  children?: ReactNode;
  /** A native source whose server projected no concrete destination: the automatic option is
   *  refused and the copy cannot be submitted until the viewer picks a library themselves. */
  ruleUnavailable?: boolean;
  /** Holds the primary action back while a source or a destination is not yet usable. */
  submitDisabled?: boolean;
  onClose: () => void;
  onSubmit: (target?: SaveTarget) => Promise<boolean>;
}) {
  useI18n();
  const [value, setValue] = useState<SaveTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const submitting = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const overlay = useRef<HTMLDivElement | null>(null);
  // The panel is a container-query container, which would trap a fixed overlay inside it and
  // clip it; the dialog is portalled to the body so it covers the viewport as the shell intends.
  useDialogFocus(overlay);
  useDialogViewport(overlay);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const submit = async () => {
    if (submitting.current || submitDisabled || (ruleUnavailable && value === null)) return;
    submitting.current = true;
    setBusy(true); setError("");
    try {
      if (await onSubmit(value ?? undefined) && alive.current) onClose();
    } catch (value) { if (alive.current) setError(describeError(value)); }
    finally { submitting.current = false; if (alive.current) setBusy(false); }
  };

  return createPortal(<div ref={overlay} tabIndex={-1} className="identify-overlay" role="dialog" aria-modal="true" aria-label={t("saveTarget.title", { name: label })}
    onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="panel identify-card dialog-split save-target-card">
      <div className="identify-head">
        <h2>{t("saveTarget.title", { name: label })}</h2>
        <button type="button" className="icon-button" aria-label={t("common.close")} disabled={busy} onClick={onClose}><X/></button>
      </div>
      <div className="dialog-body">
        {children}
        <SaveTargetFields kind={kind} title={title} season={season} libraries={libraries} rule={rule} ruleUnavailable={ruleUnavailable} value={value} onChange={setValue}/>
      </div>
      <footer className="dialog-foot">
        {error && <p className="login-error" role="alert">{error}</p>}
        <button type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
        <button type="button" className="primary" disabled={busy || submitDisabled || (ruleUnavailable && value === null)} onClick={() => void submit()}>
          {busy ? t("save.adding") : t("save.toLibrary")}
        </button>
      </footer>
    </div>
  </div>, document.body);
}
