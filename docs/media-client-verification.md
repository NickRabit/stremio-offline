# Production media-client verification

`scripts/media-client-verification.mjs` drives a disposable build of this
application over its own HTTP API and reports what came back. It answers two
questions the unit suites cannot: does the production path play a real remote
Jellyfin/Emby original without writing to the provider, and does a large
library browse one bounded page at a time under latency, interruption and
restoration.

It is **HTTP-level evidence**. Nothing is rendered: no browser and no TV
decoder plays a frame, so a passing report does not claim a rendered playback
pass. Browser DOM growth and viewport behaviour stay with the Playwright layer
and are a separate follow-up.

## What the runner controls

- It starts **its own disposable application**: the built server and web bundle
  are staged into a private temporary tree, with an empty data directory, an
  empty addon list, `defaultsInstalled: true`, `LIBRARY_AUTO_SCAN=0` and
  `ADDON_AUTO_REFRESH=0`. A fresh random account is created through
  `POST /api/auth/setup`; the session never leaves the process and is never
  printed.
- The child inherits **only the platform environment** (`PATH`, `TMPDIR`,
  `LANG` and the Windows equivalents) plus exactly what the run decides. Every
  variable the application reads — a deployment key path, `LIBRARY_ROOTS`, an
  administrator password, cache sizes, hardware overrides — is dropped, and the
  names of the ones that were present are reported in
  `application.strippedInheritedEnv`. The run writes its own 32-byte vault key
  (`0600`) and its own empty library root inside the tree, so no user
  installation setting can reach it.
- Every port it uses is a free port on `127.0.0.1`. It never uses 8090, 8091 or
  18099, never touches a running instance, and never reads an existing account
  or data directory.
- The child's stdout and stderr go to one `0600` file inside its own temporary
  tree (`<tree>/app.log`). The runner neither reads nor echoes it, and the tree
  is removed on the way out.
- `stop()` kills the whole process **group** — a converter or a probe belongs to
  the group, not to the leader that spawned it — even when the leader already
  exited, and is idempotent.
- A report carries aggregates, labels and hashes of identifiers. It never
  carries an address, a credential, a session, an upstream item id, a source id
  or a media path or title. The last step before writing the file refuses a
  report that grew one.

## Deadlines

Nothing in this harness waits for ever. The application client arms one deadline
per exchange (a JSON call and a bounded byte read alike, the body included); the
fixture client arms its own for every provider read and composes a caller's
signal; the observed proxy gives each upstream exchange its own bounded deadline
(`upstreamDeadlineMs`, two minutes by default) that covers the body as well as
the head. A stalled body is cut off and counted, never buffered and never hung
on; an upstream whose head was relayed but whose body never came is answered as
an error with headers that match, rather than a promise of bytes it will not
deliver.

## Prerequisites

- A build: `npm run build` (the stub stages `server/dist` and `web/dist`).
- FFmpeg and ffprobe on `PATH` for the real-provider profile, exactly as
  `npm run test:e2e` needs them. Without them the probe and playback checks
  fail honestly instead of passing.
- Real providers only for the fixture mode: local Docker instances of Jellyfin
  and Emby, reachable on loopback, with a disposable account and at least one
  item each. The coordinator supplies those.

## CLI

```
node scripts/media-client-verification.mjs --fixture <private.json> --output <report.json>
node scripts/media-client-verification.mjs --synthetic --items <count> --pages <count> --delay-ms <n> --output <report.json>
node scripts/media-client-verification.mjs --help
```

| Control | Meaning |
| --- | --- |
| `--fixture <path>` | Private provider file, see below. Only loopback base URLs are accepted, and only the item ids listed there are read. |
| `--synthetic` | The generated large-catalogue profile: an in-process Jellyfin server speaking the real protocol. |
| `--items <n>` | Synthetic catalogue size, `1..100000` (default 600). No catalogue is ever materialised: rows are generated from an index. |
| `--pages <n>` | Browse pages to traverse, `1..200` (default 6). |
| `--delay-ms <n>` | Controlled upstream latency for the fault scenarios, `0..60000` (default 0). |
| `--output <path>` | Where the JSON report is written. Required. |

