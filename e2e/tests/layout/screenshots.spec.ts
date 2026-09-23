import { expect, test, type Page } from "@playwright/test";

// Baselines catch what the invariants cannot measure: spacing, overlap, truncation,
// a control that quietly moved. They are kept to four screens on purpose -- every
// extra one is a file to regenerate whenever the design legitimately changes.
//
// The images are only comparable when they are produced in one place, so they are
// always generated inside the Playwright container. See docs/testing.md.

const settle = async (page: Page) => {
  // Posters come from the fixture addon; a half-loaded image would differ per run.
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => Promise.all(
    [...document.images].filter((image) => !image.complete).map((image) => new Promise((done) => {
      image.addEventListener("load", done, { once: true });
      image.addEventListener("error", done, { once: true });
    })),
  ));
};

const openView = async (page: Page, name: string) => {
  await page.goto("/");
  await page.getByRole("button", { name, exact: true }).click();
  await settle(page);
};

const openCatalog = async (page: Page, pattern: RegExp) => {
  await openView(page, "Katalog");
  const select = page.getByRole("combobox", { name: "Procházet katalog" });
  const labels = await select.locator("option").allTextContents();
  await select.selectOption({ label: labels.find((text) => pattern.test(text))! });
  await settle(page);
};

test.describe("screenshots", () => {
  test.beforeEach(({}, testInfo) => {
    // These four screens look the same at 1280x760 as at 1440x900. The project
    // earns its place through the invariants, which check the 780px height rule;
    // duplicating a megabyte of near-identical baselines for it does not.
    test.skip(testInfo.project.name === "desktop-short", "covered by the desktop baselines");
  });

  test("catalog", async ({ page }) => {
    await openCatalog(page, /Filmy/);
    await expect(page.getByRole("button", { name: /Zkušební film/ })).toBeVisible();
    await expect(page).toHaveScreenshot("catalog.png", { fullPage: true });
  });

  test("title detail with sources", async ({ page }) => {
    await openCatalog(page, /Filmy/);
    await page.getByRole("button", { name: /Zkušební film/ }).click();

    const detail = page.locator(".detail-panel");
    await expect(detail.getByRole("heading", { name: "Zdroje" })).toBeVisible();
    await settle(page);

    await expect(page).toHaveScreenshot("title-detail.png", {
      fullPage: true,
      // Track probing needs ffprobe, which the container does not carry, so this
      // line reads differently depending on the machine.
      mask: [detail.locator(".source-info")],
    });
  });

  test("library", async ({ page }) => {
    await page.route("**/api/library/browse?*", async (route) => {
      const response = await route.fetch();
      const result = await response.json();
      const names = new Set(["Zkušební film", "Zkušební film (2024)", "Zkušební seriál"]);
      const items = result.items.filter((item: { name?: string; label?: string }) => names.has(item.name ?? item.label ?? ""));
      return route.fulfill({ response, json: { ...result, items, total: items.length } });
    });
    await openView(page, "Knihovna");
    // The page heading is the one part of this header a phone does not show, so the trail is
    // what says the listing has arrived at every width.
    await expect(page.locator(".browse-head .crumbs")).toBeVisible();
    await expect(page).toHaveScreenshot("library.png", { fullPage: true });
  });

  test("settings", async ({ page }) => {
    await page.route("**/api/libraries", async (route) => {
      const response = await route.fetch();
      const libraries = await response.json();
      return route.fulfill({ response, json: libraries.map((library: Record<string, unknown>) => ({
        ...library, titles: 3, files: 4, bytes: 15 * 1024,
      })) });
    });
    await openView(page, "Nastavení");
    await expect(page.getByRole("combobox", { name: "Velikost položek katalogu" })).toBeVisible();
    // The report count is different on every run, and at the narrow viewports its width
    // decides whether the header wraps. The section is masked anyway, so drop the chip and
    // let the baseline measure the header, not the noise.
    await page.locator(".diagnostics-toggle .state-chip").evaluateAll((chips) => chips.forEach((chip) => chip.remove()));
    // Every path on this page is the checkout directory -- /work from the local mount,
    // /__w/<repo>/<repo> on a runner -- and the longer one wraps to a second line, which makes
    // the whole page two pixels taller. A mask does not help: it is drawn over the element's
    // own box, so it changes size along with the text. The baseline gets a fixed path instead.
    await page.locator(".library-admin-root, .storage-path code").evaluateAll((paths) => paths.forEach((path) => { path.textContent = "/library"; }));
    await expect(page).toHaveScreenshot("settings.png", {
      fullPage: true,
      // Version, uptime and free disk space are different on every run.
      mask: [page.locator(".diagnostics-section"), page.locator(".storage-path")],
    });
  });
});
