import { defineConfig, devices } from "@playwright/test";

const appPort = Number(process.env.APP_PORT ?? 8099);
const addonPort = Number(process.env.ADDON_PORT ?? 8098);
export const appUrl = `http://127.0.0.1:${appPort}`;
export const addonManifest = `http://127.0.0.1:${addonPort}/manifest.json`;

const storageState = "e2e/.tmp/session.json";

// Chosen to sit on either side of the breakpoints in web/src/style.css, which are
// 700px, 980px, a 780px height rule, a landscape rule bounded by 980x500, and a
// 460px height rule paired with 440px of width for the account dialog.
export const viewports = [
  { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  { name: "desktop-short", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 760 } } },
  { name: "tablet-landscape", use: { ...devices["Desktop Chrome"], viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true } },
  { name: "tablet", use: { ...devices["Desktop Chrome"], viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true } },
  { name: "mobile", use: { ...devices["iPhone 13"] } },
  { name: "mobile-landscape", use: { ...devices["iPhone 13 landscape"] } },
  // An Android phone held sideways is 360 tall, not the iPhone's 390, and the
  // account dialog fits in one and not the other -- it is the tightest box the
  // interface has to survive, so it is a project rather than a spot check.
  { name: "mobile-landscape-small", use: { ...devices["Pixel 5 landscape"] } },
];

export default defineConfig({
  testDir: "e2e/tests",
  // The fixture stack is a single server with a single state file, so the specs
  // share it and must not run against it at the same time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: { baseURL: appUrl, trace: "retain-on-failure", screenshot: "only-on-failure" },
  // Baselines live next to the spec, named by project rather than by platform:
  // they are always produced in the Playwright container, so the host is not
  // part of their identity.
  snapshotPathTemplate: "{testDir}/{testFileDir}/__screenshots__/{projectName}/{arg}{ext}",
  // Deliberately close to zero tolerance. A percentage-based allowance sounds
  // safe but hides exactly the changes worth catching: a 4px font bump across a
  // row of tiles stayed under a 1% ratio. Runs in the container are stable, so
  // the small fixed budget only absorbs renderer noise.
  expect: { toHaveScreenshot: { maxDiffPixels: 120, animations: "disabled", caret: "hide", scale: "css" } },
  projects: [
    { name: "setup", testMatch: /setup\.spec\.ts/ },
    {
      // The journeys are about behaviour, not layout, so one viewport is enough.
      name: "chromium",
      testIgnore: [/setup\.spec\.ts/, /layout\//, /restricted\.spec\.ts/, /safari-scroll\.spec\.ts/],
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState },
    },
    {
      name: "safari-landscape",
      testMatch: /safari-scroll\.spec\.ts/,
      dependencies: ["setup", "chromium"],
      use: { ...devices["iPhone 13 landscape"], browserName: "webkit", storageState },
    },
    {
      name: "safari-queue",
      testMatch: /layout\/queue\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["iPhone 13"], viewport: { width: 360, height: 780 }, browserName: "webkit", storageState },
    },
    // The layout projects run after the journeys, not merely after setup: the
    // journeys leave a queued download and a library file behind, and a baseline
    // has to be taken against a state that is the same every run.
    ...viewports.map(({ name, use }) => ({
      name,
      testMatch: /layout\//,
      dependencies: ["setup", "chromium"],
      use: { ...use, storageState },
    })),
  ],
  webServer: [
    {
      command: "node e2e/fixtures/addon-server.mjs",
      url: `http://127.0.0.1:${addonPort}/manifest.json`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
    },
    {
      command: "node e2e/fixtures/app-server.mjs",
      url: `${appUrl}/api/status`,
      reuseExistingServer: false,
      stdout: "pipe",
    },
  ],
});
