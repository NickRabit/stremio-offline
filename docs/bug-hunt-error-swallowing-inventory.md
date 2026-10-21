# Production error-swallowing inventory

This is the BH-0.4 inventory for the exact production patterns
`.catch(() => {})` and `.catch(() => undefined)`. It records candidates for
the owning bug-hunt units; a catch is not evidence of a defect by itself.

Recorded against `acdc44e8a6661d616a45ed4e317d3b70976e40b8` on 2026-10-21.
Total production occurrences: **301** (261 `.catch(() => undefined)` and
40 `.catch(() => {})`).
No source line contains more than one exact match at this revision; each
`path:line` in the table is therefore unique.

## Search

The checked search was:

```sh
rg -n -F -e '.catch(() => {})' -e '.catch(() => undefined)' \
  server/src web/src desktop/src android-tv \
  -g '*.{ts,tsx,js,jsx,mjs,cjs,kt,java}' \
  -g '!**/*.test.*' -g '!**/*.spec.*' \
  -g '!**/test/**' -g '!**/tests/**' -g '!**/__tests__/**' \
  -g '!**/fixtures/**' -g '!**/fixture/**' \
  -g '!**/generated/**' -g '!**/build/**' -g '!**/dist/**' \
  -g '!**/vendor/**' -g '!**/vendored/**'
```

Tests and fixtures are excluded by path and file name. Generated outputs,
build artifacts and vendored trees are excluded by directory. The scanned
languages are TS, TSX, JS, JSX, MJS, CJS, Kotlin and Java. No Kotlin or Java
match exists at this revision.

Run the dependency-free checker after edits:

```sh
node scripts/check-error-swallowing-inventory.mjs
```

By default it reads the sources of the commit named above from git, so the
inventory stays checkable as `main` moves on. `--worktree` checks the current
files instead; run it when refreshing the inventory for a new commit, and update
the recorded commit with it.

It repeats the same scope, parses this document, and fails if a source match
is missing or duplicated, if a declared count or classification is wrong, or
if a `needs review` row is absent from the candidate summary.

## Counts

| Package | Occurrences |
| --- | ---: |
| desktop | 38 |
| server | 192 |
| web | 71 |
| **Total** | **301** |

| File | Occurrences |
| --- | ---: |
| `desktop/src/connection-file.ts` | 1 |
| `desktop/src/download-dir.ts` | 2 |
| `desktop/src/local-backend.ts` | 2 |
| `desktop/src/local-media-key.ts` | 2 |
| `desktop/src/local-settings.ts` | 1 |
| `desktop/src/login-item.ts` | 1 |
| `desktop/src/main.ts` | 24 |
| `desktop/src/settings-window.ts` | 2 |
| `desktop/src/shell-prefs.ts` | 1 |
| `desktop/src/startup.ts` | 1 |
| `desktop/src/window-state.ts` | 1 |
| `server/src/activity.ts` | 1 |
| `server/src/artwork-cache.ts` | 4 |
| `server/src/artwork-sweep.ts` | 1 |
| `server/src/byte-cache.ts` | 2 |
| `server/src/client-logs.ts` | 1 |
| `server/src/download-selection.ts` | 1 |
| `server/src/downloads.ts` | 16 |
| `server/src/external-ids.ts` | 1 |
| `server/src/follows.ts` | 1 |
| `server/src/images.ts` | 3 |
| `server/src/index.ts` | 8 |
| `server/src/libraries.ts` | 2 |
| `server/src/library-actions.ts` | 3 |
| `server/src/library-admin.ts` | 2 |
| `server/src/library-grants.ts` | 1 |
| `server/src/library-meta-store.ts` | 1 |
| `server/src/library-migrate.ts` | 2 |
| `server/src/library-ops.ts` | 4 |
| `server/src/library-probe.ts` | 4 |
| `server/src/library-seen.ts` | 1 |
| `server/src/library-transfer.ts` | 6 |
| `server/src/library.ts` | 3 |
| `server/src/logger.ts` | 5 |
| `server/src/maintenance.ts` | 1 |
| `server/src/media-playlist.ts` | 1 |
| `server/src/media-server-manager.ts` | 17 |
| `server/src/media-server-personal.ts` | 2 |
| `server/src/media-server-playback.ts` | 1 |
| `server/src/media-server-quota.ts` | 3 |
| `server/src/media-server-secrets.ts` | 9 |
| `server/src/media-server-security.ts` | 22 |
| `server/src/media-server-sources.ts` | 1 |
| `server/src/mosaic.ts` | 6 |
| `server/src/outbound.ts` | 2 |
| `server/src/playback.ts` | 3 |
| `server/src/player-sidecars.ts` | 2 |
| `server/src/prepare-media-key.ts` | 2 |
| `server/src/remote-image-cache.ts` | 12 |
| `server/src/remote-read-ahead.ts` | 4 |
| `server/src/routes/content.ts` | 5 |
| `server/src/routes/curate.ts` | 2 |
| `server/src/routes/device.ts` | 2 |
| `server/src/routes/downloads.ts` | 1 |
| `server/src/routes/follows.ts` | 1 |
| `server/src/routes/home.ts` | 2 |
| `server/src/routes/libraries.ts` | 4 |
| `server/src/routes/media-servers.ts` | 2 |
| `server/src/routes/personal.ts` | 1 |
| `server/src/routes/playback.ts` | 9 |
| `server/src/store.ts` | 1 |
| `server/src/walk-cache.ts` | 1 |
| `web/src/App.tsx` | 22 |
| `web/src/CatalogueTitleDetail.tsx` | 1 |
| `web/src/FollowDialog.tsx` | 2 |
| `web/src/FollowingPage.tsx` | 1 |
| `web/src/Home.tsx` | 1 |
| `web/src/HomeLayoutSettings.tsx` | 3 |
| `web/src/LibraryManager.tsx` | 1 |
| `web/src/LocalLibraryDetail.tsx` | 1 |
| `web/src/NativeLibrarySaveDialog.tsx` | 1 |
| `web/src/Player.tsx` | 15 |
| `web/src/RemoteLibraryBrowser.tsx` | 6 |
| `web/src/SearchSettings.tsx` | 1 |
| `web/src/SeriesDownloadDialog.tsx` | 3 |
| `web/src/api.ts` | 6 |
| `web/src/desktop/preview.ts` | 1 |
| `web/src/diagnostics.ts` | 1 |
| `web/src/library-preload.ts` | 1 |
| `web/src/player-sidecar.ts` | 2 |
| `web/src/remote-mosaic.tsx` | 1 |
| `web/src/title-enrichment.ts` | 1 |

## Classification rule

A catch is **best effort** when losing its result cannot change acknowledged
user-visible or durable state. Two shapes always qualify, wherever they occur:

- releasing a body, reader, transport, agent or file handle that the code is
  already abandoning (`cancel()`, `close()`, `destroy()`), and
- removing a function's own staging (temporary file, just-created directory)
  after a failure that it rethrows.

A rejected release does not keep the resource alive in a way the caller could
act on, and the caller's own result or error is unchanged. Stopping a playback
session or converter is not a release in this sense: it is listed as a
candidate.

## Complete inventory

Rows are ordered by path and line. “Best effort” is used only where losing
that particular result does not change acknowledged user-visible or durable
state. Uncertainty is recorded as “needs review”.

