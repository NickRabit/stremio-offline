import { t } from "./i18n";
import { bytes } from "./settings-ui";
import type { Download as DownloadJob } from "./types";

export { bytes };
/** Rounded up once, to whole minutes past the first minute, and only then split into hours, so
 *  no unit ever reads sixty; a transfer that outran its announced size has nothing left. */
export const fmtEta = (seconds: number) => {
  const whole = Math.max(0, Math.ceil(seconds));
  if (whole < 60) return `${whole} s`;
  const minutes = Math.ceil(whole / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};
export const speed = (value: number) => value ? `${bytes(value)}/s` : "—";
export const statusLabel = (status: DownloadJob["status"]) => t(({ queued: "downloads.status.queued", waiting: "downloads.status.waiting", checking: "downloads.status.checking", downloading: "downloads.status.downloading", paused: "downloads.status.paused", completed: "downloads.status.completed", failed: "downloads.status.failed" } as const)[status]);
