import { expect, test } from "@playwright/test";

test.describe("auth", () => {
  test("a request without a session is refused, not answered", async ({ request }) => {
    // A fresh context carries no cookie, unlike the pages in the other specs.
    const response = await request.get("/api/addons", { headers: { cookie: "" } });
    expect(response.status()).toBe(401);
  });

  test("the status endpoint stays open, so a health check needs no account", async ({ request }) => {
    const response = await request.get("/api/status");
    expect(response.ok()).toBeTruthy();
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  test("a wrong password is rejected", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/");

    const form = page.locator("form.login-card");
    await form.getByLabel("Uživatelské jméno").fill("e2e-admin");
    await form.getByLabel("Heslo", { exact: true }).fill("wrong-password");
    await form.getByRole("button", { name: "Přihlásit se" }).click();

    await expect(page.locator(".login-error")).toContainText("Nesprávné jméno nebo heslo.");
  });

  test("the right password gets in", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/");

    const form = page.locator("form.login-card");
    await form.getByLabel("Uživatelské jméno").fill("e2e-admin");
    await form.getByLabel("Heslo", { exact: true }).fill("e2e-password");
    await form.getByRole("button", { name: "Přihlásit se" }).click();

    // Short screens hide the catalog heading, so look for the catalog itself.
    await expect(page.getByRole("combobox", { name: "Procházet katalog" })).toBeVisible();
  });
});
