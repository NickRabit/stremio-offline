import { expect, test as base, type Page } from "@playwright/test";
import { catalogTrigger, openCatalogPicker, scopeTrigger } from "./catalog-picker";

const test = base.extend({
  page: async ({ page }, use) => {
    const views = await (await page.request.get("/api/views")).json();
    await page.request.patch("/api/views", { data: { catalog: { last: null, recent: [] } } });
    try {
      await use(page);
    } finally {
      const request = page.context().request;
      await page.close();
      await request.patch("/api/views", { data: { catalog: views.catalog } });
    }
  },
});

test("the matched genre is both highlighted and committed by Enter", async ({ page }) => {
  await page.route("**/api/catalogs", async (route) => {
    const response = await route.fetch();
    const catalogs = await response.json();
    const options = [...Array.from({ length: 12 }, (_, index) => String(index)), "Drama"];
    await route.fulfill({ json: catalogs.map((catalog: object) => ({
      ...catalog, extra: [{ name: "genre", options }],
    })) });
  });
  await page.goto("/");
  await page.locator(".genre-trigger").click();
  const dialog = page.getByRole("dialog");
  const field = dialog.getByRole("combobox");
  await field.fill("Drama");
  const match = dialog.getByRole("option", { name: "Drama", exact: true });
  await expect(match).toHaveCSS("outline-style", "solid");
  await field.press("Enter");
  await expect(page.locator(".genre-trigger")).toContainText("Drama");
});

test("catalog scope can switch types directly and find a whole addon by name", async ({ page }) => {
  await page.goto("/");
  const scope = scopeTrigger(page);
  const dialog = page.getByRole("dialog");
  await scope.click();
  const field = dialog.getByRole("combobox");
  await field.fill("Filmy");
  await dialog.getByRole("option", { name: /Filmy/ }).click();
  await scope.click();
  await field.fill("Seriály");
  await dialog.getByRole("option", { name: /Seriály/ }).click();
  await expect(scope).toContainText("Seriály");
  await scope.click();
  await field.fill("E2E");
  await dialog.getByRole("option", { name: "Všechny katalogy doplňku" }).click();
  await expect(scope).toContainText("E2E doplněk");
});

test("a reload starts the catalogue over on the default choices", async ({ page }) => {
  await page.goto("/");
  const first = await catalogTrigger(page).textContent();
  const dialog = await openCatalogPicker(page);
  await dialog.getByRole("combobox").fill("Seriály");
  await dialog.getByRole("option", { name: /Seriály/ }).click();
  await expect(catalogTrigger(page)).toContainText("Seriály");
  await page.reload();
  await expect(catalogTrigger(page)).toHaveText(first!);
  await expect(scopeTrigger(page)).toContainText(/Společné hledání|Shared search/);
});

