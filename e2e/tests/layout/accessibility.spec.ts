import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { goToView } from "../nav";

// WCAG A and AA rules that can be decided from the DOM alone. Axe finds no false
// positives here in exchange for finding only part of the picture; keyboard order
// and screen reader wording still need a person.
const scan = (page: Page) =>
  new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();

const describe = (violations: Awaited<ReturnType<typeof scan>>["violations"]) =>
  violations.map((violation) => `${violation.id} (${violation.impact}) on ${violation.nodes.length}: ${violation.nodes[0]?.target.join(" ")}`);

for (const view of ["Domů", "Katalog", "Knihovna", "Stahování", "Doplňky", "Nastavení"]) {
  test(`${view} has no accessibility violations`, async ({ page }) => {
    await page.goto("/");
    await goToView(page, view);
    await page.waitForTimeout(150);

    const { violations } = await scan(page);
    expect(describe(violations)).toEqual([]);
  });
}
