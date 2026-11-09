import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mergeProcessCovs } from "@bcoe/v8-coverage";
import astV8ToIstanbul from "ast-v8-to-istanbul";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";
import { parseAstAsync } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "coverage");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// The node:test suites run under tsx. Their files are converted the way Vitest converts the web
// suite -- statements, branches and functions from the syntax tree of the code V8 ran -- so the
// four workspaces count the same things and can be added up. That code is read back from tsx's
// cache; Node's recorded line lengths pick the entry that matches what ran. A file no test
// loaded is transpiled here only to be counted at zero.
const esbuild = createRequire(createRequire(import.meta.url).resolve("tsx"))("esbuild");
const transpile = (source, file) => esbuild.transform(source, {
  target: `node${process.versions.node}`,
  loader: "ts",
  format: "esm",
  sourcemap: true,
  sourcesContent: true,
  minifyWhitespace: true,
  keepNames: true,
  sourcefile: file,
});

const runs = [
  { name: "source-selection", dir: "packages/source-selection", script: ["run", "test", "-w", "@stremio-offline/source-selection"] },
  { name: "server", dir: "server", script: ["run", "test", "-w", "@stremio-offline/server"] },
  { name: "desktop", dir: "desktop", script: ["run", "test", "-w", "@stremio-offline/desktop"] },
];
const reporters = ["text-summary", "html", "json", "json-summary", "lcovonly"];

const metrics = ["lines", "statements", "functions", "branches"];
const labels = {
  "source-selection": "Source selection",
  server: "Server",
  web: "Web",
  desktop: "Desktop",
};

const run = (command, args, env = {}) => {
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  execFileSync(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: "inherit" });
};

