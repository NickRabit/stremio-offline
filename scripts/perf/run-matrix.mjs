#!/usr/bin/env node
// Drives the playback matrix in a headless Chrome, which paints frames whether or not anyone
// is looking at it. Every cell runs on a freshly restarted instance (reset.sh).
//
//   node scripts/perf/run-matrix.mjs <work folder> <cells.json> <results.jsonl> [only-prefix]
//
// <work folder>/test-user.json holds the measurement account (add-runner.mjs). cells.json is a
// list of harness options: { label, source, path, quality?, inspectLeadMs?, playSeconds? }.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const [work, cellsFile, resultsFile, only] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.env.PERF_BASE ?? "http://localhost:8092";
const container = process.env.PERF_NAME ?? "stremio-offline-perf";
const user = JSON.parse(readFileSync(path.join(work, "test-user.json"), "utf8"));
const cells = JSON.parse(readFileSync(cellsFile, "utf8")).filter((cell) => !only || cell.label.startsWith(only));

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

async function signIn() {
  const answer = await context.request.post(`${base}/api/auth/login`, { data: { username: user.username, password: user.password, remember: true } });
  if (!answer.ok()) throw new Error(`sign-in failed: ${answer.status()}`);
  await page.goto(`${base}/`);
  await page.evaluate(async () => { await import("/perf/player-harness.js"); await window.perf.ready(); });
}

for (const cell of cells) {
  execFileSync(path.join(here, "reset.sh"), [path.join(work, "logs"), container], { stdio: "ignore" });
  await signIn();
  await page.waitForTimeout(1000);
  const result = await page.evaluate((options) => window.perf.run(options), cell);
  appendFileSync(resultsFile, `${JSON.stringify(result)}\n`);
  const m = result;
  console.log(m.label, m.mode, `probe ${m.inspected - m.minted}`, `start ${m.startAnswer - m.play}`, `frame ${m.firstFrame - m.play}`,
    `seekMid ${m.seekMidFrame - m.seekMidBegin} (${m.seekMidPlan ?? "direct"})`, `seekBack ${m.seekBackFrame - m.seekBackBegin} (${m.seekBackPlan ?? "direct"})`,
    `stalls ${m.stalls}`, m.error ?? "");
}
execFileSync(path.join(here, "reset.sh"), [path.join(work, "logs"), container], { stdio: "ignore" });
await browser.close();
