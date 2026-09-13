import { expect, test, type Page } from "@playwright/test";

const openCatalog = async (page: Page, label: RegExp) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  await page.getByRole("combobox", { name: "Procházet katalog" }).selectOption({ label: await optionLabel(page, label) });
};

// The option text carries the addon name and the item count, so it is matched
// loosely and the exact string is read back off the page.
const optionLabel = async (page: Page, pattern: RegExp) => {
  const labels = await page.getByRole("combobox", { name: "Procházet katalog" }).locator("option").allTextContents();
  const found = labels.find((text) => pattern.test(text));
  expect(found, `no catalog option matching ${pattern}`).toBeTruthy();
  return found!;
};

test.describe("catalog", () => {
  test("browses a catalog and opens a movie detail", async ({ page }) => {
    await openCatalog(page, /Filmy/);

    const poster = page.getByRole("button", { name: /Zkušební film/ });
    await expect(poster).toBeVisible();
    await poster.click();

    const detail = page.locator(".detail-panel");
    await expect(detail.getByRole("heading", { name: "Zkušební film" })).toBeVisible();
    await expect(detail).toContainText("Film, který existuje jen pro testy.");
    await expect(detail.locator(".pill")).toHaveText("Film");
  });

  test("search narrows the results", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder("Hledat ve všech doplňcích naráz…").fill("seriál");
    await page.getByRole("button", { name: "Vyhledat" }).click();

    await expect(page.getByRole("button", { name: /Zkušební seriál/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Zkušební film/ })).toHaveCount(0);
  });

  test("searches inside one selected catalogue", async ({ page }) => {
    await page.goto("/");
    const scope = page.getByRole("combobox", { name: "Kde hledat" });
    await scope.selectOption({ label: "Seriály" });
    await page.getByPlaceholder("Hledat ve všech doplňcích naráz…").fill("Zkušební");
    await page.getByRole("button", { name: "Vyhledat" }).click();

    await expect(page.getByRole("button", { name: /Zkušební seriál/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Zkušební film/ })).toHaveCount(0);
    // The locked filter offers exactly the catalogue's own type, so it can never
    // claim a type the search is not using.
    const type = page.getByRole("combobox", { name: "Typ" });
    await expect(type).toBeDisabled();
    await expect(type.locator("option")).toHaveCount(1);
    await expect(type).toHaveValue("series");
  });

  test("a search with no match says so instead of showing an empty grid", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder("Hledat ve všech doplňcích naráz…").fill("nic-takoveho-neexistuje");
    await page.getByRole("button", { name: "Vyhledat" }).click();

    await expect(page.getByText("Nic se nenašlo")).toBeVisible();
  });

  test("lists episodes of a series and loads sources for one", async ({ page }) => {
    await openCatalog(page, /Seriály/);
    await page.getByRole("button", { name: /Zkušební seriál/ }).click();

    const detail = page.locator(".detail-panel");
    await expect(detail.getByRole("heading", { name: "Epizody" })).toBeVisible();
    await detail.getByRole("combobox", { name: "Série" }).selectOption("1");
    await expect(detail.getByRole("button", { name: /První díl/ })).toBeVisible();

    await detail.getByRole("button", { name: /První díl/ }).click();
    await expect(detail.getByRole("heading", { name: "Zdroje" })).toBeVisible();
    await expect(detail.getByRole("button", { name: /E2E 1080p/ })).toBeVisible();

    await detail.getByRole("button", { name: "Změnit" }).click();
    await expect(detail.getByRole("heading", { name: "Epizody" })).toBeVisible();
    await expect(detail.getByRole("heading", { name: "Zdroje" })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: /E2E 1080p/ })).toHaveCount(0);
  });

  test("orders and filters the sources of a movie", async ({ page }) => {
    await openCatalog(page, /Filmy/);
    await page.getByRole("button", { name: /Zkušební film/ }).click();

    const detail = page.locator(".detail-panel");
    // Opening a movie fetches its sources on its own; only a series waits for a
    // pick, so there is no button to press here.
    await expect(detail.getByRole("heading", { name: "Zdroje" })).toBeVisible();

    const sources = detail.locator(".stream-list button");
    await expect(sources).toHaveCount(2);
    // Preferred language is Czech by default, so the Czech source leads.
    await expect(sources.first()).toContainText("E2E 1080p");

    await detail.getByRole("combobox", { name: "Řazení" }).selectOption("size-asc");
    await expect(sources.first()).toContainText("E2E 720p");

    await detail.getByRole("combobox", { name: "Jazyk" }).selectOption("en");
    await expect(sources).toHaveCount(1);
    await expect(sources.first()).toContainText("E2E 720p");
  });
});
