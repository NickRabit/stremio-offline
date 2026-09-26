import { CircleCheck, Download, Info, RefreshCw, TriangleAlert, X } from "lucide-react";
import { t } from "../i18n";
import type { ShellBridge, Toast } from "./bridge";

const content = (toast: Toast) => {
  switch (toast.kind) {
    case "fallback": return { icon: <TriangleAlert/>, tone: "warn", text: t("desktop.toastFallback", { name: toast.server }), action: t("desktop.toastRetry") };
    case "server-back": return { icon: <RefreshCw/>, tone: "info", text: t("desktop.toastServerBack", { name: toast.server }), action: t("desktop.toastSwitch") };
    case "download-done": return { icon: <CircleCheck/>, tone: "ok", text: t("desktop.toastDownloadDone", { file: toast.file }), action: null };
    case "download-failed": return { icon: <TriangleAlert/>, tone: "warn", text: t("desktop.toastDownloadFailed", { file: toast.file }), action: null };
    case "local-restarted": return { icon: <Info/>, tone: "info", text: t("desktop.toastLocalRestarted"), action: null };
    case "update": return { icon: <Download/>, tone: "info", text: t("desktop.toastUpdate", { version: toast.version }), action: t("desktop.toastDownload") };
  }
};

/** The overlay the shell lays over the server page; the view is only on screen while a toast is. */
export function ToastView({ bridge, toast }: { bridge: ShellBridge; toast: Toast | null }) {
  if (!toast) return null;
  const { icon, tone, text, action } = content(toast);
  return <div className={`shell-toast ${tone}`} role="status" aria-live="polite">
    <i>{icon}</i>
    <p>{text}</p>
    {action && <button className="primary" onClick={() => bridge.toastAction(toast.id)}>{action}</button>}
    <button className="shell-icon" title={t("desktop.dismiss")} aria-label={t("desktop.dismiss")} onClick={() => bridge.dismissToast(toast.id)}><X/></button>
  </div>;
}
