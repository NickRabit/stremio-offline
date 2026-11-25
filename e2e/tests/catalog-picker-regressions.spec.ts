import { expect, test as base } from "@playwright/test";
import { catalogTrigger, openCatalogPicker, scopeTrigger } from "./catalog-picker";

const test = base.extend({
  page: async ({ page }, use) => {
    const views = await (await page.request.get("/api/views")).json();
    await page.request.patch("/api/views", { data: { catalog: { last: null, recent: [] } } });
    try {
      await use(page);
    } finally {
      const request = page.context().request;
      await page.close();
      await request.patch("/api/views", { data: { catalog: views.catalog } });
    }
  },
});

test("the matched genre is both highlighted and committed by Enter", async ({ page }) => {
  await page.route("**/api/catalogs", async (route) => {
    const response = await route.fetch();
    const catalogs = await response.json();
    const options = [...Array.from({ length: 12 }, (_, index) => String(index)), "Drama"];
    await route.fulfill({ json: catalogs.map((catalog: object) => ({
      ...catalog, extra: [{ name: "genre", options }],
    })) });
  });
  await page.goto("/");
  await page.locator(".genre-trigger").click();
  const dialog = page.getByRole("dialog");
  const field = dialog.getByRole("combobox");
  await field.fill("Drama");
  const match = dialog.getByRole("option", { name: "Drama", exact: true });
  await expect(match).toHaveCSS("outline-style", "solid");
  await field.press("Enter");
  await expect(page.locator(".genre-trigger")).toContainText("Drama");
});

test("catalog scope can switch types directly and find a whole addon by name", async ({ page }) => {
  await page.goto("/");
  const scope = scopeTrigger(page);
  const dialog = page.getByRole("dialog");
  await scope.click();
  const field = dialog.getByRole("combobox");
  await field.fill("Filmy");
  await dialog.getByRole("option", { name: /Filmy/ }).click();
  await scope.click();
  await field.fill("Seriály");
  await dialog.getByRole("option", { name: /Seriály/ }).click();
  await expect(scope).toContainText("Seriály");
  await scope.click();
  await field.fill("E2E");
  await dialog.getByRole("option", { name: "Všechny katalogy doplňku" }).click();
  await expect(scope).toContainText("E2E doplněk");
});

test("a restored search-only catalog still directs the next search to that catalog", async ({ page }) => {
  await page.route("**/api/catalogs", async (route) => {
    const response = await route.fetch();
    const catalogs = await response.json();
    await route.fulfill({ json: catalogs.map((catalog: { type: string }) => catalog.type === "series"
      ? { ...catalog, extra: [{ name: "search", isRequired: true }] } : catalog) });
  });
  await page.goto("/");
  const dialog = await openCatalogPicker(page);
  await dialog.getByRole("combobox").fill("Seriály");
  const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith("/views"));
  await dialog.getByRole("option", { name: /Seriály/ }).click();
  await saved;
  await page.reload();
  await expect(catalogTrigger(page)).toContainText("Seriály");
  await expect(scopeTrigger(page)).toContainText("Seriály");
});
