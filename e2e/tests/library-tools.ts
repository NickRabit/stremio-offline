import type { APIRequestContext, Page } from "@playwright/test";

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
