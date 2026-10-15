import { useState } from "react";
import { ChevronDown, PackagePlus } from "lucide-react";
import { t, useI18n } from "./i18n";
import type { NativeAddonSourcesState } from "./use-native-addon-sources";

/**
 * The supplementary sources of a native title, drawn under its own versions in the shared picker.
 * Collapsed it is one action; pressing it discovers the providers once for the title on screen,
 * and each name it answers reads its own rows only when the viewer asks for that one.
 */
export function NativeAddonSources({ state }: { state: NativeAddonSourcesState }) {
  useI18n();
  const [open, setOpen] = useState(false);
  const toggle = () => { if (!open) state.discover(); setOpen(!open); };
  const providers = state.providers ?? [];

  return <div className={`addon-sources${open ? " open" : ""}`}>
    <button type="button" className="addon-sources-toggle" aria-expanded={open} onClick={toggle}>
      <PackagePlus aria-hidden="true"/> {t("sources.loadAddons")} <ChevronDown className="chevron" aria-hidden="true"/>
    </button>
    {open && <div className="addon-sources-body">
      {state.discovering && <p className="identify-hint" role="status">{t("common.loading")}</p>}
      {!state.discovering && state.discoverError && <p className="login-error" role="alert">
        {state.discoverError} <button type="button" onClick={state.discover}>{t("home.retry")}</button>
      </p>}
      {!state.discovering && !state.discoverError && state.providers !== null && !providers.length
        && <p className="identify-hint">{t("sources.noAddonProviders")}</p>}
      {providers.map((provider) => <div className="addon-provider" key={provider.key}>
        <span className="addon-provider-name">{provider.name}</span>
        {provider.status === "idle" && <button type="button" onClick={() => state.load(provider.key)}>{t("sources.loadProvider")}</button>}
        {provider.status === "loading" && <span role="status">{t("common.loading")}</span>}
        {provider.status === "error" && <span role="alert">{provider.error} <button type="button" onClick={() => state.load(provider.key)}>{t("home.retry")}</button></span>}
        {provider.status === "loaded" && !provider.streams.length && <span className="identify-hint">{t("sources.none")}</span>}
      </div>)}
    </div>}
  </div>;
}
