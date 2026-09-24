#!/usr/bin/env node
// Reads the Electron Fuse V1 wire back from a packaged .app so a build with a
// silently missing or unreviewed fuse cannot be uploaded.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FuseV1Options, FuseVersion, getCurrentFuseWire } from "@electron/fuses";

// Wire values from @electron/fuses, which exposes them as numbers only.
const DISABLED = 48;
const ENABLED = 49;
const STATE_NAMES = { 48: "disabled", 49: "enabled", 114: "removed", 144: "inherited" };

// The reviewed Fuse V1 state. Every fuse name the installed schema exposes has
// to appear here, so a new name in @electron/fuses fails the check until it has
// been reviewed. See desktop/README.md for why EnableCookieEncryption stays off.
const REVIEWED_FUSES = {
  RunAsNode: false,
  EnableCookieEncryption: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: true,
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultAppPath = path.resolve(scriptDir, "..", "release", "mac-arm64", "Stremio Offline.app");
const appPath = path.resolve(process.argv[2] ?? defaultAppPath);

const describe = (state) => STATE_NAMES[state] ?? `unknown (${state})`;
const errors = [];

const finish = () => {
  if (errors.length === 0) {
    console.log(`verify-fuses: all reviewed fuses match in ${appPath}`);
    process.exit();
  }
  for (const error of errors) console.error(`verify-fuses: ${error}`);
  process.exit(1);
};

if (!existsSync(appPath)) {
  errors.push(`packaged app not found at ${appPath}; run the packaging script first`);
  finish();
}

// The installed schema must not grow past the reviewed set without review.
const schemaNames = Object.keys(FuseV1Options).filter((name) => !/^\d+$/.test(name));
const reviewedNames = Object.keys(REVIEWED_FUSES);
for (const name of schemaNames.filter((name) => !reviewedNames.includes(name))) {
  errors.push(`the installed fuse schema adds "${name}"; review it and update REVIEWED_FUSES`);
}
for (const name of reviewedNames.filter((name) => !schemaNames.includes(name))) {
  errors.push(`the reviewed fuse "${name}" is missing from the installed schema`);
}
if (errors.length > 0) finish();

const wire = await getCurrentFuseWire(appPath).catch((error) => {
  errors.push(`could not read the fuse wire: ${error.message}`);
});
if (wire == null) finish();

if (wire.version !== FuseVersion.V1) {
  errors.push(`unexpected fuse wire version ${wire.version}, expected ${FuseVersion.V1}`);
}

for (const name of reviewedNames) {
  const expected = REVIEWED_FUSES[name] ? ENABLED : DISABLED;
  const actual = wire[FuseV1Options[name]];
  const status = actual === expected ? "ok" : "MISMATCH";
  console.log(`${status.padEnd(8)} ${name} = ${describe(actual)} (expected ${describe(expected)})`);
  if (actual !== expected) {
    errors.push(`${name} is ${describe(actual)}, expected ${describe(expected)}`);
  }
}

finish();
