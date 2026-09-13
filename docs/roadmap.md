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

## Later

### Library and discovery

- **Library metadata**: posters and descriptions for folders that did not arrive through the download queue. Spec in [library-metadata.md](library-metadata.md). Path parser, title units and scoring ship first; Identify, the scan job and library chrome follow.
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

## Out of scope unless revisited

- A local torrent engine on the NAS.
- Playing an uncached torrent in the player while Real-Debrid is still leeching.
- AllDebrid, Premiumize, or a second debrid provider before Real-Debrid is in daily use.
- Parsing the API token out of a Torrentio (or other addon) manifest URL.
- Building the image on every push. Revisit after features land through pull requests instead of bursts on `main`.
