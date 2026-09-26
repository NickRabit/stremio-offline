import { useEffect, useState } from "react";
import { ArrowRight, Laptop, Server, Settings2, TriangleAlert } from "lucide-react";
import { LOCALE_NAMES, t, type Key } from "../i18n";
import type { FailureReason, MainScreen, ShellBridge, ShellState } from "./bridge";
import { Brand } from "./Brand";
import { ServerForm } from "./ServerForm";

const ERROR_TEXT: Record<FailureReason, [Key, Key]> = {
  unreachable: ["desktop.errorUnreachable", "desktop.errorUnreachableText"],
  "insecure-transport": ["desktop.errorInsecure", "desktop.errorInsecureText"],
  "not-status": ["desktop.errorNotStatus", "desktop.errorNotStatusText"],
  invalid: ["desktop.errorInvalid", "desktop.errorInvalidText"],
  "local-startup": ["desktop.errorLocal", "desktop.errorLocalText"],
  "port-busy": ["desktop.errorPortBusy", "desktop.errorPortBusyText"],
};

export function MainWindow({ bridge, state }: { bridge: ShellBridge; state: ShellState }) {
  const { screen } = state;
  if (screen.kind === "connected") return null;
  return <main className="shell-screen">
    {screen.kind === "welcome" && <>
      <LanguageSwitch bridge={bridge} state={state}/>
      <Welcome bridge={bridge}/>
    </>}
    {screen.kind === "connecting" && <Connecting bridge={bridge} screen={screen}/>}
    {screen.kind === "error" && <Failure bridge={bridge} screen={screen}/>}
  </main>;
}

/** On the first screen, before anything else is chosen: the language the rest is read in. */
function LanguageSwitch({ bridge, state }: { bridge: ShellBridge; state: ShellState }) {
  return <div className="shell-language" role="radiogroup" aria-label={t("desktop.language")}>
    {(["cs", "en"] as const).map((locale) => <button key={locale} role="radio" aria-checked={state.locale === locale}
      className={state.locale === locale ? "active" : ""} onClick={() => void bridge.setLocale(locale)}>{LOCALE_NAMES[locale]}</button>)}
  </div>;
}

function Welcome({ bridge }: { bridge: ShellBridge }) {
  const [adding, setAdding] = useState(false);
  return <section className="shell-welcome">
    <Brand/>
    <h2>{t("desktop.welcomeTitle")}</h2>
    {adding
      ? <div className="shell-card shell-welcome-form">
        <h3><Server/> {t("desktop.networkServer")}</h3>
        <ServerForm bridge={bridge} submitLabel={t("desktop.connect")} onCancel={() => setAdding(false)}
          onSaved={(profile) => void bridge.connect({ kind: "profile", id: profile.id })}/>
      </div>
      : <div className="shell-choices">
        <button className="shell-choice" onClick={() => void bridge.connect({ kind: "local" })}>
          <i><Laptop/></i>
          <span><strong>{t("desktop.thisMac")}</strong><small>{t("desktop.thisMacText")}</small></span>
          <ArrowRight className="shell-choice-go"/>
        </button>
        <button className="shell-choice" onClick={() => setAdding(true)}>
          <i><Server/></i>
          <span><strong>{t("desktop.networkServer")}</strong><small>{t("desktop.networkServerText")}</small></span>
          <ArrowRight className="shell-choice-go"/>
        </button>
      </div>}
    <p className="shell-muted">{t("desktop.welcomeText")}</p>
  </section>;
}

function Connecting({ bridge, screen }: { bridge: ShellBridge; screen: Extract<MainScreen, { kind: "connecting" }> }) {
  // A settings way out only once the wait stops being a moment.
  const [slow, setSlow] = useState(false);
  useEffect(() => { setSlow(false); const timer = setTimeout(() => setSlow(true), 6000); return () => clearTimeout(timer); }, [screen]);
  const local = screen.target.kind === "local";
  return <section className="shell-connecting" aria-live="polite">
    <Brand pulse/>
    <p className="shell-connecting-text">{local ? t("desktop.startingLocal") : t("desktop.connectingTo", { name: screen.name })}</p>
    {screen.origin && !local && <p className="shell-origin">{screen.origin}</p>}
    <button className={`shell-ghost${slow ? "" : " shell-hidden"}`} tabIndex={slow ? 0 : -1} onClick={() => bridge.openSettings()}>
      <Settings2/> {t("desktop.openSettings")}
    </button>
  </section>;
}

function Failure({ bridge, screen }: { bridge: ShellBridge; screen: Extract<MainScreen, { kind: "error" }> }) {
  const [title, text] = ERROR_TEXT[screen.reason];
  const vars = { name: screen.name || t("desktop.thisMac"), port: screen.port ?? "" };
  return <section className="shell-card shell-failure" role="alert">
    <i className="shell-failure-icon"><TriangleAlert/></i>
    <h2>{t(title, vars)}</h2>
    <p>{t(text, vars)}</p>
    {screen.origin && <p className="shell-origin">{screen.origin}</p>}
    <div className="shell-actions">
      <button onClick={() => bridge.openSettings()}><Settings2/> {t("desktop.openSettings")}</button>
      {screen.target.kind === "profile" && <button onClick={() => void bridge.connect({ kind: "local" })}><Laptop/> {t("desktop.useThisMac")}</button>}
      <button className="primary" autoFocus onClick={() => void bridge.connect(screen.target)}>{t("desktop.retry")}</button>
    </div>
  </section>;
}
