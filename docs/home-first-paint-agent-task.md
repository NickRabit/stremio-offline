# Agent task: get Home on screen sooner

Follow-up to the Home loading work of 2026-11-07 and 2026-11-08 (#774, #776,
#779, #780, #781, #783, #784), analysed on `main` at `a2dd2665` (2026-11-11,
version 0.7.93). Read `AGENTS.md` first; it governs branches, pull requests,
version bumps and the Docker check. Read `docs/home-spec.md` and the
descriptions of the seven pull requests before touching the code: they hold
the measurements and the reasons behind what is there now. File locations
below are from that revision and will drift.

## Why

Those pull requests fixed what happens once Home is drawing: content no longer
jumps, pictures arrive in time, Continue watching no longer waits 1.5 s for
the same artwork lookups. What they left is the way to the first frame, and
the work repeated on every return to Home.

Today a reload goes through these steps one after another:

1. `index.html`, then the one script (1.05 MB, 237 KB as Brotli in a local
   build) and the one stylesheet (232 KB).
2. Only when that script runs does it learn the language and fetch its
   catalogue chunk (`i18nReady` in `web/src/i18n/index.ts`); nothing renders
   before it (`web/src/main.tsx`).
3. The first render shows a full-screen "Loading…" until `/api/auth/me`
   answers (`session === undefined` in `web/src/App.tsx`).
4. Only then does `useHome` know the account, read the Home it stored in
   `localStorage`, and ask `/api/home`.

On the owner's NAS every one of these steps is a round trip with real latency.
And the stored Home of step 4 is thrown away after every release, because it
is keyed on the app version.

None of the items below has been measured. They come from reading the code;
the first job of each item is to put a number on it.

## Ground rules for every item

- Measure first, on `main`, with the method the earlier pull requests used, so
  the numbers compare: Playwright with a phone profile (Pixel 7 for Chromium,
  iPhone 13 for WebKit), 4x CPU throttle, 9 Mbit / 60 ms, cache disabled for a
  cold start and enabled for a reload, median of three runs. Report FCP, LCP,
  CLS, the time until the first Home shelf with cards is on screen, the main
  thread blocked in frames over 50 ms in the first 3 s, and the request count.
  Put the before and after table in the pull request.
- An item whose measured gain is within the noise is dropped, not merged.
  Say so in the pull request or in a comment on the task, with the numbers.
- Failing test first, then the change. Client logic gets Vitest cases beside
  `web/src/home-cache.test.ts`, `useHome.test.tsx`, `Home.test.tsx`,
  `home-state.test.ts` and the app-level start-up tests in
  `title-detail-app.test.tsx`.
- One pull request per item, merged in order, each rebased on current `main`.
  Read `main`'s version and tags right before any version bump.
- Nothing may move on screen that does not move today. CLS stays at or below
  the 0.038 of #774, and the first-scroll checks of #776 and #779 stay at zero
  on-screen jumps. Rerun them for items 2 and 4.
- The old-browser floor in `web/vite.config.ts` stays (`chrome87`, `safari14`):
  TV browsers open this page. Anything newer needs a fallback that leaves
  those browsers as they are today.
- The server is not the problem: #781 measured a catalogue shelf at 5-50 ms
  and a picture at 4-26 ms on the NAS. Do not add server caches or timers, and
  no new disk writes on the NAS.
- Do not send test traffic to third-party media servers.
- Interface text goes through `web/src/i18n`; none of these items should need
  a new string.

## Item 1: keep the stored Home across releases

`readHomeCache` in `web/src/home-cache.ts` returns null when the stored
`version` differs from the app's `package.json` version. This project ships
several releases a day, so the first Home after each one starts from
skeletons, which is exactly the cold start #779 worked to avoid.

- Replace the app version with a format number owned by `home-cache.ts`,
  raised by hand only when the stored shape changes. Say in a one-line comment
  when to raise it.
- The reader already validates the shape and returns null on anything it does
  not recognise. Extend that validation where a card field the page relies on
  could be missing, so a Home stored by an older build can never throw while
  rendering. A stored Home is replaced by the server's answer within one
  request anyway.
- A Home stored under the old key format is simply ignored once.

Tests: a Home written under one app version is read under another; a stored
Home with another format number is refused.

## Item 2: shorten the chain to the first frame

Three independent steps, one pull request each, in this order. Measure each on
its own.

### 2a. Ask the server while the script is still starting

`/api/auth/me`, the build info and the settings are asked from effects after
the first render, which itself waits for the language chunk. Start them at
module load in `web/src/main.tsx`, in parallel with `i18nReady`, and let the
existing effects pick the same answers up.

