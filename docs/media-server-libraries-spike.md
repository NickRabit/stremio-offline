# Read-only provider feasibility results

Measured on 2026-10-12. This verifies a developer transport candidate, not
production integration or a minimum supported server version. See the
[product contract](media-server-libraries-spec.md), [analysis](media-server-libraries-analysis.md),
[delivery tasks](media-server-libraries-tasks.md) and [Nuvio source review](media-server-libraries-nuvio.md).

## Environment

Two disposable official server images ran in a separate Docker Compose project,
`stremio-media-spike`, on the local Docker Linux VM (ARM64). Media was mounted
read-only. Configurations, random credentials and synthetic media remain local
under `.ai-team/tasks/MEDIA-SPEC/docker/`; none belongs in git or ordinary
configuration exports. The existing application containers were not replaced.

| Provider | Reported version | Pinned image |
| --- | --- | --- |
| Jellyfin | 12.2.0 | `jellyfin/jellyfin@sha256:357724bf0ae27a672c7cbaa899db2d9abeb13dbd8657ccce750258a4c059d037` |
| Emby | 4.9.3.0 | `emby/embyserver_arm64v8@sha256:22aeef01c017467c3e41d5f735bf93bff5745b54b7366b2df951d99efdf5f9da` |

[Jellyfin's container documentation](https://jellyfin.org/docs/general/installation/container/)
identifies its official image; [Emby's Docker page](https://emby.media/docker-server.html)
identifies the ARM64 repository. These particular digests were pulled and
reported the versions above. Latest tags were used only to discover the images;
the test composition pins digests.

Fixture setup, using administrator-only startup/user/library/policy/refresh
operations, was separate from the read-only runner. It created movie and series
libraries plus a non-administrator reader account with remote transcoding,
remuxing and content deletion disabled. Those setup writes are not production
adapter permissions. Separate checks temporarily changed only this disposable
account's policy and restored it afterwards.

The small fixture was the repository's `e2e/fixtures/media/sample.mp4`, copied
into a movie and S01E01 episode. A second identical small movie version and a
30-second generated H.264/AAC test-pattern/sine version established version
enumeration and distinct original selection. An English SRT fixture contained
one synthetic cue. A local streaming HTTP reverse proxy exposed both providers
under `/jellyfin` and `/emby` on port 18098, preserving Range and cancellation.

## Measured transport candidate

Use `Authorization: MediaBrowser ... Token="..."` for authenticated requests.
The runner additionally sends `X-Emby-Token`; the token never appears in a query
string. On tested Jellyfin, a MediaBrowser header without its Token field plus
only `X-Emby-Token` returned 401; including Token worked on both servers.

The tested API allowlist is:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/System/Info/Public` | Version and server identity |
| POST | `/Users/AuthenticateByName` | Authenticate; password only in JSON body |
| GET | `/Users/{userId}/Views` | Account-visible libraries |
| GET | `/Users/{userId}/Items` | Bounded discovery/index pages |
| GET | `/Users/{userId}/Items/{itemId}` | Details and history snapshots |
| GET | `/Items/{itemId}/PlaybackInfo?UserId=...` | Read media-source metadata |
| HEAD/GET | `/Videos/{itemId}/stream?Static=true&MediaSourceId=...` | Selected original file |
| GET | `/Videos/{itemId}/{sourceId}/Subtitles/{index}/Stream.srt` | External subtitle |
| GET | `/Sessions` | Diagnostic fixture session/transcode observation |

The runner has no setup, media mutation, watched/favourite update, remote
transcode/remux, POST PlaybackInfo or `Sessions/Playing*` call. It rejects absent
`Static=true`/media-source ID before network access, redirects, non-loopback
origins and path escapes; requests and response sizes are bounded. It only
accepts ordinary File sources without live/open/close requirements.

[Emby's GET PlaybackInfo reference](https://dev.emby.media/reference/RestAPI/MediaInfoService/getItemsByIdPlaybackinfo.html)
documents the metadata GET separately from its POST preparation API. No POST
preparation, playback-session report or remote cleanup mutation was needed for
this static-file candidate. Logout was tested separately to invalidate a fixture
token, not as playback stop reporting.

## Results

The committed runner completed 16 successful runs: three movie versions and one
episode on each provider, directly and through the reverse-proxy base path.
Each run authenticated the non-admin reader, enumerated views, read the selected
item/source, checked HEAD length and two 32-byte ranges, and compared remote
history before preparation, immediately afterwards and after all reads.

| Check | Jellyfin 12.2.0 | Emby 4.9.3.0 |
| --- | --- | --- |
| Authentication and account-visible views | Passed | Passed |
| Movie and S01E01 metadata | Passed | Passed |
| Three selectable movie media sources | Passed | Passed |
| Static HEAD: exact original length | Passed | Passed |
| Range 0–31 and 32–63: 206, exact Content-Range/bytes | Passed | Passed |
| Different-size generated version selected explicitly | Passed | Passed |
| Reverse-proxy prefix for metadata/media/subtitles | Passed | Passed |
| External SRT, exact fixture text (additional manual comparison) | Passed | Passed |
| Five history fields unchanged across runner snapshots | Passed | Passed |
| No fixture NowPlayingItem or remote TranscodingInfo after reads | Passed | Passed |
| Interrupted large-file read: fetch abort observed | Passed | Passed |
| History unchanged after interrupted read | Passed | Passed |
| Revoked authentication token refused with 401 | Passed | Passed |

Compared history fields: PlaybackPositionTicks, Played, PlayCount,
LastPlayedDate and IsFavorite. Cancellation was an additional real-server
probe using AbortController on the generated file, then a history/session
re-read. The committed runner itself honestly labels cancellation untested;
its bounded range reads are not evidence of mid-stream cancellation. The
additional probe observed a client-side aborted reader and no active playback
or history change; it did not instrument provider-internal socket cleanup.

The SRT index was 0 on Jellyfin and 2 on Emby for the small movie. This is
concrete evidence that provider indices must not be assumed identical to
ffprobe's video/audio/subtitle indexing.

## Authorization finding: static bytes are not proof of access

Using the reader token, fixture setup changed account policy to hide the movie
library and disable media playback, then requested a previously known movie ID.
The policy change was confirmed by an administrator read. Account-visible Views
changed too: Jellyfin showed only the selected show library; Emby returned no
visible libraries in this probe.

| Request after the policy change | Jellyfin | Emby |
| --- | --- | --- |
| User-scoped item detail | 404 | 200 |
| GET PlaybackInfo | 404 | 200 |
| Known original static stream | 200 | 200 |

Emby's returned source flags still advertised direct play/stream/transcoding in
this probe. Successful detail/PlaybackInfo responses and source flags therefore
cannot alone establish current remote policy. These observations describe the
tested versions/configuration and existing reader token, not every deployment.
The temporary policy was restored after each check. Logout invalidated the
reader token on both servers; its next Views request returned 401, and a fresh
login restored the fixture.

Before production, the adapter must independently obtain current account
playback policy, verify selected-library membership in current authorized Views,
validate item ancestry and enforce those checks before original reads. This
requires an additional read endpoint such as user policy retrieval, which is
not silently added to the spike allowlist. Test that endpoint and effective
restrictions in MS-1/MS-3. A local administrator must never override remote
account restrictions. Remote revalidation must also cover active sessions;
local grants/connection generation changes revoke immediately.

This is an open production authorization gate, not a passed security claim.
Known static URLs continuing to work is exactly why our backend cannot just
relay a provider's playable candidate indefinitely.

## Reproducing the developer runner

Provision disposable servers using the pinned images, mount synthetic media
read-only, and create a separate reader account. Supply its credentials through
environment variables using the local secret mechanism; do not put passwords
on command lines or in tracked files. Discover the fixture item ID and subtitle
index using that account. Then run:

```sh
node --check scripts/media-server-spike.mjs
node --test scripts/media-server-spike.test.mjs
node scripts/media-server-spike.mjs \
  --provider jellyfin --url http://127.0.0.1:18096 \
  --item-id <fixture-item-id> --fixture <exact-local-fixture.mp4> \
  --subtitle-index <external-srt-index>
node scripts/media-server-spike.mjs \
  --provider emby --url http://127.0.0.1:18097/emby \
  --item-id <fixture-item-id> --fixture <exact-local-fixture.mp4>
```

An optional `--base-path` supports a reverse proxy when the URL does not already
include the prefix. The API export additionally accepts a specific
`mediaSourceId` for variant checks. CLI reports are structured JSON without
tokens/passwords/authenticated URLs; exit status is nonzero for required
failed/unsupported checks. The HTTP fixture suite runs in CI.

## Explicit limits and next step

No production adapter, local grants, opaque source integration, credential
store, download enforcement, local progress, Home/search UI or Android TV
integration is shipped by this spike. Browser/desktop/TV end-to-end playback,
long-running codecs, embedded/burn-in subtitles, large-library resource limits,
DNS rebinding, remote schedules/ratings and precise remote socket cleanup remain
release gates for later tasks. No screenshot baselines changed.

The original-media/history candidate is feasible for ordinary files on these
two versions. Proceed to MS-1 using the measured GET/static path and separately
resolve the remote-policy authorization gate. Do not advertise a general
minimum version or full read-only integration from this result.
