# Native media-server foundation (MS-1)

Status: internal backend foundation, not wired to the running application. This
document describes what exists in `server/src/media-server-*.ts`, its limits and
the honest integration gates it leaves open. No public route, UI, startup wiring
or playable source is exposed by this stage.

This document describes the MS-1 foundation as it was delivered, and its module
contract still holds. The feature built on it — routes, startup wiring, playback,
artwork, subtitles, personal state, remote cards and the removal lifecycle — is
documented in [media-server-management.md](media-server-management.md), which is
the current contract.

The product contract and delivery split live in [planning PR #395](https://github.com/NickRabit/stremio-offline/pull/395)
and its media-server-libraries documents, which are deliberately not duplicated here.
The measured provider results live in that PR's separate spike report and are
not copied into this branch.

## What MS-1 shipped, and what came later

MS-1 was deliberately split, and the second column has since been delivered:

| Delivered by MS-1 | Delivered since (MS-2 and later) |
| --- | --- |
| Persisted records, public/admin projections, canonical identity | `index.ts` startup wiring, environment variables, `backup.ts` and `routes/settings.ts` integration |
| Validated configuration service on `Store.update` | Public HTTP routes, member/admin role allow-listing |
| AES-256-GCM token vault | Runtime connection status and live re-authentication |
| Per-instance scoped JSON transport | Original-media proxy, FFmpeg, subtitle fetch, artwork |
| Typed metadata provider | Cached index, download admission, personal progress/Home |

Filesystem libraries, scanning and downloads are unchanged by the remote feature.
The new `State` fields are optional, so a state written before them keeps its
shape, and an older settings backup simply carries no remote configuration.

## Types, records and identity

`server/src/media-server-types.ts` holds the shared vocabulary.

- `MediaServerKind` is `"jellyfin" | "emby"`.
- `RemoteIdentity` is `{ provider, serverId, accountId, itemId }`, and
  `remoteProgressKey` is `remote:` plus the SHA-256 of
  `JSON.stringify([provider, serverId, accountId, itemId])` — an ordered tuple,
  so a swapped field is a different key. Connection ids and URLs are never
  identity.
- Local handles are `mconn_` and `rlib_` plus `randomBytes(16).toString("hex")`.
  They cannot satisfy the filesystem `lib_` matcher, so a remote id is never
  mistaken for a local one, and vice versa.
- `READ_ONLY_MEDIA_CAPABILITIES` is frozen with every capability false
  (rename, move, delete, identify, writeArtwork, downloadToLibrary,
  downloadToDevice).
- `publicMediaConnection` is a member allow-list: `id`, `provider`, `name`,
  `enabled`, `generation`, `configured`. It never carries the account id, server
  id, address or secret reference. `adminMediaConnection` adds `baseUrl`,
  `allowLan`, `allowLoopback`, `serverId`, `accountId` — still never the secret
  reference. `publicRemoteLibrary` never spreads an incoming record and always
  attaches the read-only capabilities. Member library projections omit grants;
  `adminRemoteLibrary` adds a copied `allowedUsers` list.
- `MediaServerError` is the single failure type. It carries a stable code and
  fixed English text; upstream payloads, tokens, raw URLs and remote error
  messages are never interpolated into it.

`MediaConnectionRecord` and `RemoteLibraryRecord` are the persisted shapes. A
connection keeps `id`, `provider`, `name`, a normalized `baseUrl`, the LAN and
loopback flags, verified `serverId`/`accountId`, `enabled`, `generation`, an
optional `secretRef` and `addedAt`. A remote library keeps `id`, `connectionId`,
opaque `remoteId`, `name`, `type` (`movie`/`series`/`mixed`), `enabled`, `order`,
`allowedUsers`, `showOnHome` and `showInContinueWatching`. There is no root,
artifact path, write flag, token or status field; runtime status belongs to a
later service and must not be persisted where it can go stale.

`Store` gains optional `mediaConnections` and `remoteLibraries` state arrays and
clone-returning `mediaConnections()` / `remoteLibraries()` accessors. The
existing `libraries()` accessor is unchanged and remains filesystem-only, so
every scanner, path resolver and download target keeps its local contract. No
schema bump is needed for the additive optional fields.

## Configuration service

`MediaServerConfiguration(store)` is the only validated writer. Every method
reads and writes through the store's serialized `update`, so duplicates and
dangling references are refused atomically: a rejected call leaves nothing
behind, not even a partial write.

- `addConnection(input)` normalizes the URL, validates every field, and refuses a
  duplicate verified account — the same `provider` + `serverId` + `accountId`
  is refused even under a different name or address. `id`, `generation`,
  `addedAt` and `secretRef` are not accepted; injected `secretRef`, `token`,
  `password` or `root` keys are rejected.
- `attachLibrary(connectionId, input)` requires an existing, enabled, verified
  connection, refuses a duplicate `connectionId` + `remoteId`, and always
  attaches `allowedUsers: []`. Grants cannot be injected.
- `setEnabled(connectionId, enabled)` increments the generation only on a real
  change.
- `removeConnection(connectionId)` removes the connection and its libraries
  atomically and returns `{ secretRefsToRemove }`. **It does not delete the
  secret.** The caller owns that cleanup, and durable retry of it belongs to
  MS-2. An unknown id is `not-found`.
- `setSecretReference(connectionId, expectedGeneration, ref, vault)` snapshots
  the connection, requires a matching generation, decrypts the reference through
  the vault using the stored binding, and rechecks identity and generation
  inside the queued update before assigning. A revocation or credential change
  during the awaited decrypt fails with `stale-generation`. It resolves to
  `{ secretRefsToRemove }` — the previous reference only, or `[]` for an initial
  binding or a same-reference replacement — so the caller can delete exactly the
  superseded secret and never the one just bound. A binding that fails after the
  vault write (a `stale-generation`, say) leaves the newly written reference
  orphaned; the caller owns deleting it, as with `removeConnection`. Durable
  retry of any vault cleanup still belongs to MS-2.
- `exportConfiguration()` emits exactly
  `{ version: 1, connections: [...], libraries: [...] }` with metadata only:
  `enabled`, `generation`, `addedAt`, grants and `secretRef` are omitted.
- `restoreConfiguration(input)` is additive and mints fresh handles. Exported
  handles are only references for remapping, never installed. Restored
  connections and libraries land disabled with `generation: 0`, fresh
  `addedAt`, empty grants and no secret reference. It validates uniqueness
  (including repeated library ids and repeated `connectionId` + `remoteId`), no
  dangling library, and the count/field bounds before any write, and it refuses
  a duplicate verified account atomically.

Validation is typed *and* runtime: every method re-reads its input, so callers
passing parsed untrusted data cannot bypass it with a cast.

The ordinary settings backup is version 3 and carries the media-server
configuration as metadata: the connections and their attached libraries, with no
secret reference, grant, generation, enabled flag, timestamp or token. Importing
one replaces the remote configuration atomically with the settings and the
add-ons, disabled and with no grants, so a restored connection is signed in
again. See [media-server-management.md](media-server-management.md#backup-and-restore).

## Token vault

`MediaServerSecrets(directory, keyFile)` stores only provider tokens — never a
password. `put` returns `msecret_<32hex>`; `get` decrypts; `remove` unlinks. All
operations are serialized, and a failed operation does not poison the queue.

The envelope is version 1 with a random 12-byte IV, an AES-256-GCM 16-byte tag
and the ciphertext, written as JSON. The additional authenticated data is the
tuple `["media-server-secret", 1, connectionId, provider, serverId, accountId,
ref]`, so a swapped file, a swapped binding or a renamed reference all fail to
decrypt. Tokens are bounded to 8192 bytes of printable ASCII (0x21–0x7e,
excluding `"` and `\`); the same validation guards the transport, so a token one
accepts the other accepts.

The deployment key is an existing regular file of exactly 32 raw random bytes,
owner-only (`0600`), owned by the process user where the platform supports it;
symlinks are refused with `O_NOFOLLOW` and the descriptor is verified with
`fstat`, so there is no lstat-then-read race. The key is read on every
operation and never cached, so a missing, changed or corrupt key fails closed
with `secret-key-unavailable` — the vault never generates or replaces a key on
its own. Before the vault is constructed, startup creates
`DATA_DIR/media-server.key` when `MEDIA_SERVER_KEY_FILE` is unset and the
install has no encrypted credential yet. The vault directory is created `0700`; a pre-existing directory that is
not a real directory, is a symlink, or is group/other-accessible or owned by
another user is refused. A stored envelope is opened only after an `lstat`
rejects a symlink or non-regular file, and the opened descriptor is confirmed to
be the same inode and to be a regular file that is owner-only and owned by the
process user, so a FIFO cannot block the reader and a swapped or permission-
widened file fails closed. The envelope is read in bounded steps rather than
trusting the stat size, so a growing or oversized file is refused.
`remove` refuses a symlinked or unsafe vault directory, is idempotent for a
missing directory or reference, and needs no key. Writes go to a random
exclusive `0600` temp file, are `fsync`ed, then renamed atomically; a failed
write cleans the temp file up.

A normal start creates the default key. Generate a file yourself only when
`MEDIA_SERVER_KEY_FILE` points at a path the server must not create:

```sh
node -e 'const {randomBytes}=require("node:crypto");require("node:fs").writeFileSync(process.argv[1],randomBytes(32),{flag:"wx",mode:0o600})' /data/media-server-secret.key
```

Operational contracts:

- Back the key and the vault up independently of ordinary metadata exports. A
  full backup that carries the key, the ciphertext and the state file protects
  the operator from losing configuration, not from a stolen copy: whoever holds
  that backup holds the tokens.
- Key rotation is not supported yet. There is no re-wrap step, and replacing the
  key without it makes existing references undecryptable by design.
- The key's owner must match the runtime UID. A `chown` migration is a
  deliberate deployment recovery, never a silent application repair; the vault
  will not quietly fix or recreate an owner-mismatched key.
- The desktop application now maintains a persistent installation key; see
  [Desktop media-server credentials](desktop-media-servers.md).

## Scoped transport

`createMediaServerTransport({ baseUrl, allowLan, allowLoopback }, seams?)` builds
one transport per connection with an independent address policy. It never
consults `ALLOW_PRIVATE_ADDONS` or `ALLOW_ADDON_HOSTS`, and it does not reuse the
addon `safeFetch` path.

`normalizeMediaServerUrl` keeps an `origin` plus an optional base path. It
refuses credentials, query, fragment, raw whitespace, control characters and
backslashes, raw dot segments, encoded path separators or dots, double escapes
and empty interior segments; exactly one final slash is allowed and stripped.
Unusual IPv4 notation is resolved to its literal (for example
`http://2130706433` becomes `http://127.0.0.1`) and then checked. Request URLs
are assembled only from encoded path segments, so a raw remote path cannot
bypass construction.

`assertMediaServerAddress` classifies a *literal* address; a hostname is refused
there (`unsafe-address`) because callers resolve first and check every answer.
Loopback (`127/8`, `::1`) requires `allowLoopback`; RFC1918 and IPv6 ULA
(`fc00::/7`) require `allowLan`. Everything else that is not public is blocked
even with LAN on: unspecified, link-local, multicast, reserved, documentation,
benchmark, CGNAT, IPv4 broadcast, the Azure platform address `168.63.129.16`,
special and transition IPv6 ranges, and IPv6 zone identifiers. Public IPv6 is
`2000::/3` excluding `2001::/23`, `2001:db8::/32`, `2002::/16` and `3fff::/20`.
IPv4-mapped IPv6 is unwrapped in dotted and hex form before classification.

The transport exposes only a typed operation union with fixed arguments:

| Operation | Method and path |
| --- | --- |
| `info` | `GET /System/Info/Public` |
| `login` | `POST /Users/AuthenticateByName`, credentials in the JSON body only |
| `user` | `GET /Users/{userId}` |
| `views` | `GET /Users/{userId}/Views` |
| `items` | `GET /Users/{userId}/Items` with `Recursive=true`, a mandatory `ParentId`, `IncludeItemTypes`, `Fields=ProviderIds,ParentId`, `EnableUserData=false`, an always-sent `StartIndex` (default 0) and `Limit` (default 100, explicit 1–200), optional `SearchTerm` |
| `detail` | `GET /Users/{userId}/Items/{itemId}` |
| `ancestors` | `GET /Items/{itemId}/Ancestors?UserId=...` |
| `versions` | `GET /Items/{itemId}/PlaybackInfo?UserId=...` |

There is no stream, preparation, logout, session or artwork call here.
Every request carries fixed MediaBrowser client/device/version identity, including
login without a token. Authenticated requests append `Token="..."` with
fixed client/device/version values and also `X-Emby-Token`; authentication never
travels in a query. Redirects are refused (`redirect: "error"`) even
same-origin, and no credential is forwarded. Each instance allows at most four
in-flight calls and fails the fifth fast with `busy` (no hidden queue), enforces
a 10-second deadline covering DNS, headers and body, caps the JSON body at 2 MiB
accumulated incrementally, and aborts and consumes the response and releases its
slot on every outcome. Each request owns its agent; `close()` aborts active
requests and destroys their agents. Physically unresolved DNS lookups have a
separate limit of four, retained after cancellation until the resolver settles.
An already-aborted request starts no DNS work.
The `allowLan`/`allowLoopback` policy must be exact booleans: a parsed `"false"`
is refused rather than read as truthy. Both the request-time DNS check and the
dispatcher's connection-time lookup consult `node:dns`/`node:net`, shape-check
every answer (literal address plus matching family) and check *all* of them
under the policy *before* honoring the requested family, so a name whose first
answer is public cannot answer a blocked address of the other family at socket
time. Literal IPs are checked directly because a socket may skip the lookup. A
late, uncancellable DNS result can never start a request after the deadline, and
the connection-time lookup refuses once its own request ends, so a lookup that
settles after an abort or deadline opens no socket.

## Provider

`createMediaServerProvider(kind, transport)` returns typed methods that all
accept a trailing `AbortSignal`: `verifyIdentity`, `authenticate`,
`currentAccount`, `listLibraries`, `pageItems`, `detail`, `ancestors` and
`versions`.

- `authenticate` verifies the public identity first, then consumes the login,
  checks the returned `User.Id` and, when present, `User.ServerId` against the
  public `serverId`. No password is retained and the returned token stays
  server-private.
- `currentAccount` requires an exact id match and reads `IsDisabled`,
  `EnableMediaPlayback`, `EnableAllFolders` (booleans) and `EnabledFolders`
  (string array). `RemoteAccountPolicy` carries only `disabled`,
  `mediaPlayback`, `allFolders`, `folderIds` and `hasAdditionalRestrictions`.
  That flag records *known facts* — false `EnableRemoteAccess`/
  `EnableAllDevices`, non-empty `EnabledDevices`, `ForceRemoteSourceTranscoding`,
  a non-null `MaxParentalRating`, non-empty blocked/allowed tag, folder or
  channel lists (`BlockedTags`, `AllowedTags`, `IncludeTags`,
  `ExcludedSubFolders`, `RestrictedFeatures`, `BlockedMediaFolders`,
  `EnabledMediaFolders`, …), a non-zero `RemoteClientBitrateLimit`,
  `SimultaneousStreamLimit` or Jellyfin `MaxActiveSessions`, and any non-empty
  schedule list. A *known* restriction field with a malformed value (a string
  where a list or boolean belongs, a negative or non-integer limit) is refused
  with `invalid-response` instead of being read as unrestricted. The flag is
  never exhaustive, and unknown policy fields are not proof of permission. A
  future policy authorizer must fail closed on unsupported schedules, ratings
  and the like; incomplete parental/rating/availability checking is deliberately
  not implemented here.
- `listLibraries` keeps only `CollectionFolder` entries and maps `movies` to
  `movie`, `tvshows` to `series`, and an empty/absent `CollectionType` to
  `mixed`; explicit non-movie collections (music, books, …) are dropped. A
  malformed item array shape, or more than 1024 entries, is refused rather than
  published partially.
- `pageItems` bounds the limit to 1–200 (default 100), accepts an opaque
  base64url cursor carrying the offset plus the account, library and search
  binding, and refuses a non-canonical or mismatched cursor. The cursor is
  bounded to 8192 base64url characters and 6144 decoded UTF-8 bytes, every
  decoded binding is bounded (account and library to the upstream id bound,
  search to 256), and the offset must be a safe integer no larger than `1e9`;
  every cursor the provider emits satisfies these, so a valid page-2 request
  passes cursor validation. The total must be a non-negative safe integer no
  larger than `1e9`. The page cannot exceed the requested limit or its reported
  total; an empty page before the total is refused as inconsistent. A
  continuation is issued only when `offset + count < total`.
- `detail` and `pageItems` return a projected `ProviderItem` with only `id`,
  `name`, `type`, ancestry, numbering, `providerIds` and `durationTicks`. `Path`,
  `UserData`, raw source URLs and transcode URLs are never returned. Provider ids
  are read case-insensitively: IMDb is normalized only for an exact `tt` digits
  value, other ids are positive numeric strings, and a malformed or over-512-
  character optional id is ignored.
- `versions` keeps only usable `Protocol === "File"` sources that are not
  remote, infinite, opening/closing or live, and never selects a URL. A source
  marked remote/infinite/opening/closing must carry an explicit `false` for that
  flag to count as a plain file: `"true"`, `null` or any other non-`false` value
  keeps it out. HLS is dropped case-insensitively when `Protocol`, `Container`
  or `Path` names it (`hls`, `.m3u8`), `Path` is never returned, and more than
  200 media sources is refused. IDs are validated, and all usable versions are
  kept.
- `ancestors` accepts only a bounded (at most 128) bare `BaseItemDto` array as
  both servers actually return, refuses an invented `{ Items: [...] }` wrapper or
  any non-array, and returns the item ids only. A malformed entry is refused
  rather than partially published.

No provider status fallback masks a 401, 403 or 404; a typed transport error
propagates unchanged. The provider keeps no cache and never holds a full
collection in this stage.

## Measured provider facts

The MS-0 spike ran against two disposable servers on the local ARM64 Docker VM
and recorded these exact versions and pinned image digests:

| Provider | Reported version | Pinned image digest |
| --- | --- | --- |
| Jellyfin | 12.2.0 | `jellyfin/jellyfin@sha256:357724bf0ae27a672c7cbaa899db2d9abeb13dbd8657ccce750258a4c059d037` |
| Emby | 4.9.3.0 | `emby/embyserver_arm64v8@sha256:22aeef01c017467c3e41d5f735bf93bff5745b54b7366b2df951d99efdf5f9da` |

Additional MS-1 coordinator probes measured, with the actual non-admin reader, that
`GET /Users/{id}` and item ancestors return 200 with matching ids and the
required booleans plus an `EnabledFolders` string array. After the fixture admin
disabled playback and all folders, the same reader token's `GET user`
immediately returned false/false/`[]` on both servers (policy was restored
afterwards). A disposable mixed library returned `Type='CollectionFolder'` with
`CollectionType=null` on both, which is why that maps to `mixed`. `ProviderIds`
keys are case-insensitive.

The compiled foundation was also exercised against both servers directly and
through a reverse proxy with `/jellyfin` and `/emby` prefixes. Each of the four
walks covered identity, login, current policy, three libraries, five bounded
pages, four item details and source lists, and ancestors. Token encryption and
reopening the vault, configuration attachment/removal and secret cleanup were
verified in the same walk. The reader's remote `UserData` was identical before
and after each walk. These checks cover metadata and persistence; playback
integration remains a later stage.

Critically, both servers kept serving previously known static URLs after remote
policy revocation, and `GET PlaybackInfo` still answered on Emby. **A successful
stream or `PlaybackInfo` response is never authorization proof.** Any future
playback path must independently revalidate current account playback policy,
account-visible library membership and item ancestry.

## Limits

| Field | Bound |
| --- | --- |
| Connection name | 256 chars |
| Upstream id (server/account/item/library) | 512 chars |
| Normalized URL | 2048 chars |
| Token | 8192 bytes printable ASCII |
| Grants per library | 1024 (empty until a later stage) |
| Connections | 128 |
| Remote libraries | 1024 |
| Libraries per view response | 1024 |
| Ancestors per item | 128 |
| Media sources (versions) per item | 200 |
| Page limit | default 100, explicit 1-200 |
| Paging cursor | 8192 chars, 6144 JSON bytes |
| Request body | 16 KiB |
| JSON response body | 2 MiB |
| Concurrent calls per instance | 4 |
| Physically unresolved DNS lookups per instance | 4 |
| Paging offset and reported total | 1,000,000,000 |
| Request deadline | 10 s |
| Secret envelope | 32 KiB |

## Remaining integration gates (out of scope here)

Not implemented in this stage: public routes and role allow-listing; `index.ts`
startup wiring and environment variables; user-grant enforcement; the metadata
index/cache; artwork and subtitle fetching; the actual original-media proxy and
FFmpeg transcoding; download admission; personal progress, watched, favourites
and Home integration; remote account-policy enforcement beyond fact retrieval;
and any UI or Android TV change. The foundation must never be reachable as a
playback bypass, and no release claim of media-server support is made until the
later stages land.
