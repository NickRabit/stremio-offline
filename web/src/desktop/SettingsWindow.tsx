import { useEffect, useState } from "react";
import { Check, Copy, Download, Info, Languages, Laptop, Network, Pencil, Plus, RefreshCw, RotateCcw, Server, Trash2, TriangleAlert } from "lucide-react";
import { LOCALE_NAMES, t } from "../i18n";
import { SettingControl, SettingsSectionHead } from "../settings-ui";
import type { AppPrefs, LocalSettings, ServerProfile, ShellBridge, ShellState, Target } from "./bridge";
import { adoptDownloadDir, FolderError, FolderPath } from "./DownloadFolder";
import { ServerForm } from "./ServerForm";

type Reach = "testing" | "online" | "offline";

const isCurrent = (state: ShellState, target: Target) => {
  const current = state.connection?.target;
  if (!current || state.screen.kind !== "connected") return false;
  return current.kind === target.kind && (current.kind === "local" || (target.kind === "profile" && current.id === target.id));
};

export function SettingsWindow({ bridge, state }: { bridge: ShellBridge; state: ShellState }) {
  return <div className="shell-settings">
    <header className="shell-titlebar"><h1>{t("desktop.settingsTitle")}</h1></header>
    <div className="shell-settings-body">
      <GeneralSection bridge={bridge} state={state}/>
      <ServerSection bridge={bridge} state={state}/>
      <ThisMacSection bridge={bridge} state={state}/>
      <AboutSection bridge={bridge} state={state}/>
      <ResetSection bridge={bridge} state={state}/>
    </div>
  </div>;
}

function GeneralSection({ bridge, state }: { bridge: ShellBridge; state: ShellState }) {
  const systemLocale = state.localeChoice === null ? state.locale : null;
  const { prefs, loginItem } = state.app;
  const [loginFailed, setLoginFailed] = useState(false);
  const store = async (next: AppPrefs) => {
    const result = await bridge.setAppPrefs(next);
    setLoginFailed(!result.ok && next.openAtLogin !== prefs.openAtLogin);
  };
  const loginNote = loginItem === "unsupported" ? t("desktop.loginItemUnsupported")
    : loginFailed ? t("desktop.loginItemFailed")
    : loginItem === "requires-approval" ? t("desktop.loginItemApproval") : null;
  return <section className="settings-section shell-card">
    <SettingsSectionHead icon={<Languages/>} title={t("desktop.sectionGeneral")}/>
    <div className="shell-controls">
      <SettingControl title={t("desktop.language")} text={t("desktop.languageText")}>
        <select value={state.localeChoice ?? "system"} onChange={(event) => {
          const value = event.target.value;
          void bridge.setLocale(value === "cs" || value === "en" ? value : null);
        }}>
          <option value="system">{t("desktop.languageSystem", { language: LOCALE_NAMES[systemLocale ?? state.locale] })}</option>
          <option value="cs">{LOCALE_NAMES.cs}</option>
          <option value="en">{LOCALE_NAMES.en}</option>
        </select>
      </SettingControl>
      <SettingControl title={t("desktop.openAtLogin")} text={t("desktop.openAtLoginText")}>
        <span className="switch"><input type="checkbox" checked={prefs.openAtLogin} disabled={loginItem === "unsupported"}
          onChange={(event) => void store({ ...prefs, openAtLogin: event.target.checked })}/><span/></span>
      </SettingControl>
      {loginNote && <p className={`shell-probe ${loginItem === "unsupported" ? "" : "bad"}`}><TriangleAlert/><span>{loginNote}</span></p>}
      <SettingControl title={t("desktop.checkUpdates")} text={t("desktop.checkUpdatesText")}>
        <span className="switch"><input type="checkbox" checked={prefs.checkUpdates} onChange={(event) => void store({ ...prefs, checkUpdates: event.target.checked })}/><span/></span>
      </SettingControl>
    </div>
  </section>;
}

