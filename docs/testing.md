# Testing strategy

This document describes how the project is tested, and the plan for the layers
that are not built yet. It is written so that any phase can be picked up
independently of the others.

## Why

The client is where most of the recent bugs have been: mobile catalog layout,
title detail, landscape Safari chrome, sideways pans on the source list. All of
them were found by hand, on a device, after the fact. None of them would have
been caught by the server test suite.

The client also has no obvious seam for testing. `web/src/App.tsx` holds most of
the application state in one component, and responsive behaviour lives almost
entirely in CSS media queries -- which a DOM emulator does not evaluate at all.
The strategy below works with that reality instead of demanding a refactor
first: pure logic is unit tested, everything layout-shaped is tested in a real
browser.

## Layers

| Layer | Tool | Runs against | Purpose |
| --- | --- | --- | --- |
| L0 | `node:test` via `tsx` | `server/src` | Server logic. Exists today. |
| L1 | Vitest + Testing Library | `web/src`, jsdom | Pure client logic and components. |
| L2 | Playwright | Built app + real server + fake addon | End-to-end user journeys. |
| L3 | Playwright projects | Same, across viewports | Responsive layout, visual and accessibility regressions. |

### L0 -- server (existing)

`npm test` runs `tsx --test server/src/*.test.ts server/src/routes/*.test.ts`.
The second pattern is there because the HTTP layer is moving out of
`index.ts` area by area; a further directory under `server/src` needs its own
pattern, as `sh` does not expand `**` recursively.

### L1 -- client unit and component tests

Runner: **Vitest** with the `jsdom` environment, sharing Vite's existing
transform pipeline so there is no second build configuration to keep in sync.

Highest value per line of test code, in order:

1. Pure modules with no DOM dependency -- `streams.ts` (size parsing from free
   text, sorting and filtering), `languages.ts` (flag and word detection),
   `log-groups.ts` (log parsing, fingerprinting, grouping).
2. Modules with a narrow DOM surface -- `clipboard.ts` (the secure-context
   fallback path that exists because the NAS serves over plain HTTP),
   `diagnostics.ts` (repeat suppression, host extraction).
3. `api.ts` error handling -- `ApiError` status and code propagation, the
   timeout branch, the 204 no-content branch.
4. Component tests for the small, self-contained components (`Login`, `Stats`),
   with HTTP mocked at the network boundary.

Two rules that keep this layer useful:

- **Mock at the network boundary, not at the module boundary.** Use `msw` for
  component tests rather than stubbing the `api` object, so the tests keep
  exercising `api.ts` and break when a route changes.
- **Never assert layout in jsdom.** jsdom does not apply CSS, so a media query
  test there proves nothing. Layout belongs to L3.

`App.tsx` is deliberately not the target of this layer. Rather than refactoring
it up front, pull pure logic (stream ranking, episode selection, filter
handling) out into modules opportunistically, whenever that part of the file is
being changed for another reason, and unit test it as it comes out.

### L2 -- end-to-end journeys

Runner: **Playwright**, driving the built web bundle served by the real server.
Config in `playwright.config.ts`, specs in `e2e/tests`, fixtures in
`e2e/fixtures`.

The fixture stack is two servers, both started by Playwright itself:

- `e2e/fixtures/addon-server.mjs` is a Stremio addon that answers from memory --
  one movie, one series with three episodes, and two sources per title that
  differ in size and language so ordering and filtering have something real to
  work on. It also serves a 4 kB MP4, so a queued download is a genuine
  transfer rather than a mock.
- `e2e/fixtures/app-server.mjs` starts the built server on a throwaway
  directory under `e2e/.tmp`, wiped at the start of every run. The state file is
  seeded with `defaultsInstalled: true`, which is what stops the server fetching
  Cinemeta and OpenSubtitles on first boot; `ALLOW_PRIVATE_ADDONS=1` is what
  lets the SSRF guard accept an addon on loopback. It also lays the built server
  and web bundles out the way the image does, because the server resolves its
  web root as `../../web` -- in a plain checkout that path is the unbuilt
  workspace.

Because there is one server with one state file, the specs run serially
(`workers: 1`) rather than fighting over it.

The `setup` project runs first and is a real journey, not scaffolding: a fresh
server has no account, so it creates one and installs the fake addon through the
UI. The session it leaves behind is reused by every other spec through
`storageState`.

