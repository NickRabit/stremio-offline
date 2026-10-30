import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { addonManifest } from "../../playwright.config";

const placeholder = "Hledat v katalozích a knihovnách…";

const delayCatalog = (request: APIRequestContext, catalog: string, ms: number) =>
  request.get(new URL(`/catalog-delay?catalog=${encodeURIComponent(catalog)}&ms=${ms}`, addonManifest).href);

const openSearch = async (page: Page) => {
  await page.locator(".topbar-search").click();
  await expect(page.locator("main.view-search")).toBeVisible();
  const box = page.getByRole("combobox", { name: placeholder });
  await expect(box).toBeFocused();
  return box;
};

const search = async (page: Page, query = "Zkušební") => {
  const box = await openSearch(page);
  await box.fill(query);
  await box.press("Enter");
  return box;
};

test.afterEach(async ({ request }) => {
  await delayCatalog(request, "e2e-movies", 0);
  await delayCatalog(request, "e2e-series", 0);
});

test("the top bar and Ctrl+K open Search, while an editable field keeps the shortcut", async ({ page }) => {
  await page.goto("/");
  await openSearch(page);

  await page.locator("aside.sidebar nav").getByRole("button", { name: "Katalog", exact: true }).click();
  await page.keyboard.press("Control+K");
  await expect(page.locator("main.view-search")).toBeVisible();
  await expect(page.getByRole("combobox", { name: placeholder })).toBeFocused();

  await page.locator("aside.sidebar nav").getByRole("button", { name: "Katalog", exact: true }).click();
  const catalogField = page.getByPlaceholder("Hledat ve všech doplňcích naráz…");
  await catalogField.fill("Zkušební");
  await catalogField.press("Control+K");
  await expect(page.locator("main.view-catalog")).toBeVisible();
  await expect(page.locator("main.view-search")).toHaveCount(0);
  await expect(catalogField).toHaveValue("Zkušební");
});

test("a fast catalog paints while a delayed one is still searching", async ({ page, request }) => {
  await delayCatalog(request, "e2e-series", 8_000);
  await page.goto("/");
  await search(page);

  await expect(page.locator("[data-search-card][title=\"Zkušební film\"]").filter({ hasText: "· Film" })).toBeVisible({ timeout: 2_000 });
  await expect(page.locator(".search-source-summary")).toHaveText("Stále se hledá 1 zdroj");
  await expect(page.locator("[data-search-card][title=\"Zkušební seriál\"]").filter({ hasText: "· Seriál" })).toBeVisible({ timeout: 15_000 });
});

test("source filters start a fresh generation and drop old cards", async ({ page }) => {
  await page.goto("/");
  await search(page);
  await expect(page.locator("[data-search-card][title=\"Zkušební film\"]").filter({ hasText: "· Film" })).toBeVisible();
  await expect(page.locator("[data-search-card][title=\"Zkušební seriál\"]").filter({ hasText: "· Seriál" })).toBeVisible();

  // The library may already hold titles from earlier specs, so the libraries answer is not assumed
  // to be empty: every card on screen has to come from that search's own answers.
  const libraryMembers = new Set<string>();
  let librarySession = "";
  page.on("response", async (response) => {
    if (response.request().method() !== "POST" || !/\/api\/search\/everywhere(\/[^/]+\/poll)?$/.test(new URL(response.url()).pathname)) return;
    const answer = await response.json().catch(() => null) as { id?: string; snapshot?: { clusters: Array<{ memberKeys: string[] }>; unidentified: Array<{ memberKeys: string[] }> } } | null;
    if (answer?.id) librarySession = answer.id;
    if (!librarySession || !response.url().includes(librarySession) && !answer?.id) return;
    for (const cluster of [...(answer?.snapshot?.clusters ?? []), ...(answer?.snapshot?.unidentified ?? [])]) {
      for (const key of cluster.memberKeys) libraryMembers.add(key);
    }
  });
  const librariesRequest = page.waitForRequest((request) =>
    request.method() === "POST"
    && request.url().endsWith("/api/search/everywhere")
    && request.postDataJSON()?.sources?.[0] === "local"
    && request.postDataJSON()?.sources?.[1] === "remote");
  await page.locator(".search-filters").getByRole("button", { name: "Knihovny", exact: true }).click();
  const body = (await librariesRequest).postDataJSON();
  expect(body.query).toBe("Zkušební");
  expect(body.sources).toEqual(["local", "remote"]);
  await expect(page.locator(".search-source-summary")).toHaveText("Všechny zdroje odpověděly");
  const shown = await page.locator("[data-search-card]").evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.primaryMember ?? ""));
  for (const key of shown) expect(libraryMembers.has(key), `card ${key} is not from the libraries search`).toBe(true);

  const catalogRequest = page.waitForRequest((request) =>
    request.method() === "POST"
    && request.url().endsWith("/api/search/everywhere")
    && request.postDataJSON()?.sources?.[0] === "catalog");
  await page.locator(".search-filters").getByRole("button", { name: "Katalog", exact: true }).click();
  expect((await catalogRequest).postDataJSON().sources).toEqual(["catalog"]);
  await expect(page.getByRole("button", { name: /Zkušební film/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Zkušební film/ })).toHaveCount(1);
});

