import { expect, test, type Page } from "@playwright/test";

// Assertions that hold in every viewport, checked without stored baselines. They
// catch the class of bug this project keeps shipping -- content escaping the
// screen sideways, controls too small to hit, the wrong navigation for the size --
// and unlike screenshots they never need refreshing.

const VIEWS = ["Katalog", "Knihovna", "Stahování", "Doplňky", "Nastavení", "Statistiky"] as const;

const openView = async (page: Page, name: string) => {
  await page.goto("/");
  await page.getByRole("button", { name, exact: true }).click();
  // The bottom bar animates in on small screens; a settled frame keeps the
  // measurements below honest.
  await page.waitForTimeout(150);
};

const horizontalOverflow = (page: Page) => page.evaluate(() => {
  const root = document.documentElement;
  // A pane that scrolls sideways on purpose -- the download table, a poster
  // strip -- is allowed to hold content wider than the screen. Only content
  // that escapes the page itself is a defect.
  const insideScroller = (element: HTMLElement) => {
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const overflow = getComputedStyle(parent).overflowX;
      if (overflow === "auto" || overflow === "scroll") return true;
    }
    return false;
  };

  const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
    .filter((element) => {
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height) return false;
      if (getComputedStyle(element).position === "fixed") return false;
      if (insideScroller(element)) return false;
      return box.right > root.clientWidth + 1 || box.left < -1;
    })
    .slice(0, 5)
    .map((element) => `${element.tagName.toLowerCase()}.${element.className || "(no class)"}`);
  return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, offenders };
});

test.describe("layout invariants", () => {
  for (const view of VIEWS) {
    test(`${view} does not scroll sideways`, async ({ page }) => {
      await openView(page, view);
      const { scrollWidth, clientWidth, offenders } = await horizontalOverflow(page);
      expect(offenders, `elements past the right edge in ${view}`).toEqual([]);
      expect(scrollWidth, `${view} overflows horizontally`).toBeLessThanOrEqual(clientWidth + 1);
    });
  }

  test("navigation follows the 700px breakpoint", async ({ page }, testInfo) => {
    await openView(page, "Katalog");
    const width = page.viewportSize()!.width;
    const sidebar = page.locator("aside.sidebar");
    await expect(sidebar).toBeVisible();

    const box = (await sidebar.boundingBox())!;
    const viewport = page.viewportSize()!;
    if (width <= 700) {
      // Below the breakpoint the sidebar becomes a bar pinned to the bottom.
      expect(box.y + box.height, `${testInfo.project.name}: bottom bar is not at the bottom`)
        .toBeGreaterThan(viewport.height - box.height - 1);
      expect(box.width).toBeGreaterThan(viewport.width * 0.9);
    } else {
      expect(box.height, `${testInfo.project.name}: sidebar is not full height`)
        .toBeGreaterThan(viewport.height * 0.5);
      expect(box.width).toBeLessThan(viewport.width * 0.35);
    }
  });

  test("navigation stays reachable without scrolling", async ({ page }) => {
    await openView(page, "Katalog");
    const viewport = page.viewportSize()!;
    for (const view of VIEWS) {
      const box = (await page.getByRole("button", { name: view, exact: true }).boundingBox())!;
      expect(box, `${view} has no box`).toBeTruthy();
      expect(box.x, `${view} sits off the left edge`).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width, `${view} sits off the right edge`).toBeLessThanOrEqual(viewport.width + 1);
      expect(box.y + box.height, `${view} sits below the fold`).toBeLessThanOrEqual(viewport.height + 1);
    }
  });

  test("touch targets meet the minimum size", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, "only applies to touch devices");
    await openView(page, "Katalog");

    // WCAG 2.2 AA (2.5.8) asks for 24px. Anything roomier is a design choice and
    // is deliberately not enforced here.
    const tooSmall = await page.evaluate(() => {
      const minimum = 24;
      return [...document.querySelectorAll<HTMLElement>("nav button, .searchbar button, .filterbar select")]
        .map((element) => ({ element, box: element.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 0 && box.height > 0 && (box.width < minimum || box.height < minimum))
        .map(({ element, box }) => `${element.textContent?.trim().slice(0, 20) || element.tagName}: ${Math.round(box.width)}x${Math.round(box.height)}`);
    });

    expect(tooSmall, "controls below the 24px minimum on a touch screen").toEqual([]);
  });

  // Both dialogs keep their removal buttons behind a disclosure whose buttons do not
  // wrap, so a container narrower than they are pushes them straight off the card.
  // It guards the width, not the clipping that a scrolling dialog body can also cause:
  // that one depends on how tall the dialog's content happens to be.
  for (const dialog of [
    { view: "Nastavení", open: "Upravit knihovnu", card: ".library-edit-card" },
    { view: "Doplňky", open: "Upravit doplněk", card: ".addon-edit-card" },
  ] as const) {
    test(`removal options stay inside the ${dialog.open} dialog`, async ({ page }) => {
      await openView(page, dialog.view);
      await page.getByRole("button", { name: dialog.open }).first().click();
      const card = page.locator(dialog.card);
      await expect(card).toBeVisible();

      const disclosure = card.locator(".library-admin-danger");
      // The summary is styled `display:inline-flex`, which costs it the implicit button
      // role, so it is reached as the element it is rather than by role.
      await disclosure.locator("summary").click();
      const options = disclosure.locator("> div");
      await expect(options).toBeVisible();
      await options.scrollIntoViewIfNeeded();

      const [inner, outer] = await Promise.all([options.boundingBox(), card.boundingBox()]);
      expect(inner!.x, "the options hang off the left of the dialog").toBeGreaterThanOrEqual(outer!.x - 1);
      expect(inner!.x + inner!.width, "the options hang off the right of the dialog").toBeLessThanOrEqual(outer!.x + outer!.width + 1);
      expect(inner!.y + inner!.height, "the options hang below the dialog").toBeLessThanOrEqual(outer!.y + outer!.height + 1);
    });
  }

  test("the poster grid fits whole columns", async ({ page }) => {
    await openView(page, "Katalog");
    const grid = page.locator(".poster-grid");
    await expect(grid).toBeVisible();

    const { gridWidth, widest } = await grid.evaluate((element) => ({
      gridWidth: element.getBoundingClientRect().width,
      widest: Math.max(0, ...[...element.children].map((child) => child.getBoundingClientRect().right - element.getBoundingClientRect().left)),
    }));
    expect(widest, "a poster hangs past the edge of its grid").toBeLessThanOrEqual(gridWidth + 1);
  });
});
