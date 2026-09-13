import { expect, test } from "@playwright/test";

test("catalogue search controls fit every supported viewport", async ({ page }) => {
  await page.goto("/");
  const scope = page.getByRole("combobox", { name: "Kde hledat" });
  await scope.selectOption((await scope.locator("option").filter({ hasText: "Seriály" }).first().getAttribute("value"))!);
  await page.getByPlaceholder("Hledat ve všech doplňcích naráz…").fill("Zkušební");
  await page.getByRole("button", { name: "Vyhledat" }).click();

  await expect(page.getByRole("button", { name: /Zkušební seriál/ })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Typ" })).toBeDisabled();
  const viewport = page.viewportSize()!;
  for (const control of [scope, page.getByRole("button", { name: "Vyhledat" }), page.getByRole("combobox", { name: "Typ" })]) {
    const box = await control.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  }
  const width = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  expect(width.page).toBeLessThanOrEqual(width.viewport + 1);
});

test("global search setting remains readable and touchable", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Doplňky", exact: true }).click();
  const card = page.locator(".addon-card").filter({ hasText: "E2E doplněk" });
  await card.getByRole("button", { name: "Manifest a export" }).click();

  const setting = card.locator(".global-search-setting");
  const toggle = setting.getByRole("checkbox", { name: "Zahrnout do hledání ve všech doplňcích" });
  await expect(setting).toBeVisible();
  await expect(toggle).toBeChecked();
  const viewport = page.viewportSize()!;
  const box = (await setting.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  if (testInfo.project.use.hasTouch) {
    const switchBox = (await toggle.locator("xpath=..").locator("span").boundingBox())!;
    expect(switchBox.width).toBeGreaterThanOrEqual(24);
    expect(switchBox.height).toBeGreaterThanOrEqual(24);
  }
});
