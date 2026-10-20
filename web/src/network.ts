import type { NetworkHint } from "./types";

interface Connection { saveData?: boolean; effectiveType?: string; downlink?: number; type?: string }

/** What the Network Information API says about the link, for the server to pick a quality.
 *  Only Chromium has the API; elsewhere there is nothing to send. */
export function networkHint(connection: Connection | undefined = (navigator as Navigator & { connection?: Connection }).connection): NetworkHint | undefined {
  if (!connection) return undefined;
  const hint: NetworkHint = {};
  if (typeof connection.saveData === "boolean") hint.saveData = connection.saveData;
  if (typeof connection.effectiveType === "string") hint.effectiveType = connection.effectiveType;
  // Chromium reports 0 before it has measured anything.
  if (typeof connection.downlink === "number" && connection.downlink > 0) hint.downlink = connection.downlink;
  if (typeof connection.type === "string") hint.type = connection.type;
  return Object.keys(hint).length ? hint : undefined;
}
