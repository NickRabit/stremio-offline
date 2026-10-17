#!/usr/bin/env node
// Joins one matrix run into a table: the page's timings (results.json, saved from
// window.perf.results), the upstream request log of range-proxy.mjs, the CPU samples of
// cpu-sampler.mjs and the media-server counters noted by reset.sh.
//
//   node scripts/perf/analyze.mjs <results.json> <upstream.jsonl> <cpu.jsonl> <provider-snapshots.jsonl> [--json]
import { readFileSync } from "node:fs";

const [resultsFile, upstreamFile, cpuFile, providerFile] = process.argv.slice(2);
const lines = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const results = JSON.parse(readFileSync(resultsFile, "utf8"));
const upstream = lines(upstreamFile);
const cpu = lines(cpuFile);
const providers = lines(providerFile);

const PORTS = { 18190: "addon", 18191: "addon (100 ms)", 18196: "jellyfin", 18197: "emby" };
const MB = (bytes) => (bytes / 1024 / 1024).toFixed(1);

/** Requests that started inside a window, by when they were logged (response end) minus their duration. */
function requests(from, to, kind) {
  const inside = upstream.filter((entry) => PORTS[entry.port] && entry.at - entry.ms >= from && entry.at - entry.ms < to);
  const media = inside.filter((entry) => entry.range !== undefined || /\/(Videos|Items\/[^/]+\/Download|media)\//i.test(entry.path));
  return {
    all: inside.length,
    media: media.length,
    metadata: inside.length - media.length,
    bytes: inside.reduce((sum, entry) => sum + entry.bytes, 0),
    kind,
  };
}

/** CPU seconds ffmpeg/ffprobe (and the whole container) spent between two wall times. */
function cpuBetween(from, to) {
  const window = cpu.filter((sample) => sample.at >= from - 250 && sample.at <= to + 250);
  if (window.length < 2) return { media: undefined, container: undefined };
  const first = window[0]; const last = window.at(-1);
  // A process's last sample is its total; one that started inside the window started at zero.
  const peak = new Map();
  const before = new Map(first.processes.map((proc) => [proc.pid, proc.cpu]));
  for (const sample of window) for (const proc of sample.processes) peak.set(proc.pid, Math.max(peak.get(proc.pid) ?? 0, proc.cpu));
  let media = 0;
  for (const [pid, total] of peak) media += total - (before.get(pid) ?? 0);
  const seconds = (last.at - first.at) / 1000;
  return { media, container: last.container - first.container, seconds };
}

function providerDelta(from, to) {
  const before = [...providers].reverse().find((row) => row.at <= from + 15_000);
  const after = providers.find((row) => row.at >= to);
  if (!before || !after) return undefined;
  const delta = {};
  for (const [key, value] of Object.entries(after.total)) { const diff = value - (before.total[key] ?? 0); if (diff) delta[key] = diff; }
  return delta;
}

const rows = results.map((run) => {
  const [source] = run.label.split("/");
  const startWall = run.playWall;
  const firstFrameWall = run.firstFrameWall;
  const steady = cpuBetween(run.advancingWall, run.steadyEndWall);
  const toFrame = cpuBetween(run.playWall, run.firstFrameWall);
  const inspect = requests(run.mintedWall, run.inspectedWall, "probe");
  const start = requests(startWall, firstFrameWall ?? startWall, "start");
  const play = requests(run.advancingWall, run.steadyEndWall, "play");
  const seekMid = requests(run.seekMidBeginWall, run.seekMidFrameWall ?? run.seekMidBeginWall, "seekMid");
  const seekBack = requests(run.seekBackBeginWall, run.seekBackFrameWall ?? run.seekBackBeginWall, "seekBack");
  const total = requests(run.wallStart, run.wallEnd + 2000, "total");
  return {
    cell: run.label, source, mode: run.mode, copy: run.copy ? `${run.copy.video ? "v" : "-"}${run.copy.audio ? "a" : "-"}` : "",
    probeMs: run.inspected - run.minted,
    startMs: run.startAnswer - run.play,
    firstFrameMs: run.firstFrame - run.play,
    seekMidMs: run.seekMidFrame - run.seekMidBegin, seekMidPlan: run.seekMidPlan ?? "direct",
    seekBackMs: run.seekBackFrame - run.seekBackBegin, seekBackPlan: run.seekBackPlan ?? "direct",
    stalls: run.stalls,
    cpuToFrame: toFrame.media, cpuSteadyPct: steady.media !== undefined ? (steady.media / steady.seconds) * 100 : undefined,
    containerSteadyPct: steady.container !== undefined ? (steady.container / steady.seconds) * 100 : undefined,
    reqProbe: inspect.media, reqStart: start.media, reqPlay: play.media, reqSeekMid: seekMid.media, reqSeekBack: seekBack.media,
    reqTotal: total.media, reqMetadata: total.metadata, mbTotal: Number(MB(total.bytes)), mbProbe: Number(MB(inspect.bytes)),
    providers: providerDelta(run.wallStart, run.wallEnd),
    error: run.error,
  };
});

if (process.argv.includes("--json")) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
const columns = ["cell", "mode", "copy", "probeMs", "startMs", "firstFrameMs", "seekMidMs", "seekMidPlan", "seekBackMs", "seekBackPlan", "stalls", "cpuToFrame", "cpuSteadyPct", "reqProbe", "reqStart", "reqPlay", "reqSeekMid", "reqSeekBack", "reqTotal", "reqMetadata", "mbProbe", "mbTotal", "error"];
const show = (value) => value === undefined || value === null || Number.isNaN(value) ? "–" : typeof value === "number" ? (Number.isInteger(value) ? String(value) : value.toFixed(1)) : String(value);
console.log(`| ${columns.join(" | ")} |`);
console.log(`| ${columns.map(() => "---").join(" | ")} |`);
for (const row of rows) console.log(`| ${columns.map((column) => show(row[column])).join(" | ")} |`);
console.log();
for (const row of rows) if (row.providers) console.log(row.cell, JSON.stringify(row.providers));