Everything is validated before a socket is opened: an unknown flag, a missing
mode, an out-of-range count, a non-loopback origin, credentials inside a URL or
a provider that is not `jellyfin`/`emby` fails with exit code 2 and a sentence.

### The private fixture file

```json
{
  "providers": [
    {
      "provider": "jellyfin",
      "baseUrl": "http://127.0.0.1:8096",
      "username": "<disposable account>",
      "password": "<disposable password>",
      "itemIds": ["<provider item id>", "<provider item id>"]
    }
  ]
}
```

The file stays private: it is read, validated, and never copied into a report.
The runner performs no provisioning writes; everything it does against a
provider is a `GET`, `HEAD` or the one authentication `POST`.

## The observed proxy

Each provider is reached through a streaming observer on its own loopback port.
It relays bodies without buffering them, keeps `content-length`,
`content-range`, `accept-ranges`, `etag` and `last-modified` intact, forwards
no redirect automatically, and refuses every mutation but
`POST /Users/AuthenticateByName` -- including `Sessions/Playing*`,
`UserData`/`Played`/`Favorite`, refresh and setup calls. A refusal is counted
per kind and never reaches the provider.

Every request is classified into a category a report may name: `info`,
`authentication`, `user`, `views`, `listing`, `match`, `detail`, `ancestors`,
`versions`, `original`, `subtitle`, `artwork`, `other`, `prohibited`. Counters
per category and lane: `starts`, `completions`, `aborts`, `failures`, `refused`,
`redirects`, `inFlight`, `inFlightPeak`, `bytes`, `delayed`, `delayedAborted`,
`held`, `heldAborted`, `heldReleased`. Only a bounded tail of safe events is
kept.

The harness reads the provider itself over the same observer, in a separate
`fixture` lane, so its own sign-in, `UserData` snapshot, version list and
original-byte comparison never blur what the application did. A request that
the client gives up on while it is delayed is counted as `delayedAborted` and
**never** dials the provider.

Two controls drive the fault scenarios, always against these disposable
instances:

| Control | Effect |
| --- | --- |
| `setLatency(category, ms)` | Wait before dialling upstream for that category. |
| `armFault(category, { kind, times, ... })` | `status` (any status, `retryAfterSeconds` adds `Retry-After`), `drop` (a connection drop) or `hold` (no answer until the client leaves). Spent faults disappear. |

`faultServed(category, kind)` and `dials(category)` report how many times a fault
was actually served and how many times the provider was dialled. The recovery
checks read both: a fault that was never served means the application answered
without asking the provider, which is reported as **not exercised** rather than
as a pass.

## Result contract

```jsonc
{
  "version": 1,
  "generatedAt": "ISO",
  "mode": "fixture" | "synthetic",
  "runner": { "node": "v22…", "platform": "darwin", "arch": "arm64", "durationMs": 0 },
  "config": { "items": 600, "pages": 6, "delayMs": 0, "providers": 1, "browseLimit": 60, "capabilities": { } },
  "application": { "port": 53611, "version": "0.5.76", "build": "disposable", "strippedInheritedEnv": ["MEDIA_SERVER_KEY_FILE", "LIBRARY_ROOTS"] },
  "observed": { "providers": [ { "label": "provider-1", "categories": { }, "refused": { }, "upstreamDials": { }, "fixtureReads": { }, "events": [ ] } ] },
  "checks": [ { "id": "provider-1.item-1.seek", "status": "pass", "detail": { } } ],
  "skips": [ { "id": "…track-change", "reason": "only one audio track is available" } ],
  "unmeasured": [ { "id": "…cancellation-child-processes", "reason": "`ps` is not available on this platform" } ],
  "caveats": [ "…" ],
  "contract": { "runner.runVerification": "(config, { fixture?, repoRoot?, folders?, appLogLevel? }) => Report" },
  "summary": { "pass": 11, "fail": 0, "skipped": 0, "unmeasured": 0 },
  "ok": true
}
```

