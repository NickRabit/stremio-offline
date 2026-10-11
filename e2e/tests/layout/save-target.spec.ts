import { expect, test } from "@playwright/test";

/** Walking into the title's own folder and keeping "a folder for each title" used to promise
 *  the title folder a second time inside it -- and the server made it. */
test("the save preview does not repeat the title folder that was picked", async ({ page }) => {
  const libraries = ["Downloads", "Filmy"].map((name, index) => ({
    id: `lib_0000000${index}`, name, type: "mixed", enabled: true, order: index, addedAt: "2026-01-01T00:00:00.000Z",
    writeArtwork: false, autoScanMetadata: false, unreachable: false, readOnly: false, writable: true,
    defaultMovie: index === 0, defaultSeries: index === 0, titles: 1, files: 1, bytes: 1e9,
  }));
  await page.route("**/api/libraries", (route) => route.fulfill({ json: libraries }));
  await page.route("**/api/library/folders?*", (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") ?? "";
    const folders = path.includes("/") ? [] : [{ name: "Zkušební film", path: `${path}/Zkušební film` }];
    return route.fulfill({ json: { path, folders } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const options = await page.getByRole("combobox", { name: "Procházet katalog" }).locator("option").allTextContents();
  await page.getByRole("combobox", { name: "Procházet katalog" }).selectOption({ label: options.find((text) => /Filmy/.test(text))! });
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  const detail = page.locator(".detail-panel");
  await detail.locator(".stream-list button").first().click();
  await detail.getByRole("button", { name: "Uložit jinam…" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByText("Jinam", { exact: true }).click();
  const preview = dialog.locator(".save-target-preview");
  await expect(preview).toContainText("Downloads › Zkušební film");
  await dialog.locator(".move-list button", { hasText: "Zkušební film" }).click();
  await expect(dialog.locator(".move-crumbs")).toContainText("Zkušební film");
  await expect(preview).toContainText("Downloads › Zkušební film");
  await expect(preview).not.toContainText("Zkušební film › Zkušební film");
});