const readSummary = async (workspace) => {
  const file = path.join(output, workspace, "coverage-summary.json");
  return JSON.parse(await readFile(file, "utf8")).total;
};

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const productionFiles = async (dir) => {
  const src = path.join(root, dir, "src");
  const entries = await readdir(src, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts"))
    .map((entry) => path.join(src, entry))
    .sort();
};

// tsx wraps every dynamic import() in `.then(s => { const e = "default"; ... })` for CommonJS
// interop. The wrapper is not in the source, so it is left out of the counts.
const tsxInterop = (node) =>
  node.type === "ArrowFunctionExpression" &&
  node.body.type === "BlockStatement" &&
  node.body.body[0]?.type === "VariableDeclaration" &&
  node.body.body[0].declarations[0]?.init?.value === "default";

const tsxCacheDirectory = path.join(os.tmpdir(), `tsx-${os.userInfo().uid}`);

const tsxCache = async (dir) => {
  const prefix = path.join(root, dir, "src") + path.sep;
  const byFile = new Map();
  for (const name of await readdir(tsxCacheDirectory)) {
    const text = await readFile(path.join(tsxCacheDirectory, name), "utf8");
    if (!text.includes(JSON.stringify(prefix).slice(1, -1))) continue;
    const entry = JSON.parse(text);
    const map = typeof entry.map === "string" ? JSON.parse(entry.map) : entry.map;
    const file = map?.sources?.length === 1 ? map.sources[0] : null;
    if (file?.startsWith(prefix)) byFile.set(file, [...(byFile.get(file) ?? []), { code: entry.code, map }]);
  }
  return byFile;
};

const collect = async (item) => {
  const raw = await mkdtemp(path.join(os.tmpdir(), `coverage-${item.name}-`));
  try {
    run(npm, item.script, { NODE_V8_COVERAGE: raw });

    const files = await productionFiles(item.dir);
    const wanted = new Set(files.map((file) => pathToFileURL(file).href));
    const processes = [];
    const lineLengths = new Map();
    for (const name of await readdir(raw)) {
      const dump = JSON.parse(await readFile(path.join(raw, name), "utf8"));
      processes.push({ result: dump.result.filter((script) => wanted.has(script.url)) });
      for (const [url, entry] of Object.entries(dump["source-map-cache"] ?? {})) {
        if (wanted.has(url)) lineLengths.set(url, entry.lineLengths);
      }
    }
    const executed = new Map(mergeProcessCovs(processes).result.map((script) => [script.url, script.functions]));
    const cache = await tsxCache(item.dir);

    const coverageMap = libCoverage.createCoverageMap({});
    for (const file of files) {
      const url = pathToFileURL(file).href;
      const functions = executed.get(url) ?? [];
      let code;
      let sourceMap;
      if (functions.length) {
        // tsx appends an inline source map after the code, which Node counts as further lines.
        const recorded = lineLengths.get(url) ?? [];
        const ran = (cache.get(file) ?? []).find((entry) => {
          const lengths = entry.code.split("\n").map((line) => line.length);
          return lengths.join() === recorded.slice(0, lengths.length).join();
        });
        if (!ran) throw new Error(`tsx left no cached code for ${path.relative(root, file)} that matches what it ran`);
        ({ code, map: sourceMap } = ran);
      } else {
        const result = await transpile(await readFile(file, "utf8"), file);
        code = result.code;
        sourceMap = JSON.parse(result.map);
      }
      sourceMap = { ...sourceMap, sources: [url] };
      coverageMap.merge(await astV8ToIstanbul({
        code,
        sourceMap,
        ast: parseAstAsync(code),
        coverage: { url, functions },
        ignoreNode: (node) => (tsxInterop(node) ? "ignore-this-and-nested-nodes" : undefined),
      }));
    }

    const context = libReport.createContext({ dir: path.join(output, item.name), coverageMap, defaultSummarizer: "nested" });
    for (const reporter of reporters) reports.create(reporter).execute(context);
    await writeFile(path.join(output, item.name, "coverage-summary.json"), JSON.stringify({ total: coverageMap.getCoverageSummary().toJSON() }));
  } finally {
    await rm(raw, { recursive: true, force: true });
  }
};

for (const item of runs) await collect(item);

run(npm, ["run", "test:coverage", "-w", "@stremio-offline/web"]);

const workspaces = {};
for (const name of Object.keys(labels)) {
  workspaces[name] = await readSummary(name);
}

const total = Object.fromEntries(metrics.map((metric) => {
  const counts = Object.values(workspaces).map((workspace) => workspace[metric]);
  const covered = counts.reduce((sum, item) => sum + item.covered, 0);
  const denominator = counts.reduce((sum, item) => sum + item.total, 0);
  const skipped = counts.reduce((sum, item) => sum + (item.skipped ?? 0), 0);
  return [metric, {
    total: denominator,
    covered,
    skipped,
    pct: denominator ? Number(((covered / denominator) * 100).toFixed(2)) : 100,
  }];
}));

const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const report = {
  generatedAt: new Date().toISOString(),
  commit,
  scope: "Production TypeScript and TSX in source-selection, server, web and desktop",
  excluded: [
    "test files and test setup",
    "generated and build output",
    "translation catalogues",
    "Android TV",
    "Playwright E2E browser execution",
  ],
  workspaces,
  total,
};

await writeFile(path.join(output, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);

const percent = (value) => `${value.toFixed(2)} %`;
const markdownRows = Object.entries(workspaces).map(([name, value]) =>
  `| ${labels[name]} | ${percent(value.lines.pct)} | ${percent(value.branches.pct)} | ${percent(value.functions.pct)} | ${percent(value.statements.pct)} |`,
);
const markdown = [
  "# Stremio Offline coverage",
  "",
  `Commit: \`${commit}\``,
  "",
  `Generated: ${report.generatedAt}`,
  "",
  "| Workspace | Lines | Branches | Functions | Statements |",
  "| --- | ---: | ---: | ---: | ---: |",
  ...markdownRows,
  `| **Total** | **${percent(total.lines.pct)}** | **${percent(total.branches.pct)}** | **${percent(total.functions.pct)}** | **${percent(total.statements.pct)}** |`,
  "",
  "Coverage is collected from unit and integration tests. Playwright E2E execution, iOS device behaviour, Android TV and visual regression are reported separately.",
  "",
].join("\n");
await writeFile(path.join(output, "summary.md"), markdown);

const summaryNode = (name, value) =>
  `<tr><td><a href="${name}/index.html">${labels[name]}</a></td><td>${percent(value.lines.pct)}</td><td>${percent(value.branches.pct)}</td><td>${percent(value.functions.pct)}</td><td>${percent(value.statements.pct)}</td></tr>`;
const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stremio Offline coverage</title>
<style>
  :root { color-scheme: dark; font: 16px/1.5 system-ui, sans-serif; background: #11131a; color: #eef0f5; }
  body { max-width: 980px; margin: 40px auto; padding: 0 24px; }
  h1 { margin-bottom: .25rem; }
  p { color: #aeb5c4; }
  table { width: 100%; border-collapse: collapse; margin: 2rem 0; }
  th, td { padding: .75rem 1rem; border-bottom: 1px solid #353a47; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  a { color: #ff815a; }
  .total { font-weight: 700; background: #1d202a; }
</style>
<h1>Stremio Offline coverage</h1>
<p>Commit <code>${commit}</code>, generated ${report.generatedAt}</p>
<p>Production TypeScript and TSX. Tests, generated code, translation catalogues, Android TV and Playwright browser execution are excluded from this unit/integration total.</p>
<table>
  <thead><tr><th>Workspace</th><th>Lines</th><th>Branches</th><th>Functions</th><th>Statements</th></tr></thead>
  <tbody>
    ${Object.entries(workspaces).map(([name, value]) => summaryNode(name, value)).join("\n    ")}
    <tr class="total"><td>Total</td><td>${percent(total.lines.pct)}</td><td>${percent(total.branches.pct)}</td><td>${percent(total.functions.pct)}</td><td>${percent(total.statements.pct)}</td></tr>
  </tbody>
</table>
</html>
`;
await writeFile(path.join(output, "index.html"), html);

console.log(`\n${markdown}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  await writeFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`, { flag: "a" });
}
