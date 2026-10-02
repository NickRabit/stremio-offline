// Every manifest that carries the app's version must carry the same one. The release
// checks the tag against desktop/package.json only after the image has shipped, so a
// forgotten bump there surfaces as a failed desktop build on a version already out.
import { readFileSync } from "node:fs";

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
const lock = read("package-lock.json");
const versions = {
  "package.json": read("package.json").version,
  "server/package.json": read("server/package.json").version,
  "web/package.json": read("web/package.json").version,
  "desktop/package.json": read("desktop/package.json").version,
  "package-lock.json": lock.version,
  'package-lock.json packages[""]': lock.packages[""]?.version,
  "package-lock.json packages.server": lock.packages.server?.version,
  "package-lock.json packages.web": lock.packages.web?.version,
  "package-lock.json packages.desktop": lock.packages.desktop?.version,
};
const expected = versions["package.json"];
const tag = process.argv[2]?.replace(/^v/, "");
const wrong = Object.entries(versions).filter(([, version]) => version !== (tag ?? expected));
if (wrong.length) {
  console.error(`Versions disagree; all must be ${tag ?? expected}${tag ? ` to match the tag` : ""}:`);
  for (const [file, version] of Object.entries(versions)) console.error(`  ${wrong.some(([name]) => name === file) ? "✗" : "✓"} ${file}: ${version}`);
  process.exit(1);
}
console.log(`All manifests are at ${expected}.`);
