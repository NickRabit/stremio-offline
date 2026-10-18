# Media-server management and authorized metadata

Status: the server side of the feature is complete. An administrator connects a
Jellyfin or Emby account, attaches its libraries and grants them to accounts. A
granted member browses the remote metadata, plays the original files, keeps
their own progress, artwork and external subtitles, and sees their own remote
cards on Home and Continue watching. The filesystem libraries, the scanner and
every existing consumer are unchanged.

This document is the operator- and reviewer-facing contract for the code in
`server/src/media-server-*.ts`, its routes under `server/src/routes/`, and the
foundation modules they build on ([MS-1](media-server-foundation.md)). Client
work is documented where that client lives; nothing here promises a release or
interface gate this server does not itself enforce.

## What an administrator gets

All administration is `POST`/`PATCH`/`DELETE` under `/api/media-servers`, behind
the ordinary sign-in, password-change and restricted-mode gates, and is
administrator-only in the route table itself. In restricted mode the admin reads
below are refused as well, because they name remote addresses and account ids;
the member metadata stays readable. The restricted-mode tables match the path the router actually matched —
case-insensitively and with a single optional trailing slash, never decoding or
collapsing interior slashes — so `/api/Media-Servers/` or
`/api/media-servers/export/` cannot slip past a rule. Member role rules require
the canonical lower-case path without a trailing slash; variants fail closed.

| Method and path | Effect |
| --- | --- |
| `GET /api/media-servers` | `{ connections: [...], keyConfigured }`. Each connection is the admin projection plus a runtime `status` (`disabled`, `available`, `unavailable`, `reauthentication-required`, `identity-changed`). `keyConfigured` only says a key path was supplied, never that it is readable. |
| `POST /api/media-servers` | Creates a connection from exactly `provider`, `name`, `baseUrl`, `allowLan`, `allowLoopback`, `username`, `password`. Any other field is refused before any network call. |
| `PATCH /api/media-servers/:id` | Changes only `name` and `enabled`. A rename changes nothing derived, so it neither bumps the generation nor throws away live work; toggling `enabled` bumps the generation, cancels staged scans and moves the permission stamp of every ordinary account granted one of its libraries. |
| `DELETE /api/media-servers/:id` | Removes the connection and its attached libraries and queues its token file for deletion. Its stored history is kept invisibly for 30 days; `?forget=true` deletes it at once. Once the removal is saved, its token is logged out upstream (`POST /Sessions/Logout`, best effort, at most 5 s) so the server session stops counting against the account's session limit. |
| `POST /api/media-servers/:id/reauthenticate` | Signs in again with `{ username, password }`; requires the same verified server/account identity. Nothing is logged out: the login reuses the connection's DeviceId, so the server replaces that device's session itself (Emby would end the new token together with the old one). A failed create and a settings restore log out the tokens they abandon; an additive configuration import abandons none. |
| `GET /api/media-servers/:id/libraries` | `{ items: ProviderLibrary[] }` — the libraries the stored account can currently see. |
| `POST /api/media-servers/:id/libraries` | Attaches one remote library from `{ remoteId, name?, order?, showOnHome?, showInContinueWatching?, showInFavorites?, browseMode?, mosaic? }`; the remote name and type come from verified discovery. New libraries are granted to nobody. |
| `PATCH /api/remote-libraries/:id` | Local configuration only: `name`, `enabled`, `order`, `showOnHome`, `showInContinueWatching`, `showInFavorites`, `browseMode`, `mosaic`, `allowedUsers`, `downloadLibraryId`, `downloadSettings`. `root`, `writeArtwork`, `type`, `remoteId`, `connectionId` and any download flag are refused. |
| `DELETE /api/remote-libraries/:id` | Removes the local attachment. Its stored history is kept invisibly for 30 days; `?forget=true` deletes it at once. The remote server is never mutated. |
| `GET /api/media-servers/export` | The metadata-only configuration export (`version`, connections, libraries). No secret references, grants, generations or timestamps. |
| `POST /api/media-servers/import` | Additively restores an export: fresh handles, connections and libraries land **disabled** with no grants and no secrets, and a duplicate remote account refuses the whole batch. Its own body parser allows up to 8 MiB, above the ordinary 256 KiB. |

Only the exact import path gets that larger parser: a path that merely starts with
it keeps the ordinary 256 KiB ceiling. `GET` handlers take no body and no query
unless their contract names one, and reject either before any network call.

Both removals take no body and one optional query, `forget`, whose only accepted
values are the exact strings `true` and `false`. Anything else — an array, a
nested key, another field, a body — is refused before the manager is asked to
change anything.

An imported connection has no credential yet, and that does **not** block it:
`POST /api/media-servers/:id/reauthenticate` performs the first credential binding
for a secret-less connection, still requiring the same verified server/account
identity, without enabling the connection or its libraries and without restoring
any grant. The operator then enables the connection and each library explicitly.

