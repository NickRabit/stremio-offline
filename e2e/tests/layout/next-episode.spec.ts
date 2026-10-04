import { expect, test } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { addonManifest } from "../../../playwright.config";

const folder = "e2e/.tmp/downloads/Preview episodes";
test("local player previews a frame and plays the next naturally sorted file", async ({ page, request }) => {
  await mkdir(folder, { recursive: true });
  const video = await (await request.get(new URL("/browser-video.webm", addonManifest).href)).body();
  for (const name of ["Episode 1.webm", "Episode 2.webm", "Episode 10.webm"]) await writeFile(`${folder}/${name}`, video);
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Knihovna", exact: true }).click();
    await page.locator(".folder .library-open", { hasText: "Preview episodes" }).click();
    await page.locator('.browse-item[data-path="Preview episodes/Episode 1.webm"] .library-open').click();
    const overlay = page.locator(".player-overlay");
    await expect(overlay.locator(".player-head")).toContainText("DIRECT STREAM");
    const previous = overlay.getByRole("button", { name: "Předchozí díl", exact: true });
    await expect(previous).toHaveCount(0);
    const next = overlay.getByRole("button", { name: "Další díl", exact: true });
    await expect(next).toHaveAttribute("title", "Další díl: Episode 2.webm");
    expect(await overlay.locator(".player-controls").evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
    // Reserve the optional subtitle toggle even for the subtitle-free fixture.
    await overlay.locator(".player-view-controls").evaluate((element) => {
      const toggle = element.querySelector(".player-settings-toggle")!.cloneNode(true) as HTMLElement;
      toggle.className = "subtitle-layout-placeholder";
      toggle.removeAttribute("id");
      toggle.removeAttribute("aria-label");
      element.before(toggle);
    });
    expect(await overlay.locator(".player-controls").evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
    await overlay.locator(".subtitle-layout-placeholder").evaluate((element) => element.remove());
    const timeline = overlay.locator(".timeline-bar");
    await expect.poll(async () => Number(await timeline.getAttribute("aria-valuemax"))).toBeGreaterThan(0);
    await timeline.dispatchEvent("pointermove", { pointerType: "mouse", clientX: (await timeline.boundingBox())!.x + 5 });
    await expect(overlay.locator(".timeline-preview img")).toBeVisible({ timeout: 15_000 });
    await timeline.dispatchEvent("pointerout");
    await timeline.dispatchEvent("pointerdown", { pointerId: 42, pointerType: "touch", button: 0, clientX: (await timeline.boundingBox())!.x + 10 });
    await expect(overlay.locator(".timeline-preview img")).toBeVisible({ timeout: 15_000 });
    await timeline.dispatchEvent("pointercancel", { pointerId: 42, pointerType: "touch" });
    await expect(overlay.locator(".timeline-preview")).toHaveCount(0);
    const stretch = overlay.getByRole("button", { name: "Roztáhnout obraz", exact: true });
    await expect(overlay.locator("video")).toHaveCSS("object-fit", "contain");
    await stretch.click();
    await expect(overlay.locator("video")).toHaveCSS("object-fit", "fill");
    await next.click();
    await expect(overlay.locator(".player-head strong")).toContainText("Episode 2.webm");
    await expect(next).toHaveAttribute("title", "Další díl: Episode 10.webm");
    await expect(previous).toHaveAttribute("title", "Předchozí díl: Episode 1.webm");
    await expect(overlay.locator("video")).toHaveCSS("object-fit", "fill");
    await expect(stretch).toHaveAttribute("aria-pressed", "true");
    expect(await overlay.locator(".player-controls").evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
    const transport = overlay.locator(".transport-controls");
    const boxes = await Promise.all((await transport.locator("button").all()).map((button) => button.boundingBox()));
    expect(new Set(boxes.map((box) => Math.round(box!.y))).size).toBe(1);
    expect(boxes.map((box) => box!.x)).toEqual(boxes.map((box) => box!.x).sort((a, b) => a - b));
    if (page.viewportSize()!.width >= 350 && page.viewportSize()!.width <= 700) {
      // The toolbar may wrap onto a second row, but neither group may be split across rows.
      const viewBoxes = await Promise.all((await overlay.locator(".player-view-controls button").all()).map((button) => button.boundingBox()));
      expect(new Set(viewBoxes.map((box) => Math.round(box!.y))).size).toBe(1);
    }
    await page.screenshot({ path: `test-results/episode-controls-${test.info().project.name}.png` });
    await previous.click();
    await expect(overlay.locator(".player-head strong")).toContainText("Episode 1.webm");
    await expect(previous).toHaveCount(0);
    await next.click();
    await expect(overlay.locator(".player-head strong")).toContainText("Episode 2.webm");
    await next.click();
    await expect(overlay.locator(".player-head strong")).toContainText("Episode 10.webm");
    await expect(next).toHaveCount(0);
    await expect(previous).toHaveAttribute("title", "Předchozí díl: Episode 2.webm");
    await overlay.getByRole("button", { name: "Zavřít přehrávač", exact: true }).click();
  } finally {
    await page.close();
    for (const name of ["Episode 1.webm", "Episode 2.webm", "Episode 10.webm"]) await request.delete(`/api/progress/${encodeURIComponent(`file:Preview episodes/${name}`)}`);
    await rm(folder, { recursive: true, force: true });
  }
});
