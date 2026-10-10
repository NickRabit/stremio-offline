# Android TV client: specification

Status: proposed, nothing implemented. Written 2026-10-10 against `main` at
0.5.36. It revises an implementation brief from another agent; every claim
about current behaviour below was checked against the source, and a second,
independent pass re-checked the routes, the playback lifecycle and the Home
contract. The [roadmap](roadmap.md) owns priority; this file owns the scope and
the contracts. A clickable layout study lives in
[android-tv-prototype](android-tv-prototype/index.html).

## Outcome

A native Android TV app that connects to an existing Stremio Offline server (a
Synology NAS in the owner's case) and lets a household member browse, watch and
resume with only a remote. The server keeps accounts, grants, addons, source
resolution, downloads, storage and conversion. The TV is another device of an
existing account, not a second identity system.

Target devices: the owner's TCL televisions running Android TV and an NVIDIA
Shield TV Pro. Exact models, Android versions and audio chains are still to be
recorded; nothing in this spec may assume they are equal.

Not in scope, at any version: a server on the TV, a torrent engine, an SMB
client, downloads onto the TV, administration (accounts, addons, libraries,
grants, filesystem, the Home *To confirm* suggestions), and destructive library
operations.

## Shape: the same three sections as the web app

The app mirrors the web navigation, so a person who knows one knows the other.

| Section | v1 contents | Server source |
| --- | --- | --- |
| **Home** | The rows the web Home shows, in the web's order: Continue watching, Favourites, Tonight, the addon catalog carousels, New episodes, Ready to play, Recently added, then the Downloads summary. | `GET /api/home` and its typed `HomeCard` kinds (`server/src/home.ts`); the summary from `GET /api/downloads` |
| **Catalog** | Addon catalogs with the type and genre choice the web has, paged with `skip`; search across searchable catalogs; title detail. | `/api/catalogs`, `/api/catalog`, `/api/search`, `/api/searchable`, `/api/meta/:type/:id` |
| **Library** | Granted libraries, their folders and titles, title detail with seasons and episodes, favourites. | `/api/libraries`, `/api/library/browse`, `/api/library/resume`, `/api/library/favorites`, `/api/library/favorite` |
| Settings | Server address, account and sign-out, interface language, preferred audio and subtitle languages, start page, playback diagnostics. | `GET`/`PATCH /api/settings` (the personal part only), `/api/languages` |

The start page follows the account's **Start page** setting (`startView`:
`catalog`, `home` or `library`), as on the web.

**Home is rendered, not recomputed.** `GET /api/home` answers with
`{ generatedAt, rows }`, where `rows` is an object keyed by row id. It carries
no order: the web's display order lives in `HOME_ROWS`
(`web/src/home-state.ts`), with the addon carousels after Tonight. So that the
TV does not copy that list, PR 1 adds an `order` array to `HomeResponse`: every
row id the account would see, in display order, addon carousels included. The
web may adopt it later; nothing changes for it now. The TV draws the rows in
`order`, skips a row id or card kind it does not know, and skips `confirm`
(administrator curation). A row added to the server later appears on TV without
an app release.

The addon carousels keep the web's lazy contract: placeholders first, then
`GET /api/home?rows=catalog:<addon>:<type>:<id>` for the rows coming into view,
batched, with the web's retry on a partial row. The Downloads summary is not a
Home row: it comes from `GET /api/downloads`, filtered the way `homeQueue`
(`web/src/home-rows.ts`) does.

**Title detail** (catalogue and library alike): artwork, title, year,
synopsis, resume state, and Play or Resume as the focused action. Start over and
Favourite where they apply (`/api/library/favorite` for a library title,
`/api/watchlist` for a catalogue one). A series shows seasons and episodes with
the next relevant episode focused. A catalogue title that the account may
download also offers **To library**, the same `POST /api/downloads` the web
makes. When a playable library copy exists it is the default; other sources are
a separate choice. Otherwise a source picker shows quality, language, size and
addon, and marks an unknown value as unknown. Sources come from
`/api/streams/:type/:id` and `/api/stream-sources/:type/:id`; a library item is
read through `/api/library/browse?path=…` (there is no separate item route) and
made playable with `POST /api/library/source`.

**Later (v1.1, in this order):** Following, the Downloads queue with
pause/resume/cancel, the Android TV *Watch Next* channel on the launcher, voice
search. Each is a separate PR.

Every screen has a loading, empty, error and retry state. Returning from detail
or the player restores the focused item and scroll position; if that item is
gone, the nearest one takes focus. Focus is always visible.

## Interface

