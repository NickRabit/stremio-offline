#!/usr/bin/env node
// Logs every upstream request the app makes during a playback measurement.
//
//   node scripts/perf/range-proxy.mjs --log <file.jsonl> \
//     --proxy 18196=http://127.0.0.1:8096 --proxy 18197=http://192.168.1.205:8096 \
//     --files 18190=<media folder>
//
// A --proxy port forwards to a media server unchanged; point the connection's base URL at it.
// A --files port serves a folder with byte ranges and a minimal Stremio addon whose streams
// point back at those files, so an addon HTTP source can be measured against the same files.
// --files 18191=<folder>@100 answers every request 100 ms late, like a remote host's time to first byte.
// Each line of the log is one request: port, method, path (query dropped, it carries tokens),
// requested range, status, bytes sent and how long the response took.
import { createReadStream, appendFileSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name) => args.flatMap((value, index) => (value === name ? [args[index + 1]] : []));
const logFile = option("--log")[0];
if (!logFile) throw new Error("--log is required");
const publicHost = option("--host")[0] ?? "host.docker.internal";

const record = (entry) => appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
const cleanPath = (url) => (url ?? "").split("?")[0];

function tracked(port, req, res) {
  const started = Date.now();
  let bytes = 0;
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  res.write = (chunk, ...rest) => { if (chunk) bytes += Buffer.byteLength(chunk); return write(chunk, ...rest); };
  res.end = (chunk, ...rest) => { if (chunk && typeof chunk !== "function") bytes += Buffer.byteLength(chunk); return end(chunk, ...rest); };
  res.once("close", () => record({
    port, method: req.method, path: cleanPath(req.url), range: req.headers.range, status: res.statusCode,
    bytes, ms: Date.now() - started, aborted: !res.writableFinished,
  }));
}

for (const spec of option("--proxy")) {
  const [port, target] = spec.split("=");
  const upstream = new URL(target);
  http.createServer((req, res) => {
    tracked(Number(port), req, res);
    const forward = http.request({
      host: upstream.hostname, port: upstream.port || 80, method: req.method, path: req.url,
      headers: { ...req.headers, host: upstream.host },
    }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    forward.once("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.once("close", () => forward.destroy());
    req.pipe(forward);
  }).listen(Number(port), "0.0.0.0");
}

const MIME = { ".mp4": "video/mp4", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo" };

for (const spec of option("--files")) {
  const [port, target] = spec.split("=");
  const [folder, delay = "0"] = target.split("@");
  const base = `http://${publicHost}:${port}`;
  const files = () => readdirSync(folder).filter((name) => MIME[path.extname(name)]);
  http.createServer(async (req, res) => {
    tracked(Number(port), req, res);
    if (Number(delay)) await new Promise((resolve) => setTimeout(resolve, Number(delay)));
    const url = cleanPath(req.url);
    const json = (value) => { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(value)); };
    if (url === "/manifest.json") {
      return json({
        id: `cz.stremiooffline.perf${Number(delay) ? `.delay${delay}` : ""}`, version: "1.0.0", name: `Playback measurement${Number(delay) ? ` (${delay} ms)` : ""}`,
        description: "Serves the measurement files as HTTP streams", resources: ["stream"], types: ["movie"], idPrefixes: ["tt"], catalogs: [],
      });
    }
    if (url.startsWith("/stream/movie/")) {
      return json({ streams: files().map((name) => ({ name: "Perf", title: name, url: `${base}/media/${encodeURIComponent(name)}` })) });
    }
    if (!url.startsWith("/media/")) { res.writeHead(404); return res.end(); }
    const name = path.basename(decodeURIComponent(url.slice("/media/".length)));
    const file = path.join(folder, name);
    let size;
    try { size = statSync(file).size; } catch { res.writeHead(404); return res.end(); }
    const headers = { "accept-ranges": "bytes", "content-type": MIME[path.extname(name)] ?? "application/octet-stream" };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (!range) {
      res.writeHead(200, { ...headers, "content-length": size });
      return req.method === "HEAD" ? res.end() : createReadStream(file).pipe(res);
    }
    let start = range[1] === "" ? size - Number(range[2]) : Number(range[1]);
    let end = range[1] === "" || range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
    if (start >= size || start > end) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
    start = Math.max(0, start);
    res.writeHead(206, { ...headers, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}` });
    if (req.method === "HEAD") return res.end();
    createReadStream(file, { start, end }).pipe(res);
  }).listen(Number(port), "0.0.0.0");
}

console.log("range proxy listening", { proxies: option("--proxy"), files: option("--files"), log: logFile });
