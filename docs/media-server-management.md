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
| `DELETE /api/media-servers/:id` | Removes the connection and its attached libraries and queues its token file for deletion. Its stored history is kept invisibly for 30 days; `?forget=true` deletes it at once. No remote session is reported or logged out. |
| `POST /api/media-servers/:id/reauthenticate` | Signs in again with `{ username, password }`; requires the same verified server/account identity. |
| `GET /api/media-servers/:id/libraries` | `{ items: ProviderLibrary[] }` — the libraries the stored account can currently see. |
| `POST /api/media-servers/:id/libraries` | Attaches one remote library from `{ remoteId, name?, order?, showOnHome?, showInContinueWatching? }`; the remote name and type come from verified discovery. New libraries are granted to nobody. |
| `PATCH /api/remote-libraries/:id` | Local configuration only: `name`, `enabled`, `order`, `showOnHome`, `showInContinueWatching`, `allowedUsers`. `root`, `writeArtwork`, `type`, `remoteId`, `connectionId` and any download flag are refused. |
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
| `GET /api/remote-libraries/:id/items` | Bounded browse: `limit` (default 100, 1–200), opaque `cursor`, `search` (≤256 chars, case-insensitive name substring) and exact `type` (`movie`/`series`/`season`/`episode`). |
| `GET /api/remote-libraries/:id/items/:itemId` | `{ item, capabilities }` for the current authorized item. |
| `GET /api/remote-libraries/:id/items/:itemId/episodes` | `limit` and `cursor` only; the parent must be a verified `series` or `season`. |
| `GET /api/remote-libraries/:id/items/:itemId/sources` | The verified ordinary file versions of one playable item as sealed, source-owned streams. Each carries its external text subtitles as sealed references. No upstream address or token is returned. |
| `GET /api/remote-libraries/:id/streams/:type/:catalogId` | The verified sources behind one exact external id (`ttN`, `tmdb:N`, `tvdb:N`, or a series episode `ttN:S:E`). The snapshot only finds candidates; every candidate is re-read and re-matched before its versions are minted, and an id this app does not match exactly answers `{ streams: [] }`. |
| `GET /api/remote-libraries/:id/items/:itemId/artwork/:imageType` | Fixed `Primary`/`Backdrop` artwork bytes, read through the scoped transport. Always private, `no-store`, `nosniff`; an `If-None-Match` never short-circuits the authorization. Missing artwork answers `404` and the client falls back. |
| `GET /api/remote-libraries/:id/items/:itemId/state`, `PATCH …/state` | The account's own position, duration, favourite, watched and chosen version for a verified item. Kept apart from the generic progress map, so a `remote:` key never resolves through the filesystem or catalogue parsers. |
| `GET /api/remote-libraries/personal?filter=resume\|favorites&skip&limit` | The account's own resume or favourite cards, each library confirmed against the live remote policy first. A library that cannot be confirmed is dropped and the answer is marked `partial`; `skip` is 0–1000 and `limit` 1–120. The whole projection runs under one budget — 1.5 s for Home, 5 s otherwise, two confirmations at a time — and every card is re-proved against the account, the connection, the remote identity, the upstream library and the switches as they stand before the JSON leaves. |

Paged browse, episode and detail responses also carry same-origin `poster` and
`wide` artwork paths, built only from the encoded local library and item handle
and a fixed image role. The client loads those paths; a cached provider row can
never become a client-admitted URL.

Paged browse and episode responses carry `stale: false`; content responses
carry `capabilities` with every capability false. Unknown or denied libraries
and items answer the same `404 err.libraryNotFound`, so a guessed id tells
nothing. Malformed item identifiers answer `400 err.invalidRequest`.

## Authorization, per request

Nothing here relies on a cached permission decision. Before any browse, detail or
episode read the manager:

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
5. for a guessed item, fetches the item detail and its ancestors and requires the
   attached remote library id in that ancestor chain;
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

## Snapshot cache (bounded, in memory only)

`MediaServerIndex` holds up to 20 snapshots (LRU), at most 10 000 items or 5 MiB
per library, 32 MiB in total, and runs at most two scans at once with no queue: a
third scan or a second scan of the same library is refused immediately as
`busy`. A scan pages the provider at 200 items over at most 50 pages, requires
unique item ids, a terminating cursor and cursors it has not already seen (a
cycle is refused before the page limit), and refuses an over-cap library rather
than publishing part of it. The 5 MiB budget is enforced incrementally while the
pages arrive, not only after the last one; the aggregate cap refuses a single
snapshot that alone exceeds it.

