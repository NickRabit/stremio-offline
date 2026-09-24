# Roadmap

A living backlog, not a sprint commitment. Update this file when something ships
or when a new pain shows up in daily use.

The target platform remains a Synology NAS with an Intel Celeron (QuickSync on a
DS220+ or DS920+). Direct play and remux are the common path; a real transcode
needs VAAPI. See [Hardware acceleration](hardware-acceleration.md) for the setup.

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
  names and roots of the libraries. Tokens in addon URLs mean the file is a
  secret.
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
- English or Czech throughout, chosen on first run; server messages travel as
  English text plus a catalogue key.
- Tile size that follows the panel, portrait or landscape tiles per page, and
  cached artwork sized for a tile.
- Restricted / demo mode (`RESTRICTED_MODE=1`), English documentation, the
  community files, the GHCR image and the build and release workflows.
- **Desktop shell**: a separate window that opens an existing server, after a
  main-process status check, with its own connection screen, named server
  profiles, a session per origin, a refused public HTTP request and links that
  leave for the system browser. An arm64 packaging prototype builds a macOS
  `.dmg`/`.zip` with the reviewed Electron Fuse V1 hardening applied at package
  time — Node-as-Node, Node option injection, inspector switches and asar
  shadowing are off, asar integrity validation is on, and the packaging
  workflow reads the fuses back from the built `.app`. **Save to this device**
  hands a download to the native dialog. Delivered by
  [PR #211](https://github.com/NickRabit/stremio-offline/pull/211),
  [PR #221](https://github.com/NickRabit/stremio-offline/pull/221),
  [PR #222](https://github.com/NickRabit/stremio-offline/pull/222) and
  [PR #223](https://github.com/NickRabit/stremio-offline/pull/223); it stays an
  unsigned, unnotarized prototype, not a distribution.

## Next (daily friction)

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

Daily check for new episodes of a show, enqueued as lazy jobs. The lazy-job
plumbing exists; the watch list and the scheduler do not. Torrent sources should
enqueue the same way.

### Queue robustness

Optional later: a night-only window, a speed limit, and a notice when the queue
drains. The in-app notice is shared with the debrid waiting state; push out of
the browser is later.

### Search

Live input (~400 ms debounce), recent queries, suggestions from already loaded
catalogs, and an optional rank-by-title-match.

### Desktop

The remote desktop shell ships with named server profiles and a macOS arm64
packaging prototype (`.dmg`/`.zip`) with the native save-to-device handoff and
the reviewed Electron Fuse V1 hardening applied at package time;
[desktop/README.md](../desktop/README.md) records how it stands and what it
deliberately leaves out. What is still outstanding for a distributable remote
client is signing, notarization, update delivery and clean-install verification,
and the cookie-encryption fuse stays off until there is a stable signing
identity to tie the macOS keychain key to. Phase 2, starting and managing the
local backend from the shell, follows that release work.

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
survives a restart through `library-scan.json` and `library-ops.json`. Nothing
else does: artwork generation, a metadata update or a transcode killed mid-flight
has no stated behaviour on the next start, and a cross-mount copy stages through
a name derived from the destination.

After a restart every interrupted operation should end up resumed, retried,
marked failed, cleaned up, or shown to the user — never displayed as finished
while the disk holds half a file. Temporary and staging files need deterministic
names, a rule for collisions and an owner that clears them, and a partial
destination must never be scannable as complete media.

### Playback hardening

Direct play → remux → transcode stays the order, and it should be deterministic
and testable rather than discovered per stream. What needs checking: byte ranges
and seeking on direct play; the fragmented MP4 lifecycle and audio-only
conversion on remux; cancellation, client disconnect and concurrent sessions on
transcode — no FFmpeg process may outlive its request; and the VAAPI failure
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
assumed — and how secrets in addon URLs are handled. Restore validates the file
before applying any of it, fails loudly on an incompatible or partial backup, and
stays explicit about remapping when the filesystem roots moved. A full-instance
restore, accounts included, is a separate undesigned operation.

### A classification behind the errors

`AppError` already carries English text plus a catalogue key. What is missing is a
stable code and a class — source, network, storage, library, playback, transcode,
addon, authentication, configuration, internal — so the diagnostics panel can
group failures, say whether the thing is still going, and say whether a retry
helps, instead of showing a raw exception string. Redaction stays covered by
tests.

## Later

### Access and multi-instance

- Profiles beyond an account: lockable profiles, kids profiles that honour age
  metadata when the catalog provides it, and switching between them without a
  password. Accounts already separate addons, libraries, history and settings.
- Configurable LAN IP/host for the running container. The web client should try
  that address first so playback on the home network does not hairpin through a
  reverse proxy or Cloudflare Tunnel. Fail closed: never treat an unauthenticated
  LAN probe as an open door.
- Remote client mode: another instance (Docker or native) can use this one as the
  download/playback server, including an instance published behind a Cloudflare
  Tunnel with explicit auth.

Do not expose the app directly to the internet. An HTTPS reverse proxy or a VPN
remains the rule; the cookie is only `Secure` when the server sees HTTPS.

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
