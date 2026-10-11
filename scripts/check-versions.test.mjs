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
