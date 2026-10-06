import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { withholdUnloadProgress } from "./film-progress";

const folder = path.resolve("e2e/.tmp/seek-resume");
test.beforeAll(async () => {
  await mkdir(folder, { recursive: true });
  await promisify(execFile)("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-stream_loop", "59", "-i", path.resolve("e2e/fixtures/media/sample.mp4"),
    "-an", "-c:v", "libvpx-vp9", "-g", "24", "-f", "hls", "-hls_time", "1", "-hls_segment_type", "fmp4",
    "-hls_playlist_type", "vod", "-y", path.join(folder, "index.m3u8"),
  ]);
});
test.afterAll(async () => { await rm(folder, { recursive: true, force: true }); });

for (const scenario of ["playing", "paused", "queued", "closed", "unconfirmed"] as const) {
  test(`a refused seek recovers safely: ${scenario}`, async ({ page }) => {
    let seeks = 0;
    let starts = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const descriptor = { id: "resume-test", mode: "remux", url: "/seek-resume/1/index.m3u8", offset: 0, duration: 6000, hardware: false, acceleration: false, audioTracks: [], subtitleTracks: [], audioTrack: 0, subtitleTrack: null, quality: null };
    const intermediate = { ...descriptor, url: "/seek-resume/2/index.m3u8", offset: 1000 };
    const playlists: string[] = [];
    await page.route("**/seek-resume/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const name = path.basename(pathname);
      if (name.endsWith("m3u8")) playlists.push(pathname);
      await route.fulfill({ contentType: name.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4", body: await readFile(path.join(folder, name)) });
    });
    await withholdUnloadProgress(page);
    await page.route("**/api/progress", (route) => route.request().method() === "POST" ? route.fulfill({ status: 204 }) : route.continue());
    await page.route("**/api/progress/*", (route) => route.request().method() === "GET" ? route.fulfill({ json: null }) : route.continue());
    await page.route("**/api/playback", (route) => { starts++; return route.fulfill({ json: descriptor }); });
    await page.route("**/api/playback/resume-test", (route) => route.fulfill({ status: 204 }));
    await page.route("**/api/playback/resume-test/seek", async (route) => {
      seeks++;
      if (seeks === 1) await held;
      if (scenario === "unconfirmed") return route.fulfill({ status: 400, json: { error: "Conversion failed", messageKey: "err.conversionFailed" } });
      if (scenario === "queued" && seeks === 1) return route.fulfill({ json: intermediate });
      return route.fulfill({ json: { ...(scenario === "queued" ? intermediate : descriptor), seekRestored: true } });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Katalog", exact: true }).click();
    const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
    await catalog.selectOption((await catalog.locator("option").filter({ hasText: "Filmy" }).first().getAttribute("value"))!);
    await page.getByRole("button", { name: /Zkušební film/ }).click();
    await page.getByRole("button", { name: "Přehrát", exact: true }).click();
    const overlay = page.locator(".player-overlay");
    const video = overlay.locator("video");
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 1)).toBe(true);
    await overlay.dispatchEvent("pointermove");
    if (scenario === "paused") await overlay.getByRole("button", { name: "Pozastavit", exact: true }).click();
    const before = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
    const timeline = page.getByRole("slider", { name: "Pozice", exact: true });
    await timeline.click({ position: { x: 250, y: 5 }, force: true });
    await expect.poll(() => seeks).toBe(1);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    if (scenario === "queued") await timeline.click({ position: { x: 450, y: 5 }, force: true });
    if (scenario === "closed") {
      await overlay.dispatchEvent("pointermove");
      await page.getByRole("button", { name: "Zavřít přehrávač", exact: true }).click({ force: true });
    }
    const response = page.waitForResponse((r) => r.url().endsWith("/resume-test/seek"));
    release();
    await response;
    if (scenario === "closed") {
      await expect(video).toHaveCount(0);
      expect(starts).toBe(1);
      return;
    }
    // A refused seek leaves the film playing, so it is a passing notice, never the error curtain.
    const kept = overlay.getByRole("status").filter({ hasText: "Nepodařilo se přeskočit" });
    if (scenario === "unconfirmed" || scenario === "paused") {
      if (scenario === "unconfirmed") await expect(overlay.locator(".player-error")).toBeVisible();
      else { await expect(kept).toBeVisible(); await expect(overlay.locator(".player-error")).toHaveCount(0); }
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
      expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(before - 0.05);
    } else {
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
      if (scenario === "queued") {
        expect(seeks).toBe(2);
        expect(playlists).toContain("/seek-resume/2/index.m3u8");
        await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.3);
      } else {
        await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(before + 0.3);
        expect(playlists.filter((url) => url === "/seek-resume/1/index.m3u8")).toHaveLength(1);
      }
      await expect(kept).toBeVisible();
      await expect(overlay.locator(".player-error")).toHaveCount(0);
    }
  });
}