`status` is one of `pass`, `fail`, `skipped` and `unmeasured`:

- **skipped** is a capability-dependent case that never ran -- a single audio
  track, no external subtitle, no embedded text track, one playable version --
  and a case the run could not put the application in front of: no playback
  session was created, the 503 or the dropped connection was never served, the
  item was not on a browsed page, inspection never read the source so a held
  read could not be requested. A skipped check is never a pass, and
  `skips[].reason` says which of these it was.
- **unmeasured** is a comparison or a metric that could not be produced: the
  same range could not be read from the provider, the provider reported no
  `UserData`, or `ps` is unavailable so the child-process count is unknown. It
  is not guessed at.
- **fail** is a real failure. Structural budget failures -- a browse page that
  fans out into more than one upstream page, a per-item detail or version call
  during a listing, a duplicate or missing item in a traversal, more rows handed
  over than one page per browse request allows, an unbounded retry count after a
  429 -- fail the run, and `ok` becomes false with exit code 1.

Two rules keep a pass meaningful. A check never passes while the thing it
asserts is unknown: an unreadable provider range, a missing `UserData` snapshot
or an unmeasurable child count is `unmeasured`, never `pass`. And a check never
passes a case that did not run: a fault that was never served, a source that
could not be sealed fresh or a probe that never reached the provider is
`skipped` (or `fail` when the application was demonstrably able to get there and
did not).

### Check ids

Focused on playback and remote libraries: `provider-N.fixture-signin`,
`connection-create`, `library-discover`, `library-attach`, `visible-libraries`,
`no-prohibited-mutation`, `fixture-reads`, and per supplied item
`browse-membership`, `detail`, `sources-listing`, `sources-shape`, `inspect`,
`playback-start`, `session-live`, `content`, `seek-api`, `track-change`,
`external-subtitle`, `embedded-subtitle`, `local-resume`,
`local-resume-reopen`, `local-resume-version-tag-write`, `second-version`,
`.second.content`, `cancellation`, `cancellation-child-processes`,
`recovery-503`, `recovery-drop`, `rate-limit-budget`, `session-stopped`,
`provider-userdata-unchanged`, and for the generated catalogue
`synthetic.connection-create`, `library-discover`, `library-attach`,
`titles-traversal`, `repeat-page`, `cancel-delayed-page`, `folder-mode`,
`second-connection`, `unrelated-provider`, `fetch-budget`.

An `item-N` label is the position in the fixture file; the report carries a
short hash of the item id so a result can be matched to the fixture without the
id itself travelling.

## What the profiles assert

**Playback profile (real providers).** Connection, discovery, attachment and the
projected read-only capabilities; browse membership, item detail and the sealed
source listing; a real inspection that has to report something about the media;
a production playback session with an explicit browser capability set, then a
nonzero `Range` against the returned resource which must answer `206` with
exactly the range asked for and deliver the provider's own bytes for it (status,
`Content-Range`, length and SHA-256 all compared -- a pass is never granted when
the provider side could not be read); converted paths, when exposed, checked by a playlist
plus a real media segment and, where the variant declares one, a usable init
segment; a seek API call that keeps the same session (browser timestamp application remains unmeasured); an audio-track change that does the
same; the available external and embedded subtitle paths; local resume written,
read back and tagged with the version it was written for, explicit replacement of
that version tag, and the saved time used to reopen; automatic browser resume
isolation is explicitly unmeasured; a second
version inspected, started and compared the same way (prefer an offered HEVC
variant to exercise browser conversion); the session stopped and
proved gone; provider `UserData` compared before and after; recovery from a 503 and
a connection drop, proving the fault was served and the retry reached the provider;
a separate 429 request-budget check proves rate limiting was exercised but does
not claim recovery after the fault clears; and a cancellation experiment on a cold
inspection source that holds the original, aborts the client, requires the
application's child processes to be back to their baseline and requires the
following request to work again.

