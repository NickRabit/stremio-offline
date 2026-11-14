import { expect, test, type Page } from "@playwright/test";

const openCatalogue = async (page: Page) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const select = page.getByRole("combobox", { name: "Procházet katalog" });
  const labels = await select.locator("option").allTextContents();
  await select.selectOption({ label: labels.find((text) => /Filmy/.test(text))! });
};

const stubPerson = async (page: Page) => {
  await page.route("**/api/meta/movie/*/extras*", async (route) => {
    await route.fulfill({ json: {
      source: "tmdb",
      people: [
        { name: "Brad Pitt", role: "cast", id: 287, character: "Tyler" },
        { name: "Ada Director", role: "director" },
      ],
      related: [],
    } });
  });
  await page.route("**/api/person/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/title/")) {
      await route.fulfill({ json: { id: "tt-e2e-movie" } });
      return;
    }
    await route.fulfill({ json: {
      id: 287,
      name: "Brad Pitt",
      photo: "/e2e-person.svg",
      sections: [
        { key: "acting", titles: [
          { type: "movie", tmdbId: 1, id: "tt-e2e-movie", name: "Pulp Fiction", year: "1994", role: "Jimmie", inLibrary: true },
        ] },
        { key: "crew", titles: [
          { type: "series", tmdbId: 2, id: "tt-e2e-series", name: "Kill Bill", year: "2003", role: "Director" },
        ] },
      ],
    } });
  });
};

const openPerson = async (page: Page) => {
  await stubPerson(page);
  await openCatalogue(page);
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  await page.locator(".detail-panel .detail-info:visible").click();
  const main = page.locator("main.view-title-detail");
  await expect(main.locator(".title-extras .person", { hasText: "Brad Pitt" })).toBeVisible();
  await main.locator(".title-extras .person", { hasText: "Brad Pitt" }).click();
  const person = page.locator(".person-view");
  await expect(person).toBeVisible();
  await expect(person.getByRole("heading", { name: "Herectví" })).toBeVisible();
  await expect(person.getByRole("heading", { name: "Režie a scénář" })).toBeVisible();
  await expect(person.locator(".browse-item", { hasText: "Pulp Fiction" })).toBeVisible();
  await expect(person.locator(".browse-item", { hasText: "Kill Bill" })).toBeVisible();
};

const journey = async (page: Page) => {
  await openPerson(page);
  await page.locator(".person-view .browse-item", { hasText: "Pulp Fiction" }).click();
  const detail = page.locator("main.view-title-detail");
  await expect(detail).toBeVisible();
  await expect(detail.locator(".library-title-detail h2")).toBeVisible();
  await detail.locator(".library-back").click();
  await expect(page.locator("main.view-title-detail")).toHaveCount(0);
  await expect(page.locator(".person-view")).toBeVisible();
  await expect(page.locator(".person-view").getByRole("heading", { name: "Herectví" })).toBeVisible();
};

test("opening a person shows the filmography and closing a title returns to it", async ({ page }) => {
  await journey(page);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("opening a person shows the filmography without sideways scroll", async ({ page }) => {
    await journey(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(overflow).toBe(true);
  });

  test("landscape does not scroll sideways", async ({ page }) => {
    await page.setViewportSize({ width: 812, height: 375 });
    await openPerson(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(overflow).toBe(true);
  });
});
