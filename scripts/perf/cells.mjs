#!/usr/bin/env node
// Writes the matrix as a cells.json for run-matrix.mjs from the identifiers of one setup:
//
//   node scripts/perf/cells.mjs <sources.json> [--warm] > cells.json
//
// Play is pressed as the source is selected, while its probe still runs (the cold case);
// --warm presses it only once the probe has answered.
//
// sources.json: { "library": "<library id>", "addon": { "key": "<addon key>", "id": "tt…", "index": { "mkv": 1, … } },
//   "slowAddon": { same shape, optional },
//   "remote": { "jellyfin": { "library": "<rlib>", "items": { "mkv": "<item>", … } }, "emby": { … } } }
// Files are keyed mkv, mp4fast, mp4end and avi; the library holds them as the names below.
import { readFileSync } from "node:fs";

const setup = JSON.parse(readFileSync(process.argv[2], "utf8"));
const FILES = { mkv: "mkv-h264.mkv", mp4fast: "mp4-faststart.mp4", mp4end: "mp4-moov-end.mp4", avi: "avi-idx1-end.avi" };
// Direct play: the browser's own declaration. Remux of an MP4 only happens for a native client
// that plays no file container; an MKV is remuxed for the browser itself. A transcode is what a
// chosen quality forces (1080 never scales these sources up).
const PATHS = {
  mp4fast: { direct: {}, remux: { path: "native" }, transcode: { quality: 1080 } },
  mp4end: { direct: {}, remux: { path: "native" }, transcode: { quality: 1080 } },
  mkv: { remux: {}, transcode: { quality: 1080 } },
  avi: { transcode: {} },
};
const sources = {
  lib: (file) => ({ kind: "library", path: `${setup.library}/${FILES[file]}` }),
  addon: (file) => ({ kind: "addon", id: setup.addon.id, addon: setup.addon.key, index: setup.addon.index[file] }),
  // The same addon behind a host that answers 100 ms late (range-proxy.mjs --files port=folder@100).
  ...(setup.slowAddon ? { addonslow: (file) => ({ kind: "addon", id: setup.slowAddon.id, addon: setup.slowAddon.key, index: setup.slowAddon.index[file] }) } : {}),
  ...Object.fromEntries(Object.entries(setup.remote).map(([name, remote]) => [name, (file) => ({ kind: "remote", library: remote.library, item: remote.items[file] })])),
};
const cells = [];
for (const [name, source] of Object.entries(sources)) {
  for (const [file, paths] of Object.entries(PATHS)) {
    for (const [route, extra] of Object.entries(paths)) {
      cells.push({ label: `${name}/${file}/${route}`, source: source(file), path: "direct", inspectLeadMs: 0, playSeconds: 20, ...extra });
      if (process.argv.includes("--warm")) Object.assign(cells.at(-1), { label: `${cells.at(-1).label}/warm`, waitForInspect: true });
    }
  }
}
console.log(JSON.stringify(cells, null, 2));