Creating a connection authenticates once with a temporary scoped transport,
generates the local handle, writes the encrypted token to the vault and then, in
a single guarded state write, installs the enabled connection. A refusal or a
failed save removes the just-written token file; if that removal cannot be
persisted, startup reconciliation finds the unbound file later. No password is
retained and no token is ever returned. Each connection uses its own stable
upstream device identity, so signing in on an imported instance does not replace
another instance's token through a shared device identifier.

## What a member gets

| Method and path | Effect |
| --- | --- |
| `GET /api/remote-libraries` | `{ libraries: [...] }` — the public remote-library projections the account may see. No upstream call: the names come from the local attachment. Never carries grants, server or account ids, the address or a secret reference. |
| `GET /api/remote-libraries/:id/browse` | Native browsing: `limit` (default 60, 1–200), opaque `cursor`, optional `parentId`, `mode` (`folders`/`titles`), `search`, `type`, `sort` (`name`/`added`/`size`) and `order` (`asc`/`desc`). Reads one provider page, preserving folders in folder mode. Cursors are bound to the actor, library generation and complete browse context. |
| `GET /api/remote-libraries/:id/preview` | Optional `parentId`; the tile's own tagged poster, or up to four posters from one bounded child page when it has none. A library root reads its own image from the current view list; a season shows no mosaic at all. A disabled mosaic reads no provider pages. |
| `GET /api/remote-libraries/:id/items` | Bounded browse: `limit` (default 60, 1–200), opaque `cursor`, `search` (≤256 chars, provider search term) and exact `type` (`movie`/`series`/`season`/`episode`). |
| `GET /api/remote-libraries/:id/items/:itemId` | `{ item, capabilities }` for the current authorized item. |
| `GET /api/remote-libraries/:id/items/:itemId/episodes` | `limit` and `cursor` only; the parent must be a verified `series` or `season`. |
| `GET /api/remote-libraries/:id/items/:itemId/sources` | The verified ordinary file versions of one playable item as sealed, source-owned streams. Each carries its external text subtitles as sealed references. No upstream address or token is returned. |
| `GET /api/remote-libraries/:id/streams/:type/:catalogId` | Optional `name` (≤256 chars, the resolved catalogue or series title). The verified sources behind one exact external id (`ttN`, `tmdb:N`, `tvdb:N`, or a series episode `ttN:S:E`). One bounded provider-id query finds candidates; a movie re-reads each, and an episode reads one series query and one parent-scoped season page. Every candidate is re-read and re-matched before its versions are minted, and an id this app does not match exactly answers `{ streams: [] }` with no upstream work. Any other query key is refused. |
| `GET /api/remote-libraries/:id/items/:itemId/artwork/:imageType` | Fixed `Primary`/`Backdrop` bytes and at most one optional `tag` and one optional `size` query, streaming through the image lane. `size=tile` asks the provider for 640 pixels and `size=detail` for 1920; a request that names no size keeps the older widths, 1920 for a Backdrop and 640 for a Primary. Private, `max-age=31536000`, and `immutable` only when the `tag` query matches the current tag, `nosniff`, with an `ETag` of the tag the bytes belong to and the size variant. A changed tag is a new URL, and so is the tile variant of a backdrop. A repeat of the same tag and variant is served from memory or disk — an address that names an outdated tag is the entry for that tag — so the image itself is not fetched from the provider again. A matching `If-None-Match` that does arrive is a local `304` after the local checks. Missing artwork answers `404` and the client falls back. |
| `GET /api/remote-libraries/:id/items/:itemId/state`, `PATCH …/state` | The account's own position, duration, favourite, watched and chosen version for a verified item. Kept apart from the generic progress map, so a `remote:` key never resolves through the filesystem or catalogue parsers. |
| `POST /api/remote-libraries/:id/items/:itemId/playing` | Reports `mediaSourceId`, `position`, `paused`, `event` and an optional `playId` for one remote playback. A `playId` is 8–64 letters, digits, `_` or `-`; one play uses the same id for start, progress and stop. It keeps a late report from touching another play of the same account, item and source, while clients that omit it keep the legacy session key. |
| `GET /api/remote-libraries/personal?filter=resume\|favorites&skip&limit` | The account's own resume or favourite cards, each library confirmed against the live remote policy first. A library that cannot be confirmed is dropped and the answer is marked `partial`; `skip` is 0–1000 and `limit` 1–120. The whole projection runs under one budget — 1.5 s for Home, 5 s otherwise, two confirmations at a time — and every card is re-proved against the account, the connection, the remote identity, the upstream library and the switches as they stand before the JSON leaves. |

