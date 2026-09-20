import { expect, test, type Page } from "@playwright/test";

// The catalogue header used to size itself by the window while the panels below it sized
// themselves by the space left over, so the two only lined up at one width by accident. These
// check the relationships rather than the pixels, so they hold in every viewport.

const EDGE = 2;

const openCatalog = async (page: Page) => {
  await page.goto("/");
  await expect(page.getByRole("combobox", { name: "Procházet katalog" })).toBeVisible();
  await page.waitForTimeout(150);
};

const edges = (page: Page) => page.evaluate(() => {
  const right = (selector: string) => {
    const element = document.querySelector(selector);
    return element ? element.getBoundingClientRect().right : null;
  };
  const bar = document.querySelector<HTMLElement>(".filterbar");
  const controls = [...(bar?.children ?? [])]
    .filter((child) => child.getBoundingClientRect().width > 0);
  return {
    search: right(".searchbar"),
    filters: right(".filterbar"),
    results: right(".result-panel"),
    detail: right(".detail-panel"),
    lastControl: controls.length ? Math.max(...controls.map((c) => c.getBoundingClientRect().right)) : null,
    filterHeight: bar ? bar.getBoundingClientRect().height : 0,
    tallestControl: controls.length ? Math.max(...controls.map((c) => c.getBoundingClientRect().height)) : 0,
    filtersAreOneLine: bar ? getComputedStyle(bar).display === "flex" : false,
    clipped: [...(bar?.querySelectorAll("select") ?? [])]
      .filter((select) => select.scrollWidth > select.clientWidth + 1)
      .map((select) => select.value),
  };
});

test("the search bar ends with the sources panel", async ({ page }) => {
  await openCatalog(page);
  const { search, detail, results } = await edges(page);
  // One column or two, the search bar reaches the far edge of the content, which is the
  // sources panel where there is one beside the results.
  expect(Math.abs(search! - Math.max(detail!, results!))).toBeLessThanOrEqual(EDGE);
});

test("the filter row ends with the results panel", async ({ page }) => {
  await openCatalog(page);
  const { filters, results, lastControl } = await edges(page);
  expect(Math.abs(filters! - results!), "filter bar against the results panel").toBeLessThanOrEqual(EDGE);
  expect(Math.abs(lastControl! - results!), "last filter control against the results panel").toBeLessThanOrEqual(EDGE);
});

test("the filter row stays on one line without truncating a control", async ({ page }) => {
  await openCatalog(page);
  const { filtersAreOneLine, filterHeight, tallestControl, clipped } = await edges(page);
  test.skip(!filtersAreOneLine, "narrow viewports stack the filters with their labels above");
  expect(filterHeight, "filter controls wrapped onto another line").toBeLessThanOrEqual(tallestControl + 2);
  expect(clipped, "filter selects with their text cut off").toEqual([]);
});

test("the footer buttons fill their panel and keep their captions", async ({ page }) => {
  await openCatalog(page);
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  const options = await catalog.locator("option").allTextContents();
  await catalog.selectOption({ label: options.find((text) => /Filmy/.test(text))! });
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  await expect(page.locator(".source-footer .actions button").first()).toBeVisible();

  const footer = await page.evaluate(() => {
    const actions = document.querySelector<HTMLElement>(".source-footer .actions")!;
    const box = actions.getBoundingClientRect();
    const buttons = [...actions.children].map((button) => ({
      label: button.textContent?.trim() ?? "",
      rect: button.getBoundingClientRect(),
      clipped: button.scrollWidth > button.clientWidth + 1,
    }));
    return {
      left: box.left,
      right: box.right,
      firstLeft: Math.min(...buttons.map((b) => b.rect.left)),
      lastRight: Math.max(...buttons.map((b) => b.rect.right)),
      clipped: buttons.filter((b) => b.clipped).map((b) => b.label),
      rows: new Set(buttons.map((b) => Math.round(b.rect.top))).size,
      tallest: Math.max(...buttons.map((b) => b.rect.height)),
      shortest: Math.min(...buttons.map((b) => b.rect.height)),
    };
  });

  expect(Math.abs(footer.firstLeft - footer.left), "a gap at the left of the row").toBeLessThanOrEqual(EDGE);
  expect(Math.abs(footer.lastRight - footer.right), "a gap at the right of the row").toBeLessThanOrEqual(EDGE);
  expect(footer.clipped, "buttons with their caption cut off").toEqual([]);
  // A caption broken over two lines makes one button taller than the rest; the row splits
  // into two rows of whole buttons instead when the captions no longer fit side by side.
  expect(footer.tallest - footer.shortest, "buttons of unequal height").toBeLessThanOrEqual(1);
  expect(footer.rows, "the footer used more than two rows").toBeLessThanOrEqual(2);
});
