# Image cache maintenance: implementation handoff

Status: proposed implementation, not shipped. Validated on 2026-10-04 against
`origin/main` at `fc15054`. Recheck the latest main before implementing; the
checkout used in the original review was older. Follow `AGENTS.md`.

## Objective

Make image storage maintenance run without browsing or new image downloads,
account for actual generated artwork on disk, and retire unused proxy mappings
without breaking persisted references. Preserve library removal semantics and
protect artwork when filesystem observations are incomplete.

## Validated findings and corrections

| Finding | Assessment and source |
| --- | --- |
| Two separate caches | Confirmed: `ImageProxy` in `server/src/images.ts` and `ArtworkCache` in `server/src/artwork-cache.ts`. Defaults are 512 MiB and 256 MiB. Both evict least recently used bytes to 80% of the cap after writes. |
| Generated artwork orphan detection | Covers `ART_VARIANTS`, folder ancestors, queued download keys, and a one-hour freshness guard. Disabled, unreachable, or unreadable roots are skipped. See `sweepArtwork` in `server/src/index.ts`. |
| Removing a library deletes its artwork | Only with `forget=1`. Removing without forgetting deliberately retains artwork and metadata for reattachment. Preserve this distinction (`server/src/routes/libraries.ts`). |
| Deletion updates byte accounting | `removeArtwork` calls `artworks.removed`; library forgetting calls `removedTree`. Deleting a folder does not immediately enumerate every hashed descendant thumbnail; the sweep remains necessary. |
| Orphan sweep is periodic | False. It is requested by non-prewarm `GET /api/library/browse`, throttled to once per ten minutes. There is no independent maintenance timer. |
| Empty libraries get cleaned | False on reviewed main: `if (!own.length) continue` protects against stale/unavailable scan results but also leaves old thumbnails after the last video is removed externally. |
| Root readability guarantees a complete scan | False. `walkVideos`/`listVideos` in `server/src/library.ts` can turn nested read failures into empty results. A nonempty partial scan can therefore falsely classify live artwork as orphaned. This is a code-path risk; no production data loss was reproduced. |
| Proxy TTL defaults to disabled | Confirmed (`IMAGE_CACHE_TTL_DAYS=0`), a reasonable policy to preserve. When enabled, TTL eviction currently runs only after a successful new image download, not on a timer or load. |
| Proxy index only grows | Confirmed. Eviction removes bytes, preserving `{url, at}` forever. Even rewriting catalogue metadata registers mappings for images never fetched. The byte limit does not bound this index or its memory usage. |
| Proxy age means last display | Not exactly: `proxied()` refreshes `at` when a URL is emitted, and fetching cached bytes refreshes it too. Metadata use therefore extends retention even without a displayed image. |
| Proxy startup removes unknown files | Confirmed: `ImageProxy.load()` removes files not represented by its index. |
| Artwork cap accounts for every file | False. `ArtworkCache.load()` only visits index entries, and trusts a nonzero recorded size. Valid unindexed thumbnails left by a crash can remain outside accounting until served or rewritten. An orphan sweep will intentionally retain them while their media exists. |

The existing 29 image/artwork-cache unit tests passed in the original checkout.
That result covers existing behavior, not the new maintenance cases below.

## Required behavior

### 1. Independent, bounded maintenance

- Expose testable maintenance methods instead of invoking private eviction logic
  indirectly through a download or thumbnail write.
- Schedule one background pass after stores, caches, libraries, and download
  state are initialized, then every six hours. Use an unreferenced timer and
  explicit shutdown cleanup; do not block server readiness on a media-tree walk.
- Keep write-triggered cap enforcement. Browse-triggered cleanup may remain,
  but all triggers must share the same non-overlapping maintenance path.
- Run proxy TTL and size enforcement even if no new image has been downloaded.
  Enforce lowered limits after restart as well.
- Catch background failures, log a concise English diagnostic, and allow the
  next pass to retry. One failing library must not prevent other libraries or
  the proxy cache from being maintained. Do not leave rejected promises unhandled.
- Coordinate eviction, index persistence, downloads, generated artwork writes,
  moves, and shutdown flushes. Recheck deletion candidates after awaits so a
  newly used or replaced entry is not removed using an old snapshot. Skip active
  transfers and never return a just-downloaded path already removed by eviction.
- Do not launch metadata matching or artwork generation merely to clean caches.

### 2. Safe orphan detection, including an empty library

- Obtain an authoritative scan for deletion, with an explicit complete/incomplete
  outcome. A cached browse list without completeness information is insufficient.
- A successfully scanned empty library must have its old orphan thumbnails
  removed. An unreadable root, failed nested directory read, traversal truncation,
  or interrupted scan must never be treated as proof of absence. Conservatively
  skip orphan deletion for the affected library when completeness is uncertain.
- Preserve nested-library exclusions, all artwork variants, folder ancestors,
  queued download keys, and the one-hour file freshness guard. Keep the existing
  unavailable/disabled-library protections and read-only-library support.
- Use existing shared walk facilities where practical, but do not make a
  best-effort browsing result authoritative for deletion. Coordinate with library
  mutations so moving media cannot create false orphans during a sweep.
- Keep orphan removal distinct from cap eviction: a configured cache limit may
  still evict reproducible cached bytes, regardless of media availability.
