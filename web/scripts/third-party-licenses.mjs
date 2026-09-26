// Writes the licence texts of every package the web bundle carries into the build output, so
// the interface ships them wherever it is served: the image, the desktop app, a plain build.
// Only production dependencies, followed transitively; dev tools never reach the bundle.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = path.resolve(process.argv[2] ?? path.join(webDir, "dist", "third-party-licenses.txt"));

const packageDirOf = (name, fromDir) => {
  const require = createRequire(path.join(fromDir, "package.json"));
  return path.dirname(require.resolve(`${name}/package.json`, { paths: [fromDir] }));
};

const seen = new Map();
const visit = (name, fromDir) => {
  const dir = packageDirOf(name, fromDir);
  const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const key = `${manifest.name}@${manifest.version}`;
  if (seen.has(key)) return;
  const licenceFile = readdirSync(dir).find((file) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file));
  if (!licenceFile) throw new Error(`${key} ships no licence file; add its text by hand before releasing.`);
  const notices = readdirSync(dir).filter((file) => /^notice(\.|$)/i.test(file) && file !== licenceFile);
  const texts = [licenceFile, ...notices].map((file) => readFileSync(path.join(dir, file), "utf8").trim());
  seen.set(key, { key, licence: manifest.license ?? "see text", texts });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, dir);
};

const root = JSON.parse(readFileSync(path.join(webDir, "package.json"), "utf8"));
for (const dependency of Object.keys(root.dependencies ?? {})) visit(dependency, webDir);

const entries = [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
const rule = "-".repeat(78);
const body = [
  "Third-party software in the Stremio Offline web interface",
  "",
  "The interface bundles the packages below. Each keeps its own licence, reproduced here.",
  "Stremio Offline itself is MIT-licensed; see LICENSE and docs/licensing.md in the repository.",
  "",
  ...entries.flatMap((entry) => [rule, `${entry.key} (${entry.licence})`, rule, "", ...entry.texts.flatMap((text) => [text, ""])]),
].join("\n");
writeFileSync(output, body);
console.log(`third-party-licenses: ${entries.length} packages -> ${path.relative(process.cwd(), output)}`);
