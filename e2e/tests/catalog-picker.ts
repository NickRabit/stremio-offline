import { expect, type Locator, type Page } from "@playwright/test";

const catalogName = /^(Procházet katalog|Browse catalog)$/;
const scopeName = /^(Kde hledat|Where to search)$/;
const typeGroupName = /^(Typ|Type)$/;
const movieName = /^(Filmy|Movies)$/;
const seriesName = /^(Seriály|Series)$/;
const catalogDialogName = /^(Katalog|Catalog)$/;
const scopeDialogName = /^(Hledat v|Search in)$/;

/** The catalog-page button that opens the catalog picker. */
export function catalogTrigger(page: Page): Locator {
  return page.getByRole("button", { name: catalogName });
}

/** The button that opens the scope picker on the catalog page or in Search Everywhere. */
export function scopeTrigger(page: Page): Locator {
  return page.getByRole("button", { name: scopeName });
}

const queryText = (name: RegExp | string): string =>
  typeof name === "string" ? name : name.source.replace(/\\[sSdDwWbB]/g, " ").replace(/[\\^$.*+?()[\]{}|]/g, "");

const optionName = (name: RegExp | string): RegExp =>
  name instanceof RegExp ? name : new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

const catalogDialog = (page: Page): Locator => page.getByRole("dialog", { name: catalogDialogName });

async function switchPickerType(dialog: Locator, type: "movie" | "series"): Promise<void> {
  const group = dialog.getByRole("group", { name: typeGroupName });
  if (await group.count() === 0) return;
  const button = group.getByRole("button", { name: type === "movie" ? movieName : seriesName });
  if (await button.getAttribute("aria-pressed") === "true" || await button.isDisabled()) return;
  await button.click();
}

async function pickRow(dialog: Locator, name: RegExp | string): Promise<void> {
  await dialog.getByRole("combobox").fill(queryText(name));
  await dialog.getByRole("option", { name: optionName(name) }).first().click();
  await expect(dialog).toBeHidden();
}

/** Opens the catalog picker from the catalog page toolbar. */
export async function openCatalogPicker(page: Page): Promise<Locator> {
  await catalogTrigger(page).click();
  const dialog = catalogDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Chooses a catalog whose row text matches `name`, switching the type first when `type` is given. */
export async function chooseCatalog(page: Page, name: RegExp | string, type?: "movie" | "series"): Promise<void> {
  const dialog = await openCatalogPicker(page);
  if (type) await switchPickerType(dialog, type);
  await pickRow(catalogDialog(page), name);
}

/** The row labels of the open catalog picker for the current type (for specs that list options). */
export async function catalogRowLabels(page: Page): Promise<string[]> {
  const dialog = catalogDialog(page);
  await expect(dialog).toBeVisible();
  const heads = dialog.locator("button[aria-expanded]");
  const count = await heads.count();
  for (let index = 0; index < count; index += 1) {
    const head = heads.nth(index);
    if (await head.getAttribute("aria-expanded") !== "true") await head.click();
  }
  return dialog.getByRole("option").allTextContents();
}

/** Chooses a search scope row matching `name` in the scope picker (catalog page or Search Everywhere). */
export async function chooseScope(page: Page, name: RegExp | string, type?: "movie" | "series"): Promise<void> {
  await scopeTrigger(page).click();
  const dialog = page.getByRole("dialog", { name: scopeDialogName });
  await expect(dialog).toBeVisible();
  if (type) await switchPickerType(dialog, type);
  await pickRow(dialog, name);
}
