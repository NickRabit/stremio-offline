import type { Page } from "@playwright/test";

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
