import { openSync, writeSync, fsyncSync, closeSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const dirs = { TEMP: process.env.TEMP, RUNNER_TEMP: process.env.RUNNER_TEMP };
const pct = (a, p) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1);
for (const [name, base] of Object.entries(dirs)) {
  const dir = mkdtempSync(path.join(base, "fsync-"));
  const raw = [];
  const fd = openSync(path.join(dir, "f"), "w");
  for (let i = 0; i < 200; i++) { writeSync(fd, Buffer.alloc(4096, i)); const t = performance.now(); fsyncSync(fd); raw.push(performance.now() - t); }
  closeSync(fd);
  const t0 = performance.now();
  const db = new DatabaseSync(path.join(dir, "a.sqlite"));
  db.exec("PRAGMA synchronous = FULL"); db.exec("PRAGMA journal_mode = WAL");
  const commits = [];
  for (let i = 0; i < 25; i++) { const t = performance.now(); db.exec(`CREATE TABLE t${i} (x)`); commits.push(performance.now() - t); }
  db.close();
  const created = [];
  for (let i = 0; i < 200; i++) { const t = performance.now(); writeFileSync(path.join(dir, `n${i}.json`), "{}"); created.push(performance.now() - t); }
  console.log(`${name}=${base} fsync p50=${pct(raw, .5)} p95=${pct(raw, .95)} max=${pct(raw, 1)} ms | sqlite commit p50=${pct(commits, .5)} max=${pct(commits, 1)} total=${(performance.now() - t0).toFixed(0)} ms | new file p50=${pct(created, .5)} max=${pct(created, 1)}`);
  rmSync(dir, { recursive: true, force: true });
}
