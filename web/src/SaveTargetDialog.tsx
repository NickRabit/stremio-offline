import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { describeError } from "./api";
import { t, useI18n } from "./i18n";
import { SaveTargetFields } from "./SaveTargetFields";
import type { SaveKind, SaveTarget } from "./save-target";
import type { AddonDownloadSettings, LibraryView } from "./types";

/** The "Save to…" dialog: the addon's rule or a destination the user picks, with a preview of
 *  where the title lands. Same shell as the move dialog, so the two feel like one thing. */
export function SaveTargetDialog({ label, kind, title, season, libraries, rule, onClose, onSubmit }: {
  label: string;
  kind: SaveKind;
  title: string;
  season?: number;
  libraries: LibraryView[];
  rule: AddonDownloadSettings | undefined;
  onClose: () => void;
  onSubmit: (target?: SaveTarget) => Promise<boolean>;
}) {
  useI18n();
  const [value, setValue] = useState<SaveTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const submit = async () => {
    setBusy(true); setError("");
    try {
      if (await onSubmit(value ?? undefined)) onClose();
    } catch (value) { setError(describeError(value)); }
    finally { setBusy(false); }
  };

  return <div className="identify-overlay" role="dialog" aria-modal="true" aria-label={t("saveTarget.title", { name: label })}
    onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="panel identify-card dialog-split save-target-card">
      <div className="identify-head">
        <h2>{t("saveTarget.title", { name: label })}</h2>
        <button type="button" className="icon-button" aria-label={t("common.close")} disabled={busy} onClick={onClose}><X/></button>
      </div>
      <div className="dialog-body">
        <SaveTargetFields kind={kind} title={title} season={season} libraries={libraries} rule={rule} value={value} onChange={setValue}/>
      </div>
      <footer className="dialog-foot">
        {error && <p className="login-error" role="alert">{error}</p>}
        <button type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
        <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? t("save.adding") : t("save.toLibrary")}
        </button>
      </footer>
    </div>
  </div>;
}
