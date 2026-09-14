import { expect, test } from "@playwright/test";

// The stored manifest is what decides which catalogues are offered and which addons
// are asked for streams, so both the per-addon button and the one for the whole list
// have to reach the provider and report what came back.
test.describe("addons", () => {
  const openAddons = async (page: import("@playwright/test").Page) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Doplňky", exact: true }).click();
    await expect(page.getByRole("heading", { name: "E2E doplněk" })).toBeVisible();
  };

  test("one manifest can be refreshed by hand", async ({ page }) => {
    await openAddons(page);
    await page.getByRole("button", { name: "Obnovit manifest", exact: true }).click();
    await expect(page.getByText("Doplněk E2E doplněk je aktuální.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "E2E doplněk" })).toBeVisible();
  });

  test("the whole list can be refreshed at once", async ({ page }) => {
    await openAddons(page);
    await page.getByRole("button", { name: "Obnovit manifesty", exact: true }).click();
    await expect(page.getByText("Všechny manifesty jsou aktuální.")).toBeVisible();
  });

  test("the refresh interval is a setting and survives a reload", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Nastavení", exact: true }).click();

    const interval = page.getByRole("combobox", { name: "Jak často se obnovují manifesty" });
    await interval.selectOption("0");
    await expect(page.getByText("Nastavení uloženo.")).toBeVisible();

    await page.reload();
    await page.getByRole("button", { name: "Nastavení", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Jak často se obnovují manifesty" })).toHaveValue("0");

    await page.getByRole("combobox", { name: "Jak často se obnovují manifesty" }).selectOption("24");
  });

  test("a save rule names the library it goes to", async ({ page }) => {
    await openAddons(page);
    await page.getByRole("button", { name: "Pravidla ukládání", exact: true }).click();
    const card = page.locator(".addon-card", { has: page.getByRole("heading", { name: "E2E doplněk" }) });

    // One library is configured, so its name is the default and the preview spells out the
    // real root instead of the /downloads the form used to hardcode for every install.
    const movies = card.getByRole("combobox", { name: "Filmy – knihovna" });
    await expect(movies.locator("option").first()).toHaveText("Výchozí · downloads");
    const [library] = await (await page.request.get("/api/libraries")).json();
    await expect(card.locator(".download-rule").first()).toContainText(library.root);
  });
});
