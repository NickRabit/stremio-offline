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
      if (dialog.open === "Upravit doplněk") {
        await page.route("**/api/addons", async (route) => {
          const response = await route.fetch();
          const addons = await response.json();
          const [first, ...rest] = addons;
          return route.fulfill({ response, json: [
            { ...first, essential: false, manifest: { ...first.manifest, id: "e2e.removable" } },
            ...rest,
          ] });
        });
      }
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

  // The Users dialog holds four blocks -- the account, the libraries it may see, the addons it
  // may use and what it may download -- one pane at a time. The grants are stubbed: what is
  // checked here is how a long list behaves, and its length is the point rather than which
  // library somebody was given.
  test("the users dialog fits the screen and scrolls in one place only", async ({ page }, testInfo) => {
    const grantee = {
      id: "user-1", username: "příjemce", role: "user", disabled: false, mustChangePassword: false,
      createdAt: "2026-01-01T00:00:00.000Z", permissions: { downloadToLibrary: false, downloadToDevice: true },
      libraries: 0, addons: 0,
    };
    const libraries = Array.from({ length: 16 }, (_, index) => ({
      id: `lib_${(index + 1).toString(16).padStart(8, "0")}`, name: `Knihovna ${index + 1}`, type: "mixed",
      root: `/library/${index + 1}`, enabled: true, order: index, addedAt: "2026-01-01T00:00:00.000Z",
      writeArtwork: false, unreachable: false, readOnly: false, defaultMovie: false, defaultSeries: false,
      titles: 0, files: 0, bytes: 0,
    }));
    // Enough that the list must overflow even on the roomiest viewport: the point of the
    // check is what a list too long for its pane does, and sixteen now fit on a desktop.
    const addons = Array.from({ length: 60 }, (_, index) => ({
      key: `addon-${index}`, role: "both", enabled: true, globalSearch: false,
      manifest: { id: `e2e.addon.${index}`, name: `Doplněk ${index + 1}`, version: "1.0.0" },
    }));
    await page.route("**/api/users", (route) => route.fulfill({ json: [grantee] }));
    await page.route("**/api/libraries", (route) => route.fulfill({ json: libraries }));
    await page.route("**/api/addons", (route) => route.fulfill({ json: addons }));

    await openView(page, "Nastavení");
    const edit = page.locator(".user-manager-section").getByRole("button", { name: "Upravit", exact: true });
    await expect(edit).toBeVisible();
    await edit.click();
    const dialog = page.getByRole("dialog", { name: "Upravit účet" });
    await expect(dialog).toBeVisible();

    const card = dialog.locator(".identify-card");
    const viewport = page.viewportSize()!;
    const body = dialog.locator(".dialog-body");

    for (const pane of ["Účet", "Knihovny", "Doplňky", "Stahování"]) {
      await dialog.getByRole("tab", { name: new RegExp(`^${pane}`) }).click();
      const box = (await card.boundingBox())!;
      expect(box.y, `${testInfo.project.name}: the ${pane} pane starts above the screen`).toBeGreaterThanOrEqual(-1);
      expect(box.y + box.height, `${testInfo.project.name}: the ${pane} pane reaches past the fold`)
        .toBeLessThanOrEqual(viewport.height + 1);

      const { scrollWidth, clientWidth, offenders } = await horizontalOverflow(page);
      expect(offenders, `elements past the right edge on the ${pane} pane`).toEqual([]);
      expect(scrollWidth, `the ${pane} pane overflows horizontally`).toBeLessThanOrEqual(clientWidth + 1);

      // One scroller, never two. A pane holding a grant list gives the scrolling to the list,
      // so the body around it must not scroll as well -- that pairing is what used to give the
      // same gesture two meanings. A plain form has no list, and a phone held sideways is
      // shorter than the account form is tall, so there the body is the one scroller and
      // scrolling it is correct.
      const hidden = await body.evaluate((element) => element.scrollHeight - element.clientHeight);
      if (await dialog.locator(".user-grant-list").count()) {
        expect(hidden, `${testInfo.project.name}: the ${pane} pane scrolls the whole dialog as well as its list`)
          .toBeLessThanOrEqual(1);
      }
    }

    // A list longer than the room it has scrolls where the eye already is, and moves nothing else.
    await dialog.getByRole("tab", { name: /^Doplňky/ }).click();
    const list = dialog.locator(".user-grant-list");
    await expect(list).toHaveCount(1);
    const before = (await card.boundingBox())!;
    const measured = await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return { scrolled: element.scrollTop, hidden: element.scrollHeight - element.clientHeight, overflow: getComputedStyle(element).overflowY };
    });
    expect(measured.hidden, "the addons fit, so this checked nothing").toBeGreaterThan(0);
    expect(measured.scrolled, "the list does not scroll inside itself").toBeGreaterThan(0);
    expect(measured.overflow).toBe("auto");
    expect(Math.abs((await card.boundingBox())!.y - before.y), "scrolling the list moved the dialog").toBeLessThan(1);

    // The file's touch rule, applied to this dialog: a tick is painted over by the label a
    // finger actually hits, so the label is the box that has to be big enough.
    if (testInfo.project.use.hasTouch) {
      const tooSmall = await dialog.evaluate((element) => {
        const minimum = 24;
        return [...element.querySelectorAll<HTMLElement>("button, input, select")]
          .map((control) => control.closest<HTMLElement>("label") ?? control)
          .map((target) => ({ target, box: target.getBoundingClientRect() }))
          .filter(({ box }) => box.width > 0 && box.height > 0 && (box.width < minimum || box.height < minimum))
          .map(({ target, box }) => `${target.tagName} "${target.textContent?.trim().slice(0, 20)}": ${Math.round(box.width)}x${Math.round(box.height)}`);
      });
      expect(tooSmall, "controls below the 24px minimum in the users dialog").toEqual([]);
    }
  });
});