const tile = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name} `) });

test("All browses both typed resources, retries failed pages and is where a reload starts", async ({ page }) => {
  const addonKey = "paired-addon";
  const calls: string[] = [];
  let failSeriesPage = true;
  await page.route("**/api/catalogs", (route) => route.fulfill({ json: [
    { addonKey, addonName: "Test addon", type: "movie", id: "movie-feed", name: "Netflix" },
    { addonKey, addonName: "Test addon", type: "series", id: "series-feed", name: "Netflix" },
    { addonKey, addonName: "Test addon", type: "channel", id: "live", name: "Channels" },
  ] }));
  await page.route("**/api/catalog?**", (route) => {
    const query = new URL(route.request().url()).searchParams;
    const type = query.get("type")!;
    const skip = Number(query.get("skip"));
    calls.push(`${query.get("id")}:${skip}`);
    if (type === "series" && skip === 1 && failSeriesPage) {
      failSeriesPage = false;
      return route.fulfill({ status: 503, json: { error: "Unavailable" } });
    }
    const ids = type === "movie" && skip === 0 ? ["1", "2"] : type === "series" && skip <= 1 ? [String(1 + skip)] : [];
    return route.fulfill({ json: ids.map((id) => ({ id, type, name: `${type} ${id}` })) });
  });

  await page.goto("/");
  const types = page.locator(".catalog-type-switch");
  const all = types.getByRole("button", { name: "Vše", exact: true });
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await expect(tile(page, "movie 2")).toBeVisible();
  await expect(tile(page, "series 1")).toBeVisible();

  const more = page.locator(".load-more button");
  await more.click();
  await expect(more).toHaveText("Zkusit znovu");
  await more.click();
  await expect(tile(page, "series 2")).toBeVisible();
  expect(calls.filter((call) => call === "movie-feed:2")).toHaveLength(1);
  expect(calls.filter((call) => call === "series-feed:1")).toHaveLength(2);
  await more.click();
  await expect(more).toHaveCount(0);

  await types.getByRole("button", { name: "Seriály", exact: true }).click();
  await expect(tile(page, "movie 2")).toHaveCount(0);
  await page.reload();
  await expect(all).toHaveAttribute("aria-pressed", "true");
  const picker = await openCatalogPicker(page);
  await picker.getByRole("combobox").fill("Netflix");
  await expect(picker.getByRole("option")).toHaveCount(1);
  // All mixes movies and series only, yet a search from it still finds the other kinds.
  await picker.getByRole("combobox").fill("Channels");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await expect(picker.getByRole("option")).toContainText("channel");
});

const twoAddons = (route: import("@playwright/test").Route) => route.fulfill({ json: [
  { addonKey: "first", addonName: "First addon", type: "movie", id: "top", name: "Top", extra: [{ name: "genre", options: ["Drama", "Comedy"] }] },
  { addonKey: "first", addonName: "First addon", type: "series", id: "top", name: "Top", extra: [{ name: "genre", options: ["Drama", "Comedy"] }] },
  { addonKey: "first", addonName: "First addon", type: "series", id: "upnext", name: "Up next" },
  { addonKey: "second", addonName: "Second addon", type: "movie", id: "plain", name: "Plain list" },
  { addonKey: "second", addonName: "Second addon", type: "movie", id: "kinds", name: "Kinds", extra: [{ name: "genre", options: ["Comedy"] }] },
  { addonKey: "anime", addonName: "Anime addon", type: "anime", id: "airing", name: "Airing" },
] });
const metasFor = (route: import("@playwright/test").Route) => {
  const query = new URL(route.request().url()).searchParams;
  const type = query.get("type")!;
  const id = query.get("id")!;
  const genre = query.get("genre") ?? "";
  return route.fulfill({ json: Number(query.get("skip")) ? [] : [{ id: `${id}-${type}-${genre || "any"}`, type, name: `${id} ${type} ${genre || "any"}` }] });
};

test("the picker lists only the chosen type while browsing and every type while searching", async ({ page }) => {
  await page.route("**/api/catalogs", twoAddons);
  await page.route("**/api/catalog?**", metasFor);
  await page.goto("/");
  const picker = await openCatalogPicker(page);
  await picker.getByRole("group", { name: /^(Typ|Type)$/ }).getByRole("button", { name: /^(Jiné|Other)$/ }).click();
  await expect(picker.getByRole("option")).toHaveText([/Airing/]);
  await expect(picker.getByRole("combobox")).toBeFocused();
  await page.keyboard.type("top");
  await expect(picker.getByRole("option")).toHaveCount(2);
  await picker.getByRole("combobox").fill("");
  await picker.getByRole("group", { name: /^(Typ|Type)$/ }).getByRole("button", { name: /^(Vše|All)$/ }).click();
  await expect(picker.getByRole("option", { name: /Up next/ })).toContainText(/jen seriály|series only/i);
});

test("a genre does not follow the viewer to a catalogue without it, but waits on the same list in another type", async ({ page }) => {
  await page.route("**/api/catalogs", twoAddons);
  await page.route("**/api/catalog?**", metasFor);
  await page.goto("/");
  const genre = page.locator(".genre-trigger");
  await genre.click();
  await page.getByRole("dialog").getByRole("option", { name: /^(Drama)/ }).click();
  await expect(genre).toContainText("Drama");

  const types = page.locator(".catalog-type-switch");
  await types.getByRole("button", { name: /^(Filmy|Movies)$/ }).click();
  await expect(genre).toContainText("Drama");

  let picker = await openCatalogPicker(page);
  await picker.getByRole("combobox").fill("plain");
  await picker.getByRole("option", { name: /Plain list/ }).click();
  await expect(genre).not.toContainText("Drama");

  picker = await openCatalogPicker(page);
  await picker.getByRole("combobox").fill("kinds");
  await picker.getByRole("option", { name: /Kinds/ }).click();
  await expect(genre).not.toContainText("Drama");
  await expect(page.getByRole("button", { name: /^kinds movie any/ })).toBeVisible();
});

test("clicking Catalog in the menu again resets the catalogue, its type and genre", async ({ page }) => {
  await page.route("**/api/catalogs", twoAddons);
  await page.route("**/api/catalog?**", metasFor);
  await page.goto("/");
  const genre = page.locator(".genre-trigger");
  await genre.click();
  await page.getByRole("dialog").getByRole("option", { name: /^(Drama)/ }).click();
  const types = page.locator(".catalog-type-switch");
  await types.getByRole("button", { name: /^(Seriály|Series)$/ }).click();
  await expect(genre).toContainText("Drama");

  await page.getByRole("navigation").getByRole("button", { name: /^(Katalog|Catalog)$/ }).first().click();
  await expect(types.getByRole("button", { name: /^(Vše|All)$/ })).toHaveAttribute("aria-pressed", "true");
  await expect(genre).not.toContainText("Drama");
});

test.describe("on a touch phone", () => {
  test.use({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true });

  test("one tap on the folded bar's catalogue button opens the picker", async ({ page }) => {
    await page.route("**/api/catalogs", twoAddons);
    await page.route("**/api/catalog?**", (route) => {
      const query = new URL(route.request().url()).searchParams;
      const type = query.get("type")!;
      return route.fulfill({ json: Number(query.get("skip")) ? [] : Array.from({ length: 60 }, (_, index) => ({ id: `${type}-${index}`, type, name: `${type} ${index}` })) });
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: /^movie 59 / })).toBeAttached();
    await page.locator(".poster-grid").evaluate((grid) => grid.scrollBy(0, 2000));
    await expect(page.locator(".catalog-view.catalog-compact")).toBeVisible();
    await catalogTrigger(page).tap();
    await expect(page.getByRole("dialog", { name: /^(Katalog|Catalog)$/ })).toBeVisible();
  });
});

test("the picker reopens on a current addon further down, and stays at the top for the first one", async ({ page }) => {
  const addons = Array.from({ length: 9 }, (_, index) => `Addon ${index + 1}`);
  await page.route("**/api/catalogs", (route) => route.fulfill({ json: addons.flatMap((name, index) =>
    ["One", "Two", "Three", "Four"].map((list) => ({ addonKey: `addon-${index + 1}`, addonName: name, type: "movie", id: list.toLowerCase(), name: `${list} ${index + 1}` }))) }));
  await page.route("**/api/catalog?**", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  let picker = await openCatalogPicker(page);
  await expect(picker.getByRole("group", { name: "Addon 1" })).toBeInViewport();

  await picker.getByRole("combobox").fill("Four 9");
  await picker.getByRole("option", { name: /Four 9/ }).click();
  picker = await openCatalogPicker(page);
  await expect(picker.getByRole("group", { name: "Addon 9" }).getByRole("option", { name: /Four 9/ })).toBeInViewport();

  await picker.getByRole("combobox").fill("One 1");
  await picker.getByRole("option", { name: /One 1/ }).first().click();
  picker = await openCatalogPicker(page);
  await expect(picker.getByRole("group", { name: /^(Naposledy použité|Recently used)$/ })).toBeInViewport();
});
