import { useState } from "react";
import { FolderOpen, TriangleAlert } from "lucide-react";
import { t } from "../i18n";
import type { ShellBridge, ShellState } from "./bridge";

type Failure = keyof typeof FAILURE_TEXT;
const FAILURE_TEXT = { "not-absolute": "desktop.folderNotAbsolute", "not-folder": "desktop.folderNotFolder", "not-writable": "desktop.folderNotWritable", reserved: "desktop.folderReserved" } as const;

/** Makes the chosen folder ready and stores it as the local backend's download folder. */
export async function adoptDownloadDir(bridge: ShellBridge, state: ShellState, dir: string): Promise<Failure | null> {
  const prepared = await bridge.prepareDownloadDir(dir);
  if (!prepared.ok) return prepared.reason;
  const stored = await bridge.setLocalSettings({ ...state.local.settings, downloadDir: prepared.dir });
  return stored.ok ? null : "not-writable";
}

/** A long path is cut at its start, where it matters least; the text itself stays left to right. */
export function FolderPath({ dir }: { dir: string }) {
  return <code title={dir}><bdi dir="ltr">{dir}</bdi></code>;
}

export function FolderError({ failure }: { failure: Failure | null }) {
  if (!failure) return null;
  return <p className="shell-probe bad" role="alert"><TriangleAlert/><span>{t(FAILURE_TEXT[failure])}</span></p>;
}

/** The setup step after "This Mac": where downloads go, before the backend exists. */
export function FolderStep({ bridge, state, onBack }: { bridge: ShellBridge; state: ShellState; onBack: () => void }) {
  const [dir, setDir] = useState(state.local.settings.downloadDir ?? state.local.suggestedDownloadDir);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const choose = async () => {
    const picked = await bridge.pickFolder(dir);
    if (picked) { setDir(picked); setFailure(null); }
  };
  const start = async () => {
    setBusy(true);
    try {
      const failed = await adoptDownloadDir(bridge, state, dir);
      if (failed) return setFailure(failed);
      await bridge.connect({ kind: "local" });
    } finally { setBusy(false); }
  };
  return <div className="shell-card shell-welcome-form shell-folder-step">
    <h3><FolderOpen/> {t("desktop.setupFolderTitle")}</h3>
    <p className="shell-step-text">{t("desktop.setupFolderText")}</p>
    <div className="shell-folder"><FolderPath dir={dir}/><button type="button" onClick={() => void choose()}>{t("desktop.chooseFolder")}</button></div>
    <FolderError failure={failure}/>
    <div className="shell-actions">
      <button type="button" onClick={onBack}>{t("desktop.back")}</button>
      <button type="button" className="primary" autoFocus disabled={busy} onClick={() => void start()}>{t("desktop.start")}</button>
    </div>
  </div>;
}
