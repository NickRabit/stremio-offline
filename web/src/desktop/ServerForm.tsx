import { useState } from "react";
import { Check, LoaderCircle, TriangleAlert } from "lucide-react";
import { t } from "../i18n";
import type { ProbeResult, ServerProfile, ShellBridge } from "./bridge";

const probeText = (result: ProbeResult) => result.ok ? t("desktop.testOk", { version: result.version })
  : result.reason === "insecure-transport" ? t("desktop.errorInsecureText")
  : result.reason === "not-status" ? t("desktop.errorNotStatusText")
  : result.reason === "invalid" ? t("desktop.invalidAddress")
  : t("desktop.errorUnreachableText");

/** Adds or edits a saved server. `onSaved` gets the stored profile, so the caller can connect to it. */
export function ServerForm({ bridge, profile, submitLabel, onSaved, onCancel }: {
  bridge: ShellBridge;
  profile?: ServerProfile;
  submitLabel: string;
  onSaved: (profile: ServerProfile) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(profile?.name ?? "");
  const [origin, setOrigin] = useState(profile?.origin ?? "http://");
  const [probe, setProbe] = useState<ProbeResult | "testing" | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const test = async () => {
    setProbe("testing");
    setProbe(await bridge.probe(origin.trim()));
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await bridge.saveProfile({ id: profile?.id ?? null, name, origin });
      if (result.ok) return onSaved(result.profile);
      setError(result.reason === "invalid-name" ? t("desktop.invalidName") : result.reason === "invalid-data" ? t("desktop.invalidAddress") : t("desktop.saveFailed"));
    } finally { setBusy(false); }
  };

  return <form className="shell-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <label><span>{t("desktop.serverName")}</span>
      <input value={name} maxLength={80} autoFocus placeholder={t("desktop.serverNamePlaceholder")} onChange={(event) => setName(event.target.value)}/></label>
    <label><span>{t("desktop.serverAddress")}</span>
      <div className="shell-inline">
        <input value={origin} inputMode="url" spellCheck={false} autoCapitalize="off" autoCorrect="off"
          onChange={(event) => { setOrigin(event.target.value); setProbe(null); }}/>
        <button type="button" onClick={() => void test()} disabled={probe === "testing" || !origin.trim()}>{t("desktop.testServer")}</button>
      </div>
      <small>{t("desktop.serverAddressHint")}</small></label>
    {probe && <p className={`shell-probe ${probe === "testing" ? "" : probe.ok ? "ok" : "bad"}`} role="status">
      {probe === "testing" ? <LoaderCircle className="shell-spin"/> : probe.ok ? <Check/> : <TriangleAlert/>}
      <span>{probe === "testing" ? t("desktop.connectingTo", { name: origin.trim() }) : probeText(probe)}</span>
    </p>}
    {error && <p className="shell-probe bad" role="alert"><TriangleAlert/><span>{error}</span></p>}
    <div className="shell-actions">
      <button type="button" onClick={onCancel}>{t("desktop.cancel")}</button>
      <button type="submit" className="primary" disabled={busy}>{submitLabel}</button>
    </div>
  </form>;
}
