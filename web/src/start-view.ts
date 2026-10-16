import type { StartView } from "./types";

/**
 * The view the app opens on once the first settings answer arrives, or null to leave the
 * person where they are. Home is the default, a restricted account never opens Home, an
 * install with no catalogue stays on the catalogue's onboarding, and one who has navigated in
 * this session keeps their choice.
 */
export function resolveStartView(
  setting: StartView,
  { restricted, navigated, hasCatalogs = true }: { restricted: boolean; navigated: boolean; hasCatalogs?: boolean },
): StartView | null {
  if (navigated || !hasCatalogs) return null;
  const wanted = restricted && setting === "home" ? "catalog" : setting;
  return wanted === "catalog" ? null : wanted;
}
