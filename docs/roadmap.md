# Roadmap

A living backlog, not a sprint commitment. Update this file when something ships
or when a new pain shows up in daily use.

The target platform remains a Synology NAS with an Intel Celeron (QuickSync on a
DS220+ or DS920+). Direct play and remux are the common path; a real transcode
needs VAAPI. See [Hardware acceleration](hardware-acceleration.md) for the setup.

## Direction and delivery order

Reviewed against PR #260 (`11f1759`) and `main` (`14f7beb`) on 2026-09-29.
This is a proposed delivery sequence, not a statement that the work below has
shipped.

Make the NAS a dependable family media library: a useful home screen, a
restricted child account and predictable playback. Deliver household UX alongside
focused data-safety work, then reduce daily effort with show following and
guided library management. Extend into Sonarr/Radarr through the
existing queue only after its durability and staging boundaries are proven.
Keep desktop clients on the same server contracts; avoid a second downloader,
metadata store or scheduler for each platform.

| Order | Outcome | Scope / release gate |
| --- | --- | --- |
| P0a | Files survive failure | Audit destructive paths; recover transfers without overwrites or lost evidence |
| P0b | Playback and mobile controls are dependable | Session lifecycle tests and physical iOS verification |
| P1a | Home is useful immediately | Permission-filtered personal rows from existing state; no scheduler dependency |
| P1b | Children can use the app safely | Restricted child account, server-enforced policy, parent-authenticated exit |
| P2a | New episodes are easy to discover | Follow show with opt-in downloads, durable deduplication and bounded polling |
| P2b | Library management is guided | Guided split, then live search; bulk rename only after P0 recovery works |
| P3 | External automation is usable | Opt-in HTTP Sonarr/Radarr bridge passing the real-application harness |

Home-screen work, small mobile fixes and backup inventory documentation can
ship alongside P0. Child mode requires its own server policy before release;
it does not depend on completing the entire engineering backlog.
The ordering is a dependency guide, not a reason to bundle unrelated changes.
Signing, unattended installers, remote-instance protocols, richer profiles and
additional debrid providers remain separate investments. Do not add them to a
release merely because a related screen is being edited.

The [delivery specification](roadmap-delivery-spec.md) defines contracts,
non-goals, acceptance scenarios and suggested PR boundaries. It also records
where the previous roadmap overstated missing functionality. Existing feature
documents describe shipped behavior; the delivery specification describes
proposed changes.

## Done

Shipped and living in `main`. The list is here to stop settled questions from
being reopened, not as a changelog.

- Local library: browse and play downloaded files from disk, with continue
  watching, favourites and clean-up when a title leaves.
- **Several libraries**: named roots with a type, managed from the interface,
  added inside a granted root, moved and copied between each other, removed
  against disabled, re-added with their identity intact, and split out of the
  download directory without moving a file. See
  [Libraries](libraries.md).
- **Library identification**: a path parser and scorer turn folders into titles,
  a durable scan job matches them against the catalogues, low-confidence hits
  wait as suggestions, and Identify / Fix match / Unmatch are the manual
  override. See [Library identification](library-metadata.md).
- **Accounts**: more than one, an administrator and ordinary users, per-user
  library and addon visibility, per-user download permissions, per-user addon
  order and personal settings, session revocation when a right is taken away,
  and the admin dashboard. See [Accounts](users.md).
- Secure mode: artwork from addons is fetched and cached by the server, the page
  gets an opaque link, and a Content-Security-Policy keeps the browser from
  loading anything else.
- Settings export/import, including installed addons, their save rules and the
  names and roots of the libraries. Addon URLs, the Real-Debrid token and the
  TMDB API key mean the file is a secret.
- Playback: direct play vs. remux vs. transcode, on-demand timeline previews,
  next/previous episode, embedded and addon subtitles, and the player volume
  remembered on the device. See [Playback](playback.md).
- Trailers from Cinemeta, with TMDB as a fallback: in-app when secure mode is
  off, an external tab when it is on. See [Trailers](trailers.md).
- Download queue: survives a restart, resumes `.part` files with HTTP Range,
  pauses on ENOSPC and resumes when space returns, retries a dead source,
  segmented transfers, and the torrent hand-off through Real-Debrid.
- Smart season and whole-show downloads: ordered addons or largest-file
  selection, verified audio language with fallback, and optional or required
  subtitles resolved per episode at the front of the queue.
