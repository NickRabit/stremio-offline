import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "complexity-report.mjs");

const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

test("the JSON report names the known large files and exits 0", () => {
  const result = run(["--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);

  const files = report.largestFiles.map((entry) => entry.file);
  for (const known of ["web/src/App.tsx", "server/src/index.ts", "web/src/style.css"]) {
    assert.ok(files.includes(known), `expected ${known} among the largest files`);
  }
  assert.equal(report.largestFiles.length, 15);

  const lines = report.largestFiles.map((entry) => entry.lines);
  assert.deepEqual(lines, [...lines].sort((left, right) => right - left));
});

test("the Markdown report says route registrations are not endpoints and exits 0", () => {
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Complexity report/);
  assert.match(result.stdout, /registrations, not endpoints/);
  assert.match(result.stdout, /Persistent-state files/);
});
