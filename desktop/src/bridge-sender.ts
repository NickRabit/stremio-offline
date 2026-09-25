import { LOCAL_PARTITION } from "./local-backend.js";

export interface BridgeSender {
  /** The sender is the server view currently on screen. */
  currentView: boolean;
  /** The partition of that view. */
  partition: string | null;
  /** The frame that sent it: absent once destroyed, `top` false for any subframe. */
  frame: { url: string; top: boolean } | null;
  /** The origin of the backend this app runs, or null when none is running. */
  localOrigin: string | null;
}

const originOf = (url: string) => {
  try { return new URL(url).origin; } catch { return null; }
};

/** The bridge answers only the top frame of the local backend's own page while it is on screen. */
export function localPageSent(sender: BridgeSender): boolean {
  return sender.currentView
    && sender.partition === LOCAL_PARTITION
    && sender.frame !== null && sender.frame.top
    && sender.localOrigin !== null && originOf(sender.frame.url) === sender.localOrigin;
}
