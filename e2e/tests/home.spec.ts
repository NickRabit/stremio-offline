import { expect, test } from "@playwright/test";
import { forgetFilm } from "./film-progress";
import { goToView, menuItem } from "./nav";

// Home is built from what the account already holds, so the journeys seed that state through
// the API and read it back through the page. Layout across the viewport matrix is covered by
// the invariants and accessibility specs, which list Home with the other views.

test.beforeEach(async ({ request }) => { await forgetFilm(request); });
test.afterEach(async ({ request }) => { await forgetFilm(request); });

const seedFilm = (request: import("@playwright/test").APIRequestContext) =>
  request.post("/api/progress", { data: { key: "movie:tt-e2e-movie", title: "Zkušební film", position: 30, duration: 600 } });

test("Home shows the title that was left half watched and Forget progress removes it", async ({ page, request }) => {
  expect((await seedFilm(request)).ok()).toBe(true);
  await page.goto("/");
  await goToView(page, "Domů");

  const shelf = page.locator(".home-row", { has: page.getByRole("heading", { name: "Pokračovat ve sledování" }) });
  const card = shelf.locator(".browse-item", { hasText: "Zkušební film" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Otevřít titul");

  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: /Akce pro/ }).click();
  await page.getByRole("button", { name: "Zapomenout postup" }).click();
  await expect(card).toHaveCount(0);
  expect(await (await request.get(`/api/progress/${encodeURIComponent("movie:tt-e2e-movie")}`)).json()).toBeNull();
});

test("a card opens the title where the catalogue's own Continue watching tile does", async ({ page, request }) => {
  expect((await seedFilm(request)).ok()).toBe(true);
  await page.goto("/");
  await goToView(page, "Domů");
  const shelf = page.locator(".home-row", { has: page.getByRole("heading", { name: "Pokračovat ve sledování" }) });
  await shelf.locator(".browse-item", { hasText: "Zkušební film" }).getByRole("button").first().click();
  await expect(page.locator(".detail-panel")).toContainText("Zkušební film");
});

test.describe("compact navigation", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("More holds the other destinations, closes on Escape and gives focus back", async ({ page }) => {
    await page.goto("/");
    const nav = page.locator("aside.sidebar nav");
    await expect(nav.locator("button:visible")).toHaveCount(5);
    const more = nav.getByRole("button", { name: "Více", exact: true });
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect(menuItem(page, "Nastavení")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(more).toBeFocused();

    await goToView(page, "Nastavení");
    await expect(page.locator("main.view-settings")).toBeVisible();
    await expect(more).toHaveClass(/active/);
  });
});
