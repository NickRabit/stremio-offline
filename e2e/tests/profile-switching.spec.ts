import { expect, test, type Page } from "@playwright/test";

const admin = { username: "e2e-admin", password: "e2e-password" };
const alpha = { username: "psw-alpha", password: "alpha-password" };
const beta = { username: "psw-beta", password: "beta-password" };

const login = async (page: Page, account: { username: string; password: string }) => {
  const response = await page.request.post("/api/auth/login", {
    data: { username: account.username, password: account.password, remember: true },
  });
  expect(response.ok()).toBe(true);
};

const createAccount = async (page: Page, account: { username: string; password: string }) => {
  const response = await page.request.post("/api/users", {
    data: { username: account.username, password: account.password, role: "user" },
  });
  expect(response.status()).toBe(201);
  return await response.json() as { id: string };
};

const openProfiles = async (page: Page, mobile: boolean) => {
  if (mobile) {
    await page.locator(".nav-more").click();
    await page.getByRole("menuitem", { name: "Přepnout profil" }).click();
  } else {
    await page.locator(".profile-trigger").click();
  }
};

const openFavorites = async (page: Page, mobile: boolean) => {
  if (mobile) {
    await page.locator(".nav-more").click();
    await page.getByRole("menuitem", { name: "Oblíbené", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Oblíbené", exact: true }).click();
  }
};

const journey = async (page: Page, mobile: boolean) => {

  try {
    await login(page, admin);
    const alphaId = await createAccount(page, alpha);
    const betaId = await createAccount(page, beta);

    expect((await page.request.patch(`/api/users/${alphaId.id}/pin`, { data: { pin: "2468" } })).ok()).toBe(true);
    expect((await page.request.patch(`/api/users/${alphaId.id}`, {
      data: { switcher: true, unlock: "pin" },
    })).ok()).toBe(true);
    expect((await page.request.patch(`/api/users/${betaId.id}`, {
      data: { switcher: true },
    })).ok()).toBe(true);

    await login(page, alpha);
    expect((await page.request.post("/api/watchlist", {
      data: { type: "series", id: "tt-e2e-series", favorite: true },
    })).ok()).toBe(true);

    await login(page, beta);
    expect((await page.request.post("/api/watchlist", {
      data: { type: "movie", id: "tt-e2e-movie", favorite: true },
    })).ok()).toBe(true);
    await page.goto("/");
    await expect(page.locator("aside.sidebar nav")).toBeVisible();

    if (mobile) {
      await openProfiles(page, true);
      const profiles = page.getByRole("dialog", { name: "Přepnout profil" });
      await expect(profiles.locator(".profile-row.current")).toContainText(beta.username);
    } else {
      await expect(page.locator(".profile-trigger")).toContainText(beta.username);
      await page.locator(".profile-trigger").click();
    }

    const dialog = page.getByRole("dialog", { name: "Přepnout profil" });
    await dialog.getByRole("button", { name: /psw-alpha/ }).click();
    await dialog.getByLabel("PIN pro psw-alpha").fill("2468");
    await Promise.all([
      page.waitForNavigation(),
      dialog.getByRole("button", { name: "Přepnout", exact: true }).click(),
    ]);
    await expect(page.locator("aside.sidebar nav")).toBeVisible();

    if (mobile) {
      await openProfiles(page, true);
      const profiles = page.getByRole("dialog", { name: "Přepnout profil" });
      await expect(profiles.locator(".profile-row.current")).toContainText(alpha.username);
      await expect(profiles.locator(".profile-row.current")).not.toContainText(beta.username);
      await profiles.locator(".dialog-foot").getByRole("button", { name: "Zavřít" }).click();
    } else {
      await expect(page.locator(".profile-trigger")).toContainText(alpha.username);
      await expect(page.locator(".profile-trigger")).not.toContainText(beta.username);
    }

    await openFavorites(page, mobile);
    await expect(page.locator(".favorites-view")).toBeVisible();
    await expect(page.locator(".favorites-view")).toContainText("tt-e2e-series");
    await expect(page.locator(".favorites-view")).not.toContainText("tt-e2e-movie");
    const favorites = await page.request.get("/api/favorites")
      .then((response) => response.json() as Promise<{ total: number }>);
    expect(favorites.total, "the previous account's favourite did not follow the switch").toBe(1);
  } finally {
    await login(page, admin).catch(() => undefined);
    const users = await page.request.get("/api/users")
      .then((response) => response.json() as Promise<Array<{ id: string; username: string }>>)
      .catch(() => []);
    for (const account of users.filter((entry) => entry.username === alpha.username || entry.username === beta.username)) {
      await page.request.delete(`/api/users/${account.id}`).catch(() => undefined);
    }
  }
};

test("a PIN switch reloads into the other account's favourites", async ({ page }) => {
  await journey(page, false);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("a PIN switch from the More menu reloads into the other account's favourites", async ({ page }) => {
    await journey(page, true);
  });
});
