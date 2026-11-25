import { expect, test } from "@playwright/test";
import { chooseScope, scopeTrigger } from "../catalog-picker";
import { goToView } from "../nav";

test("catalogue search controls fit every supported viewport", async ({ page }) => {
  await page.goto("/");
  await chooseScope(page, /Seriály/, "series");
  const field = page.getByPlaceholder("Hledat v: E2E doplněk · Seriály…");
  await field.fill("Zkušební");
  await field.press("Enter");

  await expect(page.getByRole("button", { name: /Zkušební seriál/ })).toBeVisible();
  const results = page.getByRole("group", { name: "Ve výsledcích" });
  await expect(results.getByRole("button", { name: "Filmy" })).toBeDisabled();
  const viewport = page.viewportSize()!;
  const scope = scopeTrigger(page);
  // A phone submits from its keyboard and keeps the row for results; wider screens keep the button.
  const submit = page.getByRole("button", { name: "Vyhledat" });
  if (viewport.width <= 700) await expect(submit).toBeHidden();
  const cancel = page.getByRole("button", { name: "Zrušit" });
  for (const control of [scope, ...(viewport.width <= 700 ? [] : [submit]), cancel, results]) {
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
  await goToView(page, "Doplňky");
  const card = page.locator(".addon-card").filter({ hasText: "E2E doplněk" });
  await card.getByRole("button", { name: "Upravit doplněk" }).click();

  const dialog = page.getByRole("dialog", { name: "Upravit doplněk" });
  const setting = dialog.locator(".library-check", { hasText: "Zahrnout do společného hledání" });
  const toggle = setting.getByRole("checkbox", { name: "Zahrnout do společného hledání" });
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