The TV keeps the web's identity rather than inventing one: the same tokens
(`--bg #0b0e13`, panels `--panel`/`--panel2` with the `--line` border, text
`--text`/`--muted`, the `--accent #ff5b38` to `--accent2` gradient, the plum
glow behind the brand mark, `--green` for healthy and `--red` for failed), Inter,
and the small letter-spaced accent eyebrow above every page title. The Compose
theme is generated from these values, not re-picked. The
[prototype](android-tv-prototype/index.html) shows every screen below and
answers to the arrow keys, Enter and Esc.

**One focus rule.** On the web the accent gradient marks the primary action. On
TV it marks focus: the focused control fills with the accent and grows by 6 to
8 %, a focused tile gets a 4 px `--accent2` ring and a soft accent shadow. An
unfocused primary action is only tinted, so the cursor is never confused with
the default. Nothing else on screen uses a full accent fill.

**Canvas and sizes.** Designed on 1920×1080 (960×540 dp), everything inside a 5 %
overscan safe area (96 px at the sides, 54 px top and bottom). Body text is
24 px or larger, meta text 20 px, row titles 30 px, page titles 52 px, detail
titles 84 px. Posters are 220×330, wide cards 400×225, episodes 380×214. Every
row scrolls with focus pinned to its first slot, as Android TV launchers do.

**Navigation rail.** The web sidebar becomes a rail on the left: Search, Home,
Catalog, Library, and the account avatar for Settings, with the web's icons and
the same accent bar on the current section. It shows icons only and opens with
labels when focus enters it. Back from any content goes to the rail first; Back
on the rail asks before leaving the app. Detail and the player are full screen,
without the rail.

**Home.** The top 55 % is a backdrop that follows focus: the focused card's
art behind a scrim, its row as the eyebrow, title, rating, year, genre and
length, resume progress, and three lines of synopsis. The rows sit below. This
is not the fixed resume hero the [Home spec](home-spec.md) rejected for phones:
it has no action of its own and changes with every move. Rows above the focused
one dim. The Downloads summary is a single focusable strip at the end.

**Title detail.** Full-bleed art with a left scrim, eyebrow (`Movie · in your
library`, `Series · Open Movies`), title, meta line with the rating star in
gold, the web's title chips (kind, library copy, quality, subtitles), synopsis
and resume bar. Actions in one row, Resume focused: Resume, Start over,
Favourite (icon), To library, Sources. A series adds its season and the episode
row underneath, with the next episode focused, watched ones ticked and a new one
badged.

**Side panels instead of dialogs.** Sources, audio and subtitles, diagnostics,
and every choice list (language, genre, sort) open as a panel from the right,
720 px wide, styled like the web's `panel`. Back closes it and returns focus to
the control that opened it. There are no centred dialogs on TV.

**Player.** The web's controls, sized for the sofa: the eyebrow names the
playback path (`Direct play · MKV · no server conversion`, `Remux`, `Audio
converted`), the title below it; at the bottom the timeline and a row of round
buttons: back 10, play/pause in the accent, forward 10, audio and subtitles
(labelled with the current choice), next episode, diagnostics. With the
controls hidden, OK pauses and shows them, and left or right seek with a bubble
and a thin progress line at the bottom edge. The controls hide after 5 seconds
of playback without input. Over video, whose colours the app does not control,
focus is a white fill instead of the accent, and play/pause keeps the web's
accent circle with a white ring when focused.

**Failure states.** Each failure is a centred panel that names the server, says
what was kept (the saved position), and offers one way forward (Try again,
Change server, Sign in). Never an endless spinner, never a raw error string: the
text comes from the `AppError` `messageKey`.

## Architecture

- A separate `android-tv/` project in this repository: Kotlin, Gradle Wrapper,
  Jetpack Compose for TV, Media3 ExoPlayer with an OkHttp data source, and
  MediaSession. Stable, pinned dependencies; the required JDK and SDK are
  written in `android-tv/README.md`.
- Native UI, not a WebView wrapper. The web UI (about 12,700 lines of TSX) in a
  system WebView on a TCL set with 1.5–2 GB of RAM and an old Chromium is not
  usable with a remote, and its focus model is the browser's. The price is a
  second UI to maintain, which is why Home is server-driven and why the TV only
  gets the three sections above.
- Layers: API client, session store, playback coordinator, screen state.
  Business logic stays on the server.
- Relative URLs from the API resolve against the configured server base URL,
  including a reverse-proxy base path. Artwork comes through `/api/image/:id`
  and `/api/library/thumb`, with the same cookie.
- One server and one signed-in account at a time. Sign-out or a server change
  clears every account-scoped cache.
- Server changes are additive and leave the browser's behaviour unchanged.

## Connection and sign-in

- Server address entry (default `http://<nas>:8090`), a reachability check
  against `GET /api/status`, username and password, remembered session,
  sign-out.
- A server without an administrator yet: say that setup happens in the web
  interface.