Detailed item responses carry optional bounded overview,
year, genres, run time, size and creation time, plus same-origin `poster` and
`wide` artwork paths. Known absent image roles are omitted. These paths are built only from the encoded local
library and item handle
and a fixed image role. The client loads those paths; a cached provider row can
never become a client-admitted URL.

Paged browse and episode responses carry `stale: false`; content responses
carry `capabilities` with every capability false. Unknown or denied libraries
and items answer the same `404 err.libraryNotFound`, so a guessed id tells
nothing. Malformed item identifiers answer `400 err.invalidRequest`.

## Authorization, per request

Nothing here relies on a cached permission decision. The remote facts a read
proves — the server identity, the account policy and the view list — are cached
for **30 seconds** per runtime, and a proved item or parent membership is cached
for up to **5 minutes** (bounded, in memory), but the local authority is never
cached: every read re-reads the acting account, its grant and the connection
around each await. An operator discovering or attaching a library forces the view
list to be read afresh so a library that appeared upstream moments ago is seen.
Before any browse, detail or episode read the manager:

1. re-reads the acting account from the state (it must exist, match the captured
   secret, be enabled and not owe a password change) and runs the captured
   request guard (`requireAccess`), which covers session revocation, expiry and
   the permission stamp;
2. verifies the **current** public server identity and requires it to equal the
   stored `serverId`;
3. reads the **current** account policy and requires the exact stored `accountId`,
   neither `IsDisabled` nor a missing playback right, and no known additional
   restrictions (fail closed);
4. requires the library in the **current** view list and, when the account is
   restricted to folders, the exact remote library id in `EnabledFolders`;
5. for an id not yet proved, fetches the item detail and its ancestors **once**
   and requires the attached remote library id in that ancestor chain, then
   records the membership proof; a library root is authorized from the view list
   without an ancestor-of-itself call, and an id a page already returned needs no
   second detail or ancestor call;
6. repeats steps 1 and the local visibility check after **all** awaited work and
   immediately before returning, including for a cached snapshot.

A library edit bumps its connection generation, which invalidates sibling
snapshots and cancels staged scans; a grant edit also bumps `permissionsVersion`
for every ordinary account it added or removed. So does a visibility change —
switching a library or a connection off, or removing either — because it takes the
library away from the same accounts; a rename or a reorder is not a permission
change and bumps nobody. Every request-facing write repeats the full authority
check (the route's own access gate, the acting account, the write-time
administrator check) **inside** the synchronous state mutator that lands it, so a
session revoked while an earlier await or a queued write was in flight cannot
still commit. Membership itself is always rechecked, so the permission stamp alone
is never trusted. Deleting an account sweeps its id out of `allowedUsers`; the
dashboard counts remote grants in a separate
`remoteLibraries` field so the local count keeps its meaning. There is no
immediate network-abort hook on user deletion in this stage, but the
publish-time check stops any late read from being returned.

## Caches (bounded, in memory only)

Three short-lived caches speed up reads while allowing briefly stale upstream policy, image membership and
one folder listing, and nothing on the interactive path scans a whole library.

**Session facts (30 seconds).** The proved server identity, account policy and
view list are cached on the connection's runtime for 30 seconds, so a burst of
browse, image or card reads proves them once. The token is never part of that
cache: the vault is still read on every request, so a changed or removed key
fails closed. A cached fact is re-validated on every use, and the local actor,
grant and connection are re-checked around each await. Administrator discovery
and attachment bypass the cache so a library that appeared moments ago is seen.

**Membership proofs (5 minutes, at most 8192).** An item (or a library root)
proved to sit inside one granted library for one acting account is cached for up
to 5 minutes, keyed by the actor, the library, the connection generation and the
secret reference. A page that passed its permission re-check registers each of
its rows, so listing a library and then loading its images repeats no per-image
detail or ancestor call; an id that was never proved is proved once. The row a
title detail or a sources read asks for is still read live — a grid row carries
neither an overview nor genres — but the ancestor walk behind it is skipped when
that very item was proved within the window; reading a title again proves it
again, so an item opened more often than once per window stays proved. A proof
carries only membership and the current image role tags — never a playback
decision — and a proof never crosses actors, libraries or generations.

**Mosaic listings (5 minutes, at most 128).** A folder that has no picture of its
own is listed once and the page is kept, together with the up to four posters the
tile draws from it, so reopening a grid of folders does not ask the provider once
per tile. The entry is keyed by the library, its type, the folder, whether the
tile asked for the folder's own picture or its children's, and the connection
generation and secret; a re-served listing puts its rows back into the proof
cache, so the pictures the tile then loads still need no walk of their own. A
folder that carries its own tag, and a mosaic that is switched off, never look at
this cache.