test("a card opens the title page and Back restores the same Search", async ({ page }) => {
  await page.goto("/");
  await search(page);
  const card = page.locator("[data-search-card][title=\"Zkušební film\"]");
  await expect(card).toBeVisible();
  // One copy from one addon needs no question: the card opens its title page directly.
  await card.click();
  await expect(page.getByRole("dialog", { name: "Kde otevřít Zkušební film" })).toHaveCount(0);
  await expect(page.locator(".catalogue-title-detail")).toContainText("Zkušební film");

  await page.locator(".browse-head .library-back").click();
  await expect(page.locator("main.view-search")).toBeVisible();
  await expect(page.getByRole("combobox", { name: placeholder })).toHaveValue("Zkušební");
  await expect(page.locator("[data-search-card][title=\"Zkušební film\"]")).toBeVisible();
});

test("Search remembers a query and drops it under the field the way the Catalog search does", async ({ page }) => {
  await page.goto("/");
  await page.request.delete("/api/search/history");
  try {
    await search(page);
    await expect(page.locator("[data-search-card][title=\"Zkušební film\"]")).toBeVisible();

    const form = page.locator("form.search-everywhere-form");
    const box = page.getByRole("combobox", { name: placeholder });
    const list = page.getByRole("listbox", { name: "Návrhy" });
    await form.getByRole("button", { name: "Zrušit" }).click();
    await expect(box).toHaveValue("");
    await expect(list).toHaveCount(0);
    await box.focus();
    await expect(list.getByRole("option")).toHaveText([/Zkušební/]);

    await list.getByRole("option", { name: /Zkušební/ }).click();
    await expect(box).toHaveValue("Zkušební");
    await expect(list).toHaveCount(0);
    await expect(page.locator("[data-search-card][title=\"Zkušební film\"]")).toBeVisible();

    await form.getByRole("button", { name: "Zrušit" }).click();
    await box.focus();
    await box.press("ArrowDown");
    await box.press("Shift+Delete");
    await expect(list).toHaveCount(0);
    await page.reload();
    await (await openSearch(page)).focus();
    await expect(page.locator("#search-all-suggestions")).toHaveCount(0);
  } finally {
    await page.request.delete("/api/search/history");
  }
});

test("Search keeps the query out of the URL and browser storage", async ({ page }) => {
  await page.goto("/");
  await search(page);
  await expect(page.locator("[data-search-card][title=\"Zkušební film\"]")).toBeVisible();

  expect(page.url()).not.toContain("Zkušební");
  const stored = await page.evaluate(() => JSON.stringify({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }));
  expect(stored).not.toContain("Zkušební");
});

test.describe("compact navigation", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Catalog controls stay in place and the mobile navigation keeps five entries", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("combobox", { name: "Kde hledat" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Procházet katalog" })).toBeVisible();
    await expect(page.getByPlaceholder("Hledat ve všech doplňcích naráz…")).toBeVisible();
    await expect(page.locator("aside.sidebar nav button:visible")).toHaveCount(5);
  });
});
