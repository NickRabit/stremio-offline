import { expect, test } from "@playwright/test";

// A rotation collapses the scrollable range, and the browser clamps the offset to the new
// maximum -- which loses the position for good, because rotating back cannot undo a clamp.
// The lists hold an item anchor instead, so what the viewer was looking at stays on screen.

const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };

/** The fixture addon serves a single film, far too few to fill a scrolling grid. */
const manyMovies = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `tt${String(index).padStart(7, "0")}`,
  type: "movie",
  name: `Film ${index}`,
  releaseInfo: "2026",
  poster: "",
  genres: ["Akce"],
}));

test("a rotation keeps the catalogue looking at the same title", async ({ page }) => {
  await page.route("**/api/catalog?**", async (route) => {
    await route.fulfill({ json: manyMovies(60) });
  });
  await page.setViewportSize(PORTRAIT);
  await page.goto("/");
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  await expect(catalog).toBeVisible();
  const options = await catalog.locator("option").allTextContents();
  await catalog.selectOption({ label: options.find((text) => /Filmy/.test(text))! });
  const grid = page.locator(".poster-grid");
  await expect(grid.locator(".poster-card").first()).toBeVisible();

  // Scroll well past what the landscape grid is able to hold.
  await grid.evaluate((element) => { element.scrollTop = element.scrollHeight * 0.7; });
  await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const watched = await grid.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const card = [...document.querySelectorAll<HTMLElement>(".poster-card")]
      .find((candidate) => candidate.getBoundingClientRect().bottom > top + 1);
    return card?.dataset.catalogKey ?? null;
  });
  expect(watched).toBeTruthy();

  await page.setViewportSize(LANDSCAPE);
  await page.waitForTimeout(900);
  await page.setViewportSize(PORTRAIT);
  await page.waitForTimeout(900);

  const seen = await page.locator(`[data-catalog-key="${watched}"]`).evaluate((card) => {
    const grid = card.closest<HTMLElement>(".poster-grid")!.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    return { visible: box.bottom > grid.top && box.top < grid.bottom };
  });
  expect(seen.visible).toBe(true);
});

test("a rotation keeps the library looking at the same item", async ({ page }) => {
  // The library the journeys leave behind is a handful of files, too short to scroll.
  await page.route("**/api/library/browse?**", async (route) => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      kind: "folder", path: `lib_test/folder-${index}`, name: `Složka ${index}`, fileCount: 2, size: 1024,
    }));
    await route.fulfill({ json: { path: "", items, total: items.length, pending: false } });
  });
  await page.setViewportSize(PORTRAIT);
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  const items = page.locator(".browse-item[data-path]");
  await expect(items.first()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(400);
  const watched = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".browse-item[data-path]")]
    .find((candidate) => candidate.getBoundingClientRect().bottom > 90)?.dataset.path ?? null);
  expect(watched).toBeTruthy();

  await page.setViewportSize(LANDSCAPE);
  await page.waitForTimeout(900);
  await page.setViewportSize(PORTRAIT);
  await page.waitForTimeout(900);

  const visible = await page.locator(`[data-path="${watched}"]`).first().evaluate((item) => {
    const box = item.getBoundingClientRect();
    return box.bottom > 90 && box.top < window.innerHeight;
  });
  expect(visible).toBe(true);
});

// Safari slides its toolbars away as the page scrolls, which changes innerHeight and fires
// resize exactly as a rotation does. Answering it starts a chase that re-applies the anchor
// every frame, and iOS momentum keeps scrolling after the finger is gone -- so the list was
// hauled back while it was still gliding. A scroll no gesture drives stands in for momentum,
// because the chase gives way to wheel and touch but never to a scroll on its own.
const TOOLBAR_COLLAPSED = { width: 390, height: 940 };

test("a toolbar sliding away does not haul a gliding list back", async ({ page }) => {
  await page.route("**/api/catalog?**", async (route) => {
    await route.fulfill({ json: manyMovies(60) });
  });
  await page.setViewportSize(PORTRAIT);
  await page.goto("/");
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  await expect(catalog).toBeVisible();
  const options = await catalog.locator("option").allTextContents();
  await catalog.selectOption({ label: options.find((text) => /Filmy/.test(text))! });
  const grid = page.locator(".poster-grid");
  await expect(grid.locator(".poster-card").first()).toBeVisible();

  await grid.evaluate((element) => { element.scrollTop = element.scrollHeight * 0.4; });
  await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  // Only the height changes, the way it does when the toolbars go.
  await page.setViewportSize(TOOLBAR_COLLAPSED);
  // Still gliding: the position moves on with no gesture behind it.
  const glided = await grid.evaluate((element) => {
    element.scrollTop += 900;
    return element.scrollTop;
  });
  await page.waitForTimeout(900);

  expect(await grid.evaluate((element) => element.scrollTop)).toBe(glided);
});

test("a rotation does not fetch a page nobody scrolled for", async ({ page }) => {
  let fetches = 0;
  await page.route("**/api/catalog?**", async (route) => {
    fetches += 1;
    await route.fulfill({ json: manyMovies(60) });
  });
  await page.setViewportSize(PORTRAIT);
  await page.goto("/");
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  await expect(catalog).toBeVisible();
  const options = await catalog.locator("option").allTextContents();
  await catalog.selectOption({ label: options.find((text) => /Filmy/.test(text))! });
  const grid = page.locator(".poster-grid");
  await expect(grid.locator(".poster-card").first()).toBeVisible();
  await grid.evaluate((element) => { element.scrollTop = element.scrollHeight * 0.4; });
  await page.waitForTimeout(600);
  const before = fetches;

  // Landscape leaves the grid so short that it sits inside the paging margin by itself, and
  // the clamp that follows arrives as a scroll event. Neither is the viewer asking for more.
  await page.setViewportSize(LANDSCAPE);
  await page.waitForTimeout(1500);

  expect(fetches).toBe(before);
});
