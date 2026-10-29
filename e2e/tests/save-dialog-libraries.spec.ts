import { expect, test } from "@playwright/test";
import { pickAddonStream } from "./catalog-sources";

// The library list is read once at sign-in, and on a slow or resumed phone connection that read
// can fail quietly. The save dialog then offered no library to save into ("Elsewhere" disabled)
// until the page was reloaded. Opening the dialog reads the list again.
test("the save dialog offers the libraries even when the first library list failed", async ({ page }) => {
  let failed = false;
  await page.route("**/api/libraries", async (route) => {
    if (failed || route.request().method() !== "GET") return route.fallback();
    failed = true;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "busy" }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  await catalog.selectOption((await catalog.locator("option").filter({ hasText: "Filmy" }).first().getAttribute("value"))!);
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  await pickAddonStream(page);
  expect(failed, "the first library list was refused").toBe(true);

  await page.locator(".detail-panel").getByRole("button", { name: "Uložit jinam…" }).click();
  const dialog = page.getByRole("dialog");
  const elsewhere = dialog.getByRole("radio", { name: /^Jinam/ });
  await expect(elsewhere).toBeEnabled();
  await expect(dialog).not.toContainText("Pro tento druh titulu nemáte knihovnu");
});
