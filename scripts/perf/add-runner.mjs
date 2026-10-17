#!/usr/bin/env node
// Adds the measurement account to a stopped measurement instance's data folder, so a headless
// browser can sign in to the copy without anyone's real password. Run inside the app image:
//
//   docker run --rm -v <work>/data:/data -v <work>/test-user.json:/user.json:ro -v $PWD/scripts/perf:/perf:ro \
//     --entrypoint node <image> /perf/add-runner.mjs
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const { hashPassword } = await import("/app/server/dist/auth.js");
const { username, password } = JSON.parse(readFileSync("/user.json", "utf8"));
const file = "/data/state.json";
const state = JSON.parse(readFileSync(file, "utf8"));
state.users = (state.users ?? []).filter((user) => user.username !== username);
state.users.push({
  id: `usr_${randomBytes(4).toString("hex")}`, username, passwordHash: await hashPassword(password),
  secret: randomBytes(32).toString("hex"), role: "admin", createdAt: new Date().toISOString(),
  permissions: { downloadToLibrary: true, downloadToDevice: true }, permissionsVersion: 0,
});
writeFileSync(file, JSON.stringify(state));
console.log("added", username);
