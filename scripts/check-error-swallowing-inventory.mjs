#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inventoryPath = join(root, "docs", "bug-hunt-error-swallowing-inventory.md");
const targets = ["server/src", "web/src", "desktop/src", "android-tv"];
const extensions = new Set([".cjs", ".java", ".js", ".jsx", ".kt", ".mjs", ".ts", ".tsx"]);
const excludedDirectories = new Set([
  "__tests__", "build", "dist", "fixture", "fixtures", "generated", "test", "tests", "vendor", "vendored",
]);
const patterns = [".catch(() => {})", ".catch(() => undefined)"];

const walk = async (path) => {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) files.push(...await walk(join(path, entry.name)));
    } else if (
      entry.isFile()
      && extensions.has(extname(entry.name))
      && !/\.(?:test|spec)\.[^.]+$/i.test(entry.name)
    ) {
      files.push(join(path, entry.name));
    }
  }
  return files.sort();
};

const source = new Map();
for (const target of targets) {
  for (const file of await walk(join(root, target))) {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((text, index) => {
      let count = 0;
      for (const pattern of patterns) {
        for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, at + pattern.length)) count += 1;
      }
      if (count > 0) {
        const path = relative(root, file).split(sep).join("/");
        source.set(`${path}:${index + 1}`, { count, text: text.trim() });
      }
    });
  }
}

const document = await readFile(inventoryPath, "utf8");
const inventoryStart = document.indexOf("## Complete inventory");
const summaryStart = document.indexOf("## Needs-review candidates");
const countsStart = document.indexOf("## Counts");
if (inventoryStart === -1 || summaryStart === -1 || countsStart === -1 || summaryStart < inventoryStart) {
  throw new Error("The inventory, counts, and needs-review sections are required.");
}

