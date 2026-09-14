# Roadmap

A living backlog, not a sprint commitment. Update this file when something ships
or when a new pain shows up in daily use.

The target platform remains a Synology NAS with an Intel Celeron (QuickSync on a
DS220+ or DS920+). Direct play and remux are the common path; a real transcode
needs VAAPI. See [Hardware acceleration](hardware-acceleration.md) for the setup.

## Done

These used to be open notes. They are in `main` now.

- Local library: browse and play downloaded files from disk.
- Continue watching and My list, including cleanup when a title is deleted from the library.
- Image workflow is manual (`workflow_dispatch`) plus version tags. It does not build on every commit. Building on merge to `main` can wait until the branch workflow settles.
- Secure mode: artwork from addons is fetched and cached by the server, the page gets an opaque link, and a Content-Security-Policy keeps the browser from loading anything else.
- Settings export/import, including installed addons and their save rules. Tokens in addon URLs mean the file is a secret.
- Subtitle cue background no longer fights the player chrome when the timeline shows or hides.
- Fullscreen keeps HTML subtitles visible on Windows Chrome/Brave (the video is no longer promoted over the cue layer).
- Hide/show subtitles from the player icon or `c`/`t` without restarting FFmpeg.
- Clicking the current sidebar section resets it (filters, path, scroll). Clicking it from another section restores the last filters and position.
- Jump from a finished download job to the file in the library.
- Mobile item / stream / play / download flow (catalog detail, landscape, control sizing).
- Save to the current device from the stream picker, the player, and the library, always through the server proxy.
- Diagnostics panel: levels, rotation, retention, redaction, client playback errors, grouped issues.
- Per-host guard on outbound addon calls: concurrency cap, queue, and a circuit breaker.
- English documentation, MIT license, and the GitHub community files (contributing, security, code of conduct, issue and pull request templates).
- GHCR image plus manual and tag-driven build workflows (`ghcr.io/nickrabit/stremio-offline`).
- Download queue: classify failures (network vs source vs disk), Range resume after a clean drop, halt the queue on ENOSPC and resume when space returns.
- Mobile player scrubber: press anywhere on the bar, including the unplayed part, and drag the current position forward or back without first jumping to the press point.
- Download queue on a phone: stacked layout so the page is usable.
- iPhone landscape: the left menu clears the notch with a safe-area layout.
- Interface in English and Czech: English (or the browser's language when we ship it) on a fresh install, a picker on the first-run screen that also seeds the preferred audio and subtitles, and a Language setting afterwards. An install from before the change keeps Czech. Server messages travel as English text plus a catalogue key, so a stored download error follows the language too.
- Real-Debrid client: API token in Settings, torrent rows no longer look like HTTP, waiting queue jobs that do not take an HTTP slot, play only when an HTTPS URL exists now, in-app toasts for the two hand-offs.
- Restricted / demo mode (`RESTRICTED_MODE=1`): process-wide lock so a shared instance cannot change addons, settings or the password, and cannot export tokens. Off by default.
- Smart season and whole-show downloads: ordered addons or largest-file selection across sources, verified audio language with fallback, and optional or required embedded/addon subtitles resolved per episode at the front of the queue.

## Next (daily friction)

### Player and mobile chrome

- [x] Keep episode navigation, seek/play, and settings in one compact row on portrait iPhones.
- [x] Click the video to hide controls and dismiss playback settings.
- [x] Hide the mouse cursor after ten idle seconds in fullscreen.
- [x] Use only overlay fullscreen and hide the button when unsupported, keeping custom controls on Safari.

- [x] Compact direct/transcoded playback labels with HW/SW for transcoding.
- [x] On-demand timeline image previews for mouse hover and touch scrubbing, with bounded server work and cache.
- [x] Previous/next-episode buttons for naturally sorted video files in the same library folder.
- [x] Restore document scrolling after inner scrolling kept Safari's tab bar permanently expanded.
- [ ] Improve Safari landscape chrome behavior on a physical iPhone/iPad; WebKit automation cannot emulate browser chrome.

- Catalog actions **To library** / **To device** are clipped at the bottom of the sheet.

### Stats

Stats currently follow finished library downloads and ignore catalog playback. Local library playback is LAN traffic and should not be mixed into the same counter.

Pick one:

- stop counting playback at all, or
- split the page into **Downloads** vs **Playback** (catalog / remote vs library / local).

Do not keep a single number that pretends to be watch time.

### Queue robustness

- Optional later: night-only window, speed limit, notify when the queue drains, delete watched files. In-app notify (toast + Stahování badge) is shared with the debrid waiting state below; push out of the browser is later.

### Torrents and Real-Debrid

Shipped. Remaining: follow-show can later enqueue torrent sources the same way;
push / ntfy out of the browser.

## Engineering health (before the next feature)

Feature work is cheap now; long-lived complexity is not. These items are about
keeping the code changeable and the data safe, and they are worth taking in this
order. Each one is independently mergeable — do not fold two of them into one
refactor, and do not carry a feature along with one.

### Split the HTTP layer out of `index.ts`

`server/src/index.ts` is 3085 lines and registers 97 routes. The domain modules
next to it are fine; `index.ts` is the problem, because it is bootstrap, wiring,
router, auth boundary and orchestration for libraries, playback, downloads,
settings and diagnostics all at once. Every change reads it, so every change is
expensive, and two agents working in parallel collide in it.

Move the handlers into `server/src/routes/` by area (auth, addons, playback,
downloads, libraries, settings, diagnostics) and leave composition behind. This
is a move, not a rewrite: no behaviour change, no API change, no state format
change, no DI framework and no new dependency. Done when changing one endpoint
means opening one small file and the existing suites stay green.

### Version the persisted state and test the migrations

Only libraries have an explicit migration today (`library-migrate.ts`). The main
state, settings, addons, the download queue, the artwork index, history, favourites
and resume positions have no version and no test that an old file still loads.

Give a version to the structures that actually change shape — not to everything —
and keep real state directories from released versions as fixtures
(`server/test-fixtures/state/<version>/`), with a test that loading one produces
the expected current state. Migration must be deterministic, idempotent where it
can be, and safe when the process dies halfway. An upgrade must never require
hand-editing a JSON file, no valid user data may be dropped in silence, and a
failed migration must name the file and the reason.

### Make destructive filesystem paths fail safe

The rule: when the app cannot tell **"the library is empty"** from **"the library
could not be read"**, it must not clean anything up. Uncertainty stops.

The cross-library artwork loss in `LIBRARY_BUGS.md` is exactly this shape — a
swallowed `ENOENT`, a file orphaned under the old key, and an hour later the sweep
took it for good. Walk the rest of the same surface: library add / remove / forget /
disable / re-enable / re-root / reconnect / type change; file rename, move, copy,
delete, bulk and cross-library operations, including across filesystems; artwork
generation, replacement, cleanup and orphan detection; metadata binding after an
external rename or a vanished file. A destructive path gets explicit preconditions
and never swallows an error, a failure never leaves a success showing in the
interface, and each case found gets a regression test at the domain layer.

### Give interrupted operations a defined restart

Downloads have `.part` files and a resume. Nothing else does: a library move or
copy, a bulk operation, artwork generation, a scan, a metadata update or a
transcode killed mid-flight has no stated behaviour on the next start.

After a restart every interrupted operation should end up resumed, retried, marked
failed, cleaned up, or shown to the user — never displayed as finished while the
disk holds half a file. Temporary and staging files need deterministic names,
a rule for collisions and an owner that clears them, and a partial destination must
never be scannable as complete media.

### Playback hardening

Direct play → remux → transcode stays the order, and it should be deterministic
and testable rather than discovered per stream. What needs checking: byte ranges
and seeking on direct play; the fragmented MP4 lifecycle and audio-only conversion
on remux; cancellation, client disconnect and concurrent sessions on transcode —
no FFmpeg process may outlive its request; and VAAPI/QuickSync falling back to
software instead of failing. A failed playback should tell us the source, the mode
chosen, hardware or software, and the stage that failed, without a token or a full
private stream URL reaching the log.

### Backup scope, written down

`backup.ts` exports and imports settings. What a backup means is not written down:
which data must be preserved (addons, preferences, library definitions, favourites,
resume state, metadata bindings, download settings), which is genuinely rebuildable
cache — verified, not assumed — and how secrets in addon URLs are handled. Restore
validates the file before applying any of it, fails loudly on an incompatible or
partial backup, and stays explicit about remapping when the filesystem roots moved.

### A classification behind the errors

`AppError` already carries English text plus a catalogue key. What is missing is a
stable code and a class — source, network, storage, library, playback, transcode,
addon, authentication, configuration, internal — so the diagnostics panel can group
failures, say whether the thing is still going, and say whether a retry helps,
instead of showing a raw exception string. Redaction stays covered by tests.

## Later

### Library and discovery

- **Library metadata**: posters and descriptions for folders that did not arrive through the download queue. Spec in [library-metadata.md](library-metadata.md). Path parser, title units and scoring ship first; Identify, the scan job and library chrome follow.
- **Multiple libraries**: several named roots with a type (movie / series / mixed),
  managed from the interface, items moved between them, per-addon save targets,
  bulk file operations, and the metadata/cache groundwork that goes with it.
  Spec in [multi-library.md](multi-library.md), state of the work and what is
  left in [multi-library-handoff.md](multi-library-handoff.md). It supersedes the "Plex-like
  separate libraries" rejection in [library-metadata.md](library-metadata.md).
- **Follow show**: daily check for new episodes, enqueue as lazy jobs. The lazy-job plumbing exists; the watch list and scheduler do not.
- Search: live input (~400 ms debounce), recent queries, suggestions from already loaded catalogs, optional rank-by-title-match.

### Access and multi-instance

- Profiles: addons, settings, history and favorites per profile; user management; lockable profiles; kids profiles that honour age metadata when the catalog provides it.
- Configurable LAN IP/host for the running container. The web client should try that address first so playback on the home network does not hairpin through Cloudflare Tunnel. Fail closed: never treat an unauthenticated LAN probe as an open door.
- Remote client mode: another instance (Docker or native) can use this one as the download/playback server, including an instance published behind a Cloudflare Tunnel with explicit auth.

Do not expose the app directly to the internet. HTTPS reverse proxy or a VPN remains the rule; the cookie is only `Secure` when the server sees HTTPS.

### Packaging

- One-compose install path for people who will not read the Synology chapter.

### Tests

Stream sorting and filtering is still checked by hand against real addon
payloads. See [testing.md](testing.md) for the layers that do exist.

The suite is strong and should stay cheap to keep. When it starts costing more
than it catches, the things to look for are an end-to-end test proving something
a domain test already proves, a screenshot baseline that breaks on unrelated
changes, and a wait on a sleep where an observable condition exists. A flaky test
is a defect, not weather.

## Out of scope unless revisited

- A local torrent engine on the NAS.
- Playing an uncached torrent in the player while Real-Debrid is still leeching.
- AllDebrid, Premiumize, or a second debrid provider before Real-Debrid is in daily use.
- Parsing the API token out of a Torrentio (or other addon) manifest URL.
- Building the image on every push. Revisit after features land through pull requests instead of bursts on `main`.
