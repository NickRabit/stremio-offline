#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(root, "server", "dist", "index.js");
const webEntry = path.join(root, "web", "dist", "index.html");
const fixture = path.join(root, "e2e", "fixtures", "media", "sample.mp4");
const requestTimeoutMs = 120_000;
const startupTimeoutMs = 30_000;
const scanTimeoutMs = 15 * 60_000;
const searchTimeoutMs = 2 * 60_000;
const pollDelayMs = 100;
const searchNoProgressPollLimit = 30;
const serverOutputLines = 20;

class BenchmarkError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  throw new BenchmarkError(message);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--files" && flag !== "--samples") fail(`Unknown argument: ${flag}`);
    if (Object.hasOwn(values, flag)) fail(`Duplicate argument: ${flag}`);
    const raw = argv[index + 1];
    if (raw === undefined || raw.startsWith("--") || !/^\d+$/.test(raw)) {
      fail(`${flag} requires a positive integer`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) fail(`${flag} requires a positive integer`);
    values[flag] = value;
    index += 1;
  }
  if (values["--files"] === undefined || values["--samples"] === undefined) {
    fail("Both --files and --samples are required");
  }
  return { files: values["--files"], samples: values["--samples"] };
}

async function requireBuild() {
  const checks = await Promise.all([
    access(serverEntry).then(() => true, () => false),
    access(webEntry).then(() => true, () => false),
  ]);
  if (checks.some((present) => !present)) {
    fail("The built server or web bundle is missing. Run npm run build before benchmarking.");
  }
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    fail("Could not reserve a loopback port");
  }
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function seedFixture(tempRoot, fileCount) {
  const dataDir = path.join(tempRoot, "data");
  const downloadsDir = path.join(tempRoot, "downloads");
  await mkdir(dataDir);
  await mkdir(downloadsDir);
  await writeFile(
    path.join(dataDir, "state.json"),
    JSON.stringify({ addons: [], defaultsInstalled: true }, null, 2),
  );

  const fixtureInfo = await stat(fixture);
  if (!fixtureInfo.isFile() || fixtureInfo.size <= 0) fail("e2e/fixtures/media/sample.mp4 is not a valid fixture");

  const batchSize = 64;
  for (let start = 1; start <= fileCount; start += batchSize) {
    const copies = [];
    for (let number = start; number <= Math.min(fileCount, start + batchSize - 1); number += 1) {
      const name = `Movie-${String(number).padStart(5, "0")}`;
      const directory = path.join(downloadsDir, name);
      copies.push((async () => {
        await mkdir(directory);
        await copyFile(fixture, path.join(directory, `${name}.mp4`));
      })());
    }
    await Promise.all(copies);
  }
  return { dataDir, downloadsDir, fixtureSizeBytes: fixtureInfo.size };
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", exited);
      resolve(false);
    }, timeoutMs);
    const exited = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", exited);
  });
}

async function terminateServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 5_000)) return;
  child.kill("SIGKILL");
  if (!await waitForExit(child, 2_000)) fail("The benchmark server did not stop");
}

function startServer({ dataDir, downloadsDir, port }) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      NODE_ENV: "production",
      DATA_DIR: dataDir,
      DOWNLOAD_DIR: downloadsDir,
      LIBRARY_ROOTS: downloadsDir,
      HOST: "127.0.0.1",
      PORT: String(port),
      LIBRARY_AUTO_SCAN: "0",
      ADDON_AUTO_REFRESH: "0",
      LIBRARY_SCAN_GAP_MS: "0",
      SEARCH_EVERYWHERE_ENABLED: "1",
    },
  });
  child.outputTail = [];
  const keep = (chunk) => {
    child.outputTail.push(...String(chunk).split("\n").filter(Boolean));
    child.outputTail.splice(0, Math.max(0, child.outputTail.length - serverOutputLines));
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  return child;
}

async function fetchJson(url, init = {}, timeoutMs = requestTimeoutMs) {
  const startedAt = performance.now();
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { response, body, elapsedMs: performance.now() - startedAt };
}

async function waitForStartup(baseUrl, child) {
  const startedAt = performance.now();
  const deadline = startedAt + startupTimeoutMs;
  while (performance.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      fail("The benchmark server exited before becoming ready");
    }
    try {
      const result = await fetchJson(`${baseUrl}/api/status`, {}, 1_000);
      if (result.response.ok && result.body?.status === "ok") return performance.now() - startedAt;
    } catch {
      // The listener is not up yet.
    }
    await sleep(25);
  }
  fail(`The benchmark server did not answer /api/status within ${startupTimeoutMs / 1_000} seconds`);
}

