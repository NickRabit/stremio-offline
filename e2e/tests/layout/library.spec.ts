import { expect, test } from "@playwright/test";

const poster = (color: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="360"><rect width="240" height="360" fill="${color}"/><circle cx="120" cy="130" r="70" fill="#ffffff22"/><path d="M0 360L130 170L240 360" fill="#00000033"/></svg>`)}`;
const folder = { kind: "folder", path: "Seriály", name: "Seriály", fileCount: 8, size: 8e9, poster: poster("#38516d"), favorite: true, year: "1995", description: "Kněží na ostrově Craggy Island.", match: "matched" };
const file = { kind: "file", path: "Film.mkv", label: "Cesta za obzor a další dobrodružství na konci světa", size: 2e9, season: null, episode: null, modified: "2026-09-01", poster: poster("#936347"), favorite: true, year: "2024", description: "Film, který existuje jen pro testy.", match: "matched" };
const episode = { ...file, path: "Seriály/01/epizoda.mkv", label: "Dlouhý název epizody, který se musí vejít i na telefonu", season: 1, episode: 1, progress: { position: 120, duration: 2400 } };

test("library cards, favorites and folder navigation", async ({ page }, testInfo) => {
  await page.route("**/api/library/favorites?*", (route) => route.fulfill({ json: { path: ":favorites", items: [folder, file], total: 2, pending: false } }));
  await page.route("**/api/library/browse?*", (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") || "";
    return route.fulfill({ json: { path, items: path ? [episode] : [folder, file, { ...file, path: "other.mkv", label: "Film bez plakátu", poster: undefined, favorite: false, description: undefined, year: undefined }], total: path ? 1 : 3, pending: false } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await expect(page.locator(".favorites-collage img")).toHaveCount(2);
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
    const toolbar = (await page.locator(".browse-tools").boundingBox())!;
    expect(toolbar.height).toBeLessThanOrEqual(100);
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
  await expect(page.getByRole("button", { name: /Dlouhý název.*Pokračovat/ })).toBeVisible();
  await page.getByRole("button", { name: "O složku zpět" }).click();
  await page.locator(".library-favorites").click();
  await expect(page.locator(".crumbs")).toContainText("Oblíbené");
  await page.getByRole("button", { name: /Seriály.*Otevřít složku/ }).click();
  await page.getByRole("button", { name: "O složku zpět" }).click();
  await expect(page.locator(".crumbs button", { hasText: "Oblíbené" })).toBeDisabled();
  await page.getByRole("button", { name: "Zobrazit po řádcích" }).click();
  await expect(page.locator(".browse-rows .library-open")).toHaveCount(2);
  await page.waitForTimeout(1000);
  await expect(page.locator(".browse-rows .library-open")).toHaveCount(2);
  await expect.soft(page).toHaveScreenshot("library-list.png", { fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (testInfo.project.use.hasTouch) {
    const buttons = await page.locator(".browse-menu").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
    expect(buttons.every((height) => height >= 36)).toBe(true);
  }
});


test("empty favorites explain how to add titles", async ({ page }) => {
  await page.route("**/api/library/favorites?*", (route) => route.fulfill({ json: { path: ":favorites", items: [], total: 0, pending: false } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await page.locator(".library-favorites").click();
  await expect(page.getByText("Zatím žádné oblíbené", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "O složku zpět" }).click();
  await expect(page.locator(".library-favorites")).toBeVisible();
  await expect(page.locator(".crumbs")).not.toContainText("Oblíbené");
});

test("show all opens the complete resume collection", async ({ page }) => {
  const entries = Array.from({ length: 10 }, (_, index) => ({ ...file, path: `resume-${index}.mp4`, label: `Rozkoukaný film ${index}`, progress: { position: 120, duration: 2400 } }));
  await page.route("**/api/library/resume?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    const filtered = entries.filter((item) => item.label.includes(params.get("query") || ""));
    return route.fulfill({ json: { path: ":resume", items: filtered.slice(0, Number(params.get("limit") || 60)), total: filtered.length, pending: false } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await expect(page.locator(".resume-strip .browse-item")).toHaveCount(8);
  await page.getByRole("button", { name: "Zobrazit vše (10)" }).click();
  await expect(page.locator(".crumbs")).toContainText("Pokračovat ve sledování");
  await expect(page.locator(".browse-grid .library-open")).toHaveCount(10);
  await expect(page.locator(".browse-grid .library-action").first()).toHaveText("Pokračovat");
  await page.getByRole("textbox", { name: "Filtrovat knihovnu" }).fill("film 9");
  await expect(page.locator(".browse-grid .library-open")).toHaveCount(1);
  await page.getByRole("button", { name: "Zobrazit po řádcích" }).click();
  await expect(page.locator(".browse-rows .library-open")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("textbox", { name: "Filtrovat knihovnu" }).fill("nic takového");
  await expect(page.getByText("Nic neodpovídá filtru", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "O složku zpět" }).click();
  await expect(page.getByRole("button", { name: "Zobrazit vše (10)" })).toBeVisible();
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
