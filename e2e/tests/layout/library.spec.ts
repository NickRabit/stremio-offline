import { expect, test } from "@playwright/test";
import { resetViews } from "../library-tools";
import { goToView } from "../nav";

test.beforeEach(async ({ request }) => {
  await resetViews(request);
});

const poster = (color: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="360"><rect width="240" height="360" fill="${color}"/><circle cx="120" cy="130" r="70" fill="#ffffff22"/><path d="M0 360L130 170L240 360" fill="#00000033"/></svg>`)}`;
const folder = { kind: "folder", path: "Seriály", name: "Seriály", fileCount: 8, size: 8e9, poster: poster("#38516d"), favorite: true, year: "1995", description: "Kněží na ostrově Craggy Island.", match: "matched" };
const file = { kind: "file", path: "Film.mkv", label: "Cesta za obzor a další dobrodružství na konci světa", size: 2e9, season: null, episode: null, modified: "2026-09-01", poster: poster("#936347"), favorite: true, year: "2024", description: "Film, který existuje jen pro testy.", match: "matched" };
const episode = { ...file, path: "Seriály/01/epizoda.mkv", label: "Dlouhý název epizody, který se musí vejít i na telefonu", season: 1, episode: 1, progress: { position: 120, duration: 2400 } };

// A star of each kind as `GET /api/favorites` hands it out; the Favourites section draws both.
const favoriteFolder = { kind: "library", path: "Seriály", label: "Seriály", itemKind: "folder", poster: poster("#38516d"), year: "1995" };
const favoriteFile = { kind: "library", path: "Film.mkv", label: "Cesta za obzor", itemKind: "file", poster: poster("#936347"), year: "2024", progress: { position: 120, duration: 2400 } };
const favoriteCatalog = { kind: "catalog", type: "movie", id: "tt9", name: "Cesta za obzor", poster: poster("#936347"), year: "2024" };

test("library cards and folder navigation", async ({ page }, testInfo) => {
  await page.route("**/api/library/browse?*", (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") || "";
    return route.fulfill({ json: { path, items: path ? [episode] : [folder, file, { ...file, path: "other.mkv", label: "Film bez plakátu", poster: undefined, favorite: false, description: undefined, year: undefined }], total: path ? 1 : 3, pending: false } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  // Continue watching and Favourites are one section each in the navigation now, so the
  // library root draws no shelf of its own.
  await expect(page.locator(".library-shelf")).toHaveCount(0);
  if (testInfo.project.name === "mobile") {
    await expect(page.getByRole("button", { name: "Prohledat knihovnu", exact: true })).toBeHidden();
    const tools = page.getByRole("button", { name: "Nástroje knihovny", exact: true });
    await tools.click();
    await expect(tools).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("button", { name: "Skenovat znovu", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Prohledat knihovnu", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(tools).toBeFocused();
    await expect(tools).toHaveAttribute("aria-expanded", "false");
    // The tools that fold away are the block that must stay small; what stays behind sits on the
    // breadcrumb line and costs the listing nothing.
    const toolbar = (await page.locator(".browse-fold").boundingBox())!;
    expect(toolbar.height).toBeLessThanOrEqual(100);
    const trail = (await page.locator(".crumbs").boundingBox())!;
    const kept = (await page.locator(".browse-keep").boundingBox())!;
    expect(kept.y).toBeLessThan(trail.y + trail.height);
  }
  const art = page.locator(".browse-grid .browse-art").first();
  const box = (await art.boundingBox())!;
  expect(box.height / box.width).toBeCloseTo(1.5, 1);
  await expect(page.locator(".library-page button button")).toHaveCount(0);
  const rows = await page.locator(".browse-grid .library-open").evaluateAll((cards) => cards.map((card) => ({
    top: card.getBoundingClientRect().top,
    metadata: card.querySelector(".library-copy small")!.getBoundingClientRect().top,
    action: card.querySelector(".library-action")!.getBoundingClientRect().top,
  })));
  for (const card of rows) {
    const first = rows.find((other) => Math.abs(other.top - card.top) < 1)!;
    expect(Math.abs(card.metadata - first.metadata)).toBeLessThan(1);
    expect(Math.abs(card.action - first.action)).toBeLessThan(1);
  }
  // Soft, and so is the list below: one test holds both baselines, and a hard first
  // assertion ends the run there, so a stale second one stays invisible until the
  // first is fixed. Soft reports both, and the assertions after them still run.
  await expect.soft(page).toHaveScreenshot("library-cards.png", { fullPage: true });
  await page.getByRole("button", { name: "Možnosti: Seriály", exact: true }).click();
  await expect(page.getByRole("button", { name: "Odebrat z oblíbených", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "Opravit přiřazení…", exact: true })).toBeVisible();
  await expect(page.locator(".browse-grid .library-desc").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".browse-actions")).toHaveCount(0);
  await page.getByRole("button", { name: /Seriály.*Otevřít složku/ }).click();
  await expect(page.getByRole("button", { name: /Dlouhý název.*Otevřít titul/ })).toBeVisible();
  await page.getByRole("button", { name: "O složku zpět" }).click();
  await page.getByRole("button", { name: "Zobrazit po řádcích" }).click();
  await expect(page.locator(".browse-rows .library-open")).toHaveCount(3);
  await page.waitForTimeout(1000);
  await expect(page.locator(".browse-rows .library-open")).toHaveCount(3);
  await expect.soft(page).toHaveScreenshot("library-list.png", { fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (testInfo.project.use.hasTouch) {
    const buttons = await page.locator(".browse-menu").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
    expect(buttons.every((height) => height >= 36)).toBe(true);
  }
});


test("the favourites section holds both kinds and filters them", async ({ page }) => {
  const filters: string[] = [];
  await page.route("**/api/favorites?*", (route) => {
    const filter = new URL(route.request().url()).searchParams.get("filter") || "all";
    filters.push(filter);
    const items = filter === "movies" ? [favoriteFile, favoriteCatalog] : filter === "series" ? [favoriteFolder] : [favoriteFolder, favoriteFile, favoriteCatalog];
    return route.fulfill({ json: { items, total: items.length, pending: false } });
  });
  await page.route("**/api/library/browse?*", (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") || "";
    return route.fulfill({ json: { path, items: path ? [episode] : [], total: path ? 1 : 0, pending: false } });
  });
  await page.goto("/");
  await goToView(page, "Oblíbené");
  const grid = page.locator(".favorites-grid");
  await expect(grid.locator(".browse-item")).toHaveCount(3);
  await expect(grid.locator('[data-kind="favorite-catalog"]')).toHaveCount(1);
  const chips = page.locator(".favorites-view .filterbar");
  await chips.getByRole("button", { name: "Filmy", exact: true }).click();
  await expect(grid.locator(".browse-item")).toHaveCount(2);
  await chips.getByRole("button", { name: "Seriály", exact: true }).click();
  await expect(grid.locator(".browse-item")).toHaveCount(1);
  await expect(grid.locator('[data-kind="favorite-library"]')).toContainText("Seriály");
  await chips.getByRole("button", { name: "Vše", exact: true }).click();
  await expect(grid.locator(".browse-item")).toHaveCount(3);
  expect(filters).toContain("movies");
  expect(filters).toContain("series");
  await grid.locator('[data-kind="favorite-library"]').first().click();
  await expect(page.locator(".crumbs")).toContainText("Seriály");
});

test("empty favorites explain how to add titles", async ({ page }) => {
  await page.route("**/api/favorites?*", (route) => route.fulfill({ json: { items: [], total: 0, pending: false } }));
  await page.goto("/");
  await goToView(page, "Oblíbené");
  await expect(page.getByText("Zatím žádné oblíbené", { exact: true })).toBeVisible();
  const chips = page.locator(".favorites-view .filterbar");
  await chips.getByRole("button", { name: "Filmy", exact: true }).click();
  await expect(page.getByText("Žádné oblíbené filmy", { exact: true })).toBeVisible();
  await chips.getByRole("button", { name: "Seriály", exact: true }).click();
  await expect(page.getByText("Žádné oblíbené seriály", { exact: true })).toBeVisible();
});

test("the Continue watching section merges both kinds, filters and pages them", async ({ page }) => {
  // The merged Home shape: a library card and a catalogue card in one list.
  const fileCard = (index: number) => ({ kind: "resume-file", key: `file:resume-${index}.mp4`, title: `Rozkoukaný film ${index}`, path: `resume-${index}.mp4`, progress: { position: 120, duration: 2400 }, updatedAt: "2026-09-01T00:00:00.000Z", forgetKeys: [`file:resume-${index}.mp4`] });
  const catalogCard = { kind: "resume-catalogue", key: "series:tt9:1:2", title: "Ze seriálu", type: "series", id: "tt9", name: "Seriál", season: 1, episode: 2, progress: { position: 60, duration: 600 }, updatedAt: "2026-09-01T00:00:00.000Z", forgetKeys: ["series:tt9:1:2"] };
  const all = [catalogCard, ...Array.from({ length: 9 }, (_, index) => fileCard(index))];
  const filters: string[] = [];
  await page.route("**/api/resume?*", (route) => {
    const filter = new URL(route.request().url()).searchParams.get("filter") || "all";
    filters.push(filter);
    const kept = filter === "movies" ? all.filter((item) => item.kind === "resume-file")
      : filter === "series" ? all.filter((item) => item.kind === "resume-catalogue") : all;
    return route.fulfill({ json: { items: kept, total: kept.length, pending: false } });
  });
  await page.goto("/");
  await goToView(page, "Pokračovat ve sledování");
  const grid = page.locator(".section-grid");
  await expect(grid.locator(".browse-item")).toHaveCount(10);
  const chips = page.locator(".section-view .filterbar");
  await chips.getByRole("button", { name: "Filmy", exact: true }).click();
  await expect(grid.locator(".browse-item")).toHaveCount(9);
  await expect(grid.locator('[data-kind="resume-catalogue"]')).toHaveCount(0);
  await chips.getByRole("button", { name: "Seriály", exact: true }).click();
  await expect(grid.locator(".browse-item")).toHaveCount(1);
  await expect(grid.locator('[data-kind="resume-catalogue"]')).toContainText("Ze seriálu");
  await chips.getByRole("button", { name: "Vše", exact: true }).click();
  await expect(grid.locator(".browse-item")).toHaveCount(10);
  expect(filters).toContain("movies");
  expect(filters).toContain("series");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("showing a finished download highlights the file in a crowded folder", async ({ page }) => {
  const files = Array.from({ length: 24 }, (_, index) => ({
    kind: "file" as const,
    path: `Seriály/ep-${String(index + 1).padStart(2, "0")}.mkv`,
    label: `Epizoda ${index + 1}`,
    size: 1e9,
    season: 1,
    episode: index + 1,
    modified: "2026-09-01",
    poster: poster("#38516d"),
    favorite: false,
  }));
  const wanted = files[17];
  await page.route("**/api/downloads", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      json: {
        jobs: [{
          id: "job-1",
          title: wanted.label,
          status: "completed",
          target: wanted.path,
          received: 1e9,
          total: 1e9,
          speed: 0,
          order: 0,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        }],
        halt: null,
      },
    });
  });
  await page.route("**/api/library/browse?*", (route) => {
    const folderPath = new URL(route.request().url()).searchParams.get("path") || "";
    const items = folderPath === "Seriály"
      ? files
      : [{ kind: "folder", path: "Seriály", name: "Seriály", fileCount: files.length, size: 24e9, poster: poster("#38516d"), favorite: false }];
    return route.fulfill({ json: { path: folderPath, items, total: items.length, pending: false } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Stahování", exact: true }).click();
  await page.locator(".queue-history-toggle").click();
  await page.locator(".job-link").click();
  const focused = page.locator(".browse-item.focused");
  await expect(focused).toBeVisible();
  await expect(focused).toHaveAttribute("aria-current", "true");
  await expect(focused).toContainText("1×18 Epizoda 18");
  await expect(focused).toContainText("Tento soubor");
  await expect(focused).toBeInViewport();
  await expect(page.locator(".browse-item")).toHaveCount(24);
});

// The fix-match dialog is the one that opens with a keyboard, so it is the one that showed
// what a sheet sized against the layout viewport does: the action and the results ended up
// off the screen, and the long file names ran past the card.
test("the identify dialog stays inside the screen", async ({ page }) => {
  await page.route("**/api/library/browse?*", (route) => route.fulfill({ json: { path: "", items: [file], total: 1, pending: false } }));
  await page.route("**/api/library/identity?*", (route) => route.fulfill({
    json: {
      path: file.path, key: file.path, kind: "movie", file: true, label: file.label,
      parsed: { title: "Cesta za obzor", query: "Cesta za obzor", year: 2024 },
      match: "matched", bound: { type: "movie", id: "tt1", name: "Cesta za obzor" },
    },
  }));
  // The dialog's own search is the trusted one; the wider catalogue search is a separate,
  // explicit action and is not what this test opens.
  await page.route("**/api/library/search?*", (route) => route.fulfill({
    json: {
      items: [
        { id: "tt1", type: "movie", name: "Cesta za obzor", releaseInfo: "2024", poster: poster("#936347"), source: "cinemeta" },
        { id: "tt2", type: "movie", name: "Cesta.za.obzor.2024.BluRay.1080p.DTS-HD.MA.5.1.x264-CHD.mkv", releaseInfo: "2024", source: "cinemeta" },
      ],
      total: 2,
    },
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await page.getByRole("button", { name: `Možnosti: ${file.label}` }).click();
  await page.getByRole("button", { name: "Opravit přiřazení…", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const apply = dialog.getByRole("button", { name: "Použít tento titul" });
  await expect(apply).toBeInViewport();
  await expect(dialog.locator(".identify-results button")).toHaveCount(2);

  const card = (await dialog.locator(".identify-card").boundingBox())!;
  const height = await page.evaluate(() => innerHeight);
  expect(card.y).toBeGreaterThanOrEqual(-1);
  expect(card.y + card.height).toBeLessThanOrEqual(height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const name = (await dialog.locator(".identify-results button").last().locator("strong").boundingBox())!;
  expect(name.x + name.width).toBeLessThanOrEqual(card.x + card.width + 1);

  // The results are reachable by scrolling the body, not by moving the card.
  const scrolled = await dialog.locator(".dialog-body").evaluate((body) => {
    body.scrollTop = body.scrollHeight;
    return body.scrollTop;
  });
  expect(scrolled).toBeGreaterThanOrEqual(0);
  const after = (await dialog.locator(".identify-card").boundingBox())!;
  expect(Math.abs(after.y - card.y)).toBeLessThan(1);
});