async function setupSession(baseUrl) {
  const username = `benchmark-${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("base64url");
  const result = await fetchJson(`${baseUrl}/api/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (result.response.status !== 201) fail(`POST /api/auth/setup answered ${result.response.status}`);
  const setCookie = result.response.headers.get("set-cookie");
  const cookie = setCookie?.split(";", 1)[0]?.trim();
  if (!cookie?.includes("=")) fail("POST /api/auth/setup did not return a session cookie");
  return cookie;
}

async function readRss(pid) {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    if (match) return { kib: Number(match[1]), source: "procfs" };
  } catch {
    // /proc is not available on every supported host.
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
    const kib = Number(stdout.trim());
    if (Number.isFinite(kib) && kib > 0) return { kib, source: "ps" };
  } catch {
    // The caller reports the missing process sample below.
  }
  fail(`Could not read resident memory for the benchmark server process ${pid}`);
}

async function authenticatedJson(baseUrl, cookie, route, init = {}) {
  const result = await fetchJson(`${baseUrl}${route}`, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      cookie,
      ...init.headers,
    },
  });
  if (!result.response.ok) fail(`${init.method ?? "GET"} ${route} answered ${result.response.status}`);
  return result;
}

async function runScan(baseUrl, cookie) {
  const startedAt = performance.now();
  const first = await authenticatedJson(baseUrl, cookie, "/api/library/scan", {
    method: "POST",
    body: "{}",
  });
  let state = first.body;
  const deadline = startedAt + scanTimeoutMs;
  while (state?.status !== "completed" && state?.status !== "failed") {
    if (performance.now() >= deadline) {
      fail(`Full library scan did not finish within ${scanTimeoutMs / 1_000} seconds`);
    }
    if (state?.status !== "running" && state?.status !== "paused") {
      fail(`POST /api/library/scan returned unexpected state ${String(state?.status)}`);
    }
    await sleep(pollDelayMs);
    state = (await authenticatedJson(baseUrl, cookie, "/api/library/scan")).body;
  }
  const elapsedMs = performance.now() - startedAt;
  if (state.status === "failed") fail(`Full library scan failed: ${state.error ?? "no error was provided"}`);
  return {
    status: state.status,
    elapsedMs,
    total: state.total,
    done: state.done,
    matched: state.matched,
    skipped: state.skipped,
    failed: state.failed,
  };
}

function nearestRank(values, percentile) {
  if (values.length === 0) fail("A latency summary has no samples");
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.max(1, Math.min(sorted.length, rank)) - 1];
}

function validHome(body) {
  return body !== null
    && typeof body === "object"
    && Array.isArray(body.order)
    && body.rows !== null
    && typeof body.rows === "object"
    && !Array.isArray(body.rows);
}

function validBrowse(body) {
  return body !== null
    && typeof body === "object"
    && typeof body.path === "string"
    && Array.isArray(body.items)
    && Number.isSafeInteger(body.total)
    && typeof body.pending === "boolean";
}

async function measureRoute(baseUrl, cookie, route, samples, valid) {
  const latencies = [];
  const statuses = {};
  let validResponses = 0;
  let lastBody;
  // The first request pays for lazy initialisation; with few samples it would be the p95.
  const warmUp = await fetchJson(`${baseUrl}${route}`, { headers: { cookie } });
  if (warmUp.response.status !== 200) fail(`GET ${route} answered ${warmUp.response.status}`);
  for (let sample = 0; sample < samples; sample += 1) {
    const result = await fetchJson(`${baseUrl}${route}`, { headers: { cookie } });
    const key = String(result.response.status);
    statuses[key] = (statuses[key] ?? 0) + 1;
    if (result.response.status !== 200) {
      fail(`GET ${route} answered ${result.response.status}`);
    }
    if (!valid(result.body)) fail(`GET ${route} answered 200 with an invalid response body`);
    latencies.push(result.elapsedMs);
    validResponses += 1;
    lastBody = result.body;
  }
  return {
    samples,
    validResponses,
    allResponsesValid: validResponses === samples,
    statuses,
    p50Ms: nearestRank(latencies, 50),
    p95Ms: nearestRank(latencies, 95),
    percentileMethod: "nearest-rank",
    lastBody,
  };
}

