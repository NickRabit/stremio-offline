# Jellyfin and Emby request audit

Measured against application 0.5.76 (main d4d2c9eb), 2026-10-15. The production
8090 instance retained its own data and configuration. Navigation was read-only;
no provider playback/history mutation was performed. Separate generated fixtures
are used for fault injection and large-catalogue verification.

## Measurement boundaries

The application counts requests actually dispatched to providers in
`data/provider-stats.json`. Local cache hits are excluded. Counters are global,
persist on a one-second timer, and cannot correlate an originating browser route
or item. Background clients and delayed requests can cross stage boundaries.
The observations below therefore distinguish direct measurements from verified
code-path costs. They do not count browser-to-app requests as upstream traffic.
Images were already warm in the persistent cache; these are not cold-cache image
benchmarks. Addon calls and media byte ranges are separate from provider metadata.

## Observed normal navigation

| Action | Observed upstream work | Interpretation |
| --- | --- | --- |
| Library overview, three remote mosaics | 3 Directory, one shared Info/User/Views refresh | One bounded preview list per visible remote library on a preview-cache miss. |
| XXX root | 2 Directory | Folder listing plus visible preview work; not a catalogue-wide scan. |
| XXX first content page | 1 Directory | 60 rendered items, no per-tile Detail or PlaybackInfo. |
| XXX next page | 1 Directory | 120 accumulated items; no per-tile Detail or PlaybackInfo. |
| XXX detail and rapid reopen | 3 Detail + 1 PlaybackInfo on each open | Same metadata is fetched through three independent application routes. An additional delayed Detail was observed but cannot be attributed using global counters alone. |
| Film detail | 3 Detail + 1 PlaybackInfo | Same core cost as XXX despite already browsing the item. |
| Film source chooser | 2 Match | Other permitted libraries are searched only when the chooser opens. Addon requests are additional and were not counted by these provider counters. |
| Back to XXX listing | All 120 rows retained | No Directory refetch. A delayed unassigned Detail appeared in the counter window. |

Info/User/Views refreshes appeared between longer steps. Their 30-second TTL means
they must not all be attributed to the immediately preceding click. Repeat
measurements should correlate route, item and in-flight completion timestamps to
explain the unassigned Detail rather than guessing its source.

## Confirmed amplification

### Detail and locally stored progress

`RemoteLibraryBrowser` opens item, sources and personal-state routes concurrently.
Item reads Detail; sources read Detail plus PlaybackInfo; personal state reads
Detail again. The stable warm baseline is therefore **three Detail and one
PlaybackInfo**, not four Detail calls.

A progress PATCH with a selected media-source ID also resolves Detail, then reads
Detail plus PlaybackInfo to validate the version. The player saves progress every
10 seconds: this code path can therefore generate **18 metadata requests per
minute per playing item**, before periodic authorization and byte requests. This
is a code-derived rate, not a timed playback measurement on the user's library.
The progress itself is stored only in this application. A subsequent disposable
real-provider run measured one warm progress PATCH on each provider: both made
two Detail and one PlaybackInfo request, confirming the per-save cost above.

### Preparation and subtitles

Playback/inspection authorize the original before and after preparation. Each
forced original check reads Detail, Ancestors and PlaybackInfo; the two checks
therefore cost six metadata requests per preparation, before cold session facts,
probing and media bytes. The existing 30-second original proof is used for byte
opens, but these explicit checks bypass it.

Subtitle reads likewise validate Detail, Ancestors and PlaybackInfo before reading
the subtitle. Repeated subtitle timing variants can repeat that work.

## Existing caches and request bounds

| Mechanism | Current bound and behavior |
| --- | --- |
| Session facts | 30 seconds; identity, account policy and library Views; concurrent misses coalesce. |
| Membership proof | 5 minutes, maximum 8192 entries; actor/library/connection/generation/secret/item scoped. Contains membership and artwork facts, not reusable full metadata. |
| Original proof | 30 seconds, maximum 256 entries; exact media-source identity included. Explicit revalidation bypasses it. |
| Preview pages | 5 minutes, maximum 128; library/type, parent, own-versus-children preference, connection/generation/secret-reference scoped. |
| Image bytes | Default 512 MiB disk and 128 MiB memory, maximum 5 MiB per image; tag/role/size keys and shared in-flight reads. No time TTL. |
| Browser image cache | Private one-year max-age; URLs matching the current membership image tag are immutable; older/nonmatching tags retain max-age. Local ETag support. |
| Composed mosaics | Default 128 MiB disk and 32 MiB memory; source-image versions in key; composition coalesces. |
| Playback inspection | Successful video metadata for 10 minutes; in-flight dedupe; The map can reach 201 entries; a subsequent inspection completion clears it when the existing size exceeds 200. |
| Metadata transport | Four active manager calls globally, starts spaced by 125 ms per connection, bounded 128-waiter queues. Byte and artwork pools are separate. |
| Source chooser | At most two addon and two remote-library match calls concurrently; successful groups retained within mounted title scope. |
| Browser mosaic memory | Map and session storage without explicit TTL/cap; remount still asks for preview. |

## Recommended next changes

1. Share raw successful Detail and PlaybackInfo reads across ordinary item,
   sources and personal-state routes. Use a 30-second, actor/library/account/
   connection/generation/secret/item-scoped cache and shared in-flight work.
   Retain live local permission checks before and after awaits. Do not cache an
   authorization decision or projected destination/library settings.
2. Bound the combined metadata cache by 256 entries and 8 MiB, clone payloads,
   do not extend expiry on hits, and cache no errors. A canceled subscriber must
   not cancel another subscriber; cancel upstream when the last subscriber leaves.
3. Keep matching, download admission and scheduled original checks fresh first.
   Separately consider reusing a successful proof within one playback preparation.
4. Coalesce/cache raw subtitle bytes before applying offsets locally. Preserve
   exact version/index and current resource-access checks.
5. Bound browser mosaic/visited-tile memory for long browsing sessions. The DOM
   currently grows with loaded pages; it is not virtualized.

The first optimization should reduce a warm concurrent detail open to **one Detail
plus one PlaybackInfo**, and ordinary cache-eligible repeat opens/progress saves within the unexpired 30-second window to zero
additional Detail/PlaybackInfo reads. These are proposed acceptance criteria,
not results already achieved.

## Code references

- `web/src/RemoteLibraryBrowser.tsx`: detail, source and personal-state effects.
- `web/src/Player.tsx`: periodic progress saves.
- `server/src/media-server-personal.ts`: `resolve` and exact-version validation.
- `server/src/media-server-manager.ts`: `verifiedDetail`, `versionsUnder`,
  `revalidateOriginal`, `readSubtitle`, session facts and proofs.
- `server/src/routes/playback.ts`: authorization around inspect/start.
- `server/src/provider-stats.ts`: wire counter semantics and flush timer.