**A failed refresh fails closed.** A rejected scan publishes nothing and leaves
the previous snapshot in memory only, where it can still answer a cursor that
names it exactly, so an open listing is not torn apart by a transient failure.
The next un-cursored request is refused with that failure for a bounded window
(5 s doubling to 60 s, honouring an upstream `Retry-After` up to 300 s); a retry
happens only on a later request, never in the background, and permission is never
inferred from the cache. Failure records carry the full snapshot key, so one
recorded against an older generation or identity is dropped with the connection
and cannot hold back a repaired one, and they are bounded (1024 by default).
An authentication refusal from **any** operation — the preflight or a page,
detail or ancestor call — marks the connection `reauthentication-required` and
throws away its runtime and cached snapshots. Nothing is written to disk: the
cache has a zero disk footprint.

### Request lifetime

Every request-facing read and write takes the request's `AbortSignal`, combined
with the manager's own lifetime signal. The acting account, the connection and
the local library visibility are re-read after **every** awaited step — the vault
read, the identity check, the account policy, the view list, each page, each
detail and ancestor call — and before any cached snapshot is returned. A client
that disconnects, a revoked session or a shutdown stops the work and nothing is
published or written afterwards, even if a provider ignores the abort. The
manager's `close()` aborts every staged scan, closes every cached **and every
temporary login transport**, and from then on every request-facing method fails.

### Cursors

A paging cursor is opaque base64url (≤8192 chars, ≤6144 decoded bytes) carrying
the snapshot id, library id, connection generation, actor id, the search/type
filter, an episode-parent filter and the offset. It is canonical, bounded and
re-encoded to be sure two spellings never share one cursor. A replaced snapshot,
a different actor, a different filter or an edited cursor is refused with
`409 err.mediaServerStale`, and the client restarts the listing. Every cursor the
API emits round-trips through its own validation.

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
  (`DATA_PATH/media-server-secrets`) and the key file. Whoever holds all three
  holds the tokens — treat that set as a credential. A missing key is **not**
  replaced or regenerated; existing references simply fail to decrypt, and every
  remote read fails closed with `err.mediaServerKey`.

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
| `authentication-required` | 502 | `err.mediaServerLogin` |
| `timeout`, `unavailable`, `invalid-response`, `response-too-large`, `unsafe-address` | 502 | `err.mediaServerUnavailable` |
| `closed`, `cancelled` | 503 | `err.mediaServerUnavailable` |
| `secret-key-unavailable`, `secret-unavailable` | 503 | `err.mediaServerKey` |

## Deployment

Set `MEDIA_SERVER_KEY_FILE` to an existing 32-byte owner-only key file (see
[Configuration](configuration.md)). The server never generates it. In Compose,
mount it read-only and point the variable at the mount, for example an override:

```yaml
services:
  stremio-offline:
    environment:
      MEDIA_SERVER_KEY_FILE: /run/secrets/media-server.key
    volumes:
      - ./data/media-server-secret.key:/run/secrets/media-server.key:ro
```

With the variable unset the container still boots, lists no connections and
refuses to store a credential with a clear message. Key rotation is not
supported: changing the key without re-authenticating makes existing tokens
undecryptable by design. The desktop application creates and preserves its own
installation key outside the replaceable backend directory; see
[Desktop media-server credentials](desktop-media-servers.md).

Active remote playback is revalidated every 30 seconds, with a five-second
verification deadline. Local revocations invalidate resources immediately; an
upstream policy change is caught by the periodic guard, which stops playback
when authorization cannot be confirmed.

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

- **No write reaches the media server.** Rename, move, delete, identify, artwork
  upload, playback reporting and progress reporting all stay out; a remote
  library and its history are local records only.
- **Nothing is transcoded upstream.** An original file is proxied byte-for-byte
  (ranges included) through the scoped transport, and anything that has to be
  converted — a stream the client cannot play directly, an external subtitle
  track — is converted here, on this machine, with the local FFmpeg. No transcode
  session is asked of Jellyfin or Emby.
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
- **A remote failure stays local to its own half.** A failed remote read drops
  the remote part of a row or marks it `partial`; the filesystem rows, the
  add-on rows and the other destinations are unaffected, and no cached remote
  answer is ever served as fresh.
- **The vault fails closed.** With no key, or with an unreadable one, every
  remote read refuses with `err.mediaServerKey`; the app still starts and the
  filesystem half keeps working.
