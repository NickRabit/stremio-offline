import { useEffect } from "react";
import { setLocale, useI18n } from "../i18n";
import type { ShellBridge } from "./bridge";
import { MainWindow } from "./MainWindow";
import { SettingsWindow } from "./SettingsWindow";
import { ToastView } from "./ToastView";
import { useShellState } from "./use-shell";

export function ShellApp({ bridge }: { bridge: ShellBridge }) {
  useI18n();
  const state = useShellState(bridge);
  // The app's language, not the browser's guess: the menus and dialogs of the main process speak it too.
  useEffect(() => { if (state) setLocale(state.locale); }, [state?.locale]);
  if (!state) return null;
  if (bridge.view === "settings") return <SettingsWindow bridge={bridge} state={state}/>;
  if (bridge.view === "toast") return <ToastView bridge={bridge} toast={state.toast}/>;
  return <MainWindow bridge={bridge} state={state}/>;
}