**Invalidation.** All three caches are dropped with the runtime: an
authentication refusal from any operation marks the connection
`reauthentication-required` and throws away its session facts, its proofs, its
mosaic listings and its transport; a generation change, a removal or `close()`
does the same. Nothing is written to disk: the caches have a zero disk footprint.

Visible library lists remain local-only. A fresh cached view can add the library's
own tagged poster; a cold list falls back to one lazy preview request. Signed
parent continuations renew their ancestry proof after five minutes.

The recursive `MediaServerIndex` snapshot is **no longer consulted** by native
browse, episode or match; those read exactly one provider page or one bounded
provider-id query. The index object is still created, invalidated and closed
alongside the manager, but it never widens the work an interactive request does.
Its bounded-scan behaviour, if an operator or test drives it directly, keeps the
previous limits: 20 snapshots, 10 000 items or 5 MiB per library, 32 MiB total,
two concurrent scans, a 200-item page over at most 50 pages, unique ids, a
terminating cursor and no cycles.

### Request lifetime

Every request-facing read and write takes the request's `AbortSignal`, combined
with the manager's own lifetime signal. The acting account, the connection and
the local library visibility are re-read after **every** awaited step — the vault
read, the identity check, the account policy, the view list, each page, each
detail and ancestor call — and before a cached fact or membership proof is used.
A streamed image re-checks the local authority before every chunk and cancels the
upstream read the moment the client goes away. A client that disconnects, a
revoked session or a shutdown stops the work and nothing is published or written
afterwards, even if a provider ignores the abort. The manager's `close()` aborts
every staged scan, closes every cached **and every temporary login transport**,
and from then on every request-facing method fails.

### Cursors

A native-browse cursor is opaque base64url (≤8192 chars, ≤6144 decoded bytes)
carrying the library id, connection generation, actor id, the parent, mode,
type, search and sort pair, and the provider's own page cursor. It is canonical,
bounded, re-encoded to be sure two spellings never share one cursor, and signed
with a **process-scoped HMAC**. A signed continuation that binds the exact
actor, generation, parent and query is trusted as the proof that its parent was
already proved, so it skips the parent proof; an edited, migrated or foreign
cursor fails its signature or its binding and is refused with
`409 err.mediaServerStale` (or `400` for a non-canonical one), and the client
restarts the listing. Every cursor the API emits round-trips through its own
validation.

## Token vault and cleanup

The vault (`MediaServerSecrets`) stores only provider tokens, encrypted with
AES-256-GCM under the deployment key, bound to the connection and remote identity
by additional authenticated data. It is read on every operation and never
cached, so a changed or missing key fails closed with `err.mediaServerKey`.

Removing a connection or replacing its credential queues the old reference in
`state.mediaSecretCleanup` in the *same* state write, and a drain (also run every
60 s, stopped with the manager) deletes the file and then the queue entry. The
drainer never deletes a reference that any live connection still binds. On
startup, before requests are accepted, the vault is enumerated (bounded, needs no
key) and any unbound file is queued for cleanup — but only when **both** a real
`state.json` was loaded or written in this process **and** that state owned the
media-server fields (`mediaConnections` or `mediaSecretCleanup`, even empty). A
state written before those fields existed proves nothing about a vault that may
have arrived from a newer backup, so it preserves every file. A missing state, a
missing key or an unsafe vault preserves every file and logs a generic line; the
app still starts. This is deliberately not a cross-file transaction: if a state
write and a file removal both fail, startup reconciliation is the recovery path.
It is not a recovery promise after a deliberately emptied remote configuration —
it only collects a file no state of this install binds.

The internal cleanup, drain and rollback writes are exempt from the write-time
authority guard on purpose: recovering a secret written by a request that has
since been revoked must not itself require that revoked authority.

### Backup and restore

- **Metadata only.** `GET /api/media-servers/export` and the settings backup both
  carry the configuration as metadata: the provider, the name and address, the
  verified server and account ids, and each attached library with its name, type,
  order and the two switches. No secret reference, enabled flag, generation,
  grant, timestamp, user name or token is ever copied, whatever shape the caller
  hands in. Both files are safe to keep with ordinary backups.
- **The settings backup is version 3.** From that version it also carries the
  remote configuration, so the ordinary settings file is a complete description
  of the instance's settings and its media-server attachments. A version 1 or 2
  file carries none, and importing one leaves the current remote configuration
  exactly as it stands.
- **Importing a version 3 file replaces the remote configuration** with fresh
  local handles, disabled, with no grants and no secrets — the same contract as
  `POST /api/media-servers/import`. The settings, the add-ons and the replacement
  land in **one** state write after every manifest has been fetched, so a bad
  file changes nothing, and a connection replaced this way needs an
  administrator to sign in again. Importing one's own backup is the normal case
  and works, because the old records are replaced rather than merged: nothing of
  the previous credential or grant survives by accident. The interface should say
  this before an import runs.
