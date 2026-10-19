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
      // The two files that talk to the addon and the proxy over HTTP rather than through a page
      // run as their own project: between them they are seventy seconds of test time, and a job of
      // its own lets CI run them beside the WebKit journeys instead of at the far end of this
      // suite.
      testIgnore: [/setup\.spec\.ts/, /layout\//, /restricted\.spec\.ts/, /safari-(scroll|search-position)\.spec\.ts/, /(proxy|remote-library)\.spec\.ts/],
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState },
    },
    {
      // Nothing here needs a page it did not open itself, but one of them plays a file out of the
      // library, so it needs the library: the seed is what puts the fixture titles in it, and it
      // costs seconds rather than the journey suite those titles used to come from.
      name: "chromium-transport",
      testMatch: /(proxy|remote-library)\.spec\.ts/,
      dependencies: ["setup", "layout-seed"],
      use: { ...devices["Desktop Chrome"], storageState },
    },
    {
      name: "safari-seek",
      testMatch: /player-seek-(resume|cancel)\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Safari"], storageState },
    },
    {
      name: "safari-landscape",
      testMatch: /safari-(scroll|search-position)\.spec\.ts/,
      // Scrolling and section restoration only need the account the setup project leaves: the
      // journey suite used to run in front of it for no reason the spec can name.
      dependencies: ["setup"],
      use: { ...devices["iPhone 13 landscape"], browserName: "webkit", storageState },
    },
    {
      name: "safari-queue",
      testMatch: /layout\/queue\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["iPhone 13"], viewport: { width: 360, height: 780 }, browserName: "webkit", storageState },
    },
    {
      // The library the layout screens draw, built through the API rather than by replaying the
      // journeys: a baseline has to be taken against a state that is the same every run, and one
      // job per viewport paying for the whole journey suite to get it made that state expensive.
      //
      // Whether the seed is enough depends on what else the run takes. CI gives every layout
      // viewport its own job -- `LAYOUT_SEED_ONLY=1`, so the seed is the only state builder it
      // needs. A run that takes every project in one pass shares one server, and there the
      // journeys stay first: they expect a library with nothing in it, and the seed puts files
      // there.
      name: "layout-seed",
      testMatch: /layout\/seed\.spec\.ts/,
      dependencies: process.env.LAYOUT_SEED_ONLY === "1" ? ["setup"] : ["setup", "chromium"],
      use: { ...devices["Desktop Chrome"], storageState },
    },
    // The layout projects run after that seed, not merely after setup: a library file and a
    // bound title are what the screens show, and the seed is what leaves them behind.
    ...viewports.map(({ name, use }) => ({
      name,
      testMatch: /layout\//,
      // The seed is the dependency, not part of the matrix: it is already done before these run.
      testIgnore: /layout\/seed\.spec\.ts/,
      dependencies: process.env.LAYOUT_SEED_ONLY === "1" ? ["setup", "layout-seed"] : ["setup", "chromium", "layout-seed"],
      use: { ...use, storageState },
    })),
    {
      // Language expansion changes labels everywhere; isolate its mobile width check
      // so it does not have to rerun the full journey suite as a dependency.
      name: "mobile-locales",
      testMatch: /layout\/locales\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["iPhone 13"], storageState },
    },
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
