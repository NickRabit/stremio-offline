# Android TV client: specification

Status: proposed, nothing implemented. Written 2026-10-10 against `main` at
0.5.36. It revises an implementation brief from another agent; every claim
about current behaviour below was checked against the source. The
[roadmap](roadmap.md) owns priority; this file owns the scope and the contracts.

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
grants, filesystem), and destructive library operations.

## Shape: the same three sections as the web app

The app mirrors the web navigation, so a person who knows one knows the other.

| Section | v1 contents | Server source |
| --- | --- | --- |
| **Home** | The rows `/api/home` returns, in the order it returns them: Continue watching, Favourites, Tonight, the addon catalog carousels, New episodes, Ready to play, Recently added, and the Downloads summary. | `GET /api/home` and its typed `HomeCard` kinds (`server/src/home.ts`) |
| **Catalog** | Addon catalogs with the type and genre choice the web has, paged with `skip`; search across searchable catalogs; title detail. | `/api/catalogs`, `/api/catalog`, `/api/search`, `/api/searchable`, `/api/meta/:type/:id` |
| **Library** | Granted libraries, their folders and titles, title detail with seasons and episodes, favourites. | `/api/libraries`, `/api/library/browse`, `/api/library/favorites`, `/api/library/favorite` |
| Settings | Server address, account and sign-out, interface language, preferred audio and subtitle languages, playback diagnostics. | `GET`/`PATCH /api/settings`, the personal part only |

The start page follows the account's **Start page** setting, as on the web.

**Home is rendered, not recomputed.** The app draws whatever cards `/api/home`
sends and keeps no row logic of its own. A row added to the server later
appears on TV without an app release; an unknown card kind is skipped, not an
error. The addon carousels keep the web's lazy contract: placeholders first,
then the bounded request for the rows coming into view.

**Title detail** (catalogue and library alike): artwork, title, year,
synopsis, resume state, and Play or Resume as the focused action. Start over and
Favourite where they apply. A series shows seasons and episodes with the next
relevant episode focused. A catalogue title that the account may download also
offers **To library**, the same `POST /api/downloads` the web makes. When a playable
library copy exists it is the default; other sources are a separate choice.
Otherwise a source picker shows quality, language, size and addon, and marks an
unknown value as unknown.

**Later (v1.1, in this order):** Following, the Downloads queue with
pause/resume/cancel, the Android TV *Watch Next* channel on the launcher, voice
search. Each is a separate PR.

Every screen has a loading, empty, error and retry state. Returning from detail
or the player restores the focused item and scroll position; if that item is
gone, the nearest one takes focus. Focus is always visible.

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
  including a reverse-proxy base path.
- One server and one signed-in account at a time. Sign-out or a server change
  clears every account-scoped cache.
- Server changes are additive and leave the browser's behaviour unchanged.

## Connection and sign-in

- Server address entry (default `http://<nas>:8090`), a reachability check,
  username and password, remembered session, sign-out.
- A server without an administrator yet: say that setup happens in the web
  interface.
- Distinguish unreachable, incompatible, wrong credentials, expired session and
  revoked access. No unbounded automatic retries.
- The session is the existing cookie (`server/src/routes/auth.ts`). One OkHttp
  cookie jar serves the API, images, subtitles and ExoPlayer, scoped to the
  configured origin and never forwarded across a cross-origin redirect. The
  cookie is stored with Android Keystore protection; the password is never
  stored.
- Cleartext HTTP is allowed only for the address the user typed (network
  security config), never by downgrading HTTPS or skipping certificate checks.
- Pairing by QR code, server discovery and Cloudflare Access are follow-ups.

## Playback: the server work comes first

### What the server does today

`ClientCapabilities` (`server/src/playback.ts`) is a set of browser codec
flags. `directPlay()` accepts only MP4 with H.264 or playable HEVC plus AAC or
MP3, and WebM with VP8/VP9/AV1; every other container returns "container … is
not directly playable". An MKV therefore always goes through a remux, whatever
the client can decode. A TV app alone unlocks nothing.

### The capability contract (first PR, server only)

Add, without changing what a browser gets:

- `containers`: the containers the client plays as they are (`mp4`, `webm`,
  `mkv`, `ts`).
