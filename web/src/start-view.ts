import type { StartView } from "./types";

/**
 * The view the app opens on once the first settings answer arrives, or null to leave the
 * person where they are. The catalogue is the default and already on screen, a restricted
 * account never opens Home, and one who has navigated in this session keeps their choice.
 */
export function resolveStartView(
  setting: StartView,
  { restricted, navigated }: { restricted: boolean; navigated: boolean },
): StartView | null {
  if (navigated) return null;
  const wanted = restricted && setting === "home" ? "catalog" : setting;
  return wanted === "catalog" ? null : wanted;
}