function ServerSection({ bridge, state }: { bridge: ShellBridge; state: ShellState }) {
  const [reach, setReach] = useState<Record<string, Reach>>({});
  const [editing, setEditing] = useState<ServerProfile | "new" | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const origins = state.profiles.map((profile) => `${profile.id}=${profile.origin}`).join(" ");

  // Every saved server is asked once when the window opens and after an edit, so the list says
  // which of them can be chosen right now.
  useEffect(() => {
    let live = true;
    for (const profile of state.profiles) {
      setReach((current) => ({ ...current, [profile.id]: "testing" }));
      void bridge.probe(profile.origin).then((result) => {
        if (live) setReach((current) => ({ ...current, [profile.id]: result.ok ? "online" : "offline" }));
      });
    }
    return () => { live = false; };
  }, [bridge, origins]);

  const fallbackFrom = state.connection?.fallbackFrom;
  const localRow = <div className={`shell-server${isCurrent(state, { kind: "local" }) ? " current" : ""}`}>
    <button className="shell-server-main" onClick={() => void bridge.connect({ kind: "local" })}>
      <i><Laptop/></i>
      <span><strong>{t("desktop.thisMac")}</strong><small className="shell-wrap">{t("desktop.thisMacText")}</small></span>
      {isCurrent(state, { kind: "local" }) && <em className={`shell-chip ${fallbackFrom ? "warn" : "ok"}`}>{fallbackFrom ? t("desktop.serverStandIn", { name: fallbackFrom }) : t("desktop.serverConnected")}</em>}
    </button>
  </div>;

  return <section className="settings-section shell-card">
    <SettingsSectionHead icon={<Server/>} title={t("desktop.sectionServer")} text={t("desktop.sectionServerText")}/>
    <div className="shell-servers" role="list">
      {localRow}
      {state.profiles.map((profile) => {
        const target: Target = { kind: "profile", id: profile.id };
        const current = isCurrent(state, target);
        const status = reach[profile.id];
        if (editing !== "new" && editing?.id === profile.id) {
          return <div className="shell-server editing" key={profile.id}>
            <ServerForm bridge={bridge} profile={profile} submitLabel={t("desktop.save")} onCancel={() => setEditing(null)} onSaved={() => setEditing(null)}/>
          </div>;
        }
        return <div className={`shell-server${current ? " current" : ""}`} key={profile.id} role="listitem">
          <button className="shell-server-main" onClick={() => void bridge.connect(target)}>
            <i><Server/></i>
            <span><strong>{profile.name}</strong><small>{profile.origin}</small></span>
            {current ? <em className="shell-chip ok">{t("desktop.serverConnected")}</em>
              : status && status !== "testing" && <em className={`shell-chip ${status === "online" ? "ok" : "off"}`}>{status === "online" ? t("desktop.serverOnline") : t("desktop.serverOffline")}</em>}
          </button>
          {removing === profile.id
            ? <div className="shell-server-confirm">
              <span>{t("desktop.removeServerConfirm", { name: profile.name })}</span>
              <button onClick={() => setRemoving(null)}>{t("desktop.cancel")}</button>
              <button className="danger" onClick={() => { setRemoving(null); void bridge.deleteProfile(profile.id); }}>{t("desktop.removeServer")}</button>
            </div>
            : <div className="shell-server-tools">
              <button className="shell-icon" title={t("desktop.editServer")} aria-label={t("desktop.editServer")} onClick={() => setEditing(profile)}><Pencil/></button>
              <button className="shell-icon" title={t("desktop.removeServer")} aria-label={t("desktop.removeServer")} disabled={current} onClick={() => setRemoving(profile.id)}><Trash2/></button>
            </div>}
        </div>;
      })}
    </div>
    {editing === "new"
      ? <div className="shell-server editing"><ServerForm bridge={bridge} submitLabel={t("desktop.save")} onCancel={() => setEditing(null)} onSaved={() => setEditing(null)}/></div>
      : <button className="shell-add" onClick={() => setEditing("new")}><Plus/> {t("desktop.addServer")}</button>}
  </section>;
}

const validPort = (value: string) => /^\d+$/.test(value) && Number(value) >= 1024 && Number(value) <= 65535;

