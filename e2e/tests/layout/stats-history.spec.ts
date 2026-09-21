import { expect, test } from "@playwright/test";

test("activity filters and long filenames fit the statistics panel", async ({ page }) => {
  await page.route("**/api/stats/activity?*", (route) => route.fulfill({ json: {
    items: [{ id: 1, at: "2026-09-21T12:00:00Z", kind: "library", title: "A long movie title", filename: `${"VeryLongFilename".repeat(15)}.mkv`, username: "e2e-admin", bytes: 4096 }],
    total: 1, users: [{ id: "admin", username: "e2e-admin" }],
  } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Statistiky", exact: true }).click();
  const history = page.locator(".stats-history");
  await expect(history.getByText("A long movie title")).toBeVisible();
  await history.getByRole("combobox", { name: "Aktivita", exact: true }).selectOption("library");
  await expect(history.getByText("A long movie title")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  for (const control of await history.locator("select, button").all()) {
    const box = await control.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(24);
    expect(box!.height).toBeGreaterThanOrEqual(24);
  }
});
