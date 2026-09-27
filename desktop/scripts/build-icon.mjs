// Renders desktop/icon/icon.svg into desktop/build/icon.icns, the icon electron-builder packs.
// Run with Electron (it rasterises the SVG exactly like the app draws it):
//   npx electron desktop/scripts/build-icon.mjs
// The .icns is committed; rerun this only when the SVG changes.
import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const svg = readFileSync(path.join(desktopDir, "icon", "icon.svg"), "utf8");
const SIZES = [16, 32, 64, 128, 256, 512, 1024];

app.dock?.hide();
app.whenReady().then(async () => {
  const work = path.join(os.tmpdir(), `stremio-icon-${process.pid}`);
  const iconset = path.join(work, "icon.iconset");
  mkdirSync(iconset, { recursive: true });
  const window = new BrowserWindow({ show: false, width: 1024, height: 1024, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const render = async (size) => {
    window.setContentSize(size, size);
    const html = `<html><body style="margin:0;background:transparent"><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"></body></html>`;
    await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    return (await window.webContents.capturePage({ x: 0, y: 0, width: size, height: size })).resize({ width: size, height: size }).toPNG();
  };
  for (const size of SIZES.slice(0, -1)) {
    writeFileSync(path.join(iconset, `icon_${size}x${size}.png`), await render(size));
    writeFileSync(path.join(iconset, `icon_${size}x${size}@2x.png`), await render(size * 2));
  }
  mkdirSync(path.join(desktopDir, "build"), { recursive: true });
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(desktopDir, "build", "icon.icns")]);
  writeFileSync(path.join(desktopDir, "build", "icon.png"), await render(1024));
  rmSync(work, { recursive: true, force: true });
  console.log("build-icon: desktop/build/icon.icns and icon.png written");
  app.quit();
});