| Path:line | Pattern | Nearest function or operation | Classification | Caller-behavior reason | Owning unit |
| --- | --- | --- | --- | --- | --- |
| `desktop/src/connection-file.ts:145` | `.catch(() => {})` | remove temporary connection file | best effort | The atomic connection write already failed and that error is rethrown; only its temporary file cleanup is suppressed. | BH-12.3 |
| `desktop/src/download-dir.ts:227` | `.catch(() => {})` | remove write probe | best effort | The probe has already proved the chosen directory writable; a leftover empty probe does not become acknowledged application state. | BH-12.1 |
| `desktop/src/download-dir.ts:252` | `.catch(() => {})` | remove temporary ownership file | best effort | The ownership write failed and is rethrown; suppressing cleanup cannot turn that failure into success. | BH-12.3 |
| `desktop/src/local-backend.ts:322` | `.catch(() => {})` | remove temporary port file | best effort | Publishing the port failed and the original error is rethrown; the caller sees startup failure. | BH-12.1 |
| `desktop/src/local-backend.ts:450` | `.catch(() => {})` | stop after a pending start | needs review | `stop()` deliberately joins a rejected `start()` and continues, so its caller cannot observe why startup failed. Reproduce by failing start, then awaiting stop. | BH-12.1 |
| `desktop/src/local-media-key.ts:120` | `.catch(() => {})` | close key file handle | best effort | The handle is read-only and the key result is already established; a close failure has no acknowledged data change. | BH-12.1 |
| `desktop/src/local-media-key.ts:139` | `.catch(() => {})` | remove temporary key file | best effort | The final key operation's outcome is returned separately, and this temporary is not authoritative state. | BH-12.1 |
| `desktop/src/local-settings.ts:70` | `.catch(() => {})` | remove temporary local-settings file | best effort | The atomic local-settings write failed and its original error is rethrown; only temporary cleanup is suppressed. | BH-12.3 |
| `desktop/src/login-item.ts:178` | `.catch(() => {})` | remove temporary login-item file | best effort | The login-item write failed and is rethrown; cleanup is the only suppressed result. | BH-12.3 |
| `desktop/src/main.ts:280` | `.catch(() => {})` | open project web page | needs review | A user-clicked external link can fail with no feedback because the detached shell call has no observer. Reproduce with an unavailable external URL. | BH-12.2 |
| `desktop/src/main.ts:487` | `.catch(() => {})` | poll a fallback server | needs review | A failed probe ends with neither a toast nor retry state, so a server that recovers while the probe rejects is not announced. Reproduce by failing one repoll request. | BH-12.1 |
| `desktop/src/main.ts:543` | `.catch(() => {})` | blank a failed remote page | best effort | The remote connection has already failed and this navigation only clears stale page content before the error view. | BH-12.1 |
| `desktop/src/main.ts:581` | `.catch(() => {})` | retire remote page | best effort | Retirement is explicitly bounded by a timeout and the page is destroyed afterward; a blank-page load result does not affect returned state. | BH-12.1 |
| `desktop/src/main.ts:610` | `.catch(() => {})` | open blocked remote URL externally | needs review | This is the fallback for a user navigation that the embedded page denied; a failed external open leaves the request invisible. | BH-12.2 |
| `desktop/src/main.ts:725` | `.catch(() => {})` | stop local backend while switching | needs review | `closeLocalBackend()` resolves even when managed-process shutdown rejects, hiding a possible orphaned backend. Reproduce with a stop seam rejection. | BH-12.1 |
| `desktop/src/main.ts:794` | `.catch(() => {})` | persist local startup choice | needs review | The shell proceeds to `connected` even if the remembered target was not written, so restart uses a different target without notice. | BH-12.3 |
| `desktop/src/main.ts:818` | `.catch(() => {})` | persist profile startup choice | needs review | A remote profile can be shown as connected while its selected startup target remains stale after restart. | BH-12.3 |
| `desktop/src/main.ts:1047` | `.catch(() => {})` | persist tray notice preference | needs review | The in-memory flag is marked shown before the write, so a failed write changes durable behavior without surfacing the error. | BH-12.3 |
| `desktop/src/main.ts:1105` | `.catch(() => {})` | save main-window bounds | needs review | Window bounds are acknowledged only in the debounce, not persisted; a failed write silently restores an old geometry. | BH-12.3 |
| `desktop/src/main.ts:1263` | `.catch(() => {})` | clear local session storage during reset | needs review | Reset can return success while authentication cookies remain. Inject `clearStorageData` failure and verify which signed-in state survives. | BH-12.3 |
| `desktop/src/main.ts:1264` | `.catch(() => {})` | remove local state files during reset | needs review | The reset continues after failed unlinks and reports success, potentially leaving settings, port or ownership records. | BH-12.3 |
| `desktop/src/main.ts:1266` | `.catch(() => {})` | clear saved profiles during reset | needs review | `forgetServers` can appear successful while the profile store still contains the servers after restart. | BH-12.3 |
| `desktop/src/main.ts:1268` | `.catch(() => {})` | clear profile session storage during reset | needs review | A profile partition can retain authentication after a successful reset because its clear failure is discarded. | BH-12.3 |
| `desktop/src/main.ts:1291` | `.catch(() => {})` | show reset-trash failure dialog | needs review | The only explanation of a partial reset can fail to display while the IPC result has already returned. | BH-12.1 |
| `desktop/src/main.ts:1294` | `.catch(() => {})` | show downloads-kept dialog | needs review | An informational reset outcome requested by the operation is dropped if the dialog fails. | BH-12.1 |
| `desktop/src/main.ts:1341` | `.catch(() => {})` | persist startup choice after profile deletion | needs review | The chosen server can be cleared in memory while the old startup choice remains durable. | BH-12.3 |
| `desktop/src/main.ts:1395` | `.catch(() => {})` | open update release page | needs review | A user-requested update action can fail with no visible result. Reproduce by rejecting `openExternal`. | BH-12.1 |
| `desktop/src/main.ts:1493` | `.catch(() => {})` | remove ownership record | needs review | Clearing a download-folder ownership record can fail while local settings are still committed, leaving contradictory durable state. | BH-12.3 |
| `desktop/src/main.ts:1672` | `.catch(() => {})` | stop backend after smoke failure | best effort | The smoke already failed, prints its cause and exits nonzero; this is best-effort cleanup in a failure-only path. | BH-12.1 |
| `desktop/src/main.ts:1733` | `.catch(() => {})` | show quit confirmation | needs review | If the confirmation dialog rejects, quit remains prevented and the user receives no error. Reproduce with a rejecting message-box seam. | BH-12.1 |
| `desktop/src/main.ts:1754` | `.catch(() => {})` | remove obsolete Windows init file | best effort | The file is a known stale artifact read by nothing; cleanup does not affect current user or authoritative state. | BH-12.1 |
| `desktop/src/main.ts:1766` | `.catch(() => {})` | refresh Linux autostart executable | needs review | Packaged startup can continue using an old executable while the refresh failure is hidden. Reproduce after moving the installed binary. | BH-12.1 |
| `desktop/src/main.ts:1782` | `.catch(() => {})` | migrate startup choice | needs review | A failed one-time migration still allows launch, but the legacy selected target can be replayed on the next start. | BH-12.3 |
| `desktop/src/settings-window.ts:100` | `.catch(() => {})` | save settings-window bounds | needs review | The window geometry is silently lost when its debounced write fails. | BH-12.3 |
| `desktop/src/settings-window.ts:109` | `.catch(() => {})` | load settings page | needs review | A rejected renderer load leaves an empty settings window with no failure state. Reproduce with a missing renderer page. | BH-12.1 |
| `desktop/src/shell-prefs.ts:80` | `.catch(() => {})` | remove temporary shell-prefs file | best effort | The atomic preference write failed and its original error is rethrown. | BH-12.3 |
| `desktop/src/startup.ts:50` | `.catch(() => {})` | remove temporary startup file | best effort | The startup-choice write failed and its original error is rethrown. | BH-12.3 |
| `desktop/src/window-state.ts:79` | `.catch(() => {})` | remove temporary window-state file | best effort | The window-state write failed and its original error is rethrown. | BH-12.3 |
| `server/src/activity.ts:74` | `.catch(() => undefined)` | continue activity-log write chain | best effort | The rejected write is returned to its caller; this catch only keeps the shared chain usable for later writes. | BH-1.1 |
| `server/src/artwork-cache.ts:109` | `.catch(() => undefined)` | inspect cached artwork on load | best effort | An unavailable cache file is skipped and can be regenerated; no user-owned source file is treated as absent. | BH-4.5 |
| `server/src/artwork-cache.ts:148` | `.catch(() => undefined)` | inspect artwork before memory read | best effort | This is a cache lookup; a missing or unreadable derived image falls back to regeneration. | BH-4.5 |
| `server/src/artwork-cache.ts:189` | `.catch(() => undefined)` | carry source artwork | best effort | Failure to read cached source artwork returns `carried: false` to the caller, which can build a replacement. | BH-4.5 |
| `server/src/artwork-cache.ts:230` | `.catch(() => undefined)` | inspect artwork for eviction | best effort | A failed stat only skips or updates derived-cache bookkeeping; authoritative media is not touched. | BH-4.5 |
| `server/src/artwork-sweep.ts:104` | `.catch(() => undefined)` | inspect stale artwork for sweep | best effort | An unreadable cache entry is skipped rather than deleted; loss of this result preserves data. | BH-4.5 |
| `server/src/byte-cache.ts:76` | `.catch(() => undefined)` | inspect byte-cache entry | best effort | A failed cache stat is treated as a cache miss and can be repopulated from the source. | BH-3.3 |
| `server/src/byte-cache.ts:80` | `.catch(() => undefined)` | read byte-cache entry | best effort | Failure to load a derived cache entry skips it; the result is not durable user state. | BH-3.3 |
| `server/src/client-logs.ts:113` | `.catch(() => undefined)` | prune old client-log bundles | best effort | Retention is best effort and a failed unlink only leaves an old log bundle; no live request or stored user setting is changed. | BH-7.5 |
| `server/src/download-selection.ts:167` | `.catch(() => undefined)` | inspect a download candidate | needs review | A probe error removes a candidate without exposing its reason, so source exhaustion can be reported instead of a probe failure. Reproduce with a rejecting `inspect`. | BH-2.2 |
| `server/src/downloads.ts:546` | `.catch(() => undefined)` | remove abandoned segmented partial | needs review | Restart reset clears resume bookkeeping even if the partial could not be removed; the next attempt may append to inconsistent bytes. | BH-2.2 |
| `server/src/downloads.ts:1187` | `.catch(() => undefined)` | remove cancelled media partial | needs review | Cancellation continues after failed partial cleanup, leaving a file that can block or contaminate a retry. | BH-2.2 |
| `server/src/downloads.ts:1189` | `.catch(() => undefined)` | remove cancelled subtitle partial | needs review | Failed subtitle-partial cleanup is hidden while the queue reports cancellation. | BH-2.2 |
| `server/src/downloads.ts:1251` | `.catch(() => undefined)` | keep queue save chain usable | best effort | The caller receives the actual save promise; this caught tail only prevents one rejection from poisoning later saves. | BH-2.2 |
| `server/src/downloads.ts:1277` | `.catch(() => undefined)` | keep admission chain usable | best effort | The caller receives `run`; the caught chain tail only allows a later admission after this one fails. | BH-2.2 |
| `server/src/downloads.ts:1526` | `.catch(() => undefined)` | inspect reserved destination | needs review | A stat failure is indistinguishable from “no placeholder,” so destination reservation can choose another name or proceed without the crash-recovery evidence it expects. | BH-2.2 |
| `server/src/downloads.ts:1559` | `.catch(() => undefined)` | roll back subtitle publication | needs review | If the media rename fails and subtitle rollback also fails, the original error is returned but the pair remains split without cleanup state. | BH-2.2 |
| `server/src/downloads.ts:1601` | `.catch(() => undefined)` | discard range-probe response | best effort | The range plan is already derived from headers; cancellation failure cannot change the chosen download mode. | BH-2.2 |
| `server/src/downloads.ts:1624` | `.catch(() => undefined)` | discard rejected range response | best effort | An HTTP source error is thrown immediately after the cancellation attempt, so its result is fully handled. | BH-2.2 |
| `server/src/downloads.ts:1652` | `.catch(() => undefined)` | remove old partial before playlist download | needs review | The queue resets counters and starts a new playlist after failed deletion, allowing stale bytes to survive into retry/recovery. | BH-2.2 |
| `server/src/downloads.ts:1853` | `.catch(() => undefined)` | remove partial after segment-plan mismatch | needs review | Resume state is discarded even when the old partial remains, so a later run can mix files from different plans. | BH-2.2 |
| `server/src/downloads.ts:1925` | `.catch(() => undefined)` | discard failed segment response | best effort | A source error is thrown after releasing the body; the failed response is not used for durable state. | BH-2.2 |
| `server/src/downloads.ts:2005` | `.catch(() => undefined)` | remove abandoned retry partial | needs review | Retry reset proceeds when cleanup fails, potentially appending over abandoned bytes. | BH-2.2 |
| `server/src/downloads.ts:2015` | `.catch(() => undefined)` | remove partial after HTTP 416 | needs review | The stale partial can remain while resume metadata is cleared, undermining the recovery retry. | BH-2.2 |
| `server/src/downloads.ts:2034` | `.catch(() => undefined)` | remove partial for next source | needs review | Source failover erases received/segment state even if the old media partial remains. | BH-2.2 |
| `server/src/downloads.ts:2036` | `.catch(() => undefined)` | remove subtitle partial for next source | needs review | Failover clears subtitle state without proving that the old partial was removed. | BH-2.2 |
| `server/src/external-ids.ts:71` | `.catch(() => undefined)` | load external-id cache | best effort | The cache is explicitly rebuildable and a missing/broken file starts empty; no authoritative title id is overwritten. | BH-1.1 |
| `server/src/follows.ts:845` | `.catch(() => undefined)` | continue follow write chain | best effort | The rejected write itself is returned to the caller; the caught chain only keeps later writes scheduled. | BH-2.3 |
| `server/src/images.ts:410` | `.catch(() => undefined)` | read cached image | best effort | This is a derived-image read; failure is returned as a cache miss. | BH-4.5 |
| `server/src/images.ts:428` | `.catch(() => undefined)` | inspect image for memory fill | best effort | A failed cache-file stat skips memory warmup while leaving the indexed image available for regeneration. | BH-4.5 |
| `server/src/images.ts:432` | `.catch(() => undefined)` | read image into memory | best effort | A failed cache read only skips the in-memory copy; it does not delete the indexed source. | BH-4.5 |
| `server/src/index.ts:554` | `.catch(() => undefined)` | resolve final library path | needs review | Any `realpath` failure is translated to a missing-file response, collapsing permission and transient I/O failures into a user-visible absence. | BH-7.4 |
| `server/src/index.ts:1018` | `.catch(() => undefined)` | inspect library file through loopback | needs review | Probe failures are hidden as “no media info” for artwork and other callers, including errors that are not an unsupported file. | BH-3.1 |
| `server/src/index.ts:1028` | `.catch(() => undefined)` | determine scan duration | best effort | The scan explicitly treats one failed/oversized file probe as unknown duration so it cannot fail the whole scan. | BH-4.1 |
| `server/src/index.ts:1047` | `.catch(() => undefined)` | refresh stale library health | needs review | This detached stale follow-up has no observer; a persistent refresh failure leaves callers using stale health and only the rejected promise disappears. | BH-8.2 |
| `server/src/index.ts:1310` | `.catch(() => undefined)` | stamp artwork URL | needs review | An I/O or permission failure is encoded as stamp `"0"` and may be cached as normal artwork state rather than surfaced. | BH-4.5 |
| `server/src/index.ts:1878` | `.catch(() => undefined)` | fetch optional TMDb backdrop | best effort | Missing TMDb artwork explicitly falls through to the generated frame or the existing poster. | BH-4.5 |
| `server/src/index.ts:1896` | `.catch(() => undefined)` | resolve source for scheduled artwork | best effort | A missing source simply ends optional artwork generation; acknowledgement is not stored for this disappearance. | BH-4.5 |
| `server/src/index.ts:2087` | `.catch(() => undefined)` | precheck retention deletion | needs review | A permission or I/O failure returns `false` before queueing deletion, making retention report “not a file” instead of surfacing the failed destructive operation. | BH-4.4 |
| `server/src/libraries.ts:271` | `.catch(() => undefined)` | resolve playback URLs against a library | best effort | Resolution failure is treated as not matching the library and therefore fails closed for the playback/root check. | BH-7.3 |
| `server/src/libraries.ts:317` | `.catch(() => undefined)` | resolve nearest existing path ancestor | best effort | Walking upward is the intended algorithm for a path that does not yet exist; no result is reported as an existing file. | BH-7.3 |
| `server/src/library-actions.ts:226` | `.catch(() => undefined)` | validate action source | needs review | Permission and transient I/O errors are returned as `err.pathMissing`, so a caller cannot distinguish an absent item from an unreadable library. | BH-4.4 |
| `server/src/library-actions.ts:374` | `.catch(() => undefined)` | validate item to act on | needs review | Any stat failure becomes a missing-item response before a destructive action; access failures are hidden. | BH-4.4 |
| `server/src/library-actions.ts:385` | `.catch(() => undefined)` | validate action destination folder | needs review | A failed destination stat is reported as a missing folder even when the failure is permission or I/O. | BH-4.4 |
| `server/src/library-admin.ts:82` | `.catch(() => undefined)` | inspect a proposed library root | needs review | A failed stat is treated as an absent root; with `create: true`, an unreadable existing mount can proceed toward a misleading create/registration result. | BH-4.1 |
| `server/src/library-admin.ts:142` | `.catch(() => undefined)` | continue library-root lock chain | best effort | The caller receives the work promise; the caught chain tail only allows the next lock holder to run. | BH-4.1 |
| `server/src/library-grants.ts:42` | `.catch(() => undefined)` | resolve a grant root | best effort | A grant that cannot be resolved is skipped, which fails closed and does not widen access. | BH-7.3 |
| `server/src/library-meta-store.ts:87` | `.catch(() => undefined)` | load one metadata file | needs review | Read failure is logged and protected from overwrite, but the rest of the library starts without surfacing that metadata is unavailable to the current request. | BH-1.1 |
| `server/src/library-migrate.ts:252` | `.catch(() => undefined)` | inspect leftover artwork | best effort | A failed stat skips cache migration/removal for that derived poster; no authoritative media is removed. | BH-4.5 |
| `server/src/library-migrate.ts:263` | `.catch(() => undefined)` | read queued download targets | needs review | Failure to read `downloads.json` becomes an empty target list, so migration can delete artwork for queued downloads. Reproduce with an unreadable downloads file. | BH-1.1 |
| `server/src/library-ops.ts:224` | `.catch(() => undefined)` | attach pump rejection observer | best effort | `pumped` is also exposed to `settled()`; this catch prevents unhandled rejection without replacing the stored promise. | BH-1.1 |
| `server/src/library-ops.ts:232` | `.catch(() => undefined)` | settle operation pump | needs review | Shutdown/relocation can report settled after the operation loop rejected, hiding incomplete filesystem work. | BH-1.1 |
| `server/src/library-ops.ts:233` | `.catch(() => undefined)` | settle operation saves | needs review | A failed journal write is suppressed by `settled()`, although the caller uses settlement as proof before removing or moving state. | BH-1.1 |
| `server/src/library-ops.ts:367` | `.catch(() => undefined)` | continue operation-journal save chain | best effort | The actual save promise is returned; the caught tail only permits subsequent saves after a rejection. | BH-1.1 |
| `server/src/library-probe.ts:40` | `.catch(() => undefined)` | bound a probe call | best effort | The timeout result is an explicit unknown-volume answer and the loser must not become an unhandled rejection. | BH-4.1 |
| `server/src/library-probe.ts:67` | `.catch(() => undefined)` | test case-folded probe path | best effort | Absence of the case-flipped path is the expected proof that the volume is case-sensitive. | BH-4.1 |
| `server/src/library-probe.ts:71` | `.catch(() => undefined)` | remove failed probe file | best effort | Probe failure is already converted to an unreachable/read-only answer; cleanup cannot alter that answer. | BH-4.1 |
| `server/src/library-probe.ts:120` | `.catch(() => undefined)` | observe background stale probe | best effort | The caller intentionally receives the cached value; this handler prevents the background refresh rejection from becoming unhandled. | BH-4.1 |
| `server/src/library-seen.ts:219` | `.catch(() => undefined)` | continue seen-state write chain | best effort | The caller awaits `next`; only the chain tail neutralizes a previous rejection so later writes can proceed. | BH-1.1 |
| `server/src/library-transfer.ts:97` | `.catch(() => undefined)` | inspect reservation after release failure | needs review | A failed identity lookup exits cleanup, making an fsync/access failure look like “nothing to release” in a transfer rollback. | BH-4.4 |
| `server/src/library-transfer.ts:130` | `.catch(() => undefined)` | inspect source before placeholder removal | needs review | A permission or I/O failure returns without attempting recovery, with no signal to the transfer caller. | BH-4.4 |
| `server/src/library-transfer.ts:133` | `.catch(() => undefined)` | remove directory placeholder | needs review | Recovery continues after the empty destination folder could not be removed, so the subsequent rename result is the only evidence of the failure. | BH-4.4 |
| `server/src/library-transfer.ts:137` | `.catch(() => undefined)` | re-inspect target placeholder | needs review | An unreadable target is treated as not being a placeholder and is silently left in place. | BH-4.4 |
| `server/src/library-transfer.ts:139` | `.catch(() => undefined)` | remove empty file placeholder | needs review | Failure to remove a proven placeholder is hidden before transfer publication. | BH-4.4 |
| `server/src/library-transfer.ts:151` | `.catch(() => undefined)` | remove Windows destination before swap | needs review | The fallback then attempts `rename`; failure of placeholder removal is suppressed and can be misreported as the later rename error. | BH-4.4 |
| `server/src/library.ts:523` | `.catch(() => undefined)` | describe a library path | best effort | A failed stat omits that row from a browse response; the authoritative file and metadata are not modified. | BH-4.1 |
| `server/src/library.ts:685` | `.catch(() => undefined)` | inspect browsed directory | best effort | Failure means no directory mtime/signature is used and the code falls back to walking the listing; no state is acknowledged. | BH-4.2 |
| `server/src/library.ts:729` | `.catch(() => undefined)` | refresh file size/mtime on a page | best effort | Failure keeps the listing's already cached size and modified value, a display-only fallback. | BH-4.2 |
| `server/src/logger.ts:87` | `.catch(() => undefined)` | rotate a log file | best effort | Logging must not fail the operation being logged; a rotation failure only lets the current log exceed its intended segment size. | BH-7.5 |
| `server/src/logger.ts:102` | `.catch(() => undefined)` | continue asynchronous log writes | best effort | Log durability is deliberately secondary to the application operation, and the chain must survive an unwritable log file. | BH-7.5 |
| `server/src/logger.ts:117` | `.catch(() => undefined)` | rotate logs on demand | best effort | The caller still awaits the chain; this handler prevents an optional rotation failure from rejecting unrelated work. | BH-7.5 |
| `server/src/logger.ts:128` | `.catch(() => undefined)` | remove previous rotated log | best effort | Retention cleanup is best effort and does not change application data. | BH-7.5 |
| `server/src/logger.ts:138` | `.catch(() => undefined)` | continue log-retention rewrite | best effort | Log retention is a maintenance operation; its write failure is intentionally not propagated to application callers. | BH-7.5 |
| `server/src/maintenance.ts:52` | `.catch(() => undefined)` | run and re-arm maintenance | best effort | The scheduled run is explicitly designed never to reject; this catch preserves the next timer even if that invariant regresses. | BH-1.3 |
| `server/src/media-playlist.ts:91` | `.catch(() => undefined)` | cancel playlist reader after failure | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-3.4 |
| `server/src/media-server-manager.ts:913` | `.catch(() => undefined)` | close uncached login transport | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-manager.ts:1045` | `.catch(() => undefined)` | close uncached validation transport | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-manager.ts:1861` | `.catch(() => undefined)` | cancel cached image stream after error | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-manager.ts:1872` | `.catch(() => undefined)` | cancel image response after error | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-manager.ts:2070` | `.catch(() => undefined)` | abort image body during authorization recheck | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-manager.ts:2209` | `.catch(() => undefined)` | abort download body during authorization recheck | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-manager.ts:2683` | `.catch(() => undefined)` | cancel unavailable image body | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-manager.ts:2702` | `.catch(() => undefined)` | cancel image reader after stream error | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-manager.ts:2706` | `.catch(() => undefined)` | downstream image-stream cancel callback | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-manager.ts:2739` | `.catch(() => undefined)` | cancel transformed image reader | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-manager.ts:2743` | `.catch(() => undefined)` | downstream transformed-stream cancel callback | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-manager.ts:3115` | `.catch(() => undefined)` | close stale runtime transport | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-manager.ts:3134` | `.catch(() => undefined)` | close replaced runtime transport | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-manager.ts:3144` | `.catch(() => undefined)` | close evicted runtime transport | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-manager.ts:3157` | `.catch(() => undefined)` | close runtime before reconnecting | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-manager.ts:3420` | `.catch(() => undefined)` | observe shared in-flight read | best effort | The promise remains in `inflight` and every actual subscriber joins it; this handler only prevents an unobserved temporary rejection. | BH-6.3 |
| `server/src/media-server-manager.ts:3524` | `.catch(() => undefined)` | close owned scoped transport | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-personal.ts:453` | `.catch(() => undefined)` | fetch parent-series title for a write | best effort | A failed optional title read keeps the title already stored on the playback record, as documented by the caller. | BH-6.4 |
| `server/src/media-server-personal.ts:663` | `.catch(() => undefined)` | backfill old personal-record title | best effort | Backfill explicitly skips failures and leaves records unchanged, so it cannot turn optional enrichment into a failed request. | BH-6.4 |
| `server/src/media-server-playback.ts:154` | `.catch(() => undefined)` | observe reauthorization rejection | best effort | The same `work` is raced by the caller; this catch only prevents an unhandled rejection when the timeout or close signal wins. | BH-6.4 |
| `server/src/media-server-quota.ts:109` | `.catch(() => undefined)` | cancel quota body on abort | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-quota.ts:143` | `.catch(() => undefined)` | cancel quota body on read error | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-quota.ts:149` | `.catch(() => undefined)` | downstream quota-stream cancel | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-secrets.ts:179` | `.catch(() => undefined)` | close secret file after failed stat | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.1 |
| `server/src/media-server-secrets.ts:181` | `.catch(() => undefined)` | close rejected secret file | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.1 |
| `server/src/media-server-secrets.ts:212` | `.catch(() => undefined)` | close vault key handle | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.1 |
| `server/src/media-server-secrets.ts:245` | `.catch(() => undefined)` | remove unusable vault directory | best effort | Removes the vault's own staging after a failure that is rethrown; the caller still sees the failure. | BH-6.1 |
| `server/src/media-server-secrets.ts:252` | `.catch(() => undefined)` | remove rejected vault directory | best effort | Removes the vault's own staging after a failure that is rethrown; the caller still sees the failure. | BH-6.1 |
| `server/src/media-server-secrets.ts:272` | `.catch(() => undefined)` | close stored-envelope handle | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.1 |
| `server/src/media-server-secrets.ts:330` | `.catch(() => undefined)` | close failed secret-write handle | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.1 |
| `server/src/media-server-secrets.ts:331` | `.catch(() => undefined)` | remove failed secret-write temp | best effort | Removes the vault's own staging after a failure that is rethrown; the caller still sees the failure. | BH-6.1 |
| `server/src/media-server-secrets.ts:338` | `.catch(() => undefined)` | remove unrenamed secret temp | best effort | Removes the vault's own staging after a failure that is rethrown; the caller still sees the failure. | BH-6.1 |
| `server/src/media-server-security.ts:371` | `.catch(() => undefined)` | observe aborted guarded work | best effort | The guard immediately throws the abort error; this handler only prevents the losing work promise from becoming unhandled. | BH-6.2 |
| `server/src/media-server-security.ts:788` | `.catch(() => undefined)` | cancel JSON response reader after error | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-security.ts:1288` | `.catch(() => undefined)` | cancel streamed response reader after error | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-security.ts:1363` | `.catch(() => undefined)` | cancel failed JSON response body | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-security.ts:1367` | `.catch(() => undefined)` | cancel no-content operation body | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-security.ts:1379` | `.catch(() => undefined)` | destroy request agent | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-security.ts:1472` | `.catch(() => undefined)` | cancel original-media reader on release | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-security.ts:1477` | `.catch(() => undefined)` | destroy original-media agent on release | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-security.ts:1519` | `.catch(() => undefined)` | discard rejected original response | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-security.ts:1528` | `.catch(() => undefined)` | discard encoded original response | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-security.ts:1535` | `.catch(() => undefined)` | discard range-not-satisfiable body | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-security.ts:1556` | `.catch(() => undefined)` | discard HEAD response body | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-security.ts:1613` | `.catch(() => undefined)` | cancel original stream from client | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-security.ts:1689` | `.catch(() => undefined)` | cancel image reader on release | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-security.ts:1726` | `.catch(() => undefined)` | discard rejected image response | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-security.ts:1732` | `.catch(() => undefined)` | discard encoded image response | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-security.ts:1737` | `.catch(() => undefined)` | discard oversized image body | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-security.ts:1841` | `.catch(() => undefined)` | cancel transformed image from client | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-security.ts:1916` | `.catch(() => undefined)` | discard response that arrived after abort | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-security.ts:1941` | `.catch(() => undefined)` | discard asset response after validation error | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-security.ts:1970` | `.catch(() => undefined)` | destroy asset request agent | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-security.ts:1987` | `.catch(() => undefined)` | close all transport agents | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/media-server-sources.ts:267` | `.catch(() => undefined)` | discard source response after mapping error | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/mosaic.ts:138` | `.catch(() => undefined)` | remove mosaic temporary directory | best effort | Mosaic rendering's returned bytes or original error is already determined; only derived temp cleanup is suppressed. | BH-4.5 |
| `server/src/mosaic.ts:177` | `.catch(() => undefined)` | read cached mosaic | best effort | A missing/unreadable derived mosaic is a cache miss and can be rendered again. | BH-4.5 |
| `server/src/mosaic.ts:180` | `.catch(() => undefined)` | refresh mosaic cache age | best effort | Failure to update access time can cause earlier eviction but cannot corrupt media or user state. | BH-4.5 |
| `server/src/mosaic.ts:224` | `.catch(() => undefined)` | trim mosaic cache after write | best effort | Cache retention is best effort and the newly derived mosaic result remains available. | BH-4.5 |
| `server/src/mosaic.ts:249` | `.catch(() => undefined)` | inspect mosaic for trimming | best effort | A failed stat skips that derived cache entry rather than deleting authoritative data. | BH-4.5 |
| `server/src/mosaic.ts:258` | `.catch(() => undefined)` | evict mosaic | best effort | Failed deletion leaves derived data over the soft cap but does not change user-visible source state. | BH-4.5 |
| `server/src/outbound.ts:386` | `.catch(() => undefined)` | cancel oversized outbound body | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-5.1 |
| `server/src/outbound.ts:392` | `.catch(() => undefined)` | cancel failed outbound read | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-5.1 |
| `server/src/playback.ts:35` | `.catch(() => undefined)` | discard inspected response body | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-3.1 |
| `server/src/playback.ts:471` | `.catch(() => undefined)` | clear inspection bookkeeping | best effort | The stored inspection promise remains the caller's result; this settled tail only removes its map entry and handles rejection. | BH-3.1 |
| `server/src/playback.ts:603` | `.catch(() => undefined)` | stop session after request abort | needs review | The abort path ignores a stop rejection, potentially leaving a conversion or reader alive after the creator disconnects. | BH-3.1 |
| `server/src/player-sidecars.ts:122` | `.catch(() => undefined)` | remove previous sidecar | best effort | The sidecar job remains in its own file and cleanup failure does not alter the new job's source data. | BH-3.4 |
| `server/src/player-sidecars.ts:237` | `.catch(() => undefined)` | remove completed sidecar temp | best effort | The completed subtitle result is delivered separately; only temporary-file cleanup is suppressed. | BH-3.4 |
| `server/src/prepare-media-key.ts:116` | `.catch(() => {})` | close media-key handle | best effort | The key preparation result is established before closure, and a close error does not change the produced key. | BH-6.1 |
| `server/src/prepare-media-key.ts:140` | `.catch(() => {})` | remove media-key temp | best effort | The prepared key is authoritative only after the final rename; failed temp cleanup does not acknowledge it. | BH-6.1 |
| `server/src/remote-image-cache.ts:146` | `.catch(() => undefined)` | index remote-image cache file | best effort | A failed stat omits that derived image from the in-memory index and leaves it available for later recovery. | BH-4.5 |
| `server/src/remote-image-cache.ts:163` | `.catch(() => undefined)` | inspect image for memory warmup | best effort | Failure skips the in-memory copy; the on-disk cache entry is not deleted. | BH-4.5 |
| `server/src/remote-image-cache.ts:167` | `.catch(() => undefined)` | read image for memory warmup | best effort | A failed derivation read is a cache miss and does not change user or authoritative media state. | BH-4.5 |
| `server/src/remote-image-cache.ts:228` | `.catch(() => undefined)` | read cached remote image | best effort | Failure falls through to fetching or treating the derived image as absent. | BH-4.5 |
| `server/src/remote-image-cache.ts:253` | `.catch(() => undefined)` | observe image readiness rejection | best effort | The `ready` promise is still returned/stored for subscribers; this handler prevents an unhandled temporary rejection. | BH-4.5 |
| `server/src/remote-image-cache.ts:272` | `.catch(() => undefined)` | discard unavailable image response | best effort | The image fetch fails immediately afterward and the unavailable body is not used. | BH-4.5 |
| `server/src/remote-image-cache.ts:278` | `.catch(() => undefined)` | cancel abandoned image reader | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-4.5 |
| `server/src/remote-image-cache.ts:331` | `.catch(() => undefined)` | observe cancelled image waiter | best effort | The cancellation promise remains attached to waiters; this handler only suppresses its unobserved rejection. | BH-4.5 |
| `server/src/remote-image-cache.ts:362` | `.catch(() => undefined)` | cancel all image readers on close | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-4.5 |
| `server/src/remote-image-cache.ts:389` | `.catch(() => undefined)` | remove failed image-cache temp | best effort | Cache storage failure is already logged, and the temporary has no authoritative role. | BH-4.5 |
| `server/src/remote-image-cache.ts:403` | `.catch(() => undefined)` | refresh image-cache access time | best effort | An unrefreshed mtime may affect derived-cache eviction order, not media or durable user state. | BH-4.5 |
| `server/src/remote-image-cache.ts:424` | `.catch(() => undefined)` | evict cached remote image | best effort | Failed deletion leaves derived data over its cap; cached bytes and source media remain uncorrupted. | BH-4.5 |
| `server/src/remote-read-ahead.ts:101` | `.catch(() => undefined)` | observe read-ahead block readiness | best effort | The block promise remains available to callers; this handler prevents unobserved rejection while it is being indexed. | BH-3.3 |
| `server/src/remote-read-ahead.ts:115` | `.catch(() => undefined)` | cancel read-ahead response | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-3.3 |
| `server/src/remote-read-ahead.ts:151` | `.catch(() => undefined)` | cancel read-ahead reader on completion | best effort | The reader has settled, and this final cancellation only releases remaining bytes; its result cannot change delivered data. | BH-3.3 |
| `server/src/remote-read-ahead.ts:217` | `.catch(() => undefined)` | cancel read-ahead on stop | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-3.3 |
| `server/src/routes/content.ts:261` | `.catch(() => undefined)` | validate destination parent | needs review | Any stat failure is surfaced as “destination folder does not exist,” hiding permission and I/O errors from the operation caller. | BH-7.4 |
| `server/src/routes/content.ts:280` | `.catch(() => undefined)` | validate item to mutate | needs review | Permission and transient failures become `err.pathMissing` before a destructive route action. | BH-7.4 |
| `server/src/routes/content.ts:477` | `.catch(() => undefined)` | inspect artwork before streaming | best effort | Failure returns artwork as cache-miss/not found; source media and metadata are unchanged. | BH-4.5 |
| `server/src/routes/content.ts:486` | `.catch(() => undefined)` | refresh changed artwork snapshot | best effort | A failed refresh leaves the old in-memory snapshot uncommitted while the on-disk artwork remains authoritative. | BH-4.5 |
| `server/src/routes/content.ts:501` | `.catch(() => undefined)` | read artwork into snapshot | best effort | Failure produces a cache miss/404 response for derived artwork. | BH-4.5 |
| `server/src/routes/curate.ts:295` | `.catch(() => undefined)` | resolve user library target | needs review | `libraryTarget` errors are collapsed before the route's general 404, so authorization/path failures cannot be distinguished from a missing item in logs or tests. | BH-7.4 |
| `server/src/routes/curate.ts:296` | `.catch(() => undefined)` | stat resolved curation target | needs review | A failed stat becomes `RESOURCE_NOT_FOUND`, hiding permission and storage failures at the authenticated route boundary. | BH-7.4 |
| `server/src/routes/device.ts:72` | `.catch(() => undefined)` | resolve device stream target | needs review | A user-requested device stream turns authorization/path-resolution errors into a generic missing resource. | BH-7.4 |
| `server/src/routes/device.ts:73` | `.catch(() => undefined)` | stat device stream target | needs review | A permission or I/O failure is reported as a missing source before a transfer ticket is created. | BH-7.4 |
| `server/src/routes/downloads.ts:82` | `.catch(() => undefined)` | validate download subfolder | needs review | An unreadable destination is returned as the translated “target folder missing” error, hiding the failed filesystem precondition. | BH-2.2 |
| `server/src/routes/follows.ts:271` | `.catch(() => undefined)` | run immediate follow check | needs review | The follow is acknowledged after this detached check; if it rejects, no episode state or error reaches the user who just followed. | BH-2.3 |
| `server/src/routes/home.ts:335` | `.catch(() => undefined)` | load remote favourites shelf | needs review | A failed remote-library favourites request simply removes that shelf from Home; no error or stale indicator reaches the caller. | BH-5.4 |
| `server/src/routes/home.ts:574` | `.catch(() => undefined)` | observe a losing Home lookup | best effort | The request deadline has already won and the response path no longer consumes the lookup; this catch prevents an unhandled rejection. | BH-5.4 |
| `server/src/routes/libraries.ts:132` | `.catch(() => undefined)` | create generated-artwork directory | needs review | Library creation can return success while its required derived-artwork directory is unavailable; later generation then fails independently. | BH-4.5 |
| `server/src/routes/libraries.ts:158` | `.catch(() => undefined)` | validate folder preview root | needs review | Any stat failure becomes the translated “folder does not exist” response at the path-validation boundary. | BH-7.4 |
| `server/src/routes/libraries.ts:185` | `.catch(() => undefined)` | validate grant candidate | needs review | A permission or I/O failure is represented as a missing grant root, so the user cannot diagnose the failed operation. | BH-7.4 |
| `server/src/routes/libraries.ts:244` | `.catch(() => undefined)` | validate preview library root | needs review | Preview returns the same missing-folder error for unreadable or transiently unavailable storage. | BH-7.4 |
| `server/src/routes/media-servers.ts:451` | `.catch(() => undefined)` | cancel remote artwork after client leaves | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/routes/media-servers.ts:463` | `.catch(() => undefined)` | cancel oversized remote artwork | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-6.2 |
| `server/src/routes/personal.ts:296` | `.catch(() => undefined)` | describe stale personal-library row | needs review | A failed description falls back to a generic key, and the cleanup path can remove progress under an identity the user did not see. | BH-1.1 |
| `server/src/routes/playback.ts:119` | `.catch(() => undefined)` | cancel subtitle source reader | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-3.1 |
| `server/src/routes/playback.ts:251` | `.catch(() => undefined)` | stop revoked playback session | needs review | An ownership/revocation failure triggers stop, but a stop rejection is hidden and may leave the converter or reader running. | BH-3.1 |
| `server/src/routes/playback.ts:358` | `.catch(() => undefined)` | read receiver playlist | needs review | A read failure is returned as HTTP 404, so a user-requested cast cannot distinguish a missing playlist from filesystem I/O failure. | BH-3.2 |
| `server/src/routes/playback.ts:391` | `.catch(() => undefined)` | discard playback body without waiting | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-3.1 |
| `server/src/routes/playback.ts:668` | `.catch(() => undefined)` | cancel upstream after client closes | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-3.1 |
| `server/src/routes/playback.ts:673` | `.catch(() => undefined)` | cancel rejected upstream body | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-3.1 |
| `server/src/routes/playback.ts:718` | `.catch(() => undefined)` | cancel wrong-range upstream body | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-3.1 |
| `server/src/routes/playback.ts:779` | `.catch(() => undefined)` | retry a resumed source read | needs review | A failed resumed fetch is treated like a malformed/short range and may be retried again, hiding the underlying request error. | BH-3.2 |
| `server/src/routes/playback.ts:783` | `.catch(() => undefined)` | cancel invalid resumed response | best effort | Releases a body, reader, transport, agent or handle that is already being abandoned; the path returns or throws its own result, and a rejected release neither keeps the resource nor changes that result. | BH-3.1 |
| `server/src/store.ts:340` | `.catch(() => undefined)` | continue state write chain | best effort | `write` is returned and carries the failure; the caught tail only prevents one failed save from blocking later saves. | BH-1.1 |
| `server/src/walk-cache.ts:28` | `.catch(() => undefined)` | refresh stale walk cache | needs review | A stale result is returned while the background refresh failure has no observer, so repeated refresh failures never reach the caller or visible diagnostic. | BH-4.1 |
| `web/src/App.tsx:266` | `.catch(() => undefined)` | refresh library list | needs review | A failed library load leaves the previous or empty list with no error state, so the shell cannot tell the user that libraries were not refreshed. | BH-9.1 |
| `web/src/App.tsx:313` | `.catch(() => undefined)` | load subtitles for detail playback | needs review | Subtitle failure is discarded while playback continues, leaving the detail panel indistinguishable from a source with no subtitles. | BH-9.1 |
| `web/src/App.tsx:727` | `.catch(() => undefined)` | load search preferences/state | needs review | The search UI keeps its previous state when the settings request fails, and no translated error reaches the user. | BH-9.4 |
| `web/src/App.tsx:739` | `.catch(() => undefined)` | record a committed search | needs review | The optimistic recent-search update remains visible when durable history recording fails, so a reload loses an entry the user saw as saved. | BH-9.4 |
| `web/src/App.tsx:1272` | `.catch(() => undefined)` | load follows and new episodes | needs review | Initial follow state can stay empty after a failed request without an error or retry signal. | BH-9.1 |
| `web/src/App.tsx:1290` | `.catch(() => undefined)` | refresh a newly followed title | needs review | The delayed immediate episode refresh is best effort, but repeated failure leaves the detail looking as though no episodes were discovered. | BH-9.1 |
| `web/src/App.tsx:1426` | `.catch(() => undefined)` | load UI languages | needs review | A failed language-list load can leave language selectors unavailable without surfacing the failed setup request. | BH-9.1 |
| `web/src/App.tsx:1430` | `.catch(() => undefined)` | load searchable addon set | needs review | A failed addon-capability load leaves search availability stale or empty while no request failure reaches the shell. | BH-9.1 |
| `web/src/App.tsx:1436` | `.catch(() => undefined)` | inspect selected stream languages | needs review | Probe failure is indistinguishable from missing language metadata, hiding network/file failures during source selection. | BH-9.1 |
| `web/src/App.tsx:1489` | `.catch(() => undefined)` | load watchlist and follows | needs review | A view can render empty personal data after failure, which the user sees as no saved titles rather than an unavailable request. | BH-9.1 |
| `web/src/App.tsx:1549` | `.catch(() => undefined)` | poll resume/progress entries | needs review | Polling failure leaves stale resume positions with no error state and the next successful poll silently replaces them. | BH-9.1 |
| `web/src/App.tsx:1567` | `.catch(() => undefined)` | prewarm library posters | needs review | A failed browse used for both prewarm and start state is dropped, so the first library view can remain uninitialised without a visible cause. | BH-9.1 |
| `web/src/App.tsx:1832` | `.catch(() => undefined)` | load previous library file | needs review | A failed lookup leaves the previous-file control absent or stale, with the API failure hidden from the player. | BH-9.1 |
| `web/src/App.tsx:1833` | `.catch(() => undefined)` | load next library file | needs review | A failed next-file lookup silently disables or leaves stale episode navigation. | BH-9.1 |
| `web/src/App.tsx:1851` | `.catch(() => undefined)` | load playing-catalogue subtitles | needs review | Subtitle request failure is presented as no subtitles for the playing title. | BH-9.1 |
| `web/src/App.tsx:1907` | `.catch(() => undefined)` | load alternative-source subtitles | needs review | A failed subtitle request leaves the selected alternative source without a visible failure or retry. | BH-9.1 |
| `web/src/App.tsx:2368` | `.catch(() => undefined)` | load local copies for a catalogue detail | needs review | The loading flag clears after failure, leaving an empty local section that looks like a successful no-results answer. | BH-9.1 |
| `web/src/App.tsx:2455` | `.catch(() => undefined)` | observe remote next-episode prefetch | best effort | The original promise is retained for the later consumer; this catch prevents an unhandled rejection while the prefetch is unused. | BH-9.1 |
| `web/src/App.tsx:2461` | `.catch(() => undefined)` | observe catalogue next-episode prefetch | best effort | The prefetch result is consumed later from the stored promise; no current user operation is awaiting this speculative request. | BH-9.1 |
| `web/src/App.tsx:2532` | `.catch(() => undefined)` | load local copies after next catalog episode | needs review | Failure clears the loading indicator and leaves the next-episode local-source list empty, hiding the failed request. | BH-9.1 |
| `web/src/App.tsx:2793` | `.catch(() => undefined)` | load catalogue follow marker | needs review | A failed follow lookup leaves the title looking unfollowed, although the user's durable follow may still exist. | BH-9.1 |
| `web/src/App.tsx:3075` | `.catch(() => undefined)` | observe detail next-episode prefetch | best effort | The promise is stored for a possible future play; this handler only prevents the speculative failure from becoming unhandled. | BH-9.1 |
| `web/src/CatalogueTitleDetail.tsx:215` | `.catch(() => undefined)` | load local copies in title detail | needs review | A failed local-source request leaves an empty local section with no error, so absence and failure are indistinguishable. | BH-11.1 |
| `web/src/FollowDialog.tsx:60` | `.catch(() => undefined)` | load followed episodes | needs review | The dialog can render without episodes after a failed request, indistinguishable from a followed title with no episodes. | BH-9.1 |
| `web/src/FollowDialog.tsx:96` | `.catch(() => undefined)` | refresh follow after create | needs review | Failure leaves dialog state unchanged after the user requested a follow, with no visible retry or failure message. | BH-9.1 |
| `web/src/FollowingPage.tsx:215` | `.catch(() => undefined)` | copy calendar URL | needs review | Clipboard failure prevents the “Copied” notice but gives no error feedback, making a user-requested copy appear inert. | BH-9.4 |
| `web/src/Home.tsx:139` | `.catch(() => undefined)` | run Home card action | needs review | A failed user action only clears its busy state; the user sees the action stop without an error or durable result. | BH-11.1 |
| `web/src/HomeLayoutSettings.tsx:51` | `.catch(() => undefined)` | flush Home layout before unmount | needs review | A last-moment layout change can be lost after the user leaves Settings, with no indication that the preference was not saved. | BH-9.4 |
| `web/src/HomeLayoutSettings.tsx:66` | `.catch(() => undefined)` | save debounced Home layout | needs review | The error handler reports update failures, but failures in the follow-up `load()` inside its fulfilled branch are swallowed by this trailing catch. | BH-9.4 |
| `web/src/HomeLayoutSettings.tsx:77` | `.catch(() => undefined)` | reset Home layout | needs review | A reset can fail visibly through the update handler, but failure while reloading the committed state is hidden and leaves stale controls. | BH-9.4 |
| `web/src/LibraryManager.tsx:303` | `.catch(() => undefined)` | preview a library root | needs review | The estimate remains absent after failure, with no message explaining that the folder could not be read. | BH-11.1 |
| `web/src/LocalLibraryDetail.tsx:199` | `.catch(() => undefined)` | load local progress | needs review | Failure leaves resume state empty or stale, making an unavailable progress store look like a fresh title. | BH-9.1 |
| `web/src/NativeLibrarySaveDialog.tsx:99` | `.catch(() => undefined)` | load series metadata for save dialog | needs review | The loading state ends but the dialog lacks an error state, so failed metadata is shown as a title with no series information. | BH-11.2 |
| `web/src/Player.tsx:542` | `.catch(() => undefined)` | stop playback after media failure | needs review | The player reports its own failure, but a stop rejection can leave a server-side session or conversion running. | BH-10.1 |
| `web/src/Player.tsx:552` | `.catch(() => undefined)` | autoplay direct media | best effort | Autoplay may be refused by browser policy; the video stays paused behind its play control, which is the expected outcome. | BH-10.3 |
| `web/src/Player.tsx:560` | `.catch(() => undefined)` | autoplay parsed HLS manifest | best effort | Autoplay may be refused by browser policy; the video stays paused behind its play control, which is the expected outcome. | BH-10.3 |
| `web/src/Player.tsx:593` | `.catch(() => undefined)` | autoplay native HLS | best effort | Autoplay may be refused by browser policy; the video stays paused behind its play control, which is the expected outcome. | BH-10.3 |
| `web/src/Player.tsx:654` | `.catch(() => undefined)` | stop superseded playback session | needs review | A session created while the component is already disposed is stopped, but failure to stop it is hidden and can keep server work alive. | BH-10.1 |
| `web/src/Player.tsx:691` | `.catch(() => undefined)` | release playback session | needs review | Closing or switching playback reports success locally even if the server did not release the session. | BH-10.1 |
| `web/src/Player.tsx:772` | `.catch(() => undefined)` | autoplay after session switch | best effort | Autoplay may be refused by browser policy; the video stays paused behind its play control, which is the expected outcome. | BH-10.3 |
| `web/src/Player.tsx:790` | `.catch(() => undefined)` | stop started session after failed switch | needs review | Cleanup of a session that lost the source-switch race can fail while the player moves on. | BH-10.1 |
| `web/src/Player.tsx:952` | `.catch(() => undefined)` | report remote playback event | needs review | Start/progress/stop reporting failures are invisible, so remote server state can diverge from local playback. | BH-10.2 |
| `web/src/Player.tsx:981` | `.catch(() => undefined)` | report remote pause transition | needs review | A rejected remote pause report leaves the media server's active state stale without retry or feedback. | BH-10.2 |
| `web/src/Player.tsx:994` | `.catch(() => undefined)` | report remote resume transition | needs review | A rejected remote resume report uses the same ignored path as pause. | BH-10.2 |
| `web/src/Player.tsx:1015` | `.catch(() => undefined)` | save local progress | needs review | Periodic and final saves are silent; the “saved” callback runs only on success but no failure path informs the player or retries. | BH-10.2 |
| `web/src/Player.tsx:1038` | `.catch(() => undefined)` | save remote playback state | needs review | A remote progress write can fail while the local player continues and offers no visible unsaved state. | BH-10.2 |
| `web/src/Player.tsx:1050` | `.catch(() => undefined)` | keep playback session alive | needs review | Heartbeat failure is hidden, allowing the server to expire a session the player still believes is active. | BH-10.2 |
| `web/src/Player.tsx:1067` | `.catch(() => undefined)` | resume video after user toggle | best effort | Autoplay may be refused by browser policy; the video stays paused behind its play control, which is the expected outcome. | BH-10.3 |
| `web/src/RemoteLibraryBrowser.tsx:584` | `.catch(() => undefined)` | load remote detail metadata | needs review | The remote browser keeps a partial detail after failure without exposing that metadata could not be refreshed. | BH-11.1 |
| `web/src/RemoteLibraryBrowser.tsx:737` | `.catch(() => undefined)` | load parent series for a remote item | needs review | A failed parent lookup only clears that optional request; the nested item remains without a visible missing-series state. | BH-11.1 |
| `web/src/RemoteLibraryBrowser.tsx:1080` | `.catch(() => undefined)` | forget addon progress after marking unwatched | needs review | The watched mutation is reported first, then progress cleanup failure is hidden, so durable progress can remain after the UI says it was cleared. | BH-9.4 |
| `web/src/RemoteLibraryBrowser.tsx:1233` | `.catch(() => undefined)` | load addon resume state | needs review | Failure leaves resume controls empty or stale with no distinction from missing progress. | BH-11.1 |
| `web/src/RemoteLibraryBrowser.tsx:1250` | `.catch(() => undefined)` | load subtitles for a playing addon source | needs review | Subtitle failure appears as an addon source with no subtitles. | BH-11.1 |
| `web/src/RemoteLibraryBrowser.tsx:1312` | `.catch(() => undefined)` | refresh addon subtitles | needs review | A user-triggered subtitle refresh can fail without clearing the stale list or reporting the failure. | BH-11.1 |
| `web/src/SearchSettings.tsx:11` | `.catch(() => undefined)` | reload search settings | needs review | Both a failed search-state request and a failed post-save reload end with no error, despite the component having an error callback. | BH-9.4 |
| `web/src/SeriesDownloadDialog.tsx:117` | `.catch(() => undefined)` | load remembered follow defaults | best effort | Failure leaves the dialog's safe initial defaults; these remembered choices do not alter the follow until submit. | BH-11.2 |
| `web/src/SeriesDownloadDialog.tsx:189` | `.catch(() => undefined)` | remember notify-mode follow choice | best effort | The follow itself has succeeded, and the source comment explicitly treats remembering the mode as a non-blocking courtesy. | BH-11.2 |
| `web/src/SeriesDownloadDialog.tsx:230` | `.catch(() => undefined)` | remember download-mode choices | best effort | The follow or download request has completed before this detached preference save; the known failure only loses the next dialog's prefilled values. | BH-11.2 |
| `web/src/api.ts:105` | `.catch(() => undefined)` | delete catalogue search session on unload | needs review | A keepalive cleanup can fail after the page is gone, leaving server search work and session state to expire without notice. | BH-9.4 |
| `web/src/api.ts:114` | `.catch(() => undefined)` | delete everywhere-search session on unload | needs review | The unload cleanup result is discarded, so abandoned server search sessions can survive their initiating page. | BH-9.4 |
| `web/src/api.ts:242` | `.catch(() => undefined)` | stop playback on unload | needs review | The keepalive stop is the last opportunity to end a conversion/read; its failure is hidden after navigation. | BH-10.1 |
| `web/src/api.ts:245` | `.catch(() => undefined)` | save progress on unload | needs review | Final resume progress is user-visible durable state, but a keepalive write failure is swallowed during page exit. | BH-10.2 |
| `web/src/api.ts:379` | `.catch(() => undefined)` | save remote state on unload | needs review | Final remote resume state can fail during unload with no retry or surviving acknowledgement. | BH-10.2 |
| `web/src/api.ts:385` | `.catch(() => undefined)` | report remote playback stop on unload | needs review | A failed final playing-state update leaves remote session state stale after the browser page closes. | BH-10.2 |
| `web/src/desktop/preview.ts:86` | `.catch(() => undefined)` | copy text in desktop preview | needs review | The preview's copy control swallows clipboard rejection and can appear successful when nothing was copied. | BH-9.4 |
| `web/src/diagnostics.ts:27` | `.catch(() => undefined)` | send diagnostic report | best effort | Diagnostics must not recurse into or fail the code path being diagnosed; a failed optional report does not change application state. | BH-8.2 |
| `web/src/library-preload.ts:65` | `.catch(() => undefined)` | preload a poster | best effort | This speculative image warmup has no consumer state; its failure only leaves the normal image request to run later. | BH-9.1 |
| `web/src/player-sidecar.ts:40` | `.catch(() => undefined)` | poll for a player sidecar | needs review | A rejected poll becomes the same result as a missing/not-ready subtitle, leaving playback with no diagnostic for network or server failure. | BH-10.3 |
| `web/src/player-sidecar.ts:44` | `.catch(() => undefined)` | discard duplicate sidecar body | best effort | The element fetches the track separately and this copy is intentionally unused; cancellation cannot affect the delivered subtitle. | BH-10.1 |
| `web/src/remote-mosaic.tsx:112` | `.catch(() => undefined)` | load a mosaic preview | best effort | Failure clears or leaves the optional preview while the underlying library artwork and media remain usable. | BH-4.5 |
| `web/src/title-enrichment.ts:62` | `.catch(() => undefined)` | publish enriched title metadata | needs review | The shared request keeps running for other subscribers, but this subscriber gets no error or fallback state when enrichment fails. | BH-9.1 |

