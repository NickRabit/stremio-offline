# Runtime baseline benchmark

`scripts/benchmark-runtime.mjs` measures startup, library scanning, Home, library
browse and local search against an isolated copy of the built application. It
does not contact the server used by the person running the command.

## Reproduce

Install dependencies and build first. The benchmark deliberately refuses to run
when either bundle is absent, because build time is not a runtime metric.

```bash
npm ci
npm run build
node scripts/benchmark-runtime.mjs --files 5000 --samples 30
```

Smaller positive values are useful for a smoke run:

```bash
node scripts/benchmark-runtime.mjs --files 20 --samples 3
```

The report is JSON on stdout. Invalid arguments and runtime failures exit
nonzero and explain the failure on stderr.

## Isolation and fixture

Each run creates a directory named `stremio-offline-runtime-*` under the host's
temporary directory. It contains `data/` and `downloads/`, seeds `state.json`
with `{ "addons": [], "defaultsInstalled": true }`, and creates a fresh first-run
administrator through the API. The username, password and session cookie stay
inside the run and are never included in the report.

The fixture is `e2e/fixtures/media/sample.mp4`, currently 3,697 bytes. For file
count N, the runner copies it to `downloads/Movie-00001/Movie-00001.mp4`
through `downloads/Movie-0000N/Movie-0000N.mp4`. `DOWNLOAD_DIR` points at this
temporary tree and `LIBRARY_ROOTS` is overridden with the same directory, so an
inherited mount cannot enter the benchmark. The runner never reads or deletes
the repository's `data/`, `downloads/` or configured mounts.

The built server is spawned directly with these settings:

```text
PATH=<the runner's PATH, for media tools>
NODE_ENV=production
DATA_DIR=<temporary data directory>
DOWNLOAD_DIR=<temporary downloads directory>
LIBRARY_ROOTS=<temporary downloads directory>
HOST=127.0.0.1
PORT=<reserved ephemeral port>
LIBRARY_AUTO_SCAN=0
ADDON_AUTO_REFRESH=0
LIBRARY_SCAN_GAP_MS=0
SEARCH_EVERYWHERE_ENABLED=1
```

No other parent environment is inherited. In particular, account-reset
variables, provider credentials, media-server key overrides and output paths
cannot reach the benchmark child.

The temporary directory is removed and the server is terminated in a `finally`
path. The JSON report's `temporaryDirectoryRemoved` field is emitted only after
that cleanup succeeds.

## Measurements

Cold start runs from spawning `server/dist/index.js` until `/api/status`
returns `{ "status": "ok" }`. Startup waiting is bounded to 30 seconds.

RSS is read from `/proc/<pid>/status` when procfs is available, otherwise with
`ps -o rss= -p <pid>`. Values are labelled in KiB. A sample is taken after
startup and again after the first scan; these are point-in-time values, not a
peak or steady-state measurement.

A full scan starts with `POST /api/library/scan`, polls
`GET /api/library/scan` until `completed` or `failed`, and records wall time.
A failed or timed-out scan is an error, not a latency. The second scan is
started the same way without changing files and measures the warm rescan path.

Home and browse make the requested number of serial authenticated requests
after both scans. Each route first gets one discarded warm-up request: with a
small sample count the cold first request would otherwise be the p95. Browse uses the empty path for the library root. The server
returns at most 60 root rows per response; the report records both the page
size and the unpaginated total so a five-thousand-file run can be compared
correctly. Percentiles use nearest rank: after sorting N samples, rank
`ceil(p/100 * N)` is selected. For three samples, p50 is the second value and
p95 is the third. A non-200 response or a response with the wrong body shape
fails the benchmark before any latency is published.

The local-search measurement starts one request with:

```json
{
  "query": "Movie-00001",
  "kind": "all",
  "sources": ["local"],
  "slotId": "benchmark-local-1",
  "generation": 1
}
```

The session's initial snapshot is checked, then its actual revision is polled
through `POST /api/search/everywhere/:id/poll`. A snapshot can be complete while
a source still has `hasMore: true`, so the runner repeatedly asks
`POST /api/search/everywhere/:id/page` and polls again until every source has no
more results or `limitReached` is true. The overall search wait is bounded, and
30 consecutive polls without a growth in loaded or result count are also
treated as a failure.

The report records time to the first nonempty cluster or unidentified row and
time to the last available result. It also reports `limitReached`, each
source's final `hasMore` value, and total loaded/result counts so a capped run
cannot be mistaken for a fully exhausted one. The final snapshot must contain
an exact `Movie-00001` title. The session is deleted afterward. A completed
search without that result, a failed search or a polling timeout is an error
rather than a zero latency.

## Measured baseline

Both runs used `acdc44e8a6661d616a45ed4e317d3b70976e40b8` on macOS arm64
(Darwin 25.6.0, Node v22.23.3). The fixture file is 3,697 bytes. The 20-file
smoke ran at 2026-10-21T12:19:47Z; the 5,000-file run at
2026-10-21T12:20:27Z. RSS used the host `ps` fallback. These runs predate the
warm-up request, so their Home and browse p95 include one cold request; re-run
on the same Mac before comparing a later p95 with them.

| Measurement | 20 files, 3 samples | 5,000 files, 30 samples |
| --- | ---: | ---: |
| Cold start to valid `/api/status` | 210.168 ms | 342.570 ms |
| RSS after startup | 98,864 KiB | 166,864 KiB |
| RSS after first scan | 106,896 KiB | 242,384 KiB |
| First full scan | 108.052 ms | 24,318.375 ms |
| First scan units done / failed | 20 / 0 | 5,000 / 0 |
| Rescan without file changes | 2.386 ms, 0 queued | 760.940 ms, 0 queued |
| `/api/home` p50 / p95 | 1.160 / 3.097 ms | 1.780 / 5.626 ms |
| `/api/library/browse` p50 / p95 | 22.062 / 27.660 ms | 51.762 / 79.521 ms |
| Browse items returned / total | 20 / 20 | 60 / 5,000 |
| Search: first result | 8.385 ms | 24.221 ms |
| Search: last available result | 8.401 ms | 32.095 ms |
| Search records / page requests | 11 / 0 | 32 / 1 |

Every Home and browse sample returned HTTP 200 with the expected body shape.
Both scans completed and all units in the first scan were skipped because the
fixture has no metadata providers; the warm rescan queued none. Both search
sessions found the exact `Movie-00001` title, exhausted their local source,
reported `limitReached: false`, and were deleted. Each temporary directory was
removed. The 5,000-file run copied 18,485,000 fixture bytes and took 29.30 s
wall time including fixture generation, setup, measurement and cleanup.

These are Mac measurements of a synthetic local tree. In particular, the scan
does not measure provider matching or a NAS-mounted filesystem. Compare future
runs on the same platform and fixture before attributing a change to code.

When the benchmark fails, stderr also carries the last 20 lines the server
printed, so a crash or refused start can be diagnosed without re-running.

## Qualification

Compare runs only when the file count, sample count, platform, architecture,
Node version and command arguments are also the same. The synthetic fixture
has negligible transfer and media-inspection cost and no real metadata
providers. It cannot predict NAS I/O, network-mounted library latency,
catalogue requests, artwork generation or production library shape.
