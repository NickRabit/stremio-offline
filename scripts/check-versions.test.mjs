import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertGradleVersion } from "./check-versions.mjs";

const gradlePath = new URL("../android-tv/app/build.gradle.kts", import.meta.url);

test("accepts the Gradle file that reads the version from the root package.json", () => {
  assert.doesNotThrow(() => assertGradleVersion(readFileSync(gradlePath, "utf8")));
});

test("fails on a literal versionName", () => {
  assert.throws(
    () => assertGradleVersion('android {\n  defaultConfig {\n    versionName = "0.5.37"\n  }\n}'),
    /literal versionName "0\.5\.37"/,
  );
});

test("fails when the Gradle file does not read the root version", () => {
  assert.throws(() => assertGradleVersion("android {\n}\n"), /does not read versionName/);
});

test("fails when the shared version is a literal in the Gradle file", () => {
  const source = [
    'val sharedVersion = "0.5.36"',
    "android {",
    "  defaultConfig {",
    "    versionName = sharedVersion",
    "  }",
    "}",
  ].join("\n");
  assert.throws(() => assertGradleVersion(source), /does not read the root package\.json/);
});

test("fails when the Gradle file names a shared version without reading the root package.json", () => {
  const source = [
    'val sharedVersion = Regex("version").find(File("package.json").readText())!!.groupValues[1]',
    "android {",
    "  defaultConfig {",
    "    versionName = sharedVersion",
    "  }",
    "}",
  ].join("\n");
  assert.throws(() => assertGradleVersion(source), /does not read the root package\.json/);
});
