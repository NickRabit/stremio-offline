import { expect, test } from "@playwright/test";
import { addonManifest } from "../../playwright.config";

/** Closes the player and opens the fixture film again: the overlay, and with it the `<video>`,
 *  is unmounted in between, so a volume that survives this is one that was remembered. */
const openFilm = async (page: import("@playwright/test").Page) => {
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  await catalog.selectOption((await catalog.locator("option").filter({ hasText: "Filmy" }).first().getAttribute("value"))!);
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  await page.getByRole("button", { name: "Přehrát", exact: true }).click();
};

const volumeOf = (page: import("@playwright/test").Page) =>
  page.locator("video").evaluate((element: HTMLVideoElement) => element.volume);

test("the player keeps the volume it was left at", async ({ page, request }) => {
  await request.get(new URL("/proxy-control?mode=browser", addonManifest).href);
  await page.goto("/");
  await openFilm(page);

  const slider = page.locator("input.volume");
  await expect(slider, "a device that has never been set plays at full").toHaveValue("100");
  await slider.fill("40");
  await expect.poll(() => volumeOf(page)).toBeCloseTo(0.4, 2);

  await page.getByRole("button", { name: "Zavřít přehrávač", exact: true }).click();
  await expect(page.locator(".player-overlay")).toHaveCount(0);
  await openFilm(page);
  await expect(page.locator("input.volume")).toHaveValue("40");
  await expect.poll(() => volumeOf(page)).toBeCloseTo(0.4, 2);

  // A hardware key or the system mixer changes the element without touching the slider; the
  // slider follows it, which is what keeps the control showing what is actually playing.
  await page.locator("video").evaluate((element: HTMLVideoElement) => { element.volume = 0.25; });
  await expect(page.locator("input.volume")).toHaveValue("25");

  // And it outlives the page: the point of remembering it on the device rather than in the tab.
  await page.reload();
  await openFilm(page);
  await expect(page.locator("input.volume")).toHaveValue("25");
  await expect.poll(() => volumeOf(page)).toBeCloseTo(0.25, 2);
});
