import { expect, type Locator, type Page } from "@playwright/test";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A More menu entry by its label. A badge (the add-on count, the Following indicator) is part
 *  of the accessible name, so the match allows a trailing number. */
export const menuItem = (page: Page, name: string): Locator =>
  page.getByRole("menuitem", { name: new RegExp(`^${escape(name)}(\\s+\\d+)?$`) });

/** Opens a destination the way a person does at any width: a visible button when the
 *  navigation shows it, otherwise through the More menu the compact navigation folds it into. */
export async function goToView(page: Page, name: string, more = "Více") {
  await expect(page.locator("aside.sidebar nav")).toBeVisible();
  const button = page.locator("aside.sidebar nav").getByRole("button", { name, exact: true });
  if (await button.isVisible()) { await button.click(); return; }
  await page.locator("aside.sidebar nav").getByRole("button", { name: more, exact: true }).click();
  await menuItem(page, name).click();
}
