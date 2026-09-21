import { expect, test } from "@playwright/test";
import { resetViews } from "../library-tools";

test.beforeEach(async ({ request }) => { await resetViews(request); });

test("running downloads lead the queue and status changes keep every job in its section", async ({ page }, testInfo) => {
  const base = { received: 650_000_000, total: 2_000_000_000, speed: 0, createdAt: "2026-09-01T10:00:00Z", updatedAt: "2026-09-02T10:01:30Z" };
  const jobs = [
    ...Array.from({ length: 25 }, (_, index) => ({ ...base, id: `done-${index}`, title: `Completed film ${index}`, target: `films/film-${index}.mp4`, order: index, status: "completed" })),
    { ...base, id: "waiting", title: "Planet Earth · S01E02 · Mountains", target: "", order: 25, status: "waiting", debridProgress: 36 },
    { ...base, id: "paused", title: "Interstellar (2014)", target: "films/Interstellar/Interstellar.mkv", order: 26, status: "paused" },
    { ...base, id: "failed", title: "Arrival (2016)", target: "films/Arrival/Arrival.mkv", order: 27, status: "failed", error: "Source unavailable" },
    { ...base, id: "queued", title: "Planet Earth · S01E03 · Fresh Water", target: "", order: 28, status: "queued" },
    { ...base, id: "active", title: "Planet Earth · S01E01 · From Pole to Pole", target: "series/Planet Earth/01/01 - From Pole to Pole.mkv", order: 29, status: "downloading", speed: 12_500_000 },
  ];
  await page.route("**/api/downloads", (route) => route.fulfill({ json: { jobs, halt: null } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Stahování", exact: true }).click();
  await expect(page.locator(".download-row").first()).toContainText("From Pole to Pole");
  await expect(page.locator("#queue-pending .download-row")).toHaveCount(4);
  await expect(page.locator("#queue-completed-content")).toBeHidden();
  await expect(page.locator("#queue-active .queue-live-speed")).toHaveText("12.5 MB/s");
  await expect(page.locator("#queue-active .queue-priority")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  if (page.viewportSize()!.width > 700) {
    await expect.poll(async () => {
      const sidebar = await page.locator(".sidebar").boundingBox();
      const content = await page.locator(".downloads-page").boundingBox();
      return content!.x >= sidebar!.x + sidebar!.width;
    }).toBe(true);
  }
  await page.screenshot({ path: `e2e/.tmp/queue-redesign-${testInfo.project.name}.png`, fullPage: true, animations: "disabled" });
  await page.route("**/api/downloads/active/pause", async (route) => {
    jobs[jobs.length - 1].status = "paused";
    jobs[jobs.length - 1].speed = 0;
    await route.fulfill({ status: 204 });
  });
  await page.locator("#queue-active").getByRole("button", { name: "Pozastavit", exact: true }).click();
  await expect(page.locator("#queue-active .download-row")).toHaveCount(0);
  await expect(page.locator("#queue-pending .download-row")).toHaveCount(5);
  await page.locator(".queue-history-toggle").click();
  await expect(page.locator("#queue-completed .download-row")).toHaveCount(20);
  await expect(page.locator("#queue-completed .queue-priority")).toHaveCount(0);
  await page.locator("#queue-completed").getByRole("button", { name: "Další", exact: true }).click();
  await expect(page.locator("#queue-completed .download-row")).toHaveCount(5);
  await expect(page.locator("#queue-pending .download-row")).toHaveCount(5);
});

test("queue pages, sorts and filters without overflowing the viewport", async ({ page }, testInfo) => {
  const jobs = Array.from({ length: 45 }, (_, index) => ({
    id: `queue-${index}`, title: `Queue ${String(index).padStart(2, "0")} long title for responsive layouts ${"UnbrokenTitle".repeat(20)}`,
    target: `films/a-long-folder/${"unbroken-path".repeat(20)}/queue-${index}.mp4`, order: index,
    status: index % 2 ? "paused" : "completed", received: 1024, total: 1024, speed: 0,
    createdAt: "2026-09-01T10:00:00Z", startedAt: "2026-09-02T10:00:00Z",
    completedAt: index % 2 ? undefined : "2026-09-02T10:01:30Z", updatedAt: "2026-09-02T10:01:30Z",
  }));
  await page.route("**/api/downloads", (route) => route.fulfill({ json: { jobs, halt: null } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Stahování", exact: true }).click();
  const rows = page.locator(".download-row:visible");
  await expect(rows).toHaveCount(20);
  const filters = page.locator(".queue-filters");
  await expect(filters).not.toHaveAttribute("open", "");
  await expect(page.getByLabel("Hledat název nebo cestu")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  const firstDetails = rows.first().getByRole("button", { name: "Podrobnosti", exact: true });
  if (await firstDetails.isVisible()) {
    await expect(rows.first().locator(".queue-job-details")).toBeHidden();
    const card = await rows.first().boundingBox();
    expect(card!.height).toBeLessThan(240);
    await firstDetails.click();
    await expect(rows.first().locator(".queue-job-details")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
    await firstDetails.click();
  }
  await page.screenshot({ path: `e2e/.tmp/queue-compact-${testInfo.project.name}.png` });
  await page.getByRole("button", { name: "Další", exact: true }).click();
  await expect(rows.first()).toContainText("Queue 41");
  await page.getByRole("button", { name: "Dokončené 23", exact: true }).click();
  await filters.locator("summary").click();
  await page.getByRole("combobox", { name: "Řadit podle", exact: true }).selectOption("titleSort");
  await page.getByRole("combobox", { name: "Směr", exact: true }).selectOption("desc");
  await expect(page.locator("#queue-completed .download-row").first()).toContainText("Queue 44");
  await page.getByRole("combobox", { name: "Stav", exact: true }).selectOption("completed");
  await page.getByRole("combobox", { name: "Položek na stránce", exact: true }).selectOption("50");
  await expect(rows).toHaveCount(23);
  await page.getByRole("combobox", { name: "Filtrovat datum", exact: true }).selectOption("completedAt");
  await page.getByLabel("Od", { exact: true }).fill("2026-09-03");
  await expect(rows).toHaveCount(0);
  await expect(page.getByText("Žádné odpovídající položky").first()).toBeVisible();
  await page.getByRole("button", { name: "Zrušit filtry" }).click();
  await page.getByLabel("Hledat název nebo cestu").fill("Queue 00");
  await expect(rows).toHaveCount(1);
  const detailsToggle = rows.first().getByRole("button", { name: "Podrobnosti", exact: true });
  if (await detailsToggle.isVisible()) await detailsToggle.click();
  await expect(rows.first().locator(".queue-times")).toBeVisible();
  await expect(rows.first().locator(".queue-times")).toContainText("Začátek");
  await filters.locator("summary").click();
  await expect(filters.locator("summary")).toContainText("Aktivní filtry: 1");
  await expect(rows).toHaveCount(1);
  await expect(page.getByLabel("Hledat název nebo cestu")).toBeHidden();
  await filters.locator("summary").click();
  await expect(page.getByLabel("Hledat název nebo cestu")).toHaveValue("Queue 00");
  await page.screenshot({ path: `e2e/.tmp/queue-${testInfo.project.name}.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  for (const control of await page.locator(".queue-tools input, .queue-tools select, .queue-pagination button").all()) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    const parent = await control.locator("..").boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(parent!.x + parent!.width + 1);
  }
});
