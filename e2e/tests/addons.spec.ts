import { expect, test } from "@playwright/test";

// The stored manifest is what decides which catalogues are offered and which addons
// are asked for streams, so both the per-addon button and the one for the whole list
// have to reach the provider and report what came back. The settings behind them live
// in one dialog, so opening it and saving once has to carry the whole draft.
test.describe("addons", () => {
  const openAddons = async (page: import("@playwright/test").Page) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Doplňky", exact: true }).click();
    await expect(page.getByRole("heading", { name: "E2E doplněk" })).toBeVisible();
  };
  const openEditor = async (page: import("@playwright/test").Page) => {
    const card = page.locator(".addon-card", { has: page.getByRole("heading", { name: "E2E doplněk" }) });
    await card.getByRole("button", { name: "Upravit doplněk" }).click();
    const dialog = page.getByRole("dialog", { name: "Upravit doplněk" });
    await expect(dialog).toBeVisible();
    return dialog;
  };

  test("one manifest can be refreshed by hand", async ({ page }) => {
    await openAddons(page);
    const dialog = await openEditor(page);
    await dialog.getByRole("button", { name: "Obnovit manifest", exact: true }).click();
    await expect(page.getByText("Doplněk E2E doplněk je aktuální.")).toBeVisible();
    // The card is rebuilt from the refreshed list; the dialog names the same addon, so
    // the assertion has to say which of the two headings it means.
    await expect(page.locator(".addon-card").getByRole("heading", { name: "E2E doplněk" })).toBeVisible();
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
    const dialog = await openEditor(page);

    // One library is configured, so its name is the default and the preview spells out the
    // real root instead of the /downloads the form used to hardcode for every install.
    const movies = dialog.getByRole("combobox", { name: "Filmy – knihovna" });
    await expect(movies.locator("option").first()).toHaveText("Výchozí · downloads");
    const [library] = await (await page.request.get("/api/libraries")).json();
    await expect(dialog.locator(".download-rule").first()).toContainText(library.root);
  });

  // Nothing is written until Save, and one press has to carry the whole draft: a
  // half-saved dialog would leave the queue filing downloads by a rule nobody chose.
  test("the dialog stages its changes and saves them in one go", async ({ page }) => {
    await openAddons(page);
    let dialog = await openEditor(page);
    const save = dialog.getByRole("button", { name: "Uložit změny" });
    await expect(save).toBeDisabled();

    await dialog.getByRole("textbox", { name: "Filmy – podsložka" }).fill("Akce");
    await expect(save).toBeEnabled();

    await dialog.getByRole("button", { name: "Zrušit" }).click();
    await expect(dialog).toBeHidden();
    dialog = await openEditor(page);
    await expect(dialog.getByRole("textbox", { name: "Filmy – podsložka" })).toHaveValue("");

    await dialog.getByRole("textbox", { name: "Filmy – podsložka" }).fill("Akce");
    await dialog.getByRole("button", { name: "Uložit změny" }).click();
    await expect(page.getByText("Doplněk aktualizován.")).toBeVisible();

    dialog = await openEditor(page);
    await expect(dialog.getByRole("textbox", { name: "Filmy – podsložka" })).toHaveValue("Akce");
    await dialog.getByRole("textbox", { name: "Filmy – podsložka" }).fill("");
    await dialog.getByRole("button", { name: "Uložit změny" }).click();
    await expect(page.getByText("Doplněk aktualizován.")).toBeVisible();
  });
});
