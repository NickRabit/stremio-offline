import assert from "node:assert/strict";
import test from "node:test";
import { LOGIN_ARGS, launchedHidden, loginItemQuery, loginItemStatus, loginItemUpdate, loginItemOn } from "./login-item.js";

test("a login launch on Windows starts the app in the notification area", () => {
  assert.deepEqual([...LOGIN_ARGS], ["--hidden"]);
  assert.equal(launchedHidden(["/Applications/Stremio Offline.app", "--hidden"]), true);
  assert.equal(launchedHidden(["Stremio Offline.exe", "--hidden", "--other"]), true);
  assert.equal(launchedHidden(["Stremio Offline.exe"]), false);
  assert.equal(launchedHidden(["--hidden-ish"]), false);
  assert.equal(launchedHidden([]), false);
});

test("the login item is looked up with the arguments it was registered with", () => {
  assert.deepEqual(loginItemQuery("win32"), { args: ["--hidden"] });
  assert.equal(loginItemQuery("darwin"), undefined);
  assert.equal(loginItemQuery("linux"), undefined);
});

test("registering a login item passes the arguments on Windows only", () => {
  assert.deepEqual(loginItemUpdate(true, "win32"), [{ openAtLogin: true, args: ["--hidden"], enabled: true }]);
  assert.deepEqual(loginItemUpdate(true, "darwin"), [{ openAtLogin: true }]);
  assert.deepEqual(loginItemUpdate(true, "linux"), [{ openAtLogin: true }]);
});

test("removing a Windows login item clears the entry with and without the arguments", () => {
  assert.deepEqual(loginItemUpdate(false, "win32"), [{ openAtLogin: false, args: ["--hidden"] }, { openAtLogin: false }]);
  assert.deepEqual(loginItemUpdate(false, "darwin"), [{ openAtLogin: false }]);
});

test("a development run has no login item at all", () => {
  for (const platform of ["darwin", "win32", "linux"] as const) {
    assert.equal(loginItemStatus({ openAtLogin: true, status: "enabled" }, platform, false), "unsupported", platform);
  }
});

test("macOS reports what the system says, and nothing when it does not answer", () => {
  for (const status of ["enabled", "not-registered", "requires-approval", "not-found"] as const) {
    assert.equal(loginItemStatus({ status }, "darwin", true), status);
  }
  for (const status of [undefined, null, "", "unknown", 7]) {
    assert.equal(loginItemStatus({ status: status as string | null | undefined }, "darwin", true), "unsupported", String(status));
  }
});

test("Windows has no approval step: the registry decides", () => {
  assert.equal(loginItemStatus({ openAtLogin: true }, "win32", true), "enabled");
  assert.equal(loginItemStatus({ openAtLogin: false, executableWillLaunchAtLogin: true }, "win32", true), "enabled",
    "an entry registered without the arguments still counts");
  assert.equal(loginItemStatus({ openAtLogin: false, executableWillLaunchAtLogin: false }, "win32", true), "not-registered");
  assert.equal(loginItemStatus({}, "win32", true), "not-registered");
  assert.equal(loginItemStatus({ status: "requires-approval" }, "win32", true), "not-registered");
});

test("Linux has no login item", () => {
  assert.equal(loginItemStatus({ openAtLogin: true, status: "enabled" }, "linux", true), "unsupported");
});

test("an entry Task Manager switched off reads as off on Windows, and enabling switches it back on", () => {
  assert.equal(loginItemStatus({ openAtLogin: true, executableWillLaunchAtLogin: false }, "win32", true), "not-registered");
  assert.equal(loginItemOn({ openAtLogin: true, executableWillLaunchAtLogin: false }, "win32"), false);
  assert.equal(loginItemOn({ openAtLogin: true }, "darwin"), true);
  assert.deepEqual(loginItemUpdate(true, "win32"), [{ openAtLogin: true, args: ["--hidden"], enabled: true }]);
  assert.deepEqual(loginItemUpdate(true, "darwin"), [{ openAtLogin: true }]);
});
