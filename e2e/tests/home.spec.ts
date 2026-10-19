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
  await expect(card).toContainText("Pokračovat");

  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: /Akce pro/ }).click();
  await page.getByRole("button", { name: "Zapomenout postup" }).click();
  await expect(card).toHaveCount(0);
  expect(await (await request.get(`/api/progress/${encodeURIComponent("movie:tt-e2e-movie")}`)).json()).toBeNull();
});

test("a card opens the catalogue title it remembers", async ({ page, request }) => {
  expect((await seedFilm(request)).ok()).toBe(true);
  await page.goto("/");
  await goToView(page, "Domů");
  const shelf = page.locator(".home-row", { has: page.getByRole("heading", { name: "Pokračovat ve sledování" }) });
  await shelf.locator(".browse-item", { hasText: "Zkušební film" }).getByRole("button").first().click();
  // The shared detail the libraries use, over Home: closing it puts Home back.
  await expect(page.locator(".catalogue-title-detail")).toContainText("Zkušební film");
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

test.describe("phone Home loading", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a shelf keeps its height while its cards load", async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let catalogRequests = 0;
    await page.route("**/api/home**", async (route) => {
      const rows = new URL(route.request().url()).searchParams.get("rows") ?? "";
      if (!rows.includes("catalog:")) return route.continue();
      catalogRequests += 1;
      await held;
      await route.continue();
    });

    await page.goto("/");
    await goToView(page, "Domů");
    const shelf = page.locator(".home-row", { has: page.getByRole("heading", { name: /Filmy/ }) });
    await expect.poll(() => catalogRequests).toBeGreaterThan(0);
    const waiting = await shelf.boundingBox();
    expect(waiting).not.toBeNull();

    release();
    await expect(shelf.locator(".home-card").first()).toBeVisible();
    const loaded = await shelf.boundingBox();
    expect(loaded).not.toBeNull();
    expect(Math.abs(loaded!.height - waiting!.height)).toBeLessThanOrEqual(1);
  });

  test("a reload draws the last Home before the server answers", async ({ page, request }) => {
    expect((await seedFilm(request)).ok()).toBe(true);
    await page.goto("/");
    await goToView(page, "Domů");
    const continueWatching = page.locator(".home-row", { has: page.getByRole("heading", { name: "Pokračovat ve sledování" }) });
    await expect(continueWatching.locator(".browse-item", { hasText: "Zkušební film" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((key) =>
      key.startsWith("home-cache:") && (localStorage.getItem(key) ?? "").includes("Zkušební film")))).toBe(true);

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let requests = 0;
    await page.route("**/api/home**", async (route) => {
      requests += 1;
      await held;
      await route.continue();
    });

    try {
      await page.reload();
      await goToView(page, "Domů");
      await expect.poll(() => requests).toBeGreaterThan(0);
      await expect(continueWatching.locator(".browse-item", { hasText: "Zkušební film" })).toBeVisible();
    } finally {
      release();
    }
  });
});