Covered today: first-run account creation, adding an addon, sign-in and its
refusal, the open and closed API endpoints, browsing a catalog, search with and
without a match, a movie detail, a series episode list, source ordering and
language filtering, the up-next countdown that carries playback into the next
episode, queueing a download through to a finished job, a setting that survives
a reload, diagnostics, and secure mode -- that catalogue payloads carry no
provider address, that a page load touches nothing but the app's own origin, and
that the Content-Security-Policy is served.

Restricted mode has a **separate Playwright config** (`playwright.restricted.config.ts`).
It must not share `e2e/.tmp` or the unlocked session cookie. The fixture
`e2e/fixtures/restricted-server.mjs` uses `e2e/.tmp-restricted`, app port 8199,
seeds an addon against the fake addon process and a stored account
`restricted-admin` / `restricted-password`. Run it with `npm run test:e2e:restricted`. `test:e2e:docker`
runs the unlocked suite and then the restricted config sequentially.

The test image includes FFmpeg for media inspection and real JPEG timeline previews.
Local playback tests cover mouse and touch previews, natural previous/next-file ordering,
and boundary files hiding the unavailable episode button across the viewport matrix.

### L3 -- responsive, visual, accessibility

Same Playwright installation, one set of tests run across several `projects`.
The viewports are chosen to sit on either side of the breakpoints that actually
exist in `web/src/style.css`:

| Project | Viewport | Covers |
| --- | --- | --- |
| `desktop` | 1440x900 | The >=981px layout: sidebar, two-column catalog |
| `desktop-short` | 1280x760 | The `max-height: 780px` series-sources branch |
| `tablet` | 820x1180, touch | The 701-980px band |
| `mobile` | 390x844 (iPhone 13) | The <=700px layout: bottom nav, 3-column poster grid |
| `mobile-landscape` | 844x390, touch | `max-width:980 and max-height:500 and orientation:landscape`, plus the `mobileLandscape` branch in `Player.tsx` |

The journey specs stay on one viewport -- they are about behaviour. Only the
specs under `e2e/tests/layout` run across the whole matrix.

Three kinds of assertion, in increasing order of maintenance cost:

**a) Layout invariants** (`e2e/tests/layout/invariants.spec.ts`). Deterministic,
no stored baselines, no upkeep. These catch the class of bug that has actually
been shipped:

- nothing escapes the page sideways, in any of the six views. Content inside a
  pane that scrolls horizontally on purpose -- the download table, a poster
  strip -- is exempt; only content that escapes the page itself counts.
- the navigation follows the 700px breakpoint: a full-height sidebar above it,
  a bar pinned to the bottom below it
- every navigation entry is inside the viewport without scrolling
- on touch projects, controls meet the 24px minimum from WCAG 2.2 AA (2.5.8).
  Anything roomier is a design choice and is deliberately not enforced, or the
  test would be dictating the layout rather than guarding it.
- no poster hangs past the edge of its grid

**b) Screenshot baselines** (`e2e/tests/layout/screenshots.spec.ts`). Four
screens -- catalog, a title detail with its sources, the library and settings --
across four of the five projects. They live in
`e2e/tests/layout/__screenshots__/<project>/`.

They are only comparable when every one of them is produced in the same place,
so they are always generated inside the image in `e2e/Dockerfile`, based on
`mcr.microsoft.com/playwright:v1.56.1-noble`:

```
npm run test:e2e:snapshots
```

The **Update screenshot baselines** workflow does the same thing on a branch and
pushes the result. It runs on the same amd64 runner that checks them, so it is
the path that cannot get the architecture wrong -- prefer it whenever a change
touches a baseline at all.

**The container is not enough; the architecture has to match too.** The image
pins the browser and the fonts, but glyph rasterisation still differs between
arm64 and amd64, so baselines generated in the container on an Apple Silicon Mac
are rejected by the amd64 CI runner. It is not subtle and it is not limited to
the screens that changed: regenerating one settings baseline on arm64 failed all
five viewports, including the two whose text was identical, and the fixed
120-pixel tolerance does not come close to absorbing it. To generate locally on
an Apple Silicon Mac, force the platform on both the build and the run:

```
docker build --platform linux/amd64 -t stremio-offline-e2e -f e2e/Dockerfile .
docker run --rm --platform linux/amd64 -v "$PWD":/work -w /work -e CI=1 \
  stremio-offline-e2e npx playwright test layout/screenshots.spec.ts --update-snapshots
```

Emulation makes a run roughly three times slower, which is still quicker than a
round trip through CI. Narrow it with `-g` when one screen changed: regenerating
everything commits a megabyte of churn that no reviewer can read.

Two decisions worth knowing about:

- **The tolerance is a fixed 120 pixels, not a percentage.** A 1% ratio sounds
  safe and is not: bumping the poster title from 12px to 16px stayed under it on
  every screen. Runs inside the container are byte-stable, so the small fixed
  budget only has to absorb renderer noise.
- **`desktop-short` has no baselines.** These four screens look the same at
  1280x760 as at 1440x900. That project earns its place through the invariants,
  which cover the 780px height rule; a megabyte of near-identical images does
  not.

**What baselines do not cover here.** Most of this app's content lives inside
panes that scroll on their own -- the poster grid, the source list, the episode
list. `fullPage` does not expand those, so a baseline captures the frame and
whatever is above the inner scroll boundary. That is genuinely where the
regressions have been (navigation placement, a clipped toolbar, landscape
chrome), but a change to a poster tile's title, three rows down inside the grid,
will not show up. Do not read a passing baseline as "the screen is unchanged".

**c) Accessibility** (`e2e/tests/layout/accessibility.spec.ts`).
`@axe-core/playwright` on the same matrix, WCAG 2.0 and 2.1 at A and AA. It
decides what can be decided from the DOM; keyboard order and screen reader
wording still need a person.

Running this matrix for the first time found three real defects, which are fixed
in the same change: the library toolbar was clipped below 700px so its last
control could not be reached at all; the catalog filters lost their accessible
names in landscape, where the CSS hides the label text; and the download queue
scrolled sideways without being reachable from the keyboard.

The `safari-landscape` WebKit project verifies document scrolling and section
scroll restoration. Playwright's WebKit is not iOS Safari: it does not reproduce the
mobile browser chrome, the collapsing URL bar, or the safe-area behaviour that
caused several of the landscape fixes. Those still need a real device.

### Remote playback and seek regressions

AirPlay is disabled in the custom player. The video element disallows remote
playback, no route picker is offered, and wireless events do not switch the
playback engine. HLS uses hls.js when supported, with native HLS only as a
fallback for browsers without MSE support.

Before restoring AirPlay, verify actual iPhone and Mac playback with HomePods
and video receivers, including HEVC with converted AAC audio, seeking, receiver
loss, and return to local playback. Browser API mocks cannot establish device
compatibility or reliable reconnection.

Server tests cover delayed HLS initialization on slow storage, subtitle process
cancellation and exit before media revocation, and the subtitle reader: one per
track, kept across a seek it already covers, restarted for another track, a jump
back before its start, or a position beyond what it has read. Reading embedded
subtitles out of a remote film pulls the rest of the file through the proxy, so
the cues are extracted once with source timestamps (`-copyts`) and shifted to
the playing generation on the way out; without that an input seek rebases them
to whatever packet it landed on, minutes away from the picture. Client tests
cover the poll: its retries, cancellation when the session changes, the second
attach once the reader has the whole track, and the hand-wired per-request
timeout that keeps it working on Safari without `AbortSignal.any`. The browser
regression checks that embedded subtitles attach, attach again when complete,
and that a subtitle failure leaves playback running.

FFmpeg keeps a file it writes itself buffered until it exits, so a sidecar written
that way stays empty for as long as the film takes to read -- minutes on a remote
source, which is indistinguishable from subtitles that never work. The cues come
through its stdout instead, and a unit test reads them while the reader still runs.

Switching subtitles does not touch the conversion: the cues never ride in it, and a
restart would both interrupt the picture and ask the source for a second connection,
which the hosts behind these films often refuse. For the same reason the reader runs
in bursts -- it fills a quarter of an hour ahead, lets go of the source, and picks up
where it stopped when the picture catches up -- and releases it outright before a seek.