## Needs-review candidates

There are 129 candidates: 29 P0, 97 P1 and 3 P2. Priority reflects the
potential consequence in the current caller, not confidence that a defect has
been reproduced. Each row's scenario is a focused starting point for its
owning unit.

### P0

These candidates can hide authentication/session cleanup, atomic publication,
destructive filesystem preconditions, or a store's settlement contract.

| Owning unit | Priority | File:line references | Candidate scenario to reproduce |
| --- | --- | --- | --- |
| BH-1.1 | P0 | `server/src/library-ops.ts:232`, `server/src/library-ops.ts:233` | Reject the operation pump or journal save, then call `settled()` and check whether a caller can proceed to move/remove data as if all side effects were complete. |
| BH-2.2 | P0 | `server/src/download-selection.ts:167`, `server/src/downloads.ts:546`, `server/src/downloads.ts:1187`, `server/src/downloads.ts:1189`, `server/src/downloads.ts:1526`, `server/src/downloads.ts:1559`, `server/src/downloads.ts:1652`, `server/src/downloads.ts:1853`, `server/src/downloads.ts:2005`, `server/src/downloads.ts:2015`, `server/src/downloads.ts:2034`, `server/src/downloads.ts:2036`, `server/src/routes/downloads.ts:82` | Inject partial cleanup, reservation stat, rollback and destination-stat failures around a retry/failover, and verify that `.part` bytes cannot be silently reused or a destination precondition turned into a harmless “missing” response. |
| BH-4.4 | P0 | `server/src/index.ts:2087`, `server/src/library-actions.ts:226`, `server/src/library-actions.ts:374`, `server/src/library-actions.ts:385`, `server/src/library-transfer.ts:97`, `server/src/library-transfer.ts:130`, `server/src/library-transfer.ts:133`, `server/src/library-transfer.ts:137`, `server/src/library-transfer.ts:139`, `server/src/library-transfer.ts:151` | Make a source, destination or reservation lookup fail with `EACCES`/`EIO` during a destructive action and check that the caller does not receive “missing” or proceed with an unreleased placeholder. |
| BH-12.3 | P0 | `desktop/src/main.ts:1263`, `desktop/src/main.ts:1264`, `desktop/src/main.ts:1266`, `desktop/src/main.ts:1268` | Inject session-clear, unlink and profile-write failures into local reset; restart and verify that a reported successful reset did not retain authentication, profiles or state files. |

