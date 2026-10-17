#!/usr/bin/env node
// Turns the analyze.mjs --json output of several runs into the tables of
// docs/playback-performance-audit.md.
//
//   node scripts/perf/report.mjs <folder with a-main.json, a-448.json, a-main-warm.json,
//     a-448-warm.json, a-main-slow.json, a-448-slow.json>
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const folder = process.argv[2];
const load = (name) => {
  const file = path.join(folder, `a-${name}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
};
const runs = { main: load("main"), next: load("448"), mainWarm: load("main-warm"), nextWarm: load("448-warm"), mainSlow: load("main-slow"), nextSlow: load("448-slow") };
const find = (rows, cell) => rows.find((row) => row.cell === cell || row.cell === `${cell}/warm`);
const ms = (value) => (value === undefined || Number.isNaN(value) ? "–" : value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)}`);
const num = (value, digits = 0) => (value === undefined || Number.isNaN(value) ? "–" : value.toFixed(digits));
const SOURCE = { lib: "Local library", addon: "Addon HTTP", addonslow: "Addon HTTP, 100 ms", jellyfin: "Jellyfin", emby: "Emby" };
const FILE = { mp4fast: "MP4 faststart", mp4end: "MP4 moov at end", mkv: "MKV H.264", avi: "AVI idx1 at end" };
const name = (cell) => { const [source, file, route] = cell.split("/"); return `${SOURCE[source]} | ${FILE[file]} | ${route}`; };
const table = (header, rows) => [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");

const cells = [...new Set([...runs.main.map((row) => row.cell)])];

console.log("### Play to first frame (ms)\n");
console.log(table(["Source", "Container", "Path", "Mode", "main cold", "#448 cold", "main warm", "#448 warm"],
  cells.map((cell) => {
    const main = find(runs.main, cell); const next = find(runs.next, cell);
    return [name(cell), `${main.mode}${main.copy ? ` (${main.copy})` : ""}`, ms(main.firstFrameMs), ms(next?.firstFrameMs),
      ms(find(runs.mainWarm, cell)?.firstFrameMs), ms(find(runs.nextWarm, cell)?.firstFrameMs)];
  })));

console.log("\n### Probe and start answer, cold (ms)\n");
console.log(table(["Source", "Container", "Path", "probe main", "probe #448", "start main", "start #448", "start main warm", "start #448 warm"],
  cells.map((cell) => {
    const main = find(runs.main, cell); const next = find(runs.next, cell);
    return [name(cell), ms(main.probeMs), ms(next?.probeMs), ms(main.startMs), ms(next?.startMs), ms(find(runs.mainWarm, cell)?.startMs), ms(find(runs.nextWarm, cell)?.startMs)];
  })));

console.log("\n### Seek to 50 % and back to 0:30 (ms)\n");
console.log(table(["Source", "Container", "Path", "how", "to 50 % main", "to 50 % #448", "back main", "back #448"],
  cells.map((cell) => {
    const main = find(runs.main, cell); const next = find(runs.next, cell);
    return [name(cell), main.seekMidPlan, ms(main.seekMidMs), ms(next?.seekMidMs), ms(main.seekBackMs), ms(next?.seekBackMs)];
  })));

console.log("\n### Upstream requests and bytes, whole run (probe, start, 20 s play, two seeks)\n");
console.log(table(["Source", "Container", "Path", "media reads main", "media reads #448", "probe / start / seek main", "probe / start / seek #448", "metadata main", "metadata #448", "MB main", "MB #448"],
  cells.filter((cell) => !cell.startsWith("lib/")).map((cell) => {
    const main = find(runs.main, cell); const next = find(runs.next, cell);
    return [name(cell), main.reqTotal, next?.reqTotal ?? "–", `${main.reqProbe} / ${main.reqStart} / ${main.reqSeekMid}`,
      next ? `${next.reqProbe} / ${next.reqStart} / ${next.reqSeekMid}` : "–", main.reqMetadata, next?.reqMetadata ?? "–", num(main.mbTotal), num(next?.mbTotal)];
  })));

console.log("\n### FFmpeg CPU (main build)\n");
console.log(table(["Source", "Container", "Path", "CPU-s until first frame", "steady % of one core", "container steady %"],
  cells.map((cell) => {
    const main = find(runs.main, cell);
    return [name(cell), num(main.cpuToFrame, 1), num(main.cpuSteadyPct), num(main.containerSteadyPct)];
  })));

const slow = [...new Set(runs.mainSlow.map((row) => row.cell))];
if (slow.length) {
  console.log("\n### Addon behind a host that answers 100 ms late\n");
  console.log(table(["Container", "Path", "first frame main", "first frame #448", "to 50 % main", "to 50 % #448", "back main", "back #448", "media reads main", "media reads #448", "MB main", "MB #448"],
    slow.map((cell) => {
      const main = find(runs.mainSlow, cell); const next = find(runs.nextSlow, cell);
      const [, file, route] = cell.split("/");
      return [FILE[file], route, ms(main.firstFrameMs), ms(next?.firstFrameMs), ms(main.seekMidMs), ms(next?.seekMidMs), ms(main.seekBackMs), ms(next?.seekBackMs),
        main.reqTotal, next?.reqTotal ?? "–", num(main.mbTotal), num(next?.mbTotal)];
    })));
}