- Removing a library without forgetting must retain its data as today. Do not
  add a separate policy that deletes departed-library directories merely because
  they are absent from the current library list. Forgetting must still remove
  the directory and matching index entries.
- Never apply cache cleanup to sidecar artwork beside media files.

### 3. Reconcile generated artwork with disk

- At load, discover recognized generated thumbnail files under the managed
  cache directories, including files missing from the index. Count their actual
  sizes; restore an age from a valid stored timestamp or filesystem mtime.
- Drop stale index records for missing files, repair invalid sizes, persist the
  reconciled index, and enforce the configured byte limit.
- Recover safely from a missing or malformed index without deleting valid
  thumbnails just because their index record was lost.
- Stay within the cache root, do not follow symlinks into media or other paths,
  and do not mistake temporary files or arbitrary files for generated thumbnails.
- The byte ceiling applies to recognized generated image files, not index JSON
  overhead. Document that distinction rather than promising an exact directory
  size ceiling.

### 4. Retire unused proxy mappings safely

- Add `IMAGE_CACHE_INDEX_TTL_DAYS`, default 90; `0` disables mapping expiration.
  Keep `IMAGE_CACHE_TTL_DAYS=0` as the default for cached image bytes. These are
  separate policies: one expires source mappings, the other expires image data.
- A mapping is eligible only if it has no cached bytes, has not been used for
  the configured interval, is not in flight, and is not referenced by retained
  application state. Never evict mappings solely to meet the byte cap.
- Before implementation, audit persisted and long-lived references: all users'
  watchlists, progress and watched markers, download state, library metadata,
  retained departed-library data, addon metadata caches, and backup/restore paths.
  Record which fields contain original URLs and which can hold `/api/image/<id>`.
  Preserve mappings needed by stored IDs, or normalize those fields to original
  URLs while the mapping is still available. An unavailable reference source
  must make mapping pruning conservative, not imply that nothing references it.
- Continue treating metadata emission through `proxied()` and direct serving as
  use. An image ID supplied alone must also refresh its mapping when emitted
  from supported application state, or be protected by the reference set.
- Expiration introduces a bounded lifetime for client-only IDs. A page left idle
  beyond the retention period may need to refresh metadata; document this
  explicitly. Retained application records must continue working after restart.
  Setting index TTL to 0 retains the previous indefinite mapping behavior.
- Requesting a forgotten ID must fail cleanly. Rewriting its original URL later
  must recreate the same deterministic ID and allow downloading it again.
- Do not claim a strict index-size ceiling: actively used or referenced mappings
  are deliberately retained. The goal is to collect expired unreferenced entries.

### 5. Documentation

Update `.env.example` and `docs/configuration.md` with separate byte and mapping
TTL semantics, defaults, maintenance timing, and the client-only link lifetime.
Explain that TTL 0 is intentional; operators who prefer age-based byte cleanup
can choose a positive value such as 30 days, at the cost of later refetching.
Correct the library deletion description to distinguish removal from forgetting.
No settings UI is required.

## Required regression coverage

Use injected time, explicit maintenance calls, and controlled filesystem/fetch
barriers rather than real multi-hour waits. Test observable files, requests, and
state, not just internal method calls.

1. Proxy TTL removes old bytes without any new download; TTL 0 retains them under
   the cap; both emission and serving refresh usage.
2. A lowered cap is enforced after load; both caches retain their 80% eviction
   target and can subsequently serve or regenerate the requested artwork.
3. Old unreferenced byte-less mappings are removed, recent/referenced/in-flight
   mappings survive, index TTL 0 disables pruning, and pruning survives restart.
4. A persisted ID remains usable after maintenance and restart. Expired
   client-only IDs fail cleanly and are recreated from the original URL.
5. Missing/corrupt artwork index, unindexed valid files, incorrect stored sizes,
   missing files, temporary files, and symlinks reconcile without touching media.
6. External deletion of the last video cleans an authoritatively empty library;
   unavailable roots and partial scans of otherwise nonempty libraries retain
   artwork. Include a nested directory read failure and a stale cached listing.
7. Queue entries, fresh files, all variants, ancestor folders, nested-library
   boundaries, and read-only libraries preserve the intended sweep behavior.
8. Removing with and without forgetting preserves the different contracts.
9. Overlapping timer/browse/write triggers, concurrent fetch/eviction, a file
   replacement during cleanup, a failed deletion, and shutdown during maintenance
   do not corrupt accounting or persistence; later maintenance can retry.
10. The scheduled path runs without HTTP browse requests, does not overlap itself,
    and stops cleanly without holding the process open.

## Delivery requirements for the implementing agent

Create a fresh task branch from current main and preserve unrelated local work.
Implement the behavior above, review the final diff, and run `npm test` and
`npm run build`. Run `npm run test:e2e:docker` for affected image/library flows;
perform any visual verification only after functional checks are stable.

Bump the patch version consistently in the four package files. Rebase onto
current `origin/main`, resolve conflicts, and rerun relevant checks. Deploy with
`docker compose up -d --build`, verify `docker compose ps`, inspect
`docker compose logs --tail=50 stremio-offline`, and confirm `/api/status` reports
`status: ok` on the configured local port. Push the task branch and open a PR
targeting main; do not merge it. Report results and any remaining limitations.

This handoff itself is documentation only: it does not implement the fix or
require a version bump or container redeployment.
