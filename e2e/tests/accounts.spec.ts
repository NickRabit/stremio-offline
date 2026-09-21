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

      // Everything switched on is offered ticked, so an account is usable the moment it
      // exists rather than blind until somebody remembers to grant it something. The ticks
      // are shown and can be cleared, which is what this spec does: its story needs one
      // library of several and an account with no addon yet, so it starts from nothing and
      // the grants below are what move the counts.
      // Only the grant lists: the download switches are checkboxes too, and theirs is covered
      // by the track that is drawn over it.
      // The grants are a pane each now, and leaving a pane detaches its boxes -- so each one is
      // read and cleared while it is the open one.
      let offeredTicks = 0;
      for (const pane of ["Knihovny", "Doplňky"]) {
        await dialog.getByRole("tab", { name: new RegExp(`^${pane}`) }).click();
        const boxes = await dialog.locator(".user-grant-list").getByRole("checkbox").all();
        expect(boxes.length, `the ${pane} pane offered nothing to clear`).toBeGreaterThan(0);
        for (const box of boxes) {
          if (await box.isChecked()) { offeredTicks += 1; await box.click(); }
          await expect(box).not.toBeChecked();
        }
      }
      expect(offeredTicks, "nothing was offered for a new account").toBeGreaterThan(0);
      await dialog.getByRole("tab", { name: /^Účet/ }).click();

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
      await dialog.getByRole("tab", { name: /^Knihovny/ }).click();
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
      // A new account is seeded with the language of the administrator who made it. Pinning it
      // here anyway keeps the spec independent of what the setup project chose.
      await guestContext.request.patch("/api/settings", { data: { uiLanguage: "cs" } });
      await guestPage.reload();

      // The whole section is gone for an ordinary account, not merely switched off.
      await guestPage.getByRole("button", { name: "Nastavení", exact: true }).click();
      await expect(guestPage.getByRole("heading", { name: "Nastavení aplikace" })).toBeVisible();
      await expect(guestPage.locator(".user-manager-section")).toHaveCount(0);
      await expect(guestPage.getByText("Uživatelé", { exact: true })).toHaveCount(0);

      // The rest of the audience split, pinned by what is on the page rather than by a count:
      // an ordinary account keeps the settings that are its own, and the panels that configure
      // the instance are absent, not merely disabled. A disabled control still tells the account
      // what the instance runs, and the two credential panels would name the providers.
      // The panel head is a `strong`, not a heading, so the title is matched as exact text.
      const panel = (title: string) => guestPage.locator(`.settings-section .settings-section-head strong:text-is("${title}")`);
      for (const instanceOnly of ["Knihovny", "Úložiště", "Doplňky", "Metadata z TMDB", "Real-Debrid", "Soukromí", "Záloha konfigurace", "Diagnostika"]) {
        await expect(panel(instanceOnly), `${instanceOnly} configures the instance, so an ordinary account is not shown it`).toHaveCount(0);
      }
      for (const own of ["Knihovna", "Stahování", "Přehrávání", "Vzhled", "Přihlášení"]) {
        await expect(panel(own), `${own} is the account's own setting and stays`).toHaveCount(1);
      }
      // An instance-wide control inside a panel the account does keep goes with it.
      await expect(guestPage.getByLabel("Automatické dohledání metadat")).toHaveCount(0);
      await expect(guestPage.getByLabel("Souběžná stahování")).toHaveCount(0);

      const visible = await guestPage.request.get("/api/libraries")
        .then((response) => response.json() as Promise<Array<{ id: string; root?: string }>>);
      expect(visible.map((entry) => entry.id), "the account sees the granted library and nothing else").toEqual([granted.id]);
      // Hiding the instance panels is the interface agreeing with the server; these two ask the
      // server directly, which is the only place the split actually holds.
      expect(visible.map((entry) => entry.root), "a granted library is named, never placed on the host").toEqual([undefined]);
      const asAdmin = await page.request.get("/api/libraries")
        .then((response) => response.json() as Promise<Array<{ id: string; root?: string }>>);
      expect(asAdmin.every((entry) => typeof entry.root === "string"), "an administrator still reads the roots").toBe(true);

      // Every key of the instance half, spelled out rather than counted: a response that grew
      // one back would pass a count. The list below leaves out `secureMode` and
      // `realDebridConfigured` on purpose -- the interface drops torrent sources without the
      // one and frames a trailer the wrong way without the other, so an account that is not
      // told them behaves wrongly. The assertion after it holds them to being there.
      const ownSettings = await guestPage.request.get("/api/settings")
        .then((response) => response.json() as Promise<Record<string, unknown>>);
      for (const instanceOnly of ["concurrentDownloads", "parallelPerProvider", "downloadSegments",
        "libraryAutoScan", "libraryScanPauseOnDownload", "logLevel", "addonRefreshHours",
        "defaultMovieLibrary", "defaultSeriesLibrary", "tmdbConfigured", "realDebridToken", "tmdbApiKey"]) {
        expect(Object.keys(ownSettings), `${instanceOnly} says what the instance runs`).not.toContain(instanceOnly);
      }
      expect(ownSettings.uiLanguage, "its own half arrives whole").toBe("cs");
      expect(Object.keys(ownSettings), "what the ordinary interface behaves on stays").toEqual(
        expect.arrayContaining(["secureMode", "realDebridConfigured", "streamSort", "libraryTileSize"]));
      // The export is administrator-only for a reason: it carries the raw tokens.
      expect((await guestPage.request.get("/api/settings/export")).status(),
        "the one settings route that hands out the tokens stays shut").toBe(403);

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
      await dialog.getByRole("tab", { name: /^Doplňky/ }).click();
      const addonBox = dialog.getByRole("checkbox", { name: addonGrant(addon.manifest.name) });
      await addonBox.click();
      await expect(addonBox).toBeChecked();
      await dialog.getByRole("button", { name: "Zavřít" }).click();
      const seen = await guestPage.request.get("/api/addons")
        .then((response) => response.json() as Promise<Array<{ manifest: { name: string } }>>);
      expect(seen.map((entry) => entry.manifest.name)).toEqual([addon.manifest.name]);

      // Withdrawing the library reaches the account on its next read.
      await row.getByRole("button", { name: "Upravit" }).click();
      await dialog.getByRole("tab", { name: /^Knihovny/ }).click();
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

      // Promoting the account puts its grants to sleep instead of burning them: the role
      // grants everything, so the entry grants nothing while it sits there, and a demotion
      // gets it back. What used to be the reason for sweeping still has to hold -- the very
      // next edit of that addon must go through, although the dashboard cannot name the id.
      await row.getByRole("button", { name: "Upravit" }).click();
      await dialog.getByRole("tab", { name: /^Doplňky/ }).click();
      // Granted further up and never withdrawn, so it is read rather than clicked: clicking
      // it here took the grant away and then asserted it was there.
      await expect(addonBox).toBeChecked();
      await dialog.getByRole("tab", { name: /^Účet/ }).click();
      await dialog.getByLabel("Role").selectOption("admin");
      await expect(dialog.getByText("Vidí všechny knihovny i doplňky podle role.").first()).toBeVisible();
      await dialog.getByRole("button", { name: "Zavřít" }).click();

      const guestId = await page.request.get("/api/users")
        .then((response) => response.json() as Promise<Array<{ id: string; username: string }>>)
        .then((rows) => rows.find((entry) => entry.username === guest.name)!.id);
      const dormant = await page.request.get("/api/addons")
        .then((response) => response.json() as Promise<Array<{ key: string; allowedUsers?: string[] }>>)
        .then((rows) => rows.find((entry) => (entry.allowedUsers ?? []).includes(guestId)));
      expect(dormant, "the grant is still on the addon after the promotion").toBeTruthy();

      // What the dashboard sends: the ordinary accounts only, because the grant pane is
      // hidden for an administrator. The dormant id is the addon's to keep.
      const saved = await page.request.patch(`/api/addons/${dormant!.key}`,
        { data: { allowedUsers: (dormant!.allowedUsers ?? []).filter((id) => id !== guestId) } });
      expect(saved.status(), "the addon can still be saved after a promotion").toBe(200);
      expect(await saved.json().then((body: { allowedUsers?: string[] }) => body.allowedUsers ?? []),
        "and the edit leaves the dormant grant where it was").toContain(guestId);

      // And back down: the panes return with the ticks the account had, so nothing has to be
      // rebuilt by hand.
      await row.getByRole("button", { name: "Upravit" }).click();
      await dialog.getByLabel("Role").selectOption("user");
      await dialog.getByRole("tab", { name: /^Doplňky/ }).click();
      await expect(addonBox, "the grant came back with the role").toBeChecked();
      await dialog.getByRole("button", { name: "Zavřít" }).click();
    } finally {
      // The instance goes back to the state it was found in even when an assertion failed, and
      // a failure while cleaning up must not hide the one that brought the run here.
      await cleanUp(page).catch(() => undefined);
      await guestContext?.close().catch(() => undefined);
    }
  });
});
