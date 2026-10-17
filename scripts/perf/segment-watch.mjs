#!/usr/bin/env node
// Notes when FFmpeg publishes each HLS segment of a measurement instance, read from its data
// folder on the host every 50 ms, with the segment's duration from the playlist. Joined with the
// harness timeline it shows how far production ran ahead of playback when a stall came.
//
//   node scripts/perf/segment-watch.mjs <work>/data/playback <out.jsonl>
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const [root, out] = process.argv.slice(2);
const seen = new Set();

const list = (folder) => { try { return readdirSync(folder); } catch { return []; } };

setInterval(() => {
  for (const session of list(root)) {
    for (const generation of list(path.join(root, session))) {
      const folder = path.join(root, session, generation);
      let playlist = "";
      try { playlist = readFileSync(path.join(folder, "index-0.m3u8"), "utf8"); } catch { continue; }
      const durations = new Map();
      let pending;
      for (const line of playlist.split("\n")) {
        const extinf = /^#EXTINF:([\d.]+)/.exec(line);
        if (extinf) pending = Number(extinf[1]);
        else if (line.startsWith("seg-") && pending !== undefined) { durations.set(line.trim(), pending); pending = undefined; }
      }
      for (const [file, duration] of durations) {
        const key = `${session}/${generation}/${file}`;
        if (seen.has(key)) continue;
        seen.add(key);
        appendFileSync(out, `${JSON.stringify({ at: Date.now(), session, generation: Number(generation), file, duration })}\n`);
      }
    }
  }
}, 50);
