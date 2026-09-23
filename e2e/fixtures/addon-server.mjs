// A Stremio addon that answers from memory, so the end-to-end tests never reach
// the internet and always get the same catalog back.
import { execFileSync } from "node:child_process";
import os from "node:os";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.ADDON_PORT ?? 8098);
const here = path.dirname(fileURLToPath(import.meta.url));
const videoFile = path.join(here, "media", "sample.mp4");
const browserVideo = path.join(os.tmpdir(), `stremio-e2e-${process.pid}.webm`);
execFileSync("ffmpeg", ["-v", "error", "-i", videoFile, "-c:v", "libvpx-vp9", "-c:a", "libopus", "-y", browserVideo]);

export const MOVIE = {
  id: "tt-e2e-movie",
  type: "movie",
  name: "Zkušební film",
  poster: `http://127.0.0.1:${port}/poster.svg`,
  background: `http://127.0.0.1:${port}/poster.svg`,
  description: "Film, který existuje jen pro testy.",
  releaseInfo: "2024",
  genres: ["Drama"],
};

export const SERIES = {
  id: "tt-e2e-series",
  type: "series",
  name: "Zkušební seriál",
  poster: `http://127.0.0.1:${port}/poster.svg`,
  description: "Seriál, který existuje jen pro testy.",
  releaseInfo: "2023",
  genres: ["Komedie"],
  videos: [
    { id: "tt-e2e-series:1:1", season: 1, episode: 1, title: "První díl", overview: "V prvním dílu se všichni seznámí.", released: "2023-01-01T00:00:00.000Z" },
    { id: "tt-e2e-series:1:2", season: 1, episode: 2, title: "Druhý díl", overview: "Ve druhém dílu se všichni pohádají.", released: "2023-01-08T00:00:00.000Z" },
    { id: "tt-e2e-series:2:1", season: 2, episode: 1, title: "Nová série", overview: "Nová série začíná jinde.", released: "2024-01-01T00:00:00.000Z" },
  ],
};

const MANIFEST = {
  // The library may bind a title automatically only from Cinemeta or from TMDB, and the
  // test stack has no TMDB key. The fixture names itself as Cinemeta so the scan and the
  // identity search have a trusted provider to ask, exactly as a real install would.
  id: "com.linvo.cinemeta",
  version: "1.0.0",
  name: "E2E doplněk",
  description: "Zkušební doplněk pro automatické testy.",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt-e2e"],
  catalogs: [
    { type: "movie", id: "e2e-movies", name: "Filmy", extra: [{ name: "search" }, { name: "genre", options: ["Drama", "Akce"] }] },
    { type: "series", id: "e2e-series", name: "Seriály", extra: [{ name: "search" }] },
  ],
};

// Two sizes and two languages, so ordering and the language filter have something
// to actually order and filter.
const streamsFor = (id) => id === "tt-e2e-proxy" ? [{
  name: "Proxy fixture", title: "Movie query-canary", url: `http://127.0.0.1:${port}/proxy-fixture.mp4?token=query-canary`,
  behaviorHints: { proxyHeaders: { request: { Authorization: "Bearer header-canary" } } },
  subtitles: [{ url: `http://127.0.0.1:${port}/proxy-subtitle?token=subtitle-canary`, lang: "cs" }],
  extra: { url: "https://unknown-canary.test/secret" },
}] : proxyMode === "browser" ? [{ name: "E2E WebM", url: `http://127.0.0.1:${port}/browser-video.webm` }] : [
  { name: "E2E 1080p", title: `Czech \u{1F1E8}\u{1F1FF} 2.4 GB\n${id}`, url: `http://127.0.0.1:${port}/video/${encodeURIComponent(id)}.mp4` },
  { name: "E2E 720p", title: `English \u{1F1EC}\u{1F1E7} 900 MB\n${id}`, url: `http://127.0.0.1:${port}/video/${encodeURIComponent(id)}.mp4` },
];

const POSTER = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
  <rect width="300" height="450" fill="#1b2330"/><text x="150" y="230" fill="#ff5b38" font-size="28" text-anchor="middle">E2E</text></svg>`;

const json = (res, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
};

// The catalog id may be followed by an extras segment, e.g. catalog/movie/id/search=x.json
const route = (pathname) => decodeURIComponent(pathname).replace(/\.json$/, "").split("/").filter(Boolean);

async function serveVideo(req, res, file = videoFile) {
  let info;
  try { info = await stat(file); }
  catch { res.writeHead(404).end(); return; }

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  const headers = { "content-type": file.endsWith(".webm") ? "video/webm" : "video/mp4", "accept-ranges": "bytes" };
  if (!range) {
    res.writeHead(200, { ...headers, "content-length": info.size });
    return req.method === "HEAD" ? res.end() : createReadStream(file).pipe(res);
  }
  const start = range[1] ? Number(range[1]) : 0;
  const end = range[2] ? Number(range[2]) : info.size - 1;
  res.writeHead(206, { ...headers, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${info.size}` });
  return req.method === "HEAD" ? res.end() : createReadStream(file, { start, end }).pipe(res);
}

