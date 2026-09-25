/** What the desktop app offers the page of the backend it runs itself. A browser, or the same page
 *  opened from a server, has none of it, and every caller has to work without. */
export interface DesktopBridge {
  version: number;
  /** An absolute folder the person chose in the system dialog, or null when they cancelled. */
  pickFolder(): Promise<string | null>;
}

export function desktopBridge(host: unknown = globalThis): DesktopBridge | null {
  const bridge = (host as { stremioDesktop?: unknown } | undefined)?.stremioDesktop as Partial<DesktopBridge> | undefined;
  return bridge && bridge.version === 1 && typeof bridge.pickFolder === "function" ? bridge as DesktopBridge : null;
}