const inventory = document.slice(inventoryStart, summaryStart);
const rows = [];
for (const text of inventory.split("\n")) {
  const match = /^\| `([^`]+:\d+)` \| `(\.catch\(\(\) => (?:undefined|\{\})\))` \|/.exec(text);
  if (!match) continue;
  rows.push({ key: match[1], pattern: match[2], text });
}

const errors = [];
const compareKeys = (left, right) => {
  const leftSplit = left.lastIndexOf(":");
  const rightSplit = right.lastIndexOf(":");
  const leftPath = left.slice(0, leftSplit);
  const rightPath = right.slice(0, rightSplit);
  const pathOrder = leftPath === rightPath ? 0 : leftPath < rightPath ? -1 : 1;
  return pathOrder || Number(left.slice(leftSplit + 1)) - Number(right.slice(rightSplit + 1));
};
const expectedOrder = [...source.keys()].sort(compareKeys);
for (let index = 0; index < rows.length; index += 1) {
  if (rows[index].key !== expectedOrder[index]) {
    errors.push(`inventory order differs at row ${index + 1}: ${rows[index].key} should be ${expectedOrder[index]}`);
    break;
  }
}

const seen = new Set();
for (const row of rows) {
  if (seen.has(row.key)) errors.push(`duplicate inventory row: ${row.key}`);
  seen.add(row.key);
  const occurrence = source.get(row.key);
  if (!occurrence) {
    errors.push(`row has no current source match: ${row.key}`);
    continue;
  }
  if (occurrence.count !== 1) errors.push(`${row.key} has ${occurrence.count} matches on one line; list each separately`);
  if (!occurrence.text.includes(row.pattern)) errors.push(`${row.key} does not contain ${row.pattern}`);
  const cells = row.text.split("|");
  if (cells.length !== 8) errors.push(`${row.key} must have six table cells`);
  if (!/\| (?:best effort|needs review) \|/.test(row.text)) errors.push(`${row.key} has an invalid classification`);
  if (!/\| BH-\d+\.\d+(?:-[A-Za-z0-9.]+)? \|/.test(row.text)) errors.push(`${row.key} has no owning plan unit`);
}
for (const key of source.keys()) if (!seen.has(key)) errors.push(`current source match is missing from inventory: ${key}`);

const declared = Number(/Total production occurrences: \*\*(\d+)\*\*/.exec(document)?.[1]);
if (declared !== source.size) errors.push(`document declares ${declared}; source has ${source.size}`);
if (rows.length !== source.size) errors.push(`inventory has ${rows.length} rows; source has ${source.size} occurrences`);

const countSection = document.slice(countsStart, inventoryStart);
const packageCounts = new Map();
const fileCounts = new Map();
for (const text of countSection.split("\n")) {
  const packageMatch = /^\| (desktop|server|web) \| (\d+) \|$/.exec(text);
  if (packageMatch) packageCounts.set(packageMatch[1], Number(packageMatch[2]));
  const fileMatch = /^\| `([^`]+)` \| (\d+) \|$/.exec(text);
  if (fileMatch) fileCounts.set(fileMatch[1], Number(fileMatch[2]));
}
const expectedPackages = new Map();
const expectedFiles = new Map();
for (const key of source.keys()) {
  const path = key.slice(0, key.lastIndexOf(":"));
  const packageName = path.split("/")[0];
  expectedPackages.set(packageName, (expectedPackages.get(packageName) ?? 0) + 1);
  expectedFiles.set(path, (expectedFiles.get(path) ?? 0) + 1);
}
for (const [name, count] of expectedPackages) {
  if (packageCounts.get(name) !== count) errors.push(`package count for ${name} is ${packageCounts.get(name) ?? "missing"}; expected ${count}`);
}
for (const [path, count] of expectedFiles) {
  if (fileCounts.get(path) !== count) errors.push(`file count for ${path} is ${fileCounts.get(path) ?? "missing"}; expected ${count}`);
}

const summaryEnd = document.indexOf("\n## ", summaryStart + 1);
const summary = document.slice(summaryStart, summaryEnd === -1 ? undefined : summaryEnd);
const needsReview = rows.filter(({ text }) => /\| needs review \|/.test(text));
const prioritySections = [
  ["P0", summary.indexOf("### P0"), summary.indexOf("### P1")],
  ["P1", summary.indexOf("### P1"), summary.indexOf("### P2")],
  ["P2", summary.indexOf("### P2"), summary.indexOf("### Risk highlights")],
];
const priorityCounts = new Map();
for (const [priority, start, end] of prioritySections) {
  if (start === -1 || end === -1 || end <= start) {
    errors.push(`missing or malformed ${priority} summary section`);
    continue;
  }
  const section = summary.slice(start, end);
  const refs = [...section.matchAll(/`((?:desktop|server|web)\/src\/[^`]+:\d+)`/g)].map((match) => match[1]);
  const unique = new Set(refs);
  if (unique.size !== refs.length) errors.push(`${priority} summary repeats a candidate`);
  priorityCounts.set(priority, unique.size);
}
const summaryCandidates = new Set();
for (const [priority, start, end] of prioritySections) {
  if (start === -1 || end === -1) continue;
  for (const match of summary.slice(start, end).matchAll(/`((?:desktop|server|web)\/src\/[^`]+:\d+)`/g)) summaryCandidates.add(match[1]);
}
for (const row of needsReview) {
  if (!summaryCandidates.has(row.key)) errors.push(`needs-review candidate is absent from priority summary: ${row.key}`);
}
for (const key of summaryCandidates) {
  if (!needsReview.some(({ key: candidate }) => candidate === key)) errors.push(`priority summary includes a non-candidate: ${key}`);
}
const declaredPriorities = /There are \d+ candidates: (\d+) P0, (\d+) P1 and (\d+) P2\./.exec(summary);
if (!declaredPriorities) {
  errors.push("candidate totals by priority are missing");
} else {
  for (const [index, priority] of ["P0", "P1", "P2"].entries()) {
    const declaredCount = Number(declaredPriorities[index + 1]);
    if (priorityCounts.get(priority) !== declaredCount) {
      errors.push(`${priority} summary has ${priorityCounts.get(priority) ?? 0} candidates; declared ${declaredCount}`);
    }
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  const packageSummary = [...expectedPackages].sort().map(([name, count]) => `${name} ${count}`).join(", ");
  console.log(`error-swallowing inventory ok: ${rows.length} rows, ${needsReview.length} needs review, ${rows.length - needsReview.length} best effort (${packageSummary})`);
}
