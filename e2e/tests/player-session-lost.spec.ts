import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pickAddonStream } from "./catalog-sources";
import { withholdUnloadProgress } from "./film-progress";

const folder = path.resolve("e2e/.tmp/session-lost");
test.beforeAll(async () => {
  await mkdir(folder, { recursive: true });
  await promisify(execFile)("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-stream_loop", "59", "-i", path.resolve("e2e/fixtures/media/sample.mp4"),
    "-an", "-c:v", "libvpx-vp9", "-g", "24", "-f", "hls", "-hls_time", "1", "-hls_segment_type", "fmp4",
    "-hls_playlist_type", "vod", "-y", path.join(folder, "index.m3u8"),
  ]);
});
test.afterAll(async () => { await rm(folder, { recursive: true, force: true }); });

// "segments": the session is found gone by the segment requests once play is pressed.
// "ping": the server released it while the viewer was paused (a long pause); the ping finds it
// gone, and nothing may start until the viewer presses play.
for (const scenario of ["segments", "ping"] as const) test(`the player starts a new session after the server closes the first: ${scenario}`, async ({ page }) => {
  const pings: Array<{ paused?: boolean }> = [];
  let closed = false;
  let firstSegments = 0;
  let releaseFirstSegments = () => {};
  const firstSegmentsReleased = new Promise<void>((resolve) => { releaseFirstSegments = resolve; });
  const starts: number[] = [];
  const playlists: string[] = [];
  const first = {
    id: "session-lost-1", mode: "remux", url: "/session-lost/1/index.m3u8", offset: 0, duration: 6000,
    hardware: false, acceleration: false, audioTracks: [], subtitleTracks: [], audioTrack: 0, subtitleTrack: null,
    quality: null, playlist: true,
  };
  const second = { ...first, id: "session-lost-2", url: "/session-lost/2/index.m3u8" };
  const gone = { error: "The playback session is gone.", code: "RESOURCE_NOT_FOUND", messageKey: "err.playbackSessionGone" };

  await page.route("**/session-lost/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const name = path.basename(pathname);
    const firstSession = pathname.startsWith("/session-lost/1/");
    if (firstSession && name.endsWith(".m4s")) {
      firstSegments += 1;
      if (firstSegments > 2) await firstSegmentsReleased;
    }
    if (closed && firstSession) return route.fulfill({ status: 404, json: gone });
    if (name.endsWith("m3u8")) playlists.push(pathname);
    return route.fulfill({
      contentType: name.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4",
      body: await readFile(path.join(folder, name)),
    });
  });
  await withholdUnloadProgress(page);
  await page.route("**/api/progress", (route) => route.request().method() === "POST" ? route.fulfill({ status: 204 }) : route.continue());
  await page.route("**/api/progress/*", (route) => route.request().method() === "GET" ? route.fulfill({ json: null }) : route.continue());
  await page.route("**/api/playback", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const time = Number((route.request().postDataJSON() as { time?: number }).time ?? 0);
    starts.push(time);
    return route.fulfill({ json: starts.length === 1 ? first : { ...second, offset: time } });
  });
  await page.route("**/api/playback/session-lost-1/**", (route) => {
    if (route.request().url().endsWith("/ping")) pings.push((route.request().postDataJSON() ?? {}) as { paused?: boolean });
    return closed ? route.fulfill({ status: 404, json: gone }) : route.fulfill({ status: 204 });
  });
  await page.route("**/api/playback/session-lost-2/**", (route) => {
    if (route.request().url().endsWith("/seek")) {
      const time = Number((route.request().postDataJSON() as { time?: number }).time ?? 0);
      return route.fulfill({ json: { ...second, offset: time } });
    }
    return route.fulfill({ status: 204 });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  await catalog.selectOption((await catalog.locator("option").filter({ hasText: "Filmy" }).first().getAttribute("value"))!);
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  await pickAddonStream(page);
  await page.getByRole("button", { name: "Přehrát", exact: true }).click();

  const overlay = page.locator(".player-overlay");
  const video = overlay.locator("video");
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 1)).toBe(true);
  await overlay.dispatchEvent("pointermove");
  await overlay.getByRole("button", { name: "Pozastavit", exact: true }).click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  const pausedAt = await video.evaluate((v: HTMLVideoElement) => v.currentTime);

  closed = true;
  if (scenario === "ping") {
    const pinged = page.waitForResponse((response) => response.url().endsWith("/api/playback/session-lost-1/ping"));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    expect((await pinged).status()).toBe(404);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(pings.at(-1)).toEqual({ paused: true });
    // Released while paused: nothing starts again until the viewer asks for the film.
    expect(starts).toHaveLength(1);
    await expect(overlay.locator(".player-error")).toHaveCount(0);
  }
  await overlay.dispatchEvent("pointermove");
  await overlay.getByRole("button", { name: "Přehrát", exact: true }).click();
  releaseFirstSegments();

  await expect.poll(() => starts.length).toBe(2);
  expect(Math.abs(starts[1]! - pausedAt)).toBeLessThanOrEqual(2);
  expect(playlists).toContain("/session-lost/2/index.m3u8");
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => {
    const before = v.currentTime;
    return new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(!v.paused && v.currentTime > before), 300);
    });
  })).toBe(true);
  await expect(overlay.locator(".player-error")).toHaveCount(0);
});
