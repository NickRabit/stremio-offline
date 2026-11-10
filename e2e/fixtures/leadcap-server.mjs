// Starts the built app on an isolated account for the lead-cap browser journey.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workDir = path.join(root, "e2e", ".tmp-leadcap");
const dataDir = path.join(workDir, "data");
const downloadDir = path.join(workDir, "downloads");
const appDir = path.join(workDir, "app");
const addonPort = process.env.LEADCAP_ADDON_PORT ?? "8198";
const addonManifest = `http://127.0.0.1:${addonPort}/manifest.json`;

await rm(workDir, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
await mkdir(downloadDir, { recursive: true });
await cp(path.join(root, "server", "dist"), path.join(appDir, "server", "dist"), { recursive: true });
await cp(path.join(root, "web", "dist"), path.join(appDir, "web"), { recursive: true });

const waitFor = async (url, attempts = 80) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* still booting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
};

await waitFor(addonManifest);
process.env.ALLOW_PRIVATE_ADDONS = "1";
const { loadAddon } = await import(path.join(root, "server", "dist", "addons.js"));
const { hashPassword } = await import(path.join(root, "server", "dist", "auth.js"));
const addon = await loadAddon(addonManifest, "both");
await writeFile(path.join(dataDir, "state.json"), JSON.stringify({
  addons: [addon],
  defaultsInstalled: true,
  auth: {
    username: "leadcap-admin",
    passwordHash: await hashPassword("leadcap-password"),
    secret: randomBytes(32).toString("hex"),
    isDefault: false,
    revoked: {},
  },
}, null, 2));

const child = spawn(process.execPath, [path.join(appDir, "server", "dist", "index.js")], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: process.env.LEADCAP_APP_PORT ?? "8299",
    DATA_DIR: dataDir,
    DOWNLOAD_DIR: downloadDir,
    ALLOW_PRIVATE_ADDONS: "1",
    PLAYBACK_LEAD_CAP_SECONDS: "3",
    LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? "WARN",
    LOG_STDOUT: "1",
    LIBRARY_AUTO_SCAN: "0",
    ADDON_AUTO_REFRESH: "0",
  },
});

const stop = () => { child.kill("SIGTERM"); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", (code) => process.exit(code ?? 0));