- Stats split by where the traffic comes from — a download, catalogue playback
  or library playback — with library traffic kept out of the external figures.
- Diagnostics panel: levels, rotation, retention, redaction, client playback
  errors, grouped issues, and a per-host guard on outbound addon calls.
- Ten interface languages throughout the web and desktop apps: English,
  Czech, Slovak, German, Spanish, French, Italian, Polish, Brazilian Portuguese
  and Russian. Server messages travel as English text plus a catalogue key.
  A fresh local desktop server starts in the language picked in the shell. See
  [Languages](languages.md).
- Tile size that follows the panel, portrait or landscape tiles per page, and
  cached artwork sized for a tile.
- Restricted / demo mode (`RESTRICTED_MODE=1`), English documentation, the
  community files, the GHCR image and the build and release workflows.
- **Desktop apps** for macOS (Apple Silicon), Windows x64 and Linux x64
  (`.deb` and AppImage, glibc 2.35+), attached unsigned
  to every release. Each runs the server on the computer, with bundled FFmpeg,
  hardware conversion (VideoToolbox, Media Foundation, VAAPI and NVENC) and a
  download-folder step at setup, or opens a server elsewhere through named profiles. They share
  the local server with the home network on request, save to the device through
  the native dialog, keep running after closing the window on macOS and
  Windows (closing quits on Linux), keep the computer
  awake while downloading, open at login, check GitHub for a newer release and
  reset themselves from Settings. The Electron Fuse V1 hardening is applied at
  package time and read back from the built app. See
  [Installing the macOS app](install-mac.md),
  [Installing the Windows app](install-windows.md),
  [Installing the Linux app](install-linux.md) and
  [desktop/README.md](../desktop/README.md).

