import { expect, test, type Page } from "@playwright/test";

/** The catalogue opened the way a person opens it: the view, then the listing to browse. */
const openCatalogue = async (page: Page, label: RegExp) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const select = page.getByRole("combobox", { name: "Procházet katalog" });
  const labels = await select.locator("option").allTextContents();
  await select.selectOption({ label: labels.find((text) => label.test(text))! });
};

/** The one way into the full detail, whichever of its two homes is on screen. */
const info = (page: Page) => page.locator(".detail-panel .detail-info:visible");

test("a show played from the full detail carries its own episode and plays the next one", async ({ page }) => {
  await openCatalogue(page, /Seriály/);
  await page.getByRole("button", { name: /Zkušební seriál/ }).click();
  await page.locator(".detail-panel").getByRole("button", { name: /První díl/ }).click();
  await expect(page.locator(".detail-panel .stream-list button").first()).toBeVisible();
  // The addon's own row: a library copy plays as a file, with the library's next file rather than
  // the show's next episode.
  await page.locator(".detail-panel .stream-list").getByRole("button", { name: /E2E 1080p/ }).click();
  await info(page).click();
  const main = page.locator("main.view-title-detail");
  await expect(main).toBeVisible();

  await main.getByRole("button", { name: "Přehrát", exact: true }).click();
  const player = page.locator(".player-overlay");
  await expect(player).toBeVisible();
  // The episode on screen travels with the title, and the next one comes from the detail's own
  // show, never from whatever the browse panel happens to have selected behind it.
  await expect(player.locator(".player-head strong")).toHaveText("Zkušební seriál · 01×01");
  await expect(player.locator(".next-episode")).toHaveAttribute("title", /Druhý díl/);

  await player.locator(".next-episode").click();
  await expect(player.locator(".player-head strong")).toHaveText("Zkušební seriál · 01×02");
});