### P1

These candidates affect user-requested operations, durable playback/state
records, destructive recovery, process or stream cleanup, or visible failures
that currently become empty/stale UI.

| Owning unit | Priority | File:line references | Candidate scenario to reproduce |
| --- | --- | --- | --- |
| BH-1.1 | P1 | `server/src/library-meta-store.ts:87`, `server/src/library-migrate.ts:263`, `server/src/routes/personal.ts:296` | Make a metadata/downloads read or stale-path description fail, then check whether migration deletes queued artwork, metadata starts invisibly incomplete, or progress is removed under a generic key. |
| BH-2.3 | P1 | `server/src/routes/follows.ts:271` | Reject the immediate follow check and verify that the 201 follow response leaves a visible durable check failure rather than an empty episode list. |
| BH-3.1 | P1 | `server/src/index.ts:1018`, `server/src/playback.ts:603`, `server/src/routes/playback.ts:251` | Reject the session stop during inspection, revocation and client disconnect; verify that no converter outlives its session. |
| BH-3.2 | P1 | `server/src/routes/playback.ts:358`, `server/src/routes/playback.ts:779` | Make playlist read fail or a resumed fetch reject; check that the response does not call a real read/network failure “not found” and that retry classification is observable. |
| BH-4.1 | P1 | `server/src/library-admin.ts:82`, `server/src/walk-cache.ts:28` | Fail root stat during library creation and stale walk refresh; check that an unreadable mount is not registered as absent and stale scans expose persistent refresh failure. |
| BH-4.5 | P1 | `server/src/index.ts:1310`, `server/src/routes/libraries.ts:132` | Fail artwork stat and generated-art directory creation; check for a misleading stamp and library success without a writable artwork directory. |
| BH-7.4 | P1 | `server/src/index.ts:554`, `server/src/routes/content.ts:261`, `server/src/routes/content.ts:280`, `server/src/routes/curate.ts:295`, `server/src/routes/curate.ts:296`, `server/src/routes/device.ts:72`, `server/src/routes/device.ts:73`, `server/src/routes/libraries.ts:158`, `server/src/routes/libraries.ts:185`, `server/src/routes/libraries.ts:244` | Make `realpath`/`stat` fail with `EACCES`/`EIO` on a path the route already authorized and check that the response reports a permission or I/O failure instead of a missing resource. |
| BH-9.1 | P1 | `web/src/App.tsx:266`, `web/src/App.tsx:313`, `web/src/App.tsx:1272`, `web/src/App.tsx:1290`, `web/src/App.tsx:1426`, `web/src/App.tsx:1430`, `web/src/App.tsx:1436`, `web/src/App.tsx:1489`, `web/src/App.tsx:1549`, `web/src/App.tsx:1567`, `web/src/App.tsx:1832`, `web/src/App.tsx:1833`, `web/src/App.tsx:1851`, `web/src/App.tsx:1907`, `web/src/App.tsx:2368`, `web/src/App.tsx:2532`, `web/src/App.tsx:2793`, `web/src/FollowDialog.tsx:60`, `web/src/FollowDialog.tsx:96`, `web/src/LocalLibraryDetail.tsx:199`, `web/src/title-enrichment.ts:62` | Reject each initial/detail/poll request once and verify that the UI has an error/retry state instead of presenting an empty list, stale follow or source with no subtitles. |
| BH-9.4 | P1 | `web/src/App.tsx:727`, `web/src/App.tsx:739`, `web/src/FollowingPage.tsx:215`, `web/src/HomeLayoutSettings.tsx:51`, `web/src/HomeLayoutSettings.tsx:66`, `web/src/HomeLayoutSettings.tsx:77`, `web/src/RemoteLibraryBrowser.tsx:1080`, `web/src/SearchSettings.tsx:11`, `web/src/api.ts:105`, `web/src/api.ts:114`, `web/src/desktop/preview.ts:86` | Reject search-history/settings writes, clipboard copy, progress forgetting and unload session deletes; verify no optimistic state is left looking durably committed and every user-requested operation has feedback. |
| BH-10.1 | P1 | `web/src/Player.tsx:542`, `web/src/Player.tsx:654`, `web/src/Player.tsx:691`, `web/src/Player.tsx:790`, `web/src/api.ts:242` | Reject every playback stop/cleanup request while closing, switching or racing a source creation; verify the server session and conversion do not outlive the player. |
| BH-10.2 | P1 | `web/src/Player.tsx:952`, `web/src/Player.tsx:981`, `web/src/Player.tsx:994`, `web/src/Player.tsx:1015`, `web/src/Player.tsx:1038`, `web/src/Player.tsx:1050`, `web/src/api.ts:245`, `web/src/api.ts:379`, `web/src/api.ts:385` | Reject progress, remote-state, playing-event and heartbeat writes during play and unload; verify resume data is not silently lost and a stale remote session has a visible or retryable outcome. |
| BH-10.3 | P1 | `web/src/player-sidecar.ts:40` | Reject sidecar polling; verify that sidecar unavailability is distinguishable from a sidecar that is still being written. |
| BH-11.1 | P1 | `web/src/CatalogueTitleDetail.tsx:215`, `web/src/Home.tsx:139`, `web/src/LibraryManager.tsx:303`, `web/src/RemoteLibraryBrowser.tsx:584`, `web/src/RemoteLibraryBrowser.tsx:737`, `web/src/RemoteLibraryBrowser.tsx:1233`, `web/src/RemoteLibraryBrowser.tsx:1250`, `web/src/RemoteLibraryBrowser.tsx:1312` | Reject detail/source/progress/action requests and verify that failed user actions, metadata and subtitles do not become an indistinguishable successful empty state. |
| BH-12.1 | P1 | `desktop/src/local-backend.ts:450`, `desktop/src/main.ts:487`, `desktop/src/main.ts:725`, `desktop/src/main.ts:1291`, `desktop/src/main.ts:1294`, `desktop/src/main.ts:1395`, `desktop/src/main.ts:1733`, `desktop/src/main.ts:1766`, `desktop/src/settings-window.ts:109` | Reject backend start/stop, repoll, dialogs, external update open, autostart refresh and renderer load; verify the desktop shell reports the failure and does not leave a hidden process or blank window. |
| BH-12.2 | P1 | `desktop/src/main.ts:280`, `desktop/src/main.ts:610` | Reject `shell.openExternal` for the project and denied-navigation fallback; verify the user receives feedback rather than an inert navigation or click. |
| BH-12.3 | P1 | `desktop/src/main.ts:794`, `desktop/src/main.ts:818`, `desktop/src/main.ts:1047`, `desktop/src/main.ts:1105`, `desktop/src/main.ts:1341`, `desktop/src/main.ts:1493`, `desktop/src/main.ts:1782`, `desktop/src/settings-window.ts:100` | Fail startup-choice, tray/window preference and ownership writes, then restart; verify the UI does not acknowledge in-memory settings that will revert or conflict with durable files. |