- **Full recovery.** Restoring working remote connections needs three things
  together: the state file, the encrypted vault directory
  (`DATA_PATH/media-server-secrets`) and the key file
  (`DATA_PATH/media-server.key`, unless `MEDIA_SERVER_KEY_FILE` points elsewhere).
  Whoever holds all three holds the tokens — treat that set as a credential. A
  missing key is generated only when the install has no encrypted credential yet.
  Once a login has been stored, a missing key is **not** replaced; existing
  references simply fail to decrypt, and every remote read fails closed with
  `err.mediaServerKey`.

## Removal and stored history

An account's own remote progress, favourites, watched flags and chosen version
live in that account's `remoteMedia` map, keyed by the canonical remote identity
(`remote:` plus the SHA-256 of `[provider, serverId, accountId, itemId]`). They
stay local: no upstream server is ever told about them, and no removal writes to
one.

- **Removing a library or a connection keeps that history by default.** The rows
  stay on disk, are not projected anywhere and start a 30-day countdown measured
  from the removal itself — never from the row's last update, and never from a
  disable, an outage or a withdrawn grant.
- **Scope is the exact identity and upstream library.** A removal takes the rows
  of the same provider, server id and account id, and — for a library — only that
  upstream library id. The same server under a different account is a different
  identity and is never touched.
- **A matching attachment still holds its rows.** Disabling a connection or a
  library keeps its metadata, history and grants, and starts no countdown.
  Reattaching the same verified identity and upstream library within the 30 days
  takes the history back; an attachment never brings grants with it.
- **A removal never extends a countdown**, so removing the same thing twice does
  not push the deadline back, and a library whose 30 days have run out is gone
  for good.
- **`?forget=true` deletes the rows at once**, for every account, in the same
  atomic write as the removal. Nothing upstream is contacted and no media file
  is touched.
- **A sweep runs at startup and every 60 s.** It drops rows whose 30 days are
  over and starts the countdown for rows an attachment no longer holds — rows a
  previous version left behind, whose countdown begins when they are first seen.
  It never touches a live attachment, never moves a permission stamp, never
  cancels a source, and writes nothing at all when it has nothing to do. It is
  internal maintenance and runs without an actor, like the vault drain.
- **Only a canonical row counts.** A stored row is recognised only when the map
  key, the stored key and the canonical key of the identity it carries all agree.
  A malformed row is never marked, recovered or purged, so it can never stand in
  for another identity.

## Failure mapping

Every internal `MediaServerError` is mapped to a fixed status and catalogue key
at the route boundary; a raw internal status or message never escapes. An
upstream 401 becomes `502 err.mediaServerLogin`, never a local 401. Unknown
unexpected exceptions fall through as ordinary internal failures. Each arm uses a
fixed English sentence, never the internal message, so a provider or a bug cannot
place its own text in a response. A rate-limited or busy answer carries a bounded
`Retry-After`, set only for a finite positive wait.

| Internal code | Status | Key |
| --- | --- | --- |
| `invalid-input` | 400 | `err.invalidRequest` |
| `not-found`, `forbidden` | 404 | `err.libraryNotFound` |
| `busy`, `rate-limited` | 429 | `err.mediaServerBusy` |
| `stale-generation` | 409 | `err.mediaServerStale` |
| `identity-changed` | 409 | `err.mediaServerIdentity` |
| `unsupported-policy` | 403 | `err.mediaServerRestricted` |
| `playback-not-allowed` | 403 | `err.mediaServerPlaybackNotAllowed` |
| `no-compatible-stream` | 422 | `err.mediaServerNoCompatibleStream` |
| `bitrate-limit` | 403 | `err.mediaServerBitrateLimit` |
| `authentication-required` | 502 | `err.mediaServerLogin` |
| `timeout`, `unavailable`, `invalid-response`, `response-too-large`, `unsafe-address` | 502 | `err.mediaServerUnavailable` |
| `closed`, `cancelled` | 503 | `err.mediaServerUnavailable` |
| `secret-key-unavailable`, `secret-unavailable` | 503 | `err.mediaServerKey` |

## Deployment

Leave `MEDIA_SERVER_KEY_FILE` unset. On startup the server creates
`DATA_PATH/media-server.key` when that file is absent and the install has no
saved remote login yet (see [Configuration](configuration.md)). The next start
reuses the same file. Back it up with the data directory.

Set the variable to use a key you created yourself. The server then does not
create or repair that path. Mount the file and point the variable at the mount:

```yaml
services:
  stremio-offline:
    environment:
      MEDIA_SERVER_KEY_FILE: /run/secrets/media-server.key
    volumes:
      - ./data/media-server-secret.key:/run/secrets/media-server.key:ro
```