let proxyMode = "video";
// How many times the source was actually asked for the film, which is what the cache is about.
let mediaRequests = 0;
const server = createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const parts = route(pathname);

  if (pathname === "/browser-video.webm") return void serveVideo(req, res, browserVideo);
  if (pathname === "/proxy-control") { proxyMode = searchParams.get("mode") ?? "video"; if (searchParams.get("reset")) mediaRequests = 0; return json(res, { ok: true, requests: mediaRequests }); }
  if (pathname === "/proxy-requests") return json(res, { requests: mediaRequests });
  if (pathname === "/proxy-subtitle") { res.writeHead(200, { "content-type": "text/vtt" }); return res.end("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n"); }
  if (pathname === "/proxy-fixture.mp4") {
    if (req.headers.authorization !== "Bearer header-canary") return res.writeHead(403).end("header-canary");
    mediaRequests += 1;
    // A host that drops the connection once, the way the real ones do on a big file.
    if (proxyMode === "drop-once") { proxyMode = "video"; return void req.socket.destroy(); }
    // Takes the request and never answers, the way a host that has had enough behaves.
    if (proxyMode === "hang") return;
    // Hands over the first few bytes and then cuts the stream, which is the common one.
    if (proxyMode === "cut-once") {
      proxyMode = "video";
      const info = await stat(videoFile).catch(() => undefined);
      if (!info) return void res.writeHead(404).end();
      const asked = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      const start = asked?.[1] ? Number(asked[1]) : 0;
      const end = Math.min(asked?.[2] ? Number(asked[2]) : info.size - 1, info.size - 1);
      res.writeHead(asked ? 206 : 200, {
        "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": end - start + 1,
        ...(asked ? { "content-range": `bytes ${start}-${end}/${info.size}` } : {}),
      });
      createReadStream(videoFile, { start, end: Math.min(start + 15, end) }).pipe(res, { end: false });
      return void setTimeout(() => req.socket.destroy(), 30);
    }
    if (proxyMode === "video") return void serveVideo(req, res);
    if (proxyMode === "head") { res.writeHead(req.method === "HEAD" ? 200 : 405); return res.end(); }
    if (proxyMode === "playlist") {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      return res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/proxy-key"\n#EXT-X-MAP:URI="/proxy-init"\n#EXTINF:2,query-canary\n/proxy-segment\n');
    }
    const status = Number(proxyMode);
    res.writeHead(status, {
      "content-type": "application/octet-stream", "cache-control": "public, max-age=3600",
      "set-cookie": "provider-canary=secret", "link": "<https://provider-canary.test/secret>",
      "www-authenticate": "Bearer provider-canary",
      ...(status === 416 ? { "content-range": "bytes */123" } : {}),
      ...(status === 302 ? { location: "/proxy-fixture?status=403" } : {}),
    });
    return res.end(status === 200 ? "media" : "provider-canary-secret");
  }
  if (["/proxy-key", "/proxy-init", "/proxy-segment"].includes(pathname)) {
    res.writeHead(req.headers.authorization === "Bearer header-canary" ? 200 : 403);
    return res.end("media");
  }
  if (pathname === "/proxy-playlist.m3u8") {
    res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
    return res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.test/key"\nsegment.ts\nhttps://cdn.test/segment.ts\n');
  }
  if (pathname === "/proxy-fixture") {
    const status = searchParams.has("head") && req.method !== "HEAD" ? 405 : Number(searchParams.get("status") ?? 200);
    res.writeHead(status, {
      "content-type": "application/octet-stream", "cache-control": "public, max-age=3600",
      "set-cookie": "provider-canary=secret", "link": "<https://provider-canary.test/secret>",
      "www-authenticate": "Bearer provider-canary",
      ...(status === 416 ? { "content-range": "bytes */123" } : {}),
      ...(status === 302 ? { location: "/proxy-fixture?status=403" } : {}),
    });
    return res.end(status === 200 ? req.method : "provider-canary-secret");
  }
  if (pathname === "/manifest.json") return json(res, MANIFEST);
  if (pathname === "/poster.svg") {
    res.writeHead(200, { "content-type": "image/svg+xml" });
    return res.end(POSTER);
  }
  if (parts[0] === "video") return void serveVideo(req, res);
  // Lets a test make an addon call fail without stopping the whole fixture.
  if (pathname === "/boom.json") { res.writeHead(500, { "content-type": "application/json" }); return res.end('{"error":"rozbito"}'); }

  const [resource, type, id, extras] = parts;
  const extra = new URLSearchParams((extras ?? "").replaceAll("&amp;", "&"));
  const search = (extra.get("search") ?? searchParams.get("search") ?? "").toLowerCase();
  const genre = extra.get("genre") ?? searchParams.get("genre") ?? "";

  if (resource === "catalog") {
    const metas = [MOVIE, SERIES]
      .filter((meta) => meta.type === type)
      .filter((meta) => !search || meta.name.toLowerCase().includes(search))
      .filter((meta) => !genre || meta.genres.includes(genre));
    return json(res, { metas });
  }
  if (resource === "meta") {
    const meta = [MOVIE, SERIES].find((item) => item.id === id && item.type === type);
    return meta ? json(res, { meta }) : json(res, {});
  }
  if (resource === "stream") return json(res, { streams: streamsFor(id) });

  res.writeHead(404, { "content-type": "application/json" });
  res.end('{"error":"not found"}');
});

server.listen(port, "127.0.0.1", () => console.log(`e2e addon listening on http://127.0.0.1:${port}/manifest.json`));
