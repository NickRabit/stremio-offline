import { expect, test } from "@playwright/test";

test("queues a source and the job reaches the download list", async ({ page }) => {
  await page.route("**/api/meta/movie/tt-e2e-movie?*", async (route) => {
    const response = await route.fetch();
    const meta = await response.json();
    await route.fulfill({ response, json: { ...meta, name: "Test Movie", nameLanguage: "en" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();

  const options = await page.getByRole("combobox", { name: "Procházet katalog" }).locator("option").allTextContents();
  await page.getByRole("combobox", { name: "Procházet katalog" }).selectOption({ label: options.find((text) => /Filmy/.test(text))! });
  await page.getByRole("button", { name: /Zkušební film/ }).click();

  const detail = page.locator(".detail-panel");
  await expect(detail.getByRole("heading", { name: "Zdroje" })).toBeVisible();
  await detail.locator(".stream-list button").first().click();
  await detail.getByRole("button", { name: "Do knihovny" }).click();

  await expect(page.getByText("Přidáno do fronty.")).toBeVisible();

  await page.getByRole("button", { name: "Stahování", exact: true }).click();
  await page.locator(".queue-history-toggle").click();
  const row = page.locator(".download-row", { hasText: "Zkušební film" });
  await expect(row).toBeVisible();
  // The sample file is a few kilobytes, so it is finished long before the poll
  // interval matters.
  await expect(row.locator(".job-status")).toHaveText("Dokončeno", { timeout: 20_000 });

  await row.locator(".job-link").click();
  const focused = page.locator(".browse-item.focused");
  await expect(focused).toBeVisible();
  await expect(focused).toHaveAttribute("aria-current", "true");
  await expect(focused).toContainText("Zkušební film");
  await expect(focused).toContainText("Tento soubor");
  await expect(focused).toBeInViewport();
  const history = await page.request.get("/api/stats/activity?hours=24&kind=library");
  expect(history.ok()).toBe(true);
  const activities = await history.json();
  expect(activities.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "library", username: "e2e-admin", title: "Zkušební film" }),
  ]));
});
