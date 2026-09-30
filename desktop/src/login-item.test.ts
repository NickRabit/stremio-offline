import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  AUTOSTART_NAME, autostartEntry, autostartFile, launchExecutable, launchedHidden, LOGIN_ARGS, loginItemQuery, loginItemStatus,
  loginItemUpdate, loginItemOn, readAutostart, removeAutostart, writeAutostart, type AutostartFs,
} from "./login-item.js";

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

test("Linux reads its own autostart file instead of Electron's login item", () => {
  assert.equal(loginItemStatus({ openAtLogin: true }, "linux", true), "enabled");
  assert.equal(loginItemStatus({ openAtLogin: false }, "linux", true), "not-registered");
  assert.equal(loginItemStatus({ openAtLogin: true }, "linux", false), "unsupported");
});

test("an entry Task Manager switched off reads as off on Windows, and enabling switches it back on", () => {
  assert.equal(loginItemStatus({ openAtLogin: true, executableWillLaunchAtLogin: false }, "win32", true), "not-registered");
  assert.equal(loginItemOn({ openAtLogin: true, executableWillLaunchAtLogin: false }, "win32"), false);
  assert.equal(loginItemOn({ openAtLogin: true }, "darwin"), true);
  assert.deepEqual(loginItemUpdate(true, "win32"), [{ openAtLogin: true, args: ["--hidden"], enabled: true }]);
  assert.deepEqual(loginItemUpdate(true, "darwin"), [{ openAtLogin: true }]);
});

const memoryFs = (): AutostartFs & { files: Map<string, string>; dirs: Set<string> } => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    readFile: async (file) => {
      const body = files.get(file);
      if (body === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return body;
    },
    mkdir: async (dir) => { dirs.add(dir); },
    writeFile: async (file, data) => { files.set(file, data); },
    rename: async (from, to) => {
      const body = files.get(from);
      if (body === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      files.delete(from);
      files.set(to, body);
    },
    rm: async (file) => { files.delete(file); },
  };
};

test("the autostart entry quotes the Exec line the way the Desktop Entry spec reads it", () => {
  const entry = autostartEntry("/opt/Stremio Offline/Stremio $Offline `100%`");
  assert.equal(entry.includes(`Exec="/opt/Stremio Offline/Stremio \\$Offline \\\`100%%\\\`" --hidden`), true, entry);
  assert.equal(entry.includes("[Desktop Entry]"), true);
  assert.equal(entry.includes("Type=Application"), true);
  assert.equal(entry.includes("Name=Stremio Offline"), true);
  assert.equal(entry.includes("X-GNOME-Autostart-enabled=true"), true);
  assert.equal(entry.includes("Hidden=false"), true);
  assert.equal(entry.includes("NoDisplay=false"), true);
});

test("the autostart file lives under XDG_CONFIG_HOME, or under the home folder when it is unset", () => {
  const fallback = path.join("/home/me", ".config", "autostart", AUTOSTART_NAME);
  assert.equal(autostartFile("/home/me", {}), fallback);
  assert.equal(autostartFile("/home/me", { XDG_CONFIG_HOME: "" }), fallback);
  assert.equal(autostartFile("/home/me", { XDG_CONFIG_HOME: "/custom/config" }), path.join("/custom/config", "autostart", AUTOSTART_NAME));
});

test("an AppImage starts itself from the file it was launched as", () => {
  assert.equal(launchExecutable({ APPIMAGE: "/home/me/Apps/Stremio.AppImage" }, "/opt/stremio-offline/stremio-offline"),
    "/home/me/Apps/Stremio.AppImage");
  assert.equal(launchExecutable({}, "/opt/stremio-offline/stremio-offline"), "/opt/stremio-offline/stremio-offline");
  assert.equal(launchExecutable({ APPIMAGE: "" }, "/opt/x"), "/opt/x");
});

test("the autostart entry round-trips: write, read and remove", async () => {
  const fsImpl = memoryFs();
  const file = autostartFile("/home/me", {});
  assert.deepEqual(await readAutostart(file, fsImpl), { enabled: false });
  await writeAutostart(file, "/opt/stremio-offline/stremio-offline", fsImpl);
  assert.equal(fsImpl.dirs.has(path.dirname(file)), true);
  assert.deepEqual(await readAutostart(file, fsImpl), { enabled: true });
  await removeAutostart(file, fsImpl);
  assert.deepEqual(await readAutostart(file, fsImpl), { enabled: false });
});

test("an entry the desktop turned off reads as disabled", async () => {
  const fsImpl = memoryFs();
  const file = autostartFile("/home/me", {});
  await writeAutostart(file, "/opt/x", fsImpl);
  fsImpl.files.set(file, autostartEntry("/opt/x").replace("Hidden=false", "Hidden=true"));
  assert.deepEqual(await readAutostart(file, fsImpl), { enabled: false });
  fsImpl.files.set(file, autostartEntry("/opt/x").replace("X-GNOME-Autostart-enabled=true", "X-GNOME-Autostart-enabled=false"));
  assert.deepEqual(await readAutostart(file, fsImpl), { enabled: false });
});
