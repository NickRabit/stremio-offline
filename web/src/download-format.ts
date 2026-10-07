import { t } from "./i18n";
import type { Download as DownloadJob } from "./types";

export const fmtEta = (seconds: number) => seconds < 60 ? `${Math.ceil(seconds)} s` : seconds < 3600 ? `${Math.ceil(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h ${Math.ceil((seconds % 3600) / 60)} min`;
export const statusLabel = (status: DownloadJob["status"]) => t(({ queued: "downloads.status.queued", waiting: "downloads.status.waiting", checking: "downloads.status.checking", downloading: "downloads.status.downloading", paused: "downloads.status.paused", completed: "downloads.status.completed", failed: "downloads.status.failed" } as const)[status]);
