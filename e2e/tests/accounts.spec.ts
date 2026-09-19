import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

// Two accounts on one instance, both signed in at the same time: the administrator the setup
// project created, and the ordinary account this spec makes through the Users dialog. What the
// second one may reach is read back through the API, so the interface that hands a permission
// out and the answer the account gets are checked against each other.

const root = path.resolve("e2e/.tmp/accounts-root");
const admin = { name: "e2e-admin", password: "e2e-password" };
const guest = { name: "e2e-guest", password: "e2e-guest-password" };

/** Signs in through the form. A browser nobody has used before keeps the sign-in screen in
 *  its own language, so the fields are reached by what they are, not by the words above them. */
const signIn = async (page: Page, account: { name: string; password: string }) => {
  await page.goto("/");
  const form = page.locator("form.login-card");
  await form.locator('input[autocomplete="username"]').fill(account.name);
  await form.locator('input[autocomplete="current-password"]').fill(account.password);
  await form.locator("button.primary").click();
  await expect(page.locator("aside.sidebar nav")).toBeVisible();
};

const openUsers = async (page: Page) => {
  await page.getByRole("button", { name: "Nastavení", exact: true }).click();
  await expect(page.locator(".user-manager-section")).toBeVisible();
};

const accountRow = (page: Page, name: string) => page.locator(".user-admin-row", { hasText: name });
const libraryGrant = (name: string) => `${name} je pro tenhle účet viditelná`;
const addonGrant = (name: string) => `${name} je pro tenhle účet dostupný`;

const createLibrary = async (page: Page, name: string) => {
  const response = await page.request.post("/api/libraries", { data: { name, type: "mixed", root: path.join(root, name) } });
  expect(response.status(), "the library has to exist before it can be granted").toBe(201);
  return await response.json() as { id: string; name: string };
};

/** Leaves the instance as the spec found it. The rest of the run shares its state and the
 *  layout projects take the screenshot baselines afterwards. */
const cleanUp = async (page: Page) => {
  const libraries = await page.request.get("/api/libraries")
    .then((response) => response.json() as Promise<Array<{ id: string; root?: string }>>).catch(() => []);
  for (const library of libraries.filter((entry) => entry.root?.startsWith(root))) {
    await page.request.delete(`/api/libraries/${library.id}?forget=1`);
  }
  const users = await page.request.get("/api/users")
    .then((response) => response.json() as Promise<Array<{ id: string; username: string }>>).catch(() => []);
  for (const account of users.filter((entry) => entry.username === guest.name)) {
    await page.request.delete(`/api/users/${account.id}`);
  }
  await page.request.delete(`/api/libraries/grants?path=${encodeURIComponent(root)}`);
  await rm(root, { recursive: true, force: true });
};