With no usable key the container still boots, lists no connections and refuses
to store a credential with a clear message. Key rotation is not supported:
changing the key without signing in again makes existing tokens undecryptable
by design. The desktop application creates and preserves its own installation
key outside the replaceable backend directory; see
[Desktop media-server credentials](desktop-media-servers.md).

Active remote playback is revalidated every 30 seconds, with a five-second
verification deadline. Local revocations invalidate resources immediately; an
upstream policy change is caught by the periodic guard, which stops playback
when authorization cannot be confirmed.
Each material original-stream or download admission also sends the provider's
`POST PlaybackInfo` with the account's effective bitrate limit and direct-play
flags. It does not claim a synthetic codec device profile; the backend can
consume any original file and locally convert it, while the provider's
`SupportsDirectPlay` answer remains authoritative. A provider-issued
`PlaySessionId` is carried into the static original URL and the
start/progress/stop reports; when it is omitted, the reporter keeps its local
id. Stream admissions retain that id in a bounded live map so later byte ranges
cannot rotate it while the same playback is running; stopping playback,
invalidating the connection or signing the account out retires the entry.

## Measured upstream limits

The episode grouping relies on `SeriesId`, which the measured Jellyfin 12.2.0 and
Emby 4.9.3.0 responses return once `SeriesInfo` is requested; a row without a
`SeriesId` is never guessed and is simply omitted from a series grouping. The
conservative folder policy (`EnableAllFolders` false plus the exact view id in
`EnabledFolders`) was measured on Jellyfin; the equivalent limited-folder Emby
setup returned no views and is explicitly **unverified/unsupported** in this
configuration. Unknown policy fields remain a documented compatibility limit;
this stage does not claim exhaustive remote parental-policy support.

## What this feature deliberately does not do

- **No item or library mutation reaches the media server.** Rename, move,
  delete, identify and artwork upload stay out; a remote library and its history
  are local records only. The only upstream writes are the bounded playback
  session reports (`Sessions/Playing`, `Progress`, `Stopped`).
- **Nothing is transcoded upstream.** An original file is proxied byte-for-byte
  (ranges included) through the scoped transport, and anything that has to be
  converted — a stream the client cannot play directly, an external subtitle
  track — is converted here, on this machine, with the local FFmpeg. No transcode
  session is asked of Jellyfin or Emby. `PlaybackInfo` enables direct play only,
  and a source without a usable direct-play answer is refused instead of opening
  its static URL.
- **Device approval, remote-access and schedule diagnostics are not implemented.**
  A known additional restriction still fails closed as
  `403 err.mediaServerRestricted`; this task does not add per-condition states,
  an allowlist UI or local access-schedule enforcement. Parental rating and tag
  filtering also remain unsupported and fail closed.
- **Provider subtitles are external SRT only.** External SRT/SubRip tracks are
  read through the scoped proxy and converted to VTT locally. Other provider
  sidecar formats are not offered.
- **Browsing does not need a catalogue id.** A remote item that matches no
  catalogue entry is browsable, searchable, playable and remembers its own
  progress. Catalogue matching is only what the `streams/:type/:catalogId`
  route adds.
- **Matching is exact-id only.** `ttN`, `tmdb:N`, `tvdb:N` and a series episode
  `ttN:S:E`. There is no title, filename or path matching, no fuzzy match and no
  external id conversion: an id this app cannot match exactly answers with an
  empty list rather than a guess, and an episode must still prove its series
  after every read that could have moved it.
- **Jellyfin catalogue discovery has a compatibility limit.** Emby 4.9.3 supports
  the exact `AnyProviderIdEquals` query. The tested Jellyfin 12.2.0 silently
  ignores that parameter; its adapter instead requests one bounded page using
  documented `HasImdbId`/`HasTmdbId`/`HasTvdbId` and the catalogue title as
  `SearchTerm`, then checks the returned provider IDs exactly. Different
  localized titles or more than 200 candidates can therefore hide a valid
  catalogue source. Legacy callers without a title search one bounded ID-bearing
  page. This never guesses a match or starts a full-library scan on a click;
  opening and playing an item directly from its library remains unaffected.
- **A remote failure stays local to its own half.** A failed remote read drops
  the remote part of a row or marks it `partial`; the filesystem rows, the
  add-on rows and the other destinations are unaffected, and no cached remote
  answer is ever served as fresh.
- **The vault fails closed.** With no key, or with an unreadable one, every
  remote read refuses with `err.mediaServerKey`; the app still starts and the
  filesystem half keeps working.

Music-video libraries are available in the mixed-library layout. Their clips use the standalone video playback controls and local history; their provider IDs do not participate in catalogue movie matching. Audio-only music libraries remain excluded.


## Native browsing and presentation

