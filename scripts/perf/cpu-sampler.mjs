#!/usr/bin/env node
// Runs inside the container: every 200 ms writes the CPU time of each ffmpeg/ffprobe process
// and of the whole container (cgroup), so a run can be cut into "until first frame" and
// "steady playback" windows afterwards.
//
//   docker cp scripts/perf/cpu-sampler.mjs <container>:/tmp/ && docker exec -d <container> node /tmp/cpu-sampler.mjs /tmp/cpu.jsonl
import { appendFileSync, readdirSync, readFileSync } from "node:fs";

const out = process.argv[2] ?? "/tmp/cpu.jsonl";
const TICK = 100; // USER_HZ on Linux

const cgroup = () => {
  try { return Number(/usage_usec (\d+)/.exec(readFileSync("/sys/fs/cgroup/cpu.stat", "utf8"))?.[1]) / 1e6; }
  catch { return undefined; }
};

setInterval(() => {
  const processes = [];
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
      if (comm !== "ffmpeg" && comm !== "ffprobe") continue;
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      processes.push({ pid: Number(pid), comm, cpu: (Number(fields[11]) + Number(fields[12])) / TICK });
    } catch { /* the process ended between listing and reading */ }
  }
  appendFileSync(out, `${JSON.stringify({ at: Date.now(), container: cgroup(), processes })}\n`);
}, 200);