A copied video cannot start between keyframes, so a seek lands on the one before the
second asked for, and the cues keep that much of a head start against the picture --
measured between 0.05 s and 0.37 s on one film, a whole keyframe interval on sparser
encodes. Where that landing is cannot be read while the conversion runs: FFmpeg holds
a side output of its own until it exits, whatever the format and whatever the flushing
flags, and asking the source directly costs a second connection, which is what these
hosts refuse. What is left of the offset is for the viewer to dial out: the player's subtitle timing
steps by a quarter of a second, with the comma and full stop keys, and rides in the
address of both the embedded cues and the addon ones, so the element simply reloads
them. It resets with the film.

How fast the cues arrive is the source's business, so the track is attached as soon as
they reach past the picture rather than a couple of minutes beyond it: on a NAS reading
from a remote film, two minutes of cues take longer to fetch than the viewer's next
seek, and the wait looked like subtitles that never came. The reader keeps going and
the player reads the track again once it has a useful window ahead, or once the current
window is spent. Its polls carry the live playhead separately from the generation offset,
so a direct-playing film wakes the reader again after its first fifteen-minute burst.

The remux playlist grows as an EVENT stream. Keep the hls.js start three segments behind
its edge and align it with the first buffered segment: a one-segment live reserve can put
the playhead at the last few milliseconds of a newly published fragment, which immediately
stalls after a seek on a high-bitrate file even though earlier media is already available.

Sources arrive one addon at a time, and a later one can rank above the one already
chosen. While the viewer is looking at the list, following it is right; once the film is
playing on it, moving the pick takes the session out from under the player, which stops
it on the server and starts the film again on another source -- a seek in flight then
comes back as a session that no longer exists. `repickStream` holds the pick still while
the player is open, and pressing Play counts as the viewer's own choice.

Who ended a session is worth having in the log, since a stop is otherwise indistinguishable
from a server that gave up: the player reports what it released and why, and the server
records that the player asked, beside the lines the sweep writes when it closes one itself.

The hosts behind remote films drop a connection now and then, on a range deep into a
large file as readily as on the first byte. Handed straight to FFmpeg that ends the
conversion, and the viewer's seek with it, so the proxy asks again -- three tries, a
short wait between them -- and only a timeout or a viewer who has left is given up on at
once. The addon fixture can hang up once on demand, which is how the retry is tested.

Closing a film no longer tears the conversion down at once. It keeps running for
three quarters of a minute, so a viewer who closes and opens the same film again takes
that session back instead of building a second conversion and asking the source for
another connection -- the hosts behind these films answer a handful and then stop
answering at all. From outside the server the film is over the moment the player lets
go: the receiver grant is gone, transfers in flight are cut, and every route for that
session answers as it does for one that has ended. Only FFmpeg on loopback still reads.
A film taken back has to be the same film with the same tracks, the same quality and
the same client capabilities, or it starts fresh; another film starting closes the one
left running; and anything nobody came back for is swept.

A host that stops answering altogether is a different thing from one that drops a
connection, and it has to be treated as one: three tries against thirty seconds of
silence, and the restart's own second attempt behind them, left a seek pending for the
best part of a minute, which reads as a player that has stopped taking clicks. A source
that has just gone quiet gets one short chance instead, and the tries come back as soon
as it answers again. The addon fixture can take a request and never answer, which is
how the two are told apart in the suite.

These hosts also hand over a few seconds and then cut the stream. FFmpeg answers that by
reconnecting on its own, which is another connection into a host that is counting them,
so the proxy picks the transfer up itself instead -- from the byte it stopped at, and
never past the range that was asked for, since a body longer than the length already
promised breaks the response. The fixture can cut a transfer mid-stream to prove the
range still arrives whole.

What the server records is a setting now, not only a container variable: a line that was
never written cannot be filtered back into view, which made the level in the log panel
look unrelated to anything. The panel sets what is recorded, the filter above it decides
what is shown, and the download carries whatever the filter is showing.

FFmpeg answers SIGTERM by exiting 255 without a word, which is what a conversion stopped
for a seek looks like from the outside -- indistinguishable from one that died on its own,
and it was read as the latter for a while: the log warned about it and the session carried
an error that never happened. A process we asked to stop is now remembered as such.

A seek opens a new connection, and these hosts refuse those first. The conversion that is
playing is therefore left running until the new position is open, and if it cannot be
opened the session goes back to it: the viewer loses the jump rather than the film, and
the old generation is kept off the cleanup that would otherwise delete what is playing.

