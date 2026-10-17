// Starts the built server on a throwaway data directory. Every run begins with no
// account, no addons and an empty library, so the tests never depend on what an
// earlier run left behind.
import { spawn } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workDir = path.join(root, "e2e", ".tmp");
const dataDir = path.join(workDir, "data");
const downloadDir = path.join(workDir, "downloads");
const appDir = path.join(workDir, "app");

await rm(workDir, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
await mkdir(downloadDir, { recursive: true });

// The server resolves the web root as "../../web" relative to its own bundle, so
// the tests need the same layout the image builds -- not the source tree, where
// that path is the unbuilt workspace.
await cp(path.join(root, "server", "dist"), path.join(appDir, "server", "dist"), { recursive: true });
await cp(path.join(root, "web", "dist"), path.join(appDir, "web"), { recursive: true });

// Without this flag the server would fetch Cinemeta and OpenSubtitles on first
// boot, which is both slow and a trip to the internet the tests must not take.
await writeFile(path.join(dataDir, "state.json"), JSON.stringify({ addons: [], defaultsInstalled: true }, null, 2));

const child = spawn(process.execPath, [path.join(appDir, "server", "dist", "index.js")], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: process.env.APP_PORT ?? "8099",
    DATA_DIR: dataDir,
    DOWNLOAD_DIR: downloadDir,
    // The fake addon lives on loopback, which the SSRF guard blocks by default.
    ALLOW_PRIVATE_ADDONS: "1",
    LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? "WARN",
    LOG_STDOUT: "1",
    LIBRARY_SCAN_GAP_MS: "0",
    // A renderer that crashes under emulation leaves a session behind, and the scan stays paused
    // behind it; the default five minutes outlive the tests that are waiting for a scan.
    PLAYBACK_IDLE_SECONDS: "3",
    // The tests drive the scan themselves; an automatic one would rematch titles mid-run.
    LIBRARY_AUTO_SCAN: "0",
    // The fake addon is the only manifest here; a background refresh round would be
    // a needless request in the middle of a run.
    ADDON_AUTO_REFRESH: "0",
    SEARCH_EVERYWHERE_ENABLED: "1",
  },
});

const stop = () => { child.kill("SIGTERM"); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", (code) => process.exit(code ?? 0));
