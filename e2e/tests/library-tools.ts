import { expect, type APIRequestContext, type Page } from "@playwright/test";

const libraryViewDefaults = { sort: "name", order: "asc", favoritesOnly: false, view: "grid" };
const downloadsViewDefaults = { sort: "order", direction: "asc", status: "", dateField: "createdAt", pageSize: 20 };

/** Layout projects share one account. A queue left at 50 rows or a library left in
 *  list mode would be the next project's setup, so each suite that drives those
 *  controls puts the stored views back first. */
export async function resetViews(request: APIRequestContext) {
  const libraries = await (await request.get("/api/libraries")).json() as Array<{ id: string }>;
  await request.patch("/api/views", { data: {
    libraries: Object.fromEntries(libraries.map((library) => [library.id, libraryViewDefaults])),
    extras: {
      ":favorites": libraryViewDefaults,
      ":resume": { sort: "added", order: "desc", favoritesOnly: false, view: "grid" },
    },
    downloads: downloadsViewDefaults,
  } });
}

/**
 * Scanning, creating a folder and switching library live behind the tools toggle at every
 * width now, so a test that wants one opens the menu first. Opening it twice would close
 * it again, hence the check.
 */
export async function openLibraryTools(page: Page) {
  const toggle = page.getByRole("button", { name: "Nástroje knihovny", exact: true });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
}

/** The menu opened, and the action inside it ready to click. */
export async function libraryTool(page: Page, name: string) {
  await openLibraryTools(page);
  return page.getByRole("button", { name, exact: true });
}

/**
 * Scans the library the way a person does, and only returns once the scan is over.
 *
 * The action is disabled while the server still has a scan of its own, and a click on a disabled
 * button does nothing, which left the test waiting for a summary that could not come. What is
 * running is stopped first -- a scan that paused behind a player nobody came back for keeps the
 * action disabled for as long as that session counts as watching -- so the wait is for the scan
 * this call started rather than for somebody else's.
 */
export async function scanLibrary(page: Page) {
  const stop = page.getByRole("button", { name: "Zastavit", exact: true });
  if (await stop.isVisible().catch(() => false)) {
    await stop.click();
    await expect(stop).toHaveCount(0);
  }
  const scan = await libraryTool(page, "Prohledat knihovnu");
  await expect(scan).toBeEnabled({ timeout: 60_000 });
  await scan.click();
  await expect(page.getByText(/spárováno,/)).toBeVisible({ timeout: 60_000 });
}