- `web/src/api.ts` shares concurrent identical GETs but forgets a promise the
  moment it settles (#774), so an answer that lands before the effect runs
  would be asked for twice. Hold the early answers explicitly for their first
  reader and hand them out once; do not turn the coalescing into a cache.
- The start-up tests of #774 assert each endpoint is asked once. They must
  still pass.

### 2b. Tell the browser about the language chunk in `index.html`

The catalogue chunk is discovered only after the main script has been
downloaded and run. The language is known before that: it is in
`localStorage` under `ui-language`, with the browser language as the fallback
(`web/src/i18n/detect.ts`).

- Emit, at build time, a small inline script in `index.html` that maps the
  locale to its hashed chunk and adds a `modulepreload` (or a plain `fetch`
  where `modulepreload` is not supported). The mapping comes from Vite's
  manifest; do not hard-code file names.
- English needs nothing: it ships in the main script.
- Check the page's CSP and the desktop app before adding an inline script; if
  either forbids it, use a tiny external file under `/assets/` instead.

### 2c. Draw the stored Home before `/api/auth/me` answers -- ask the owner first

This is the largest possible gain and the only item with a product risk, so
**do not build it without the owner's go-ahead**. Bring them the numbers from
2a and 2b and this trade-off:

- Gain: a reload draws the shell and the stored Home in the first render,
  as #774 already does for the start page.
- Risk: on a shared browser, a session that expired on the server shows the
  previous account's Home for the length of one request before the sign-in
  screen replaces it. Signing out is not affected: `signOut` already clears
  the stored Home.

If it is approved: remember the last account name beside the stored Home,
clear both on sign-out and on any 401, draw the stored Home read-only until
the session is confirmed (no request that acts for the account before then),
and replace it at once when `/api/auth/me` names another account or none.
Restricted builds, the forced password change and the setup screen must
behave as today; each needs a test.

## Item 3: split the one script

Everything except `hls.js` and the nine language catalogues is in one chunk.
`web/src/App.tsx` imports the player, the settings, the title detail and every
other screen statically, so opening Home pays for all of them.

- Start with a bundle report (for example `rollup-plugin-visualizer`, looked
  up in the registry at the time, as a dev dependency or a one-off run) and
  put the top entries in the pull request. Decide from that, not from a guess.
- Likely candidates, to be confirmed by the report: Settings and its admin
  pages, the player, the logs and diagnostics screens. Load them with
  `React.lazy` behind the place they are opened from.
- A lazily loaded screen must not flash or shift: keep the frame that is on
  screen until the chunk is there, and prefetch a chunk when the page is idle
  the way `main.tsx` already does for `hls.js`, so opening the player or the
  detail never waits on the network.
- A chunk that fails to load (offline, a deploy in between) must say so and
  offer a retry, not leave a blank screen. After a deploy the old hashed files
  may be gone; a reload is the retry.
- Check the stylesheet too. If one screen owns a large share of it, say so in
  the report; splitting CSS is only worth doing with a measured gain.
- The desktop app and the restricted build load the same bundle; run their
  start-up once.

Drop the item if the report shows no single screen worth more than about a
tenth of the script.

## Item 4: create cards only for shelves near the screen

#783 stopped creating 1,120 `<img>` elements at start and named what is left:
mounting the 1,120 cards themselves, 129-137 ms of blocked main thread and a
longest frame of 67-69 ms on a 56-shelf Home in WebKit.

- In `web/src/HomeShelf.tsx`, a shelf that has cards but is not yet near the
  screen draws its heading and a strip of the same height holding only as many
  card frames as the strip shows, and creates the rest when it comes near.
  The 800 px observer and the `near` state are already there; today the
  observer watches the strip, so decide what it watches once the strip may not
  hold cards.
- Height and width must not change when the real cards arrive, in both tile
  shapes and all four tile sizes. A strip's scroll width will change; that is
  fine while the shelf is off screen and must not happen once it is near.
- Keyboard and screen-reader order must stay as it is: a shelf that is not
  near still has its heading and its Show all.
- `useOmission` (#776) and the eager-picture rule (#779, #783) must keep
  working; their tests in `Home.test.tsx` are the guard.
- Returning to Home from a title restores the scroll position. Check that a
  restored position far down the page lands on drawn cards, not on frames.

Measure with the 56-shelf Home of #783 so the numbers compare. #781 found no
frame over 50 ms on an M4 Mac for the scroll itself, so the gain to show is in
the start, not in the scrolling.

## Item 5: do not redraw cards that did not change

Every return to Home, and every closed player, calls `full()` in
`web/src/useHome.ts`, which asks again for every shelf seen so far. The answer
always replaces `items` with new objects (`homeReducer`, the `answer` branch in
`web/src/home-state.ts`), so `HomeCard`'s `memo` never holds and every card on
the page renders again even when the server sent the same thing.

- In the reducer, keep the previous card object where the answered card is
  equal to it, and the previous `items` array where every card is. Compare the
  data, not the reference; the cards are plain JSON.
- A row whose answer changes nothing must not re-render its shelf beyond the
  `loading` to `ok` switch.
- Keep the comparison cheap: it runs on the whole Home at once. Measure it on
  the 56-shelf Home and stop at the first difference.

Tests: an identical answer keeps `items` and each card identical by
reference; one changed card replaces only that card; a reordered row replaces
the array and keeps the card objects. A render-count test in `Home.test.tsx`
that fails on `main`.

Optional, only with a measured gain on the NAS: `full()` sends all seen
catalogue shelves in one request, so after a server restart the answer waits
for the slowest addon up to the 1.5 s deadline. Splitting it is cheap but
multiplies requests; leave it unless the number says otherwise.

## Still open from the earlier work

#783 and #784 were not measured on the owner's iPhone. That needs the owner
and a Safari timeline; do not block on it, but do not claim it either.

## Done means

- Each merged item has a before and after table from the shared method, and a
  test that failed on `main`.
- Dropped items are listed with the numbers that dropped them.
- `docs/home-spec.md` describes any rule that changed (the stored Home's
  format number, what a far shelf draws, what is drawn before sign-in is
  confirmed).
- The local Docker check from `AGENTS.md` passes after the last item, without
  disturbing an 8090 container another agent is using.
