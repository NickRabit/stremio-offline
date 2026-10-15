import { expect, test } from "@playwright/test";

// The suite runs in Czech, which the first-run spec chose. Every test here has to
// hand that back: the layout projects take their baselines afterwards.
test.afterEach(async ({ page }) => {
  await page.request.patch("/api/settings", { data: { uiLanguage: "cs" } });
});

test.describe("language", () => {
  test("the first-run choice also seeds the preferred tracks", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Nastavení", exact: true }).click();

    await page.getByRole("tab", { name: "Domů", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Jazyk rozhraní" })).toHaveValue("cs");
    await page.getByRole("tab", { name: "Přehrávání", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Preferovaný jazyk zvuku" })).toHaveValue("cs");
    await expect(page.getByRole("combobox", { name: "Preferovaný jazyk titulků" })).toHaveValue("cs");
  });

  test("switching the language applies at once and survives a reload", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Nastavení", exact: true }).click();
    await page.getByRole("tab", { name: "Domů", exact: true }).click();
    await page.getByRole("combobox", { name: "Jazyk rozhraní" }).selectOption("en");

    // No reload in between: the whole shell redraws, sidebar included.
    await expect(page.getByRole("heading", { name: "Application settings" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Library", exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Home", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Interface language" })).toHaveValue("en");

    // The track preferences are a deliberate choice; a UI language switch leaves them alone.
    await page.getByRole("tab", { name: "Playback", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Preferred audio language" })).toHaveValue("cs");
  });

  test("a server message arrives in the chosen language", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Doplňky", exact: true }).click();
    await page.getByLabel("URL manifestu").fill("not-a-url");
    await page.getByRole("button", { name: "Přidat" }).click();
    await expect(page.locator(".toast.error")).toContainText("Neplatná URL.");
  });
});