### P2

These candidates affect optional remote content or remembered defaults, but
their current loss can still make an optional surface look successfully empty.

| Owning unit | Priority | File:line references | Candidate scenario to reproduce |
| --- | --- | --- | --- |
| BH-5.4 | P2 | `server/src/routes/home.ts:335` | Reject remote favourites and check whether Home identifies the missing shelf as unavailable rather than simply absent. |
| BH-8.2 | P2 | `server/src/index.ts:1047` | Repeatedly reject stale library-health refresh and verify that the background failure is observable rather than disappearing after every read. |
| BH-11.2 | P2 | `web/src/NativeLibrarySaveDialog.tsx:99` | Reject series metadata and verify that the dialog clears pending state without presenting missing metadata as an empty successful answer. |

### Risk highlights

- **Authentication/session cleanup:** `desktop/src/main.ts:1263` and
  `desktop/src/main.ts:1268` can return success before local/profile session
  data is cleared.
- **Path checks:** BH-7.4 candidates report a permission or I/O failure on an
  already authorized path as a missing resource.
- **Atomicity and persistence:** BH-2.2 download cleanup/reservation catches,
  BH-1.1 settlement catches and desktop BH-12.3 persistence catches can leave
  memory or user-visible state ahead of durable state.
- **Process cleanup:** BH-3.1 and BH-10.1 candidates suppress a session or
  converter stop, so a converter can outlive the player that started it.
- **User-requested operations:** the P1 web clipboard, Home action, source
  loading, playback progress, remote reporting and desktop external-link
  candidates can fail after the UI has accepted the request.