function ThisMacSection({ bridge, state }: { bridge: ShellBridge; state: ShellState }) {
  const { local } = state;
  const [port, setPort] = useState(String(local.settings.publishPort));
  const [portError, setPortError] = useState(false);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => setPort(String(local.settings.publishPort)), [local.settings.publishPort]);

  const store = async (settings: LocalSettings) => {
    const result = await bridge.setLocalSettings(settings);
    if (result.ok && result.restartNeeded) setRestartNeeded(true);
  };
  const commitPort = () => {
    if (!validPort(port)) return setPortError(true);
    setPortError(false);
    if (Number(port) !== local.settings.publishPort) void store({ ...local.settings, publishPort: Number(port) });
  };
  const restart = async () => {
    if (local.busy && !confirming) return setConfirming(true);
    setConfirming(false);
    setRestarting(true);
    setFailed(false);
    const result = await bridge.restartLocal();
    setRestarting(false);
    if (result.ok) setRestartNeeded(false); else setFailed(true);
  };
  const copy = (address: string) => { bridge.copyText(address); setCopied(address); setTimeout(() => setCopied((current) => current === address ? null : current), 1500); };

  return <section className="settings-section shell-card">
    <div className="shell-section-top">
      <SettingsSectionHead icon={<Laptop/>} title={t("desktop.sectionThisMac")} text={t("desktop.sectionThisMacText")}/>
      <em className={`shell-chip ${local.running ? "ok" : "off"}`}>{local.running ? t("desktop.localRunning") : t("desktop.localStopped")}</em>
    </div>
    <DownloadFolderRow bridge={bridge} state={state}/>
    <div className="shell-controls">
      <SettingControl title={t("desktop.share")} text={t("desktop.shareText")}>
        <span className="switch"><input type="checkbox" checked={local.settings.publish} onChange={(event) => void store({ ...local.settings, publish: event.target.checked })}/><span/></span>
      </SettingControl>
      {local.settings.publish && <div className="shell-port">
        <label><span>{t("desktop.port")}</span>
          <input value={port} inputMode="numeric" maxLength={5} aria-invalid={portError} onChange={(event) => setPort(event.target.value)}
            onBlur={commitPort} onKeyDown={(event) => { if (event.key === "Enter") commitPort(); }}/></label>
        {portError && <small className="shell-error">{t("desktop.portInvalid")}</small>}
        {local.running && local.addresses.length > 0 && <div className="shell-addresses">
          <small>{t("desktop.openOn")}</small>
          {local.addresses.map((address) => <div className="shell-address" key={address}>
            <code>{address}</code>
            <button className="shell-icon" title={t("desktop.copy")} aria-label={t("desktop.copy")} onClick={() => copy(address)}>{copied === address ? <Check/> : <Copy/>}</button>
          </div>)}
        </div>}
      </div>}
      <SettingControl title={t("desktop.lanAddons")} text={t("desktop.lanAddonsText")}>
        <span className="switch"><input type="checkbox" checked={local.settings.allowPrivateAddons} onChange={(event) => void store({ ...local.settings, allowPrivateAddons: event.target.checked })}/><span/></span>
      </SettingControl>
    </div>
    {(restartNeeded || confirming || failed) && local.running && <div className={`shell-notice${confirming ? " warn" : ""}`} role="status">
      <Network/>
      <span>{failed ? t("desktop.restartFailed") : confirming ? t("desktop.restartBusy") : t("desktop.restartNeeded")}</span>
      {confirming && <button onClick={() => setConfirming(false)}>{t("desktop.cancel")}</button>}
      <button className="primary" disabled={restarting} onClick={() => void restart()}><RefreshCw className={restarting ? "shell-spin" : ""}/> {t("desktop.restartLocal")}</button>
    </div>}
  </section>;
}