function searchResultCount(snapshot) {
  return (snapshot?.clusters?.length ?? 0) + (snapshot?.unidentified?.length ?? 0);
}

function searchTerminal(snapshot) {
  return snapshot.limitReached
    || (snapshot.state === "complete" && snapshot.sources.every((source) => !source.hasMore));
}

async function runSearch(baseUrl, cookie) {
  const request = {
    query: "Movie-00001",
    kind: "all",
    sources: ["local"],
    slotId: "benchmark-local-1",
    generation: 1,
  };
  const startedAt = performance.now();
  let id;
  let snapshot;
  let firstResultMs;
  let lastAvailableResultMs;
  let pageAllRequests = 0;
  let stalledPolls = 0;
  let previousProgress;
  let failure;
  try {
    const started = await authenticatedJson(baseUrl, cookie, "/api/search/everywhere", {
      method: "POST",
      body: JSON.stringify(request),
    });
    id = started.body?.id;
    snapshot = started.body?.snapshot;
    if (typeof id !== "string" || id === "" || snapshot === undefined) {
      fail("POST /api/search/everywhere returned an invalid session shape");
    }
    if (searchResultCount(snapshot) > 0) firstResultMs = performance.now() - startedAt;
    const deadline = startedAt + searchTimeoutMs;
    while (true) {
      if (performance.now() >= deadline) {
        fail(`Local search did not settle all available results within ${searchTimeoutMs / 1_000} seconds`);
      }
      if (snapshot.state === "failed") fail("Local search failed");
      if (searchResultCount(snapshot) > 0 && firstResultMs === undefined) {
        firstResultMs = performance.now() - startedAt;
      }
      const hasMore = snapshot.sources.some((source) => source.hasMore);
      if (searchTerminal(snapshot)) break;
      if (snapshot.state !== "partial" && hasMore) {
        const pageAll = await authenticatedJson(
          baseUrl,
          cookie,
          `/api/search/everywhere/${encodeURIComponent(id)}/page`,
          { method: "POST" },
        );
        if (pageAll.response.status !== 202 || !Number.isSafeInteger(pageAll.body?.revision)) {
          fail("POST /api/search/everywhere/:id/page returned an invalid response shape");
        }
        pageAllRequests += 1;
      }
      const polled = await authenticatedJson(
        baseUrl,
        cookie,
        `/api/search/everywhere/${encodeURIComponent(id)}/poll`,
        {
          method: "POST",
          body: JSON.stringify({ revision: snapshot.revision }),
        },
      );
      if (polled.body?.changed === true) snapshot = polled.body.snapshot;
      if (searchResultCount(snapshot) > 0 && firstResultMs === undefined) {
        firstResultMs = performance.now() - startedAt;
      }
      if (snapshot.state === "failed") fail("Local search failed");
      if (searchTerminal(snapshot)) break;
      const progress = `${snapshot.sources.reduce((total, source) => total + source.loaded, 0)}:${searchResultCount(snapshot)}`;
      stalledPolls = progress === previousProgress ? stalledPolls + 1 : 0;
      previousProgress = progress;
      if (stalledPolls >= searchNoProgressPollLimit) {
        fail(`Local search made no progress after ${searchNoProgressPollLimit} polls`);
      }
      if (polled.body?.changed !== true) await sleep(pollDelayMs);
    }
    lastAvailableResultMs = performance.now() - startedAt;
    const exactResult = [...snapshot.clusters, ...snapshot.unidentified]
      .some((result) => result.title === request.query);
    if (firstResultMs === undefined || !exactResult) {
      fail(`Local search completed without an exact ${request.query} result`);
    }
    return {
      request,
      startToFirstResultMs: firstResultMs,
      startToLastAvailableResultMs: lastAvailableResultMs,
      state: snapshot.state,
      limitReached: snapshot.limitReached,
      pageAllRequests,
      totalLoadedRecords: snapshot.sources.reduce((total, source) => total + source.loaded, 0),
      resultCount: searchResultCount(snapshot),
      sources: snapshot.sources.map((source) => ({
        class: source.sourceClass,
        state: source.state,
        loaded: source.loaded,
        hasMore: source.hasMore,
      })),
      sessionDeleted: true,
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (typeof id === "string" && id !== "") {
      try {
        const deleted = await fetchJson(
          `${baseUrl}/api/search/everywhere/${encodeURIComponent(id)}`,
          { method: "DELETE", headers: { cookie } },
        );
        if (deleted.response.status !== 204) {
          throw new BenchmarkError(`DELETE /api/search/everywhere/:id answered ${deleted.response.status}`);
        }
      } catch (error) {
        if (failure === undefined) throw error;
      }
    }
  }
}

async function revision() {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
  return stdout.trim();
}

let serverChild;

async function benchmark(options) {
  let child;
  let tempRoot;
  let removed = false;
  try {
    const commitSha = await revision();
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "stremio-offline-runtime-"));
    const seeded = await seedFixture(tempRoot, options.files);
    const port = await reservePort();
    child = startServer({ dataDir: seeded.dataDir, downloadsDir: seeded.downloadsDir, port });
    serverChild = child;
    const baseUrl = `http://127.0.0.1:${port}`;

    const coldStartMs = await waitForStartup(baseUrl, child);
    const cookie = await setupSession(baseUrl);
    const startupRss = await readRss(child.pid);
    const fullScan = await runScan(baseUrl, cookie);
    const firstScanRss = await readRss(child.pid);
    const rescan = await runScan(baseUrl, cookie);
    const home = await measureRoute(baseUrl, cookie, "/api/home", options.samples, validHome);
    const browse = await measureRoute(baseUrl, cookie, "/api/library/browse", options.samples, validBrowse);
    const search = await runSearch(baseUrl, cookie);

    const report = {
      commitSha,
      utcDate: new Date().toISOString(),
      platform: {
        name: process.platform,
        architecture: process.arch,
        release: os.release(),
      },
      nodeVersion: process.version,
      commandArguments: [...process.argv.slice(2)],
      command: `node scripts/benchmark-runtime.mjs ${process.argv.slice(2).join(" ")}`.trim(),
      fixture: {
        file: "e2e/fixtures/media/sample.mp4",
        sizeBytes: seeded.fixtureSizeBytes,
        filesSeeded: options.files,
        bytesCopied: seeded.fixtureSizeBytes * options.files,
      },
      coldStart: {
        durationMs: coldStartMs,
        ready: true,
      },
      rss: {
        unit: "KiB",
        platform: process.platform,
        afterStartup: startupRss,
        afterFirstScan: firstScanRss,
      },
      fullScan,
      rescan,
      home: {
        samples: home.samples,
        validResponses: home.validResponses,
        statusValid: home.allResponsesValid,
        statuses: home.statuses,
        p50Ms: home.p50Ms,
        p95Ms: home.p95Ms,
        percentileMethod: home.percentileMethod,
        rows: home.lastBody === undefined ? undefined : Object.keys(home.lastBody.rows).length,
      },
      browse: {
        path: "library root",
        samples: browse.samples,
        validResponses: browse.validResponses,
        statusValid: browse.allResponsesValid,
        statuses: browse.statuses,
        p50Ms: browse.p50Ms,
        p95Ms: browse.p95Ms,
        percentileMethod: browse.percentileMethod,
        pagination: {
          pageSize: 60,
          itemCount: browse.lastBody?.items?.length,
          totalItems: browse.lastBody?.total,
          responsePaginated: browse.lastBody === undefined ? undefined : browse.lastBody.total > browse.lastBody.items.length,
        },
      },
      search,
      temporaryDirectoryRemoved: true,
      qualifications: [
        "Cold start excludes dependency installation and build time.",
        "RSS is resident set size sampled after readiness and after the first scan, not a peak or steady-state value.",
        "Home and browse use serial authenticated requests after both scans and one discarded warm-up request each. Browse measures only the root page; the server page limit is 60.",
        "Percentiles use nearest-rank: for sorted N samples, rank ceil(p/100 * N), with p50 and p95 reported.",
        "The fixture copies a small synthetic MP4. It does not model NAS disk I/O, media inspection, real metadata providers, or production libraries.",
      ],
    };
    return report;
  } finally {
    try {
      await terminateServer(child);
    } finally {
      if (tempRoot !== undefined) {
        await rm(tempRoot, { recursive: true, force: true });
        removed = (await access(tempRoot).then(() => false, () => true));
        if (!removed) fail("The temporary benchmark directory was not removed");
      }
    }
  }
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    await requireBuild();
    const report = await benchmark(options);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Benchmark failed: ${message}`);
    if (serverChild?.outputTail?.length) console.error(`Last server output:\n${serverChild.outputTail.join("\n")}`);
    process.exitCode = 1;
  }
}

void main();
