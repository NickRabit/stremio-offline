# Bug hunt baseline

This is a machine-specific record of the functional gates on `origin/main`
before runtime changes for the bug hunt proposed in PR #488. It does not
represent Synology performance, Android hardware, or CI timing.

## Baseline

| Field | Value |
| --- | --- |
| Commit | `acdc44e8a6661d616a45ed4e317d3b70976e40b8` |
| UTC date | 2026-10-21 |
| Platform | macOS 26.7, Darwin 25.6.0, arm64 |
| Node | v22.23.3 |
| npm | 10.9.9 |

All commands ran from the repository root. Output was captured under `/tmp`
with:

```sh
/usr/bin/time -p npm ci > /tmp/bh01-npm-ci.log 2>&1
/usr/bin/time -p npm test > /tmp/bh01-npm-test.log 2>&1
/usr/bin/time -p npm run build > /tmp/bh01-npm-build.log 2>&1
```

`node_modules` was absent before `npm ci`. The install completed successfully:
exit code 0, 2.76 s wall time.

The aggregate `npm test` command passed with exit code 0 and 58.00 s wall time.
The four suites were then invoked separately so their wall times could be
recorded:

```sh
/usr/bin/time -p npm run test -w server > /tmp/bh01-test-server.log 2>&1
/usr/bin/time -p npm run test -w web > /tmp/bh01-test-web.log 2>&1
/usr/bin/time -p npm run test -w desktop > /tmp/bh01-test-desktop.log 2>&1
/usr/bin/time -p npm run test:media-client > /tmp/bh01-test-media-client.log 2>&1
```

## Unit and component tests

| Suite | Exit | Wall time | Tests | Passed | Skipped | Failed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Server | 0 | 47.54 s | 2,835 | 2,829 | 6 | 0 |
| Web | 0 | 8.91 s | 1,167 | 1,167 | 0 | 0 |
| Desktop | 0 | 1.22 s | 301 | 301 | 0 | 0 |
| Media client | 0 | 1.67 s | 30 | 29 | 1 | 0 |

Vitest reported 87 passed web test files. The server and desktop runners
reported zero tests outside the pass, skip, and fail categories.

The observed skips were:

- `a catalogue backdrop is narrowed before it is stored` in
  `server/src/artwork.test.ts`: TAP emitted
  `ok 81 - ... # SKIP`, with no reason.
- `on Linux only folders are watched, and the NAS's own folders are left out`
  in `server/src/library-watch.test.ts`: TAP emitted
  `ok 968 - ... # SKIP`, with no reason.
- `a folder whose own mtime did not move is still listed afresh` in
  `server/src/library.test.ts`: TAP emitted
  `# SKIP only NTFS moves a folder's mtime lazily; elsewhere the mtime is the key`.
- `a composed fan is one JPEG at the size a tile draws` in
  `server/src/mosaic.test.ts`: TAP emitted `ok 1656 - ... # SKIP`, with no
  reason.
- `the NVENC probe follows NVENC and stands down for VAAPI` in
  `server/src/playback.test.ts`: TAP emitted
  `# SKIP a Mac has no NVIDIA encoder, so NVENC is never probed there`.
- `the Dolby Vision filter strips NAL 62 and 63 from a real HEVC copy into fMP4 HLS`
  in `server/src/playback.test.ts`: TAP emitted
  `ok 1757 - ... # SKIP`, with no reason.
- `a disposable application uses its own key and roots and leaves nothing behind`
  in `scripts/media-client-verification.test.mjs`: TAP emitted
  `# SKIP no build in this checkout; the runner exercises this path explicitly`.

A second run of `npm test` on the same commit in a Linux container (x64,
Node 22, as root) reproduced the same totals per suite (2,835 / 1,167 / 301 /
30) with no failures, but a different set of server skips: 8 instead of 6.
Six of them are permission tests that skip under root because root ignores
the permission bits:

- `a directory that refuses the probe file reads as read-only`
- `a copy that fails part way leaves the destination absent and the source alone`
- `a move that fails after it took the name leaves the source and no placeholder`
- `the source of a finished move is reported, not thrown, when it will not go`
- `a directory that cannot be read leaves the walk incomplete but the rest listed`
- `a folder that could not be read is never taken for empty`
- plus the platform skips (`a Mac never probes NVENC`, the NTFS mtime test).

These are the fault-injection tests BH-2.2, BH-4.1 and BH-4.4 depend on.
Gates for those parts must run as a non-root user, and a part's PR states
which user ran them.

No flaky unit tests were established by the aggregate and timed suite
invocations; those successful runs are not treated as flakiness evidence.

## Build

`npm run build` passed with exit code 0 and 11.18 s wall time. Vite transformed
1,691 modules and reported these output sizes:

| Output | Size | Gzip |
| --- | ---: | ---: |
| `dist/index.html` | 1.12 kB | 0.53 kB |
| `dist/assets/index-CDqoBGuD.css` | 211.47 kB | 37.06 kB |
| `dist/assets/index-CzB3fWsi.js` | 2,510.89 kB | 715.01 kB |

Vite warned that some chunks were larger than 500 kB after minification and
suggested dynamic imports, manual chunks, or a higher
`build.chunkSizeWarningLimit`. The build also generated
`dist/third-party-licenses.txt` from 5 packages.

## Docker e2e

The reviewer ran `npm run test:e2e:docker` in this worktree. Docker built the
Playwright image for `linux/arm64` on the Mac. The run was stopped after 95 test
attempts because the browser target crashed in
`e2e/tests/catalog-local.spec.ts`; subsequent player tests repeatedly failed.
The interrupted command exited 137 after its container was stopped. Its output
is preserved in the local ai-team task log. This is a failed local gate, not a
passing baseline or proof of an application regression.

The same code revision under PR #488 completed all 11 GitHub CI checks,
including the Docker e2e job, on the CI host:
[run 39595191494](https://github.com/NickRabit/stremio-offline/actions/runs/39595191494).
The local arm64 browser crash remains an environment difference to investigate
if repeatable on a supported arm64 runner.

## Container smoke check

`docker compose up -d --build` could not complete on this host: Docker stalled
while resolving the locally present `node:22-trixie-slim` base image. A minimal
Dockerfile with that same base stalled at the same step. The production image
and Compose startup therefore remain unverified locally.

As a narrower check, the reviewer launched the built server and web artifacts
from this commit in an isolated container based on the locally available e2e
image, with disposable data and download directories. It is running at
`http://localhost:8092`. `GET /api/status` returned
`{"status":"ok",...}`, `GET /` returned HTTP 200, and the startup log showed
the listener ready. This verifies application startup and its HTTP surface,
not the production Dockerfile or entrypoint.

## Android host gate

From `android-tv/`, with `JAVA_HOME` set to the local JDK 17, the reviewer ran
`./gradlew assembleDebug testDebugUnitTest lintDebug`. It passed with exit code
0 in 128.54 s wall time; Gradle reported 53 executed tasks. Compiler warnings
include deprecated Coil `LocalImageLoader` use in `CardsTest.kt` and deprecated
`setIsInteractive` use in `PlayerScreenLifecycleTest.kt`. The gate ran on a Mac,
not an Android emulator or physical TV. The 159 JUnit XML reports contain 1,175
tests, all passed, with no skipped tests.