/** Fixed once the backend exists (its first library's root); before that it can still be chosen. */
function DownloadFolderRow({ bridge, state }: { bridge: ShellBridge; state: ShellState }) {
  const [failure, setFailure] = useState<Parameters<typeof FolderError>[0]["failure"]>(null);
  const change = async () => {
    const picked = await bridge.pickFolder(state.local.downloadDir);
    if (picked) setFailure(await adoptDownloadDir(bridge, state, picked));
  };
  return <div className="shell-folder-row">
    <span><strong>{t("desktop.downloadFolder")}</strong>{state.local.initialized && <small>{t("desktop.downloadFolderFixed")}</small>}</span>
    <div className="shell-folder"><FolderPath dir={state.local.downloadDir}/>
      {!state.local.initialized && <button type="button" onClick={() => void change()}>{t("desktop.change")}</button>}</div>
    <FolderError failure={failure}/>
  </div>;
}

function ResetSection({ bridge, state }: { bridge: ShellBridge; state: ShellState }) {
  const [deleteDownloads, setDeleteDownloads] = useState(false);
  const [forgetServers, setForgetServers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const reset = async () => {
    setBusy(true);
    setFailed(false);
    try {
      // The main process asks once more in a native dialog; a "no" there changes nothing here.
      const result = await bridge.resetLocal({ deleteDownloads: deleteDownloads && state.local.downloadDirOwned, forgetServers });
      if (!result.ok && !result.cancelled) setFailed(true);
    } finally { setBusy(false); }
  };
  return <section className="settings-section shell-card shell-danger">
    <SettingsSectionHead icon={<RotateCcw/>} title={t("desktop.sectionReset")} text={t("desktop.sectionResetText")}/>
    <p className="shell-step-text">{t("desktop.resetWhat")}</p>
    {state.local.downloadDirOwned
      ? <label className="shell-check"><input type="checkbox" checked={deleteDownloads} onChange={(event) => setDeleteDownloads(event.target.checked)}/>
        <span>{t("desktop.resetDownloads")}<FolderPath dir={state.local.downloadDir}/></span></label>
      : <p className="shell-step-text">{t("desktop.resetDownloadsProtected")} <FolderPath dir={state.local.downloadDir}/></p>}
    <label className="shell-check"><input type="checkbox" checked={forgetServers} onChange={(event) => setForgetServers(event.target.checked)}/>
      <span>{t("desktop.resetServers")}</span></label>
    {state.local.busy && <p className="shell-probe bad"><TriangleAlert/><span>{t("desktop.resetBusy")}</span></p>}
    {failed && <p className="shell-probe bad" role="alert"><TriangleAlert/><span>{t("desktop.resetFailed")}</span></p>}
    <div className="shell-actions"><button className="danger" disabled={busy} onClick={() => void reset()}><RotateCcw/> {t("desktop.resetButton")}</button></div>
  </section>;
}

function AboutSection({ bridge, state }: { bridge: ShellBridge; state: ShellState }) {
  const connection = state.screen.kind === "connected" ? state.connection : null;
  const mode = !connection ? t("desktop.notConnected")
    : [connection.restricted ? t("desktop.modeRestricted") : t("desktop.modeStandard"), connection.secure ? t("desktop.modeSecure") : ""].filter(Boolean).join(" · ");
  return <section className="settings-section shell-card">
    <SettingsSectionHead icon={<Info/>} title={t("desktop.sectionAbout")}/>
    <dl className="shell-facts">
      <dt>{t("desktop.appVersion")}</dt><dd>{state.appVersion}</dd>
      {state.app.update && <><dt>{t("desktop.updateAvailable")}</dt>
        <dd><button type="button" onClick={() => bridge.openUpdate()}><Download/> {t("desktop.updateDownload", { version: state.app.update.version })}</button></dd></>}
      <dt>{t("desktop.serverVersion")}</dt><dd>{connection ? `${connection.version} · ${connection.name || t("desktop.thisMac")}` : t("desktop.notConnected")}</dd>
      <dt>{t("desktop.mode")}</dt><dd>{mode}</dd>
      {state.local.ffmpeg && <><dt>{t("desktop.ffmpeg")}</dt><dd>{state.local.ffmpeg}</dd></>}
    </dl>
  </section>;
}
