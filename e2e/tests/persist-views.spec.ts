import { expect, test, type Page } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resetViews } from "./library-tools";

const viewsSaved = (page: Page) =>
  page.waitForResponse((response) => new URL(response.url()).pathname === "/api/views" && response.request().method() === "PATCH");

test("the library keeps its sort and its layout across a reload", async ({ page, request }) => {
  await resetViews(request);
  const directory = path.resolve("e2e/.tmp/downloads");
  const sample = path.join(directory, "persist-views-sample.mp4");
  await mkdir(directory, { recursive: true });
  await writeFile(sample, "fixture");
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Knihovna", exact: true }).click();
    const sorting = page.getByRole("combobox", { name: "Řazení", exact: true });
    await sorting.selectOption("size");
    await expect(sorting).toHaveValue("size");

    const saved = viewsSaved(page);
    await page.getByRole("button", { name: "Zobrazit po řádcích", exact: true }).click();
    await expect(page.locator(".browse-rows")).toBeVisible();
    await saved;

    await page.reload();
    await page.getByRole("button", { name: "Knihovna", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Řazení", exact: true })).toHaveValue("size");
    await expect(page.locator(".browse-rows")).toBeVisible();
  } finally {
    await rm(sample, { force: true });
    await resetViews(request);
  }
});

test("the queue keeps its sort, filter and page size across a section switch and a reload", async ({ page, request }) => {
  await resetViews(request);
  await page.goto("/");
  await page.getByRole("button", { name: "Stahování", exact: true }).click();
  const filters = page.locator(".queue-filters");
  const tools = page.locator(".queue-tools");
  await filters.locator("summary").click();
  const saved = viewsSaved(page);
  await tools.getByRole("combobox", { name: "Řadit podle", exact: true }).selectOption("titleSort");
  await tools.getByRole("combobox", { name: "Stav", exact: true }).selectOption("completed");
  await tools.getByRole("combobox", { name: "Položek na stránce", exact: true }).selectOption("50");
  await saved;

  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  await page.getByRole("button", { name: "Stahování", exact: true }).click();
  await filters.locator("summary").click();
  await expect(tools.getByRole("combobox", { name: "Řadit podle", exact: true })).toHaveValue("titleSort");
  await expect(tools.getByRole("combobox", { name: "Stav", exact: true })).toHaveValue("completed");
  await expect(tools.getByRole("combobox", { name: "Položek na stránce", exact: true })).toHaveValue("50");
  await expect(page.getByLabel("Hledat název nebo cestu")).toHaveValue("");

  await page.reload();
  await page.getByRole("button", { name: "Stahování", exact: true }).click();
  await filters.locator("summary").click();
  await expect(tools.getByRole("combobox", { name: "Řadit podle", exact: true })).toHaveValue("titleSort");
  await expect(tools.getByRole("combobox", { name: "Stav", exact: true })).toHaveValue("completed");
  await expect(tools.getByRole("combobox", { name: "Položek na stránce", exact: true })).toHaveValue("50");
  await expect(page.getByLabel("Hledat název nebo cestu")).toHaveValue("");
  await expect(page.getByLabel("Od", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Do", { exact: true })).toHaveValue("");
  await resetViews(request);
});

test("the catalogue sort is still only for the visit", async ({ page }) => {
  await page.goto("/");
  const sorting = page.getByRole("combobox", { name: "Řazení katalogu", exact: true });
  await sorting.selectOption("year");
  await expect(sorting).toHaveValue("year");

  await page.reload();
  await expect(page.getByRole("combobox", { name: "Řazení katalogu", exact: true })).toHaveValue("default");
});
