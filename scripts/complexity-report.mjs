#!/usr/bin/env node
/**
 * Report-only complexity snapshot for this repository. It prints a short Markdown
 * report and always exits 0, so it is never a CI gate. Run it by hand or from a
 * maintenance task and compare the numbers over time.
 *
 *   node scripts/complexity-report.mjs          # Markdown
 *   node scripts/complexity-report.mjs --json   # the same data as JSON
 *
 * The script's own test lives next to it and is not part of `npm test`, which
 * only runs the workspaces. Run it directly:
 *
 *   node --test scripts/complexity-report.test.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PRODUCTION_DIRS = ["server/src", "web/src", "desktop/src"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".git", "release", "coverage", "__screenshots__"]);
const LARGEST_COUNT = 15;

const WORKSPACES = [
  { name: "server", manifest: "server/package.json", sourceDir: "server/src" },
  { name: "web", manifest: "web/package.json", sourceDir: "web/src" },
  { name: "desktop", manifest: "desktop/package.json", sourceDir: "desktop/src" },
];
const E2E_DIRS = ["e2e", "desktop/e2e"];

const toPosix = (value) => value.split(path.sep).join("/");

function walk(rootRelative) {
  const root = path.join(repoRoot, rootRelative);
  const found = [];
  const visit = (absolute) => {
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        visit(path.join(absolute, entry.name));
      } else if (entry.isFile()) {
        found.push(path.relative(repoRoot, path.join(absolute, entry.name)));
      }
    }
  };
  visit(root);
  return found;
}

const isTestFile = (relative) => /\.(test|spec)\.(ts|tsx)$/.test(relative);
const isTranslationCatalogue = (relative) => toPosix(relative).startsWith("web/src/i18n/");

function productionSourceFiles() {
  return PRODUCTION_DIRS
    .flatMap((dir) => walk(dir))
    .filter((relative) => SOURCE_EXTENSIONS.has(path.extname(relative)))
    .filter((relative) => !isTestFile(relative))
    .filter((relative) => !isTranslationCatalogue(relative));
}

function lineCount(relative) {
  const text = readFileSync(path.join(repoRoot, relative), "utf8");
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function largestProductionFiles() {
  return productionSourceFiles()
    .map((file) => ({ file: toPosix(file), lines: lineCount(file) }))
    .sort((left, right) => right.lines - left.lines || left.file.localeCompare(right.file))
    .slice(0, LARGEST_COUNT);
}

/** Route registrations in production server source. This counts `app.get(...)`-style
 *  registrations, not distinct endpoints: one registration can serve several paths, and
 *  the SPA fallback is one of them. */
function routeRegistrations() {
  const registration = /\bapp\.(get|post|put|patch|delete|head|options)\s*\(/g;
  let count = 0;
  for (const file of productionSourceFiles()) {
    if (!toPosix(file).startsWith("server/src/")) continue;
    const text = readFileSync(path.join(repoRoot, file), "utf8");
    count += (text.match(registration) ?? []).length;
  }
  return count;
}

function testFileCounts() {
  const perWorkspace = {};
  for (const workspace of WORKSPACES) {
    perWorkspace[workspace.name] = walk(workspace.sourceDir).filter(isTestFile).length;
  }
  const e2e = E2E_DIRS.flatMap((dir) => walk(dir)).filter((file) => file.endsWith(".spec.ts")).length;
  return { perWorkspace, e2e };
}

function directDependencies() {
  const perWorkspace = {};
  for (const workspace of WORKSPACES) {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, workspace.manifest), "utf8"));
    perWorkspace[workspace.name] = Object.keys(manifest.dependencies ?? {}).length;
  }
  return perWorkspace;
}

/**
 * The persistent-state files the server writes under `DATA_DIR`, found by reading the
 * source rather than this list: a literal handed to `path.join(dataDir | DATA_DIR, "…")`
 * is a file directly under the data directory, and a literal handed to a helper that
 * joins a known subdirectory (`this.dir`, `libraryDir`, `fileIn`) is a file inside it.
 */