Mixed libraries default to folder browsing; movie and series libraries default
to all titles. Each attachment can change this independently. Series episode
pages use numeric season/episode ordering before pagination. Folder browsing
never loads every descendant to draw its first page.

Web root tiles, folder/file rows and overflow shells share the local library's
components. Remote menus offer local favorites and watched state, with personal
state fetched on menu opening rather than once per tile. Folder and season
items navigate; they do not become playable sources. Remote metadata stays
read-only, and provider paths, credentials and upstream image addresses never enter the
client projection.

Remote grids use the shared artwork component. A missing preferred image falls
back to the other role and then an icon; changing tile proportions cannot retain
an error class from an older image. Failed mosaic cells are removed instead of
leaving an empty collage.


## Shared web library detail

A local file or a matched movie folder opens a detail page instead of starting
playback. The detail retains an Open folder action for managing the individual files.
Unmatched, mixed and series folders keep their normal navigation.
Local and remote playable titles share the same hero, synopsis, metadata and
source picker; a matched local title uses its catalogue name while the selected
file name stays in the source picker.

The largest playable version with a reported file size is the default. Unknown
sizes retain the provider's order, and a user's explicit choice survives a
refresh of the same title. The arrow beside Play opens a keyboard-accessible
picker, focuses the current choice and returns focus on close. It accepts the
same public stream shape as catalogue sources.

The picker is the catalogue's own list: the same source, language and order
menus and the same row template, drawn from `SourceFilters`/`SourceRows`. It
leads with the versions the detail already had — the clicked file's copies, or
the library the detail was opened in — then the viewer's other copies, then the
other libraries this account may browse, then the add-on rows; a named sort
ranks every class together. The selected row's own store supplies its position,
and two libraries offering the same underlying file stay distinct rows. A row is
identified by its whole source identity: a group landing while the viewer walks
the list leaves the focused row the source it was, and two groups repeating one
source are listed once. A picked source keeps its option even when a language
filter leaves it no row, with the picker's own way back clearing both menus.

Opening the chooser is the single intent that reads every group at once: the
add-ons that offer the title, each other library, and the viewer's own copies of
it, discovered through the title's exact catalogue id (a series id with its own
season and episode for an episode). The library the detail came from is never
asked again. At most two add-on stream calls and two library matches are out at
once, a failing group keeps its own error and retry without touching the others,
and a group that already answered is not read again while the same title and
account stay open, and a library the account cannot browse is never asked. A
group waits for nobody: the viewer's own copies and every add-on the discovery
has already named are read the moment the chooser opens, and the two lookups
still needed — the source add-ons, and the other libraries when the caller does
not already hold them — are listed in the picker with their own loading, error
and retry state. A failed lookup keeps every row that did land and is asked
again on its own, and the recommended and by-add-on orders rank the add-on rows
by the configured provider order the discovery answered in, never by the order
two answers happened to land in. A late answer from a title, library or account
that moved on is aborted and dropped. Browsing lists, opening a detail, changing
the tile style and pressing the native Play send no add-on stream, discovery or
subtitle request at all, and no per-provider load control exists.

Playing a row that is not the detail's own file is routed by what it really is:
an add-on row plays under the title's catalogue key, a copy in another library
under that copy's own remote identity, a copy of the viewer's own files under
its path. None of them borrows the opened item's watch history, favourite or
next-episode hand-off, and each resumes and resets only its own store: a
media-server version is named by its whole library, item and version rather than
by a version id two libraries may reuse, and a state that reports a different
version counts as no position at all. After a playback the panel reads that
store again only once the final write of that same version landed. Saving a row
queues that exact source: a media-server copy with the destination its own
source projects, an add-on answer under its add-on's rule, and a file of the
viewer's own library with nothing to queue at all. The player of a row started
from this detail offers the same actions over the exact row it is playing: To
library re-enters that row's own path — the native dialog for a version of the
opened library, the copy's projected destination for another library's, the
add-on's rule for an answer — while a file of the viewer's own library is never
queued as a copy and is instead downloaded to the device from its own path. A
row also wears the transport it really carries: a copy from another library
names its own provider, never the provider of the detail it is listed in.

Local discovery reads the clicked file and its identity once, then lists exact
copies of the bound movie or episode. A failed identity lookup does not hide a
playable file. Playback resolves only the selected copy again so its sidecar
subtitles and permissions are current. Remote discovery keeps the existing
scoped source and local-history paths.

The selected video's saved position appears below the synopsis. A known duration
adds a bounded progress bar; an unknown duration shows the elapsed time alone.
Forget progress clears only that file or native item's app-local position, keeping
favourites and the remote watched flag. Play from the start opens the selected
version at zero without first deleting its saved position. Ordinary playback
retains its resume rules, including the native remote version check. Returning
from playback refreshes the position. Android TV provides the same actions; its
local clear is wired through the real shell to the owner-scoped progress API.

