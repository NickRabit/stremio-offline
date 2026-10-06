import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { withholdUnloadProgress } from "./film-progress";

const folder = path.resolve("e2e/.tmp/seek-cancel");
test.beforeAll(async () => {
  await mkdir(folder, { recursive: true });
  await promisify(execFile)("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-stream_loop", "3", "-i", path.resolve("e2e/fixtures/media/sample.mp4"),
    "-an", "-c:v", "libvpx-vp9", "-g", "24", "-f", "hls", "-hls_time", "1", "-hls_segment_type", "fmp4",
    "-hls_playlist_type", "vod", "-y", path.join(folder, "index.m3u8"),
  ]);
});
test.afterAll(async () => { await rm(folder, { recursive: true, force: true }); });

test("closing during the fourth seek does not start a replacement film", async ({ page }) => {
  let starts = 0;
  let seeks = 0;
  let finishSeek!: () => void;
  const held = new Promise<void>((resolve) => { finishSeek = resolve; });
  const descriptor = { id: "seek-test", mode: "remux", url: "/seek-cancel/index.m3u8", offset: 0, duration: 6000, hardware: false, acceleration: false, audioTracks: [], subtitleTracks: [], audioTrack: 0, subtitleTrack: null, quality: null };
  await page.route("**/seek-cancel/*", async (route) => {
    const name = path.basename(new URL(route.request().url()).pathname);
    await route.fulfill({ contentType: name.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4", body: await readFile(path.join(folder, name)) });
  });
  // The layout baselines are taken against the state the journeys leave behind, and a film
  // watched to a position resumes there. This one seeks minutes into a fixture two seconds
  // long, so what it would leave behind is a player that opens already at the end.
  await withholdUnloadProgress(page);
  await page.route("**/api/progress", (route) => route.request().method() === "POST" ? route.fulfill({ status: 204 }) : route.continue());
  await page.route("**/api/progress/*", (route) => route.request().method() === "GET" ? route.fulfill({ json: null }) : route.continue());
  await page.route("**/api/playback", (route) => { starts++; return route.fulfill({ json: descriptor }); });
  await page.route("**/api/playback/seek-test", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/playback/seek-test/seek", async (route) => {
    seeks++;
    if (seeks === 4) {
      await held;
      await route.fulfill({ status: 400, json: { error: "The playback session no longer exists.", messageKey: "err.playbackSessionGone" } });
    } else await route.fulfill({ json: { ...descriptor, offset: route.request().postDataJSON().time } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  await catalog.selectOption((await catalog.locator("option").filter({ hasText: "Filmy" }).first().getAttribute("value"))!);
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  await page.getByRole("button", { name: "Přehrát", exact: true }).click();
  const overlay = page.locator(".player-overlay");
  const timeline = page.getByRole("slider", { name: "Pozice", exact: true });
  // A film that plays takes its controls away after a few quiet seconds, and this one has
  // nothing to click without them.
  for (let seek = 1; seek <= 4; seek++) {
    await overlay.dispatchEvent("pointermove");
    await timeline.click({ position: { x: 100 + seek * 100, y: 5 }, force: true });
    await expect.poll(() => seeks).toBe(seek);
    if (seek < 4) await expect(page.locator(".player-error")).toHaveCount(0);
  }
  await overlay.dispatchEvent("pointermove");
  await page.getByRole("button", { name: "Zavřít přehrávač", exact: true }).click({ force: true });
  const response = page.waitForResponse((r) => r.url().endsWith("/seek-test/seek") && r.status() === 400);
  finishSeek();
  await response;
  await page.waitForTimeout(500);
  expect(starts).toBe(1);
  await expect(page.locator("video")).toHaveCount(0);
});