test.describe("accounts", () => {
  test("one library of several is granted to a second account, and withdrawn again", async ({ page, browser }) => {
    let guestContext: BrowserContext | undefined;
    try {
      // The setup project seeded the administrator; signing in through the form is how a
      // person gets back to it.
      await page.context().clearCookies();
      await signIn(page, admin);

      // Two libraries in one granted root, so "one of several" is a choice with a wrong answer.
      await mkdir(path.join(root, "Granted"), { recursive: true });
      await mkdir(path.join(root, "Hidden"), { recursive: true });
      expect((await page.request.post("/api/libraries/grants", { data: { path: root } })).status()).toBe(201);
      const granted = await createLibrary(page, "Granted");
      const hidden = await createLibrary(page, "Hidden");

      // An ordinary account, made through the dialog an administrator actually uses.
      await openUsers(page);
      await page.getByRole("button", { name: "Přidat účet" }).click();
      const dialog = page.getByRole("dialog", { name: "Upravit účet" });
      await dialog.getByLabel("Uživatelské jméno").fill(guest.name);
      await dialog.getByLabel("Heslo").fill(guest.password);
      await dialog.getByRole("button", { name: "Založit účet" }).click();
      await expect(page.getByText("Účet vytvořen.")).toBeVisible();
      await dialog.getByRole("button", { name: "Zavřít" }).click();

      const row = accountRow(page, guest.name);
      await expect(row.locator(".user-admin-state")).toHaveText("Uživatel");
      await expect(row.locator(".library-admin-counts")).toHaveText("Knihovny: 0 · Doplňky: 0");
      // An administrator sees everything by role, so a count on that row would be a lie.
      await expect(accountRow(page, admin.name).locator(".library-admin-counts"))
        .toHaveText("Vidí všechny knihovny i doplňky podle role.");

      await row.getByRole("button", { name: "Upravit" }).click();
      const library = dialog.getByRole("checkbox", { name: libraryGrant(granted.name) });
      await library.click();
      await expect(library).toBeChecked();
      // The tick is what the administrator just did; the count is what the server says.
      await dialog.getByRole("button", { name: "Zavřít" }).click();
      await page.locator(".user-manager-section").getByRole("button", { name: "Obnovit" }).click();
      await expect(row.locator(".library-admin-counts")).toHaveText("Knihovny: 1 · Doplňky: 0");

      // The second session is live while the administrator keeps working. A context made here
      // inherits the project's stored session, so the empty state is spelled out: nobody else
      // may hold the administrator's cookie while this account signs in.
      guestContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      const guestPage = await guestContext.newPage();
      await signIn(guestPage, guest);
      // A brand-new account inherits no language and starts in the browser's, so it is pinned
      // the way the first run pins the administrator's, and read back in the suite's language.
      await guestContext.request.patch("/api/settings", { data: { uiLanguage: "cs" } });
      await guestPage.reload();

      // The whole section is gone for an ordinary account, not merely switched off.
      await guestPage.getByRole("button", { name: "Nastavení", exact: true }).click();
      await expect(guestPage.getByRole("heading", { name: "Nastavení aplikace" })).toBeVisible();
      await expect(guestPage.locator(".user-manager-section")).toHaveCount(0);
      await expect(guestPage.getByText("Uživatelé", { exact: true })).toHaveCount(0);

      const visible = await guestPage.request.get("/api/libraries")
        .then((response) => response.json() as Promise<Array<{ id: string }>>);
      expect(visible.map((entry) => entry.id), "the account sees the granted library and nothing else").toEqual([granted.id]);

      expect((await guestPage.request.get("/api/users")).status(), "an administrator-only route refuses an ordinary account").toBe(403);

      // A library nobody granted it is answered exactly like one that does not exist: the same
      // status and the same body, so the answer cannot tell the two apart.
      const ungranted = await guestPage.request.get(`/api/library/browse?path=${hidden.id}`);
      const missing = await guestPage.request.get("/api/library/browse?path=lib_00000000");
      expect(ungranted.status(), "the refusal is the answer a missing library gets").toBe(missing.status());
      expect(await ungranted.text(), "the refusal names which of the two it was").toBe(await missing.text());
      expect((await guestPage.request.get(`/api/library/browse?path=${granted.id}`)).status(), "the granted library is reachable").toBe(200);

      // Nothing has been granted to it yet, so there is no addon to see.
      expect(await guestPage.request.get("/api/addons").then((response) => response.json())).toEqual([]);

      // The addon goes the same way: the administrator ticks it, the account sees it.
      const [addon] = await page.request.get("/api/addons")
        .then((response) => response.json() as Promise<Array<{ manifest: { name: string } }>>);
      await row.getByRole("button", { name: "Upravit" }).click();
      const addonBox = dialog.getByRole("checkbox", { name: addonGrant(addon.manifest.name) });
      await addonBox.click();
      await expect(addonBox).toBeChecked();
      await dialog.getByRole("button", { name: "Zavřít" }).click();
      const seen = await guestPage.request.get("/api/addons")
        .then((response) => response.json() as Promise<Array<{ manifest: { name: string } }>>);
      expect(seen.map((entry) => entry.manifest.name)).toEqual([addon.manifest.name]);

      // Withdrawing the library reaches the account on its next read.
      await row.getByRole("button", { name: "Upravit" }).click();
      await library.click();
      await expect(library).not.toBeChecked();
      await dialog.getByRole("button", { name: "Zavřít" }).click();
      expect(await guestPage.request.get("/api/libraries").then((response) => response.json()),
        "the library is gone from the account's next read").toEqual([]);

      // The only enabled administrator cannot lock the instance out, and the dialog says why.
      await accountRow(page, admin.name).getByRole("button", { name: "Upravit" }).click();
      const own = page.getByRole("dialog", { name: "Upravit účet" });
      await expect(own.getByLabel("Role")).toBeDisabled();
      await expect(own.getByLabel("Zapnutý")).toBeDisabled();
      await expect(own.getByRole("button", { name: "Smazat účet" })).toBeDisabled();
      await expect(own.getByText(/jediný zapnutý administrátor/)).toBeVisible();
      await own.getByRole("button", { name: "Zavřít" }).click();
    } finally {
      // The instance goes back to the state it was found in even when an assertion failed, and
      // a failure while cleaning up must not hide the one that brought the run here.
      await cleanUp(page).catch(() => undefined);
      await guestContext?.close().catch(() => undefined);
    }
  });
});
