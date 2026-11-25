import { expect, test } from "@playwright/test";
import { openCatalogPicker } from "../catalog-picker";
import { goToView } from "../nav";

test("the catalog picker's columns stay inside the dialog and scroll on their own", async ({ page }) => {
  await page.goto("/");
  await goToView(page, "Katalog");
  const dialog = await openCatalogPicker(page);
  const sizes = await dialog.evaluate((root) => {
    const box = (selector: string) => {
      const node = root.querySelector<HTMLElement>(selector);
      return node ? { client: node.clientHeight, overflow: getComputedStyle(node).overflowY } : null;
    };
    return { body: box(".picker-body"), main: box(".picker-body-rail > .picker-main"), rail: box(".picker-rail") };
  });
  expect(sizes.body).not.toBeNull();
  // Phones and narrow windows have no rail; there the body itself scrolls.
  test.skip(!sizes.main, "no rail at this viewport");
  expect(sizes.main!.client, "list column taller than the dialog body").toBeLessThanOrEqual(sizes.body!.client + 1);
  expect(sizes.rail!.client, "rail taller than the dialog body").toBeLessThanOrEqual(sizes.body!.client + 1);
  expect(sizes.main!.overflow).toBe("auto");
  await expect(dialog.getByRole("combobox")).toBeInViewport();
});