Deleting the directory a conversion is writing into takes the film down with it: the HLS
muxer cannot rename its playlist and exits, which reads as a source that dropped the
stream and is nothing of the sort. Cleanup therefore refuses a directory something is
still writing to, says so, and names what asked -- a generation that was replaced, a
conversion attempt that failed, or a session that ended. A directory whose process has
already died is still fair game, which the retry after a failed hardware attempt needs.

Every FFmpeg that opens a film reads the same two places before anything else: the header
at the start and the index at the far end. With a conversion and a subtitle reader, both
starting over at every seek, the log has the same byte offset fetched four times inside a
minute -- and these hosts count connections, not bytes. Those reads are kept now, keyed by
the exact range that was asked for, since an answer to "bytes=0-" is not an answer to
"bytes=0-31" and handing one over for the other truncates or overruns the reply. The
fixture counts what actually reached it, which is how the test knows the second read never
left the server.

Timing is the part tests cannot settle. A slow source delays the first cues,
and the reader competes with the conversion for the same link. Check on a real
film from a remote source: subtitles appear within seconds of starting, survive
several seeks without the picture stalling, and stay in step with the dialogue
an hour in. Real Synology and iPhone verification remains necessary for
hardware performance and codec behavior.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`,
and is also callable from `image.yml` through `workflow_call` so the release
path does not duplicate the checks.

Jobs:

1. `check` -- type-check both workspaces, run the server suite and the web unit
   suite. Roughly one to two minutes.
2. `e2e` (from phase 2) -- runs inside the Playwright container image, covering
   L2 and L3, sharded across the viewport matrix.
3. On failure, the Playwright HTML report and any image diffs are uploaded as
   build artifacts.

Screenshot baselines are refreshed through a separate manually triggered
workflow that regenerates them in the container and pushes the result to the
pull request branch, so updating them is not a local-environment chore.

## Phases

| Phase | Content | Status |
| --- | --- | --- |
| 1 | `ci.yml` on pull requests, Vitest set up, unit tests for pure client logic | Done |
| 2 | Playwright plus the fixture stack, first end-to-end journeys | Done |
| 3 | Viewport matrix, layout invariants, accessibility checks | Done |
| 4 | Screenshot baselines and the container workflow that updates them | Done |

Phase 3 came before phase 4 on purpose. Layout invariants catch most real
regressions and need no maintenance; screenshots are convincing but are a
recurring source of noise, so they were added last and kept to a small number of
screens.

## Commands

```
npm test                 # server and client unit suites
npm test -w server       # server only
npm test -w web          # client unit tests
npm run test:watch -w web

npm run test:e2e            # Playwright, using a locally installed browser
npm run test:e2e:docker     # the same run inside the image CI uses
npm run test:e2e:snapshots  # regenerate the screenshot baselines
```

`npm run test:e2e` needs the browser on the machine
(`npx playwright install chromium`) and FFmpeg/ffprobe on PATH. `npm run test:e2e:docker` needs nothing but
Docker, builds first, and matches CI exactly -- use it when a result has to be
comparable, and always once screenshot baselines exist.

Media ownership tests require FFmpeg and ffprobe. The Docker commands build
`e2e/Dockerfile`, which adds FFmpeg to the pinned Playwright image; native runs
need FFmpeg on PATH. The fake addon generates a small VP9/Opus WebM from the
existing MP4 fixture for browser playback on Chromium builds without H.264.
The proxy tests also use the original MP4 for actual probing, direct descriptors,
range requests, HLS resource rewriting, subtitle and download ownership checks.

During a seek, releasing the subtitle reader is a persistent hold: polling already
extracted cues cannot reopen its source until the conversion explicitly calls
`ensure` again. A regression exercises four release/poll/resume cycles and checks
that the same subtitle revision and timing correction survive. A browser test
closes the player during its fourth seek and delivers a late session-gone error;
that error must not start another film or report against a newer session.

The transfer meter is held to the reading, not to how it stores it: one regression drives
forty thousand writes past repeated compaction and an idle gap, comparing every reading
against a plain model of the same history, and another sends a burst inside a single
millisecond and expects the reading of the one write it stands for.