- Distinguish unreachable, incompatible, wrong credentials, expired session and
  revoked access. No unbounded automatic retries.
- The session is the existing cookie: `POST /api/auth/login` with
  `remember: true` sets `stremio_offline_session` (`HttpOnly`, `SameSite=Lax`,
  `Secure` only over HTTPS, `Max-Age` of 30 days); `GET /api/auth/me` checks it
  and `POST /api/auth/logout` ends it. There is no CSRF token or origin check;
  JSON bodies need `Content-Type: application/json`, and `Host` is checked only
  when `HOST_CHECK` is on. After 30 days the TV asks to sign in again.
- One OkHttp cookie jar serves the API, images, subtitles and ExoPlayer, scoped
  to the configured origin and never forwarded across a cross-origin redirect.
  This is required, not tidy: a playback session belongs to the sign-in session
  that created it, and a request carrying another one gets a 404. The cookie is
  stored with Android Keystore protection; the password is never stored.
- Cleartext HTTP is allowed only for the address the user typed (network
  security config), never by downgrading HTTPS or skipping certificate checks.
- Pairing by QR code, server discovery and Cloudflare Access are follow-ups.

## Playback: the server work comes first

### What the server does today

`ClientCapabilities` (`server/src/playback.ts`) is a set of optional browser
codec flags: `h264`, `hevc`, `hevc10`, `vp8`, `vp9`, `av1`, `aac`, `mp3`,
`opus`, `vorbis`, `ac3`, `eac3`, `flac`. `directPlay()` accepts MP4 with H.264
or playable HEVC plus AAC or MP3, and WebM or Matroska whose video is VP8, VP9
or AV1 with Opus or Vorbis audio. Every other Matroska, which in practice means
every H.264 or HEVC MKV, is remuxed whatever the client can decode. A TV app
alone unlocks nothing.

### The capability contract (first PR, server only)

Add, without changing what a browser gets:

- `containers`: the containers the client plays as they are (`mp4`, `webm`,
  `mkv`, `ts`).
- Video: the existing codec flags cover eight-bit 4:2:0; `deepColor` lists the
  codecs the device also decodes at 10 bits (HEVC keeps `hevc10`). 4:2:2 and
  4:4:4 are never handed over. Dolby Vision is reported, not negotiated.
- Audio, split into **decode** and **passthrough**, because a TCL set may not
  decode DTS while a receiver behind it would take the bitstream. The client
  re-sends it when the audio route changes.
- Text subtitle formats the client renders itself (`srt`, `ass`, `vtt`, `pgs`).

The client derives these at runtime from `MediaCodecList` and the audio
capabilities, with conservative defaults; no device is hard-coded as
"plays everything".

Order of preference, as today: the original through the authenticated server
proxy → remux when only the container is wrong → video copied and **only the
audio converted** (the expected common case on TCL with DTS or TrueHD) → full
conversion. "Direct" means no re-encoding, not bypassing the server: secure
mode, opaque resource ids and access revocation stay as they are.

The same PR adds the Home `order` array described above. Both are tested in the
existing server suite, with no Android code.

### Tracks and subtitles

- In direct play, embedded audio and text or PGS subtitles are selected inside
  ExoPlayer; the server starts no FFmpeg for a track change.
- In remux or conversion, track changes go through `/api/playback/:id/track`,
  and the progressively written sidecar (`/api/playback/:id/sidecar.vtt`) is
  reloaded as it grows, not read once.
- Addon subtitles come from `/api/subtitles/:type/:id` and
  `/api/subtitle/:subtitleId`. Language choice, Off and subtitle delay are in
  the player.
- An unsupported audio track asks the server for a fallback instead of silently
  switching language.

### Session lifecycle

The server already has the mechanism; the TV follows the web's use of it.

- Every request under `/api/playback/:id` (ping, seek, track, playlist,
  segment) marks the session as attended. `POST /api/playback/:id/ping` exists
  for exactly that: it returns 204 after the middleware has recorded the
  client.
- A claimed session with no request from its player for 90 seconds
  (`ORPHAN_MS`) is closed, an unclaimed conversion after 45 seconds
  (`UNCLAIMED_MS`), any session after five idle minutes (`IDLE_MS`).
- So the TV pings every 30 seconds while the player is open, **paused
  included**: a paused direct session reads no media and would otherwise be
  closed after 90 seconds. The web does the same (`Player.tsx`).
- On exit, Home, standby and a cancelled or superseded start, the TV calls
  `DELETE /api/playback/:id` instead of waiting for the reaper.
- Playback is a state machine: source, track and seek changes are serialized
  and stale answers dropped. The absolute position survives a regenerated
  playlist through the server's `offset`.
- A codec failure may escalate once (`/api/playback/:id/escalate`), keeping the
  position. A network failure offers retry. An authorization failure stops and
  asks to sign in. No loops through conversions, no silent lowering of quality.

