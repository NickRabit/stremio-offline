import { expect, test, type Page } from "@playwright/test";

const admin = { username: "e2e-admin", password: "e2e-password" };
const adult = { username: "kids-adult", password: "adult-password" };
const child = { username: "kids-child", password: "child-password" };
const pin = "2468";

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

const openSwitcher = async (page: Page) => {
  const direct = page.locator("aside.sidebar").getByRole("button", { name: "Přepnout profil", exact: true });
  if (await direct.isVisible()) await direct.click();
  else await page.locator(".profile-trigger").click();
};

const cleanup = async (page: Page) => {
  await login(page, admin).catch(() => undefined);
  const users = await page.request.get("/api/users")
    .then((response) => response.json() as Promise<Array<{ id: string; username: string }>>)
    .catch(() => []);
  for (const account of users.filter((entry) => entry.username === adult.username || entry.username === child.username)) {
    await page.request.delete(`/api/users/${account.id}`).catch(() => undefined);
  }
};

const journey = async (page: Page, mobile: boolean) => {
  try {
    await login(page, admin);
    const adultAccount = await createAccount(page, adult);
    const childAccount = await createAccount(page, child);

    expect((await page.request.patch(`/api/users/${adultAccount.id}/pin`, { data: { pin } })).ok()).toBe(true);
    expect((await page.request.patch(`/api/users/${adultAccount.id}`, {
      data: { switcher: true, unlock: "pin" },
    })).ok()).toBe(true);
    expect((await page.request.patch(`/api/users/${childAccount.id}`, {
      data: { child: true, switcher: true, unlock: "none" },
    })).ok()).toBe(true);

    const refusals: string[] = [];
    page.on("response", (response) => {
      if (response.status() === 403) refusals.push(`${response.request().method()} ${response.url()}`);
    });

    await login(page, child);
    await page.goto("/");
    await expect(page.locator("aside.sidebar.sidebar-child")).toBeVisible();
    const navigation = page.locator("aside.sidebar nav");
    await expect(navigation.getByRole("button")).toHaveCount(3);
    expect(await navigation.getByRole("button").allTextContents()).toEqual(["Domů", "Knihovna", "Přepnout profil"]);
    await expect(page.getByRole("button", { name: "Více", exact: true })).toHaveCount(0);

    await navigation.getByRole("button", { name: "Knihovna", exact: true }).click();
    await expect(page.locator("main.view-library")).toBeVisible();

    await openSwitcher(page);
    const switcher = page.getByRole("dialog", { name: "Přepnout profil" });
    await expect(switcher.locator(".profile-row")).toHaveCount(2);
    await expect(switcher.locator(".profile-row.current")).toContainText(child.username);
    await expect(switcher.getByRole("button", { name: new RegExp(adult.username) })).toBeVisible();
    await expect(switcher.getByRole("button", { name: new RegExp(child.username) })).toHaveCount(0);

    await switcher.getByRole("button", { name: new RegExp(adult.username) }).click();
    await switcher.getByLabel(`PIN pro ${adult.username}`).fill(pin);
    await Promise.all([
      page.waitForNavigation(),
      switcher.getByRole("button", { name: "Přepnout", exact: true }).click(),
    ]);

    await expect(page.locator("aside.sidebar")).toBeVisible();
    await expect(page.locator("aside.sidebar")).not.toHaveClass(/sidebar-child/);
    if (mobile) {
      await expect(page.locator(".nav-more")).toBeVisible();
    } else {
      await expect(page.locator("aside.sidebar").getByRole("button", { name: "Nastavení", exact: true })).toBeVisible();
      await expect(page.locator(".profile-trigger")).toContainText(adult.username);
    }
    expect(refusals, `child session made refused requests:\n${refusals.join("\n")}`).toEqual([]);
  } finally {
    await cleanup(page);
  }
};

test("a child sees the small app and leaves through the adult's PIN", async ({ page }) => {
  await journey(page, false);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the compact child bar has no More and still switches to the adult", async ({ page }) => {
    await journey(page, true);
  });
});