function persistentStateFiles() {
  const names = new Set();
  const joinCall = /path\.join\(\s*([^,()]+?)\s*,\s*"([^"]+)"\s*\)/g;
  const directoryAssign = /([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)\s*=>\s*)?path\.join\(\s*[^,()]*(?:dataDir|DATA_DIR)[^,()]*\s*,\s*"([^"]+)"\s*\)/g;
  const delegatingHelper = /([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>\s*path\.join\(\s*([A-Za-z_$][\w$]*)\s*\(/g;
  const helperCall = /([A-Za-z_$][\w$]*)\s*\([^,()]*(?:dataDir|DATA_DIR)[^,()]*,\s*(?:"([^"]+)"|`\$\{(\w+)\}\.(\w+)`)\s*\)/g;

  for (const file of productionSourceFiles()) {
    if (!toPosix(file).startsWith("server/src/")) continue;
    const text = readFileSync(path.join(repoRoot, file), "utf8");

    const directories = new Map();
    for (const match of text.matchAll(directoryAssign)) {
      directories.set(match[1], match[2]);
      directories.set(`this.${match[1]}`, match[2]);
    }
    // A helper that delegates to another (`fileIn` -> `libraryDir`) keeps the same directory.
    for (const [, helper, delegate] of text.matchAll(delegatingHelper)) {
      const directory = directories.get(delegate);
      if (directory) directories.set(helper, directory);
    }

    for (const match of text.matchAll(joinCall)) {
      const [, base, literal] = match;
      if (/dataDir|DATA_DIR/.test(base)) {
        // A bare name with no extension is a directory (`library`, `images`); its files are
        // picked up below through the variable that names it.
        if (literal.includes(".")) names.add(literal);
      } else {
        const directory = directories.get(base.trim());
        if (directory) names.add(`${directory}/${literal}`);
      }
    }

    for (const match of text.matchAll(helperCall)) {
      const [, helper, literal, templateName, templateExtension] = match;
      const directory = directories.get(helper);
      if (!directory) continue;
      if (literal) names.add(`${directory}/${literal}`);
      else names.add(`${directory}/<${templateName}>.${templateExtension}`);
    }
  }
  return [...names].sort();
}

function collect() {
  return {
    largestFiles: largestProductionFiles(),
    routeRegistrations: routeRegistrations(),
    testFiles: testFileCounts(),
    directDependencies: directDependencies(),
    persistentStateFiles: persistentStateFiles(),
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Complexity report");
  lines.push("");
  lines.push("Report-only: this is a snapshot to compare trends, not a CI gate.");
  lines.push("");
  lines.push(`## ${LARGEST_COUNT} largest production source files`);
  lines.push("");
  lines.push("Lines in `server/src`, `web/src` and `desktop/src` (`.ts`, `.tsx`, `.css`),");
  lines.push("excluding tests, generated output and the translation catalogues.");
  lines.push("");
  lines.push("| Lines | File |");
  lines.push("| ---: | --- |");
  for (const entry of report.largestFiles) lines.push(`| ${entry.lines} | \`${entry.file}\` |`);
  lines.push("");
  lines.push("## Route registrations");
  lines.push("");
  lines.push(`${report.routeRegistrations} \`app.get/post/put/patch/delete/head/options\` registrations in production server source.`);
  lines.push("These are registrations, not endpoints: one registration can serve several paths.");
  lines.push("");
  lines.push("## Unit-test files per workspace");
  lines.push("");
  lines.push("| Workspace | Files |");
  lines.push("| --- | ---: |");
  for (const workspace of WORKSPACES) lines.push(`| ${workspace.name} | ${report.testFiles.perWorkspace[workspace.name]} |`);
  lines.push("");
  lines.push(`End-to-end spec files (\`e2e\`, \`desktop/e2e\`): ${report.testFiles.e2e}.`);
  lines.push("");
  lines.push("## Direct runtime dependencies per manifest");
  lines.push("");
  lines.push("| Workspace | Dependencies |");
  lines.push("| --- | ---: |");
  for (const workspace of WORKSPACES) lines.push(`| ${workspace.name} | ${report.directDependencies[workspace.name]} |`);
  lines.push("");
  lines.push("## Persistent-state files under `DATA_DIR`");
  lines.push("");
  lines.push("Found in the server source; `<id>` or `<name>` stands for a value chosen at run time.");
  lines.push("");
  for (const name of report.persistentStateFiles) lines.push(`- \`${name}\``);
  lines.push("");
  return lines.join("\n");
}

function main() {
  const report = collect();
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(renderMarkdown(report));
}

main();
