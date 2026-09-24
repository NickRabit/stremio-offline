const DEVICE_DOWNLOAD_PATH = /^\/api\/device-download\/[A-Za-z0-9_-]+$/;

/** Only a ticket the active server handed to its own page is a desktop media download. */
export function isDeviceTicketDownload(downloadUrl: string, initiatorOrigin: string, serverOrigin: string): boolean {
  let target: URL;
  let server: URL;
  try {
    target = new URL(downloadUrl);
    server = new URL(serverOrigin);
  } catch {
    return false;
  }
  if (target.username || target.password) return false;
  if (target.origin !== server.origin || initiatorOrigin !== server.origin) return false;
  if (target.search || target.hash) return false;
  return DEVICE_DOWNLOAD_PATH.test(target.pathname);
}

export function downloadProgressPercent(receivedBytes: number, totalBytes: number): number | null {
  if (!Number.isFinite(totalBytes) || !Number.isFinite(receivedBytes) || totalBytes <= 0) return null;
  const percent = Math.round((receivedBytes / totalBytes) * 100);
  return Math.min(100, Math.max(0, percent));
}
