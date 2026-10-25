// Every manifest that carries the app's version must carry the same one. The release
// checks the tag against desktop/package.json only after the image has shipped, so a
// forgotten bump there surfaces as a failed desktop build on a version already out.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

/**
 * The Android TV app carries no version of its own: `versionName` is read from the root
 * package.json at build time, so a literal would silently drift from the shared version.
 * Throws with the reason when the Gradle file is not wired to the root version.
 */
export function assertGradleVersion(source) {
  const literal = source.match(/versionName\s*=\s*"([^"]+)"/);
  if (literal) {
    throw new Error(
      `android-tv/app/build.gradle.kts carries the literal versionName "${literal[1]}"; it must read ` +
      `versionName from the root package.json (versionName = sharedVersion).`,
    );
  }
  if (!/versionName\s*=\s*sharedVersion\b/.test(source)) {
    throw new Error(
      "android-tv/app/build.gradle.kts does not read versionName from the root package.json " +
      "(expected `versionName = sharedVersion`).",
    );
  }
  // `sharedVersion` itself has to come from the root package.json: a local `val sharedVersion =
  // "0.5.36"` would satisfy the two checks above while drifting exactly like a literal would.
  if (!/rootProject\.file\(\s*["']\.\.\/package\.json["']\s*\)/.test(source) || !/readText\(\)/.test(source)) {
    throw new Error(
      "android-tv/app/build.gradle.kts names versionName = sharedVersion but does not read the " +
      'root package.json (expected rootProject.file("../package.json").readText()).',
    );
  }
}

/** Exported so the check runs only when this file is executed, not when a test imports it. */
export function main(argv = process.argv) {
  const lock = read("package-lock.json");
  const versions = {
    "package.json": read("package.json").version,
    "packages/source-selection/package.json": read("packages/source-selection/package.json").version,
    "server/package.json": read("server/package.json").version,
    "web/package.json": read("web/package.json").version,
    "desktop/package.json": read("desktop/package.json").version,
    "package-lock.json": lock.version,
    'package-lock.json packages[""]': lock.packages[""]?.version,
    'package-lock.json packages["packages/source-selection"]': lock.packages["packages/source-selection"]?.version,
    "package-lock.json packages.server": lock.packages.server?.version,
    "package-lock.json packages.web": lock.packages.web?.version,
    "package-lock.json packages.desktop": lock.packages.desktop?.version,
  };
  const expected = versions["package.json"];
  const tag = argv[2]?.replace(/^v/, "");
  const wrong = Object.entries(versions).filter(([, version]) => version !== (tag ?? expected));
  const gradle = readFileSync(new URL("../android-tv/app/build.gradle.kts", import.meta.url), "utf8");
  let gradleError;
  try {
    assertGradleVersion(gradle);
  } catch (error) {
    gradleError = error.message;
  }
  if (wrong.length || gradleError) {
    if (wrong.length) {
      console.error(`Versions disagree; all must be ${tag ?? expected}${tag ? ` to match the tag` : ""}:`);
      for (const [file, version] of Object.entries(versions)) console.error(`  ${wrong.some(([name]) => name === file) ? "✗" : "✓"} ${file}: ${version}`);
    }
    if (gradleError) console.error(gradleError);
    return 1;
  }
  console.log(`All manifests are at ${expected}.`);
  console.log("The Android app reads its versionName from the root package.json.");
  return 0;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exit(main());
