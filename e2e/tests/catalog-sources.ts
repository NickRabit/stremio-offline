import { expect, type Page } from "@playwright/test";

/**
 * The catalogue detail answers the viewer's own library copy of a title above the addons and
 * picks it by default (`docs/local-sources-spec.md`), and the library journeys leave matched
 * fixtures behind for the layout baselines. A journey about an addon's stream, or about the
 * addon's own file, picks that row itself: the viewer's own pick is never moved.
 */
export async function pickAddonStream(page: Page): Promise<void> {
  const rows = page.locator(".detail-panel .stream-list button");
  const addon = rows.filter({ hasNot: page.locator("i.local") }).first();
  await addon.click();
  await expect(addon).toHaveClass(/selected/);
}