### Progress

Saved through `POST /api/progress` with the server's canonical keys
(`file:<library path>`, `movie:<id>`, `series:<id>:<season>:<episode>`) and
completion rules (finished above 94 %, nothing kept under 30 seconds). Read back
with `GET /api/progress/:key`. The web saves every 10 seconds and when the page
closes; the TV does the same and also after a seek and on pause. Initializing
the player never writes zero over a stored position, and a failed final write
leaves the last confirmed one in place.

## Remote and lifecycle

- Everything works with the five-way pad and Back.
- In playback with no controls shown: OK pauses and shows controls; left and
  right seek 10 seconds, debounced so a held key does not restart a
  conversion ten times. Media keys work regardless.
- Back closes a side panel, then the controls, then the player, and never traps.
- Home, backgrounding and standby pause, save progress and release the session.
  No background playback in v1.
- HDR, Dolby Vision, passthrough and refresh-rate matching are detected and
  reported in diagnostics, not promised. No HDR-to-SDR conversion.

## Languages

The Android string resources are generated at build time from
`web/src/i18n/*.ts` for every language the web ships (ten today: `en`, `cs`,
`sk`, `de`, `es`, `fr`, `it`, `pl`, `pt-BR`, `ru`), with a deterministic key
mapping and placeholder validation. Only the keys the TV uses are emitted.
English and Czech must be complete; a missing key in the others falls back to
English, as on the web. No literal UI strings in Kotlin. A server `AppError`
carries a `messageKey` plus `vars`, mapped to the same catalogue.

## Distribution and versions

- A private APK, sideloaded with the Downloader app or `adb`. No store.
- **Signed with a project release key from the first build.** A debug APK
  built on another machine cannot install as an update over the previous one,
  which would sign the user out on every release. The keystore lives in a
  GitHub secret, never in the repository. This needs neither Google Play nor an
  Apple account.
- `versionName` follows the shared version; `versionCode` is derived from it so
  it only grows. `npm version --workspaces` does not touch Gradle, so the
  Android project reads the version from the root `package.json` at build time
  rather than keeping its own copy; `scripts/check-versions.mjs` and the
  version-bump rule in `AGENTS.md` learn about it in the same PR that adds it.
- CI builds, lints and tests `android-tv/` only when files under it change.

## Delivery

| PR | Contents | Proof |
| --- | --- | --- |
| 1 | Server: capability contract, MKV and audio-only conversion for native clients, the Home `order` array | Server unit tests; browser behaviour unchanged |
| 2 | Android vertical slice: sign-in, Library → title → direct MKV playback with ping and release → stop → resume shown on the web | Debug run on the emulator, then a real device |
| 3 | Home from `/api/home` and the Downloads summary | Instrumented focus tests |
| 4 | Catalog: catalogs, type and genre, search, detail, source picker, To library | Instrumented focus tests |
| 5 | Player completion: tracks, subtitles and delay, fallback, error states, diagnostics | Device matrix below |
| 6 | Languages generator, settings, release signing, versioning | Build checks |

Each PR builds on its own and keeps the web client working.

## Verification

Automated: API parsing and errors, session scoping, capability negotiation,
absolute offsets, progress keys, fallback limits, ping and release; on the
server, that unauthorized resources stay unreachable and the browser path is
unchanged; Android instrumentation for D-pad focus, Back and focus restore.

The Android TV emulator on the Mac covers navigation and layout. It proves
nothing about codecs, HDR or audio output: those need the owner's TCL and
Shield, with model, Android version, firmware, connection and audio chain
recorded. A check that has not run on hardware is reported as pending.

Sample media (lawful): MP4 H.264/AAC, MKV H.264, MKV HEVC Main10, a 4K sample,
several audio tracks, external Czech SRT, embedded text and PGS subtitles, a
remux, an audio-only conversion and a full conversion. HDR, Dolby Vision, DTS
and TrueHD are probes with recorded results, not pass criteria.

Acceptance:

- Install, launch from the launcher, connect, sign in and use Home, Catalog and
  Library with the remote alone.
- Play an MKV with no server FFmpeg, shown in diagnostics.
- Seek, change audio and subtitles, stop, and resume at the same position on
  the TV and on the web.
- Pause for five minutes and continue without the session being closed.
- Thirty minutes of continuous playback on each device without a failure.
- Network loss, server restart, expired session and revoked access end in a
  clear state, never an endless spinner.
- Leaving through Home or standby releases the server session at once.
- To library from the TV queues on the server and continues after the app
  closes; a restricted account cannot reach another account's resources.

The server side is deployed to the local Docker setup as `AGENTS.md` requires.
Nothing is installed on the owner's televisions or NAS without their go-ahead.