Remote listings and episode lists load their next page near the end of their
scroll pane, with one request in flight and no automatic retry after an error.
The manual button remains a fallback. Breadcrumbs include the current item;
Back and visited breadcrumbs restore the listing's position and focus. The
sidebar Library entry opens the libraries overview.
The remote root block is shown only at the library root, so an opened local
folder owns its full page and scroll pane. Mobile folding uses the established
library chrome.

## Upstream request budget

Native lists read one provider page at a time, with a default of 60 items.
Remote artwork is mounted near the visible viewport; a tile's mosaic is its own
poster (or its library's own view image). A tile that stands for several films draws
one picture the server composed for it -- two pictures share the frame, three give
the first the left two thirds, a wide tile keeps a row of columns -- cached under the
version of the pictures that went into it, so a changed fan is a changed address. The tile keeps that frame — its own
picture, the first of the fan, or the folder or drive icon — while a fan is
fetched, and the fan covers it once every poster has decoded, so a reload never
leaves the tile empty. Without one, a preview reads one bounded child
page without traversing nested folders at all and changing tile shape does not repeat any discovery. Known absent
image roles are not requested, and a thumbnail a few minutes old is acceptable —
the client does not insist on zero-latency upstream metadata revocation.

**Metadata and images use separate lanes.** Metadata admits at most four active
network operations globally on a connection, one new start every 125 ms, with
bounded, abortable waiting queues and a re-pace after global saturation so a
queued burst cannot catch up. Image bytes take the transport's **own** finite
pool, with no metadata start pacing and no metadata or DNS slot, so an image burst
cannot delay a browse, a match or the playback guard's revalidation. Original
streaming bytes use their own separate transport pool too.

Concurrent identity, account-policy and view-list reads on the same runtime
share their in-flight result, and the settled facts are then reused for up to 30
seconds; each caller still repeats its own current actor, generation and grant
checks. In a four-artwork fixture burst this reduces the session reads to one
each.

An upstream `429`, or an HTTP 200 `PlaybackInfo` answer with
`ErrorCode: "RateLimitExceeded"`, puts metadata, images and new stream requests
on that transport into a shared cooldown: the supplied `Retry-After`, bounded to
five minutes, or thirty seconds when absent. Calls during cooldown make no DNS
or HTTP request. There are no automatic retry loops. The upstream client
identity remains Stremio Offline; request pacing does not imply that an operator
who allows only the official Jellyfin client permits this application.


## Copying remote originals into local libraries

The catalogue, a native video detail and its item menu can save the selected
original into a local library, on the web and Android TV. The source account on
Jellyfin or Emby must explicitly allow content downloading, and the acting app
account must have access to the remote library and permission to write to the
local destination. Device saves and bulk season or folder copies remain unavailable
for native sources. No remote watch history, metadata or files are modified.

An administrator can configure the destination library, a relative subfolder and
the storage layout in the attached library's settings, using the same rule editor
as addons. Movie and series libraries show their applicable rule; mixed libraries
show both. The editor previews the resulting path. Structured storage creates a
title folder for a movie or show and season folders for episodes; flat storage
writes the file directly below the selected subfolder. A configured subfolder
may be created when the copy starts, whereas a manually browsed folder must exist.
With no override, movie and series libraries use their respective local defaults;
other libraries prefer an enabled writable general-purpose library. The destination
picker can override this rule for a single copy. A configured destination that is
removed or no longer accessible is refused rather than silently replaced. Changing
the setting affects new copies, while queued copies retain their chosen destination.

Which slot an automatic copy of a mixed library follows is the kind sealed from the
verified item when its sources were listed, never the request body; the download
admission reads that proved kind. An older sealed source that carries no such kind
keeps the previous body-based fallback.

`PATCH /api/remote-libraries/:id` treats `downloadSettings` as a per-kind merge, not an
atomic replacement. An omitted `downloadSettings` leaves the stored rules alone. A
supplied object updates only the kind slots it names — `movie` and/or `series` — and an
absent kind keeps its current new rule, or its effective legacy seed, including an
unavailable handle that is not re-validated. Each kind the patch does name is a complete
slot: a missing `subfolder` and `layout` fall back to the empty subfolder and the
structured layout, and a changed handle is proved against the libraries the write lands
on. An empty object is a storage no-op, and `null` resets the new rules as before. The
legacy `downloadLibraryId` seed keeps its existing precedence for a library that has no
new rules.

Copies use one original-file transfer per upstream server, without segmentation.
Partial files are kept when access is withdrawn; the copy pauses instead of repeatedly
asking the server. Queue state keeps an owner-bound reference, never the upstream
address, token or browser session. The original container supplies the saved file
extension; an unknown format is refused instead of being guessed as MP4.
