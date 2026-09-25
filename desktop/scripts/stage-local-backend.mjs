// Stages the built server and web output under desktop/runtime for packaging. The layout keeps
// the server's own `../../web` calculation working: runtime/server/dist/index.js next to
// runtime/web. The server's production dependencies are copied in as well, because the packaged
// app archive does not carry the root workspace's node_modules.
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const rootDir = path.resolve(desktopDir, "..");
const serverDir = path.join(rootDir, "server");
const webDir = path.join(rootDir, "web");
const runtimeDir = path.join(desktopDir, "runtime");
const runtimeServerDir = path.join(runtimeDir, "server");
const runtimeModulesDir = path.join(runtimeServerDir, "node_modules");

const exists = async (target) => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

const requirePath = async (target, hint) => {
  if (!await exists(target)) throw new Error(`${path.relative(rootDir, target)} is missing. ${hint}`);
};

/** Node's own lookup: `<dir>/node_modules/<name>`, then each parent directory in turn. */
const resolveDependency = (name, fromDir) => {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

const readManifest = async (dir) => JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));

/** The whole production closure, each package copied flat. Nested node_modules come along. */
const stageDependencies = async () => {
  const staged = new Set();
  const stageOne = async (name, fromDir) => {
    if (staged.has(name)) return;
    const source = resolveDependency(name, fromDir);
    if (source === null) throw new Error(`the dependency ${name} is not installed; run npm ci first`);
    staged.add(name);
    await cp(source, path.join(runtimeModulesDir, name), { recursive: true, dereference: true });
    const manifest = await readManifest(source);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) await stageOne(dependency, source);
  };
  const manifest = await readManifest(serverDir);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) await stageOne(dependency, serverDir);
  return [...staged].sort();
};

const main = async () => {
  await requirePath(path.join(serverDir, "dist", "index.js"), "Run `npm run build` in the repository root first.");
  await requirePath(path.join(webDir, "dist", "index.html"), "Run `npm run build` in the repository root first.");

  await rm(runtimeDir, { recursive: true, force: true });
  await mkdir(runtimeModulesDir, { recursive: true });

  // The server package manifest travels with its dist so Node reads it as ESM.
  await cp(path.join(serverDir, "dist"), path.join(runtimeServerDir, "dist"), { recursive: true });
  await cp(path.join(serverDir, "package.json"), path.join(runtimeServerDir, "package.json"));
  await cp(path.join(webDir, "dist"), path.join(runtimeDir, "web"), { recursive: true });

  const dependencies = await stageDependencies();
  await writeFile(path.join(runtimeDir, "staged.json"), JSON.stringify({ dependencies }, null, 2) + "\n", "utf8");
  process.stdout.write(`staged the local backend: ${dependencies.length} packages under ${path.relative(rootDir, runtimeDir)}\n`);
};

main().catch((error) => {
  process.stderr.write(`stage-local-backend: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
