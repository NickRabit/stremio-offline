import { expect, test } from "@playwright/test";

test.describe("settings", () => {
  test("a changed setting survives a reload", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Nastavení", exact: true }).click();
    await page.getByRole("tab", { name: "Domů", exact: true }).click();

    const tileSize = page.getByRole("combobox", { name: "Velikost dlaždic" });
    await tileSize.selectOption("large");
    await expect(page.getByText("Nastavení uloženo.")).toBeVisible();

    await page.reload();
    await page.getByRole("button", { name: "Nastavení", exact: true }).click();
    await page.getByRole("tab", { name: "Domů", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Velikost dlaždic" })).toHaveValue("large");

    await page.getByRole("combobox", { name: "Velikost dlaždic" }).selectOption("medium");
  });

  test("downloaded titles follow the interface language unless overridden", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Nastavení", exact: true }).click();
    await page.getByRole("tab", { name: "Stahování", exact: true }).click();

    const titleLanguage = page.getByRole("combobox", { name: "Jazyk názvů ke stažení" });
    await expect(titleLanguage).toHaveValue("ui");
    await titleLanguage.selectOption("en");
    await page.reload();
    await page.getByRole("button", { name: "Nastavení", exact: true }).click();
    await page.getByRole("tab", { name: "Stahování", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Jazyk názvů ke stažení" })).toHaveValue("en");
    await page.getByRole("combobox", { name: "Jazyk názvů ke stažení" }).selectOption("ui");
  });

  test("diagnostics reports the running server", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Nastavení", exact: true }).click();
    await page.getByRole("tab", { name: "Účet", exact: true }).click();
    await page.locator("button.diagnostics-toggle").click();

    const facts = page.locator(".diagnostics-facts");
    await expect(facts).toContainText("Server běží");
    await expect(facts).toContainText("Volné místo");
  });

  test("a client log is laid out as a card: hint not indented, its three buttons one even row", async ({ page }) => {
    const created = await page.request.post("/api/client-log/bundle", {
      data: { client: "tv", app: "0.0.0", device: "Layout check · Android 12", lines: [{ t: new Date().toISOString(), level: "INFO", message: "App start" }] },
    });
    expect(created.status()).toBe(201);
    const { id } = await created.json() as { id: string };
    try {
      await page.goto("/");
      await page.getByRole("button", { name: "Nastavení", exact: true }).click();
      await page.getByRole("tab", { name: "Účet", exact: true }).click();
      await page.locator("button.diagnostics-toggle").click();

      const block = page.locator(".client-logs");
      await expect(block).toContainText("Layout check");
      const frame = (await block.boundingBox())!;
      const hint = (await block.locator(":scope > p.hint").boundingBox())!;
      expect(hint.x - frame.x, "the hint must start at the left edge of the block").toBeLessThan(4);

      const row = block.locator("li", { hasText: "Layout check" });
      const buttons = await row.locator(".client-log-actions button").evaluateAll((elements) => elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { top: box.top, height: box.height, left: box.left, right: box.right };
      }));
      expect(buttons).toHaveLength(3);
      for (const button of buttons) {
        expect(Math.abs(button.top - buttons[0]!.top), "the buttons share one row").toBeLessThan(1);
        expect(Math.abs(button.height - buttons[0]!.height), "the buttons are equally tall").toBeLessThan(1);
      }
      for (let index = 1; index < buttons.length; index += 1) {
        expect(buttons[index]!.left - buttons[index - 1]!.right, "the buttons do not touch").toBeGreaterThanOrEqual(6);
      }
    } finally {
      await page.request.delete(`/api/client-logs/${id}`);
    }
  });
});