**Synthetic profile.** The generated catalogue exercises the production browse
routes against the real protocol: one upstream page per requested page, bounded
upstream page sizes, no per-item detail or version call while listing, an exact,
duplicate-free traversal for the requested pages and the catalogue total, a
repeated page that must answer the same rows in the same order and offer a
cursor that really continues the listing (the number of upstream requests a
repeat makes is reported, not required), a cancelled delayed page that reached
the provider and never dialled it afterwards, folder mode against titles mode
with its own row accounting, an unrelated provider that answers while another is
slow and stays healthy while a third is gone, and a fetch budget that holds the
provider to at most one page of rows per browse request, alongside memory/RSS
samples of the application.

## Unit tests

```
node --test scripts/media-client-verification.test.mjs
```

They exercise the exported boundaries against real loopback servers: input
validation, the mutation refusal, streaming and range preservation, disconnect
cleanup, abort-before-upstream, finite faults, lane separation, bounded event
recording, the content-comparison classification, deadlines on stalled bodies
(application client and observed proxy), the environment isolation of the
disposable child, and the generated provider's page/total arithmetic. One test
also boots a disposable application to prove its own vault key and library roots
are used and to prove `stop()` removes the tree and is idempotent; it skips
itself when the checkout has no build. They need no provider.

## Recorded verification (2026-10-15)

The disposable Linux run against Jellyfin 12.2.0 and Emby 4.9.3.0 produced
**141 passing checks, zero failures, 43 skips and 23 unmeasured checks**. Four
18-second fixture variants cover H.264/AAC, H.264/AC3, HEVC/AAC, two audio tracks,
embedded text subtitles and external subtitles. Additional short fixtures explain
some capability skips and ranges too small to compare.

Both providers delivered verified direct-play ranges, remux segments and
transcoded segments. Dropping the first direct-play range produced `502`, then
`206` on retry, with one upstream dial and the same nonzero-range SHA-256 as the
provider. Eight supplied items retained all five compared provider `UserData`
fields; no prohibited mutation was attempted.

The cancellation reproduction initially left preparation running after the client
left. With the fix, the held original was canceled before any upstream dial,
there were no late starts, child processes returned from one to zero, and a
following inspection succeeded with a fresh original read.

The synthetic 100,000-item catalogue passed all 11 checks. Six requested pages
returned 360 distinct rows in six upstream listing requests, with no per-item
metadata fan-out. Extra repeat, folder, cancellation and isolation scenarios
remained within their page budget. This does not measure a 100,000-row browser
DOM or hardware decoder performance.

The final gates passed 2,419 server tests (eight skipped), 983 web tests, 301
desktop tests, 30 harness tests, and 22 remote-library Playwright cases in Docker.
The Playwright cases include returning from detail while a page is canceled,
retaining rows, retrying the same cursor and rejecting a late response.

## Out of scope

Bulk copying of remote items into local libraries, app-local manual matching and
an in-player source chooser are recorded follow-ups in
[roadmap.md](roadmap.md). Remote transcoding, direct client connections and
remote history synchronisation stay outside the read-only integration scope.
Real Synology and iPhone playback verification remains necessary for hardware
performance and codec behaviour, and a rendered browser or TV pass is not part
of this runner.


Each provider's `transport-direct`, `transport-remux` and `transport-transcode`
entries require a successfully prepared session and a passing corresponding byte
check. Modes absent from selected fixtures are skipped; prepared modes without
byte proof are unmeasured. These entries do not claim browser/TV decoding.
`progress-write-cost` records the observed upstream metadata count for one warm
local progress save per provider; it reports a cost, not an enforced budget.