- **Cloudflare Access in the desktop app**: email one-time PIN sign-in inside
  the window, with a separate cookie session per saved server. External identity
  provider pages are not supported. See
  [Cloudflare Access](../desktop/README.md#cloudflare-access).
- **Phones and tablets**: responsive layouts, folding headers, tablet detail
  navigation and Home Screen setup. See [Phones and tablets](mobile.md).
- Library listings and mosaics are warmed in the background, and private
  thumbnail caches are revalidated with access checks on every request.

## Next (daily friction)

These are the highest-value improvements for daily use. The priority is not to
add surface area for its own sake, but to make the common household journeys
faster, safer and more automatic.

### Family home and kids mode

Add a deliberately simple child-facing mode on top of the existing account and
library permissions:

- large, obvious tiles and touch targets with very little text;
- **Continue watching**, favourite shows and recently added episodes first;
- hide administration, diagnostics, addon management and destructive library
  actions;
- allow a parent to choose which libraries and addons are visible and require a
  parent-authenticated account switch to leave the child-facing UI; a PIN is
  optional convenience only after its server-side policy is designed;
- make repeated taps harmless and always show immediate feedback for actions
  that take noticeable time.

The MVP uses a dedicated restricted child account, with enforcement on the
server as well as a simplified interface. Hiding buttons in an adult session is
not a parental boundary. See [Family home and kids mode](roadmap-delivery-spec.md#family-home-and-kids-mode).

The practical UX target is intentionally strict: a child who already knows the
app should be able to open it, find a favourite show and start the intended
episode without adult help, documentation or recovery through browser controls.

### Home screen

Make the normal entry point useful without first navigating a catalogue. Start
with rows that can be derived from state the app already has:

- **Continue watching**;
- favourites / **My shows**;
- recently added local media;
- new episodes from followed shows once that feature exists;
- completed downloads that are ready to play.

Keep this personal per account and make the child-facing variant much smaller
than the full adult home screen. Ship the existing-state rows first; followed
episodes are an additive row, not a reason to block the home screen. See the
[home contract](roadmap-delivery-spec.md#family-home-and-kids-mode).

### Player and mobile chrome

- Improve Safari landscape chrome behavior on a physical iPhone/iPad; WebKit
  automation cannot emulate browser chrome, so this needs a device.
- Catalog actions **To library** / **To device** are clipped at the bottom of the
  sheet.

### Library

- A guided split of the download directory from the library manager. The
  supported route — carve-outs plus **Change folder** — is written up in
  [Libraries](libraries.md#splitting-the-download-directory); what is missing is
  a wizard that offers it at the moment someone needs it.
- Bulk rename by pattern. Deliberately out of the first multi-library release;
  the operations queue is shaped to take it without a migration.

### Follow show

Let a user follow a series and optionally download new episodes automatically.
Run a daily check and enqueue new episodes as lazy jobs; the lazy-job plumbing
exists, but the watch list and scheduler do not. Torrent sources should enqueue
the same way.

The feature should build on the existing source ordering, preferred audio
language, subtitle policy and library selection rather than inventing another
download path. Surface new episodes on the home screen and make duplicate
detection explicit so a repeated scheduler run is harmless. Following defaults
to discovery only; automatic downloads are a separate opt-in. See
[Follow show](roadmap-delivery-spec.md#follow-show).

### Queue robustness

Optional later: a night-only window, a speed limit, and a notice when the queue
drains. The in-app notice is shared with the debrid waiting state; push out of
the browser is later.

### Search

Live input (~400 ms debounce), recent queries, suggestions from already loaded
catalogs, and an optional rank-by-title-match.

### Desktop

The apps are distributed unsigned: the first launch needs a one-time approval on
macOS and a click through SmartScreen on Windows. Signing and notarization need
an Apple Developer account and a Windows code-signing certificate, which the
project does not have, so the manual **Desktop release** workflow stays unused
and the cookie-encryption fuse stays off. There is no Intel Mac build. Updates
are a notice pointing at the release, not an installer.

Open items: verify a clean install and an upgrade on both platforms before each
release, and keep the Windows checklist in
[testing-windows.md](testing-windows.md) current.

## Engineering health

Feature work is cheap now; long-lived complexity is not. These items are about
keeping the code changeable and the data safe, and they are worth taking in this
order. Each one is independently mergeable — do not fold two of them into one
refactor, and do not carry a feature along with one.

### Make destructive filesystem paths fail safe

The rule: when the app cannot tell **"the library is empty"** from **"the library
could not be read"**, it must not clean anything up. Uncertainty stops.

The cross-library artwork loss was exactly this shape — a swallowed `ENOENT`, a
file orphaned under the old key, and an hour later the sweep took it for good. The
library add / remove / forget / disable / re-enable / re-root / reconnect / type
change paths have been through it since, and the sweep and the migration check
the root before deleting. Walk the rest of the same surface: file rename, move,
copy, delete, bulk and cross-library operations, including across filesystems;
artwork generation, replacement, cleanup and orphan detection; metadata binding
after an external rename or a vanished file. A destructive path gets explicit
preconditions and never swallows an error, a failure never leaves a success
showing in the interface, and each case found gets a regression test at the
domain layer.

### Give interrupted operations a defined restart

Downloads have `.part` files and a resume, and a library scan or bulk job
survives a restart through `library-scan.json` and `library-ops.json`. That does not yet prove recovery at every side-effect boundary. Artwork
and metadata bulk jobs already use the operations queue; individual generation,
metadata writes and playback sessions need explicit recovery contracts too.
Cross-mount copies already use random-suffixed staging paths, destination
reservations and flushes; persist their ownership and publication phase so a
restart can distinguish an unfinished copy from a completed move.

After a restart every interrupted operation should end up resumed, retried,
marked failed, cleaned up, or shown to the user — never displayed as finished
while the disk holds half a file. Temporary and staging files need durable
ownership, collision-safe names and a conservative cleanup rule. A partial
destination must never be scannable as complete media.

### Playback hardening

Direct play → remux → transcode stays the order, and it should be deterministic
and testable rather than discovered per stream. What needs checking: byte ranges
and seeking on direct play; the fragmented MP4 lifecycle and audio-only
conversion on remux; cancellation, client disconnect and concurrent sessions on
transcode — every FFmpeg process must belong to a live session or bounded
cleanup, rather than to an individual HLS segment request; and the VAAPI failure
counter turning into a clean software fallback instead of a failed playback. A
failed playback should tell us the source, the mode chosen, hardware or software,
and the stage that failed, without a token or a full private stream URL reaching
the log.

### Backup scope, written down

`backup.ts` exports and imports settings and addons — the libraries' names and
roots are remapped on the way back in — and it deliberately carries neither the
accounts nor the media library. What a backup means beyond that is not written
down: which data must be preserved (favourites, resume state, metadata bindings,
download settings), which is genuinely rebuildable cache — verified, not
assumed — and how secrets in addon URLs are handled. The target contract is a
restore preview that validates before mutation,
explains defaulted fields and unresolved mappings, and requires an explicit
choice before redirecting downloads. Today the parser accepts versions 1/2,
normalizes some fields and falls back to the default library for unresolved
references; this is not a strict or transactional full-instance restore.
A full-instance restore, accounts included, is a separate undesigned operation.

### A classification behind the errors

`AppError` already carries English text plus a catalogue key. What is missing is a
stable code and a class — source, network, storage, library, playback, transcode,
addon, authentication, configuration, internal — so the diagnostics panel can
group failures, say whether the thing is still going, and say whether a retry
helps, instead of showing a raw exception string. Redaction stays covered by
tests.

### Exercise recovery as a first-class test surface

Add an adversarial recovery pass around operations that can leave durable state
or files behind. Kill or restart the server while a download, cross-library
copy, metadata update, scan, artwork job or transcode is in progress and verify
that the next start reaches one defined state: resumed, retried, failed,
cleaned up or explicitly shown to the user.

The goal is not another large end-to-end suite. Add the cheapest deterministic
regression test for each failure that the campaign discovers, and keep a small
number of full restart journeys for the boundaries that cannot be proven below
E2E.

### Measure the autonomous maintenance loop

GitHub issues are also the live test bed for the AI-assisted maintenance
workflow. Keep the automation useful by measuring outcomes rather than the
number of generated commits.

Track at least:

- issues rejected as invalid, duplicate or not reproducible;
- valid issues turned into a pull request without human implementation;
- pull requests that needed a human technical decision before they were ready;
- defects found by independent cross-review before merge;
- regressions caused by an AI-generated fix;
- flaky tests introduced or exposed by maintenance work;
- number of agent iterations from accepted issue to a green, reviewable change.

The implementer and the independent reviewer should not be treated as a voting
system. A green CI run or agreement between models is evidence, not proof; the
original behaviour and the regression test remain the source of truth. Use
[the measurement contract](roadmap-delivery-spec.md#maintenance-measurement) to
define denominators, human intervention and regression attribution.

## Later

### Access and multi-instance

- Richer profiles beyond the initial kids mode: several profiles under one
  account, optional age-aware filtering where trustworthy metadata exists, and
  fast profile switching without weakening the account boundary.
- Configurable LAN IP/host for the running container. The web client should try
  that address first so playback on the home network does not hairpin through a
  reverse proxy or Cloudflare Tunnel. Fail closed: never treat an unauthenticated
  LAN probe as an open door.
- Remote client mode: another instance (Docker or native) can use this one as the
  download/playback server, including an instance published behind a Cloudflare
  Tunnel with explicit auth.

Do not expose the app directly to the internet. An HTTPS reverse proxy or a VPN
remains the rule; the cookie is only `Secure` when the server sees HTTPS.

### External automation

- *arr integration can expose installed Stremio addons as a source of results
  and hand matching jobs back to Stremio Offline as a download client,
  especially for HTTP sources that the existing *arr ecosystem does not handle
  well. Keep this behind the household UX and reliability work above: it is a
  useful power-user integration, not a prerequisite for the core product. The
  [bridge specification](arr-integration-spec.md) and
  [execution plan](arr-integration-agent-task.md) own its contract. The protocol
  probe proves feasibility, not production readiness; automatic search is not
  continuous release discovery, and RSS remains a separate milestone.

### Packaging

- One-compose install path for people who will not read the Synology chapter.

### Tests

Stream sorting and filtering is still checked by hand against real addon
payloads. The screenshot matrix and the viewport projects are described in
[Testing](testing.md).

The suite is strong and should stay cheap to keep. When it starts costing more
than it catches, the things to look for are an end-to-end test proving something
a domain test already proves, a screenshot baseline that breaks on unrelated
changes, and a wait on a sleep where an observable condition exists. A flaky test
is a defect, not weather.

## Out of scope unless revisited

- A local torrent engine on the NAS.
- Playing an uncached torrent in the player while Real-Debrid is still leeching.
- AllDebrid, Premiumize, or a second debrid provider before Real-Debrid is in
  daily use.
- Parsing the API token out of a Torrentio (or other addon) manifest URL.
- Building the image on every push. Revisit after features land through pull
  requests instead of bursts on `main`.
