import { expect, test, type Locator } from "@playwright/test";
import { addonManifest } from "../../playwright.config";
import { goToView } from "./nav";

// The Library entry always starts over, and the player gives the list back where it was left.
// The rotation cases live in rotation.spec.ts; these hold the plain desktop round trips.

const folders = (count: number) => Array.from({ length: count }, (_, index) => ({
  kind: "folder", path: `lib_test/folder-${index}`, name: `Složka ${index}`, fileCount: 2, size: 1024,
}));

test("the Library entry gives a scrolled listing back at the top", async ({ page }) => {
  await page.route("**/api/library/browse?**", async (route) => {
    const items = folders(120);
    await route.fulfill({ json: { path: "", items, total: items.length, pending: false } });
  });
  await page.goto("/");
  await goToView(page, "Knihovna");
  const listing = page.locator(".browse-scroll");
  await expect(listing.locator(".browse-item[data-path]").first()).toBeVisible();
  // The section's own restore chase runs for a moment after it opens.
  await page.waitForTimeout(1600);
  const room = await listing.evaluate((element) => element.scrollHeight - element.clientHeight);
  expect(room).toBeGreaterThan(400);
  await listing.evaluate((element) => { element.scrollTop = 400; });
  await expect.poll(() => listing.evaluate((element) => Math.round(element.scrollTop))).toBe(400);

  await goToView(page, "Katalog");
  await expect(listing).toHaveCount(0);
  await goToView(page, "Knihovna");
  await expect(listing.locator(".browse-item[data-path]").first()).toBeVisible();

  // The Library entry is the way back to the root from anywhere; nothing is remembered for it.
  await expect.poll(() => listing.evaluate((element) => Math.round(element.scrollTop))).toBe(0);
});

const ratioIn = (card: Locator) => card.evaluate((element) => {
  const list = element.closest<HTMLElement>(".poster-grid")!;
  return (element.getBoundingClientRect().top - list.getBoundingClientRect().top) / list.clientHeight;
});

test("closing the player gives the catalogue grid back at the title that was played", async ({ page }) => {
  await page.route("**/api/catalog?**", async (route) => {
    const response = await route.fetch();
    const items = await response.json();
    await route.fulfill({ json: Array.from({ length: 80 }, (_, index) => ({ ...items[0], id: `tt-e2e-scroll-${index}`, name: `Scroll ${index}` })) });
  });
  await page.route("**/api/meta/movie/tt-e2e-scroll-*", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop()!);
    await route.fulfill({ json: { id, type: "movie", name: `Scroll ${id.split("-").pop()}`, description: "Scroll return title" } });
  });
  await page.goto("/");
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  await expect(catalog).toBeVisible();
  const options = await catalog.locator("option").allTextContents();
  await catalog.selectOption({ label: options.find((text) => /Filmy/.test(text))! });

  const grid = page.locator(".poster-grid");
  await expect(grid.locator(".poster-card")).toHaveCount(80);
  const title = grid.getByRole("button", { name: /Scroll 55\b/ });
  await title.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const before = await ratioIn(title);

  await title.click();
  const detail = page.locator(".detail-panel");
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { name: "Přehrát", exact: true }).click();
  const player = page.locator(".player-overlay");
  await expect(player).toBeVisible();
  // Whatever moves the grid while the player covers it must not decide where it comes back.
  await grid.evaluate((element) => { element.scrollTop = 0; });

  await player.getByRole("button", { name: "Zavřít přehrávač", exact: true }).click();
  await expect(player).toHaveCount(0);

  await expect(title).toBeInViewport();
  await expect.poll(async () => Math.abs((await ratioIn(title)) - before)).toBeLessThan(0.1);
});

test.describe("a source switch", () => {
  // Two sources the test browser can play, so the switch really happens.
  test.beforeEach(async ({ request }) => {
    await request.get(new URL("/proxy-control?mode=browser-pair", addonManifest).href);
  });
  test.afterEach(async ({ request }) => {
    await request.get(new URL("/proxy-control?mode=video", addonManifest).href);
  });

  test("switching the source in the player keeps the catalogue position it was opened from", async ({ page }) => {
    await page.route("**/api/catalog?**", async (route) => {
      const response = await route.fetch();
      const items = await response.json();
      await route.fulfill({ json: Array.from({ length: 80 }, (_, index) => ({ ...items[0], id: `tt-e2e-switch-${index}`, name: `Switch ${index}` })) });
    });
    await page.route("**/api/meta/movie/tt-e2e-switch-*", async (route) => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop()!);
      await route.fulfill({ json: { id, type: "movie", name: `Switch ${id.split("-").pop()}`, description: "Source switch title" } });
    });
    await page.goto("/");
    const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
    await expect(catalog).toBeVisible();
    const options = await catalog.locator("option").allTextContents();
    await catalog.selectOption({ label: options.find((text) => /Filmy/.test(text))! });

    const grid = page.locator(".poster-grid");
    await expect(grid.locator(".poster-card")).toHaveCount(80);
    const title = grid.getByRole("button", { name: /Switch 55\b/ });
    await title.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const before = await ratioIn(title);

    await title.click();
    const detail = page.locator(".detail-panel");
    await detail.getByRole("button", { name: "Přehrát", exact: true }).click();
    const player = page.locator(".player-overlay");
    await expect(player).toBeVisible();
    // A rotation under the player relays the grid out and clamps its offset; a switch made then
    // must not take that clamped layout for the place to come back to.
    await grid.evaluate((element) => { element.scrollTop = 0; });

    await player.dispatchEvent("pointermove");
    await page.getByRole("button", { name: "Zdroje", exact: true }).click();
    const rows = page.locator("#player-sources .player-source-list button");
    await expect.poll(() => rows.count()).toBeGreaterThan(1);
    const next = rows.and(page.locator('button[aria-pressed="false"]')).first();
    const key = await next.getAttribute("data-row-key");
    expect(key).toBeTruthy();
    await next.click();
    await expect(page.locator("#player-sources")).toHaveCount(0);
    await player.dispatchEvent("pointermove");
    const toggle = player.getByRole("button", { name: "Zdroje", exact: true });
    await toggle.click();
    await expect(rows.and(page.locator('button[aria-pressed="true"]')).first()).toHaveAttribute("data-row-key", key!);
    await toggle.click();

    await player.dispatchEvent("pointermove");
    await player.getByRole("button", { name: "Zavřít přehrávač", exact: true }).click();
    await expect(player).toHaveCount(0);

    await expect(title).toBeInViewport();
    await expect.poll(async () => Math.abs((await ratioIn(title)) - before)).toBeLessThan(0.1);
  });
});