- Video: codec with profile and bit depth (`hevc10`, `av1`, `vp9`, Dolby Vision
  profile where the device reports one).
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

This PR is tested in the existing server suite, with no Android code.

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

Endpoints to audit before changing anything: `POST /api/playback` (create),
`seek`, `track`, `escalate`, `ping`, the playlist and segment route, the
sidecar and `/api/media/:resourceId`.

- `POST /api/playback/:id/ping` is a no-op returning 204 today. Sessions are
  reaped from `lastAccess` on media and segment reads (`IDLE_MS`, five
  minutes), and an unclaimed conversion sooner. The audit decides what keeps a
  paused direct session alive and what the TV must call on exit; if the ping
  has to mean something, that is a server change in the first PR.
- Playback is a state machine: source, track and seek changes are serialized
  and stale answers dropped. The absolute position survives a regenerated
  playlist through the server's `offset`.
- A codec failure may escalate once, keeping the position. A network failure
  offers retry. An authorization failure stops and asks to sign in. No loops
  through conversions, no silent lowering of quality.
- A cancelled or superseded start leaves no server conversion running.

### Progress

Saved through `/api/progress` with the server's canonical keys and completion
rules: every 15 seconds, after a seek, on pause and on exit. Initializing the
player never writes zero over a stored position, and a failed final write
leaves the last confirmed one in place.

## Remote and lifecycle

- Everything works with the five-way pad and Back.
- In playback with no controls shown: OK pauses and shows controls; left and
  right seek 10 seconds, debounced so a held key does not restart a
  conversion ten times. Media keys work regardless.
- Back closes a dialog, then the controls, then the player, and never traps.
- Home, backgrounding and standby pause and save progress. No background
  playback in v1.
- HDR, Dolby Vision, passthrough and refresh-rate matching are detected and
  reported, not promised. No HDR-to-SDR conversion.

## Languages

The Android string resources are generated at build time from
`web/src/i18n/*.ts` for every language the web ships (ten today), with a
deterministic key mapping and placeholder validation. Only the keys the TV uses
are emitted. English and Czech must be complete; a missing key in the others
falls back to English, as on the web. No literal UI strings in Kotlin. Server
`AppError` keys map to the same catalogue.

## Distribution and versions

- A private APK, sideloaded with the Downloader app or `adb`. No store.
- **Signed with a project release key from the first build.** A debug APK
  built on another machine cannot install as an update over the previous one,
  which would sign the user out on every release. The keystore lives in a
  GitHub secret, never in the repository. This needs neither Google Play nor an
  Apple account.
- `versionName` follows the shared version; `versionCode` is derived from it so
  it only grows. `scripts/check-versions.mjs` and the version-bump rule in
  `AGENTS.md` gain the Android project in the same PR that adds it.
- CI builds, lints and tests `android-tv/` only when files under it change.

## Delivery

| PR | Contents | Proof |
| --- | --- | --- |
| 1 | Server: capability contract, MKV and audio-only conversion for native clients, the ping/lifecycle decision | Server unit tests; browser behaviour unchanged |
| 2 | Android vertical slice: sign-in, Library → title → direct MKV playback → stop → resume shown on the web | Debug run on the emulator, then a real device |
| 3 | Home from `/api/home` | Instrumented focus tests |
| 4 | Catalog: catalogs, type and genre, search, detail, source picker, To library | Instrumented focus tests |
| 5 | Player completion: tracks, subtitles and delay, fallback, error states, diagnostics | Device matrix below |
| 6 | Languages generator, settings, release signing, versioning | Build checks |

Each PR builds on its own and keeps the web client working.

## Verification

Automated: API parsing and errors, session scoping, capability negotiation,
absolute offsets, progress keys, fallback limits, lifecycle cleanup; on the
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
- Thirty minutes of continuous playback on each device without a failure.
- Network loss, server restart, expired session and revoked access end in a
  clear state, never an endless spinner.
- Leaving through Home or standby releases the server session as the lifecycle
  decision says.
- To library from the TV queues on the server and continues after the app
  closes; a restricted account cannot reach another account's resources.

The server side is deployed to the local Docker setup as `AGENTS.md` requires.
Nothing is installed on the owner's televisions or NAS without their go-ahead.
