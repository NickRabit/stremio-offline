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

Shipped in `main`; implementation details live in the linked guides.

- **Libraries**: multiple roots, types, move/copy operations, optional content
  moves when changing a root, staged settings, mosaics and galleries.
  [Libraries](libraries.md).
- **Identification**: automatic scans, suggestions and manual matching, with
  TMDB/Cinemeta metadata and artwork. [Library identification](library-metadata.md).
- **Accounts**: administrator and user roles, per-user libraries, addons,
  download permissions, preferences and session revocation. [Accounts](users.md).
- **Playback**: direct play, remux, hardware transcode, timeline previews,
  subtitle timing, next-episode countdown and device volume memory. AirPlay is
  disabled. [Playback](playback.md).
- **Continue watching**: series grouping, the next available catalogue episode
  and per-library/addon visibility. [Libraries](libraries.md#the-library-row).
- **Downloads**: restart recovery, Range resume, retries, disk-full pausing,
  segmented transfers, device saves, smart season/show selection and
  Real-Debrid torrent hand-off. [Addons and downloads](downloads.md).
- **Addons**: scoped search, scheduled/manual manifest refresh, storage rules
  and downloaded-title language. [Addons and downloads](downloads.md).
- **Search**: search while typing, title-match order of loaded results,
  per-account history that can be cleared or turned off, and suggestions from
  recent searches and titles already seen. [Enhanced search](enhanced-search-spec.md).
- **Trailers**: Cinemeta/TMDB, in-app with secure mode off and an external tab
  with it on. [Trailers](trailers.md).
- **Languages**: ten in both web and desktop clients, with per-account
  preferences. [Languages](languages.md).
- **Desktop apps**: macOS arm64, Windows x64 and Linux x64; bundled FFmpeg,
  local/remote servers, LAN sharing, login startup and update notices.
  [Desktop guide](../desktop/README.md).
- **Cloudflare Access**: desktop email-PIN sign-in.
  [Supported sign-in](../desktop/README.md#cloudflare-access).
- **Phones and tablets**: responsive layouts and Home Screen setup.
  [Mobile guide](mobile.md).
- **Statistics and diagnostics**: traffic by source, active streams, admin
  activity history, grouped errors and redacted logs.
  [Activity history](users.md#activity-history), [Diagnostics](troubleshooting.md).
- **Security and distribution**: secure-mode artwork proxying, restricted mode,
  configuration export/import, GHCR images and unsigned desktop releases.
  [README](../README.md), [Configuration backup](downloads.md#backing-up-the-configuration).

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

Design proposal: [Automatic downloads for followed series](follow-show-analysis.md).

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
