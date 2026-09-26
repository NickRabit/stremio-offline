const MAX_FILE_NAME = 80;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** The server names the download, so only its base name reaches a toast or a notification. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(CONTROL_CHARACTERS, "").trim();
  if (cleaned.length === 0) return "video";
  if (cleaned.length <= MAX_FILE_NAME) return cleaned;
  const tail = Math.floor((MAX_FILE_NAME - 1) / 2);
  const head = MAX_FILE_NAME - 1 - tail;
  return cleaned.slice(0, head) + "\u2026" + cleaned.slice(cleaned.length - tail);
}

/** Electron shows 0..1 as a determinate bar and 2 as the indeterminate one. */
export function downloadFraction(received: number, total: number): number {
  if (!Number.isFinite(received) || !Number.isFinite(total) || total <= 0) return 2;
  return Math.min(1, Math.max(0, received / total));
}

let toastCounter = 0;

export function nextToastId(): number {
  return ++toastCounter;
}
