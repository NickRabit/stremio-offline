import { expect, test } from "@playwright/test";
import { addonManifest } from "../../playwright.config";

// Runs before every other spec and leaves behind the session the rest reuse.
// It is a real journey, not scaffolding: a fresh server shows the account form
// and has no addons until one is added by hand. It also pins the language the
// rest of the suite -- and every screenshot baseline -- is written against.
test("first run: pick a language, create the account and install an addon", async ({ page }) => {
  await page.goto("/");

  const form = page.locator("form.login-card");
  // A fresh install with no stored language follows the browser, which Playwright
  // runs in English, so the first screen anyone sees is English.
  await expect(form).toContainText("No account exists yet");

  const language = form.getByLabel("Language");
  await expect(language).toHaveValue("en");
  await language.selectOption("cs");
  await expect(form).toContainText("Zatím tu není žádný účet");

  await form.getByLabel("Uživatelské jméno").fill("e2e-admin");
  await form.getByLabel("Heslo", { exact: true }).fill("e2e-password");
  await form.getByLabel("Heslo znovu").fill("e2e-password");
  await form.getByRole("button", { name: "Založit účet" }).click();

  await expect(page.getByRole("heading", { name: "Co chcete sledovat?" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Přidejte první Stremio doplněk" })).toBeVisible();

  await page.getByRole("button", { name: "Doplňky", exact: true }).click();
  await page.getByLabel("URL manifestu").fill(addonManifest);
  await page.getByRole("button", { name: "Přidat" }).click();

  await expect(page.getByText("Manifest byl přidán.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "E2E doplněk" })).toBeVisible();

  // With a catalogue in place, an account that never chose a start page opens on Home.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Domů", exact: true })).toBeVisible();
  // The rest of the suite is written from the catalogue, so this account starts there.
  expect((await page.request.patch("/api/settings", { data: { startView: "catalog" } })).ok()).toBe(true);
  await page.reload();
  await expect(page.getByPlaceholder(/Hledat ve všech doplňcích/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Domů", exact: true })).toHaveCount(0);

  await page.context().storageState({ path: "e2e/.tmp/session.json" });
});
