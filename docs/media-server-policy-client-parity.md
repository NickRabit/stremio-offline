# Media-server account policy and client parity

Status: analysis and follow-up plan, 2026-10-18.

Baseline: `main` at `28b40d52` (PR #456 and PR #457 merged), with the Android
TV playback-session follow-up still in draft PR #458.

This document is about Jellyfin and Emby servers owned by another person. It
does not claim that a client can guarantee an account will never be disabled.
It identifies the limits a server can impose, what this application currently
does, and which client behaviour is worth adding to avoid looking abusive or
bypassing the server owner's policy.

## Related work

| PR | State | What it changes |
| --- | --- | --- |
| [#456](https://github.com/NickRabit/stremio-offline/pull/456) | Merged | Reads account bitrate and stream/session limits, refuses or paces originals above the limit, and maps rate-limit/busy responses. |
| [#457](https://github.com/NickRabit/stremio-offline/pull/457) | Merged | Reports playback start/progress/stop from the web player as a normal media-server session. |
| [#458](https://github.com/NickRabit/stremio-offline/pull/458) | Draft | Adds the same session reporting to the Android TV player; needs rebasing after #457 landed. |

The event ordering in #457/#458 matters: a progress report must not arrive
after its stop and recreate a ghost session. The 60-second reporter sweep is a
fallback, not the normal path.

## What a Jellyfin or Emby server can impose

These are different concerns. A server can combine all of them.

### Account and session limits

- Disable the account or revoke its token.
- Disable remote access for the account.
- Restrict which device IDs may sign in.
- Limit the number of active sessions or concurrent video streams.
- Limit the bitrate of a remote stream.
- Lock the account after repeated failed logins.
- Control whether the user may download, delete, remux or transcode.
- Apply server-wide stream limits. Emby documents this as a server feature
  requiring Emby Premiere, separate from the per-user setting.

Jellyfin's user-management documentation lists per-device access, remote access,
parental restrictions and access schedules ([Jellyfin - Managing Users](https://jellyfin.org/docs/general/server/users/adding-managing-users/)).
Emby documents the same broad categories, including concurrent video sessions
and a remote bitrate limit ([Emby - User Customization](https://emby.media/support/articles/User-Customization.html)).
Its device approval and parental controls are separate settings
([Emby - Device Access](https://emby.media/support/articles/Device-Access.html),
[Emby - Parental Controls](https://emby.media/support/articles/Parental-Controls.html)).

### Content restrictions

- Hide libraries or individual folders.
- Hide content above a parental rating.
- Hide content with blocked tags or show only content with allowed tags.
- Hide items without a recognised rating.
- Allow access only during configured days and hours.

This is not an optimisation problem. The server owner may intentionally keep
the account from seeing particular titles, and a client must not infer those
titles from another source.

### Playback capability and transcode policy

A media server answers a playback-info request with the media sources it is
willing to offer to this device profile. The response can say:

- direct play is supported,
- direct stream/remux is supported,
- only a transcoding URL is available,
- no compatible stream exists,
- playback is not allowed,
- a rate or stream limit has been exceeded.

The PlaybackInfo response carries `MediaSources`, `PlaySessionId` and
`ErrorCode`. The documented error values are `NotAllowed`,
`NoCompatibleStream` and `RateLimitExceeded` ([Jellyfin SDK](https://typescript-sdk.jellyfin.org/variables/generated-client.PlaybackErrorCode.html),
[Emby PlaybackInfo](https://dev.emby.media/reference/RestAPI/MediaInfoService/getItemsByIdPlaybackinfo.html)).

Jellyfin's transcode documentation describes the client as sending profiles
with codecs, resolution, bitrate and other constraints; the server chooses the
best allowed playback method ([Jellyfin - Transcoding](https://jellyfin.org/docs/general/post-install/transcoding/)).

### Network and operator limits

A reverse proxy, firewall, hosting provider or fail2ban configuration can block
an address independently of Jellyfin/Emby. There is no API that makes this
visible in advance. The only safe behaviours are low request volume, bounded
concurrency and no automatic retry storm.

## Current implementation

### What #456 already does

`server/src/media-server-provider.ts` now separates quota facts from
content-visibility restrictions:

- `RemoteClientBitrateLimit` becomes `bitrateLimit`,
- the minimum non-zero value of `MaxActiveSessions` and
  `SimultaneousStreamLimit` becomes `streamLimit`,
- zero and absent values mean no limit.

`server/src/media-server-quota.ts`:

- holds one pacer per connection and source,
- carries pacing debt across sequential ranges,
- limits distinct open source keys per connection,
- shares the budget across concurrent bodies of the same source.

`server/src/media-server-manager.ts`:

- refuses an original stream above the live account bitrate limit,
- refuses an original whose bitrate is unknown while a limit exists,
- applies the same stream reservation to downloads,
- maps an upstream 429 to a bounded busy/rate-limited response.

This is a strong baseline. A local Jellyfin test with a 1 Mbit/s limit and two
sessions was successful without sending traffic to the third-party server.

### What #457/#458 already do

The web player, now merged, and the TV player in draft PR #458 report:

- `Sessions/Playing` on start,
- `Sessions/Playing/Progress` while playing, on pause, resume and seek,
- `Sessions/Playing/Stopped` on close or a 60-second idle sweep.

The transport sends a stable `DeviceId` (the connection id), the existing
MediaBrowser client identity and strict validated body fields. This makes the
account visible in the server dashboard as one ordinary playback session
instead of an unexplained static file read.

### Coverage matrix

| Owner setting or server behaviour | Current state |
| --- | --- |
| Media playback disabled | Refused before content is opened. |
| Download disabled | Download admission refused; streaming remains possible. |
| Library/folder access | Supported for visible libraries, with the existing Emby limited-folder caveat. |
| `RemoteClientBitrateLimit` | Read, enforced for originals and used to pace bodies. |
| `MaxActiveSessions` / `SimultaneousStreamLimit` | Used as a conservative local transfer cap; does not see other clients of the same account. |
| Upstream HTTP 429 / `Retry-After` | Mapped to a bounded busy state, with cooldown. |
| Playback session reporting | Added by #457 for web and #458 for TV. |
| PlaybackInfo device profile and `ErrorCode` | Missing. |
| Remote access disabled | Fail-closed as `unsupported-policy`. |
| Device allowlist | Fail-closed as `unsupported-policy`. |
| Access schedule | Fail-closed as `unsupported-policy`. |
| Parental rating, tags, unrated rules | Fail-closed as `unsupported-policy`. |
| Forced remote-source transcode | Fail-closed as `unsupported-policy`. |
| Provider-side transcode/HLS playback | Not implemented; originals only. |
| Automatic reauthentication after 401 | Not performed; the connection becomes `reauthentication-required`. |
| Interactive full-library crawl | Not performed. |

## Current gaps

### P0: PlaybackInfo capabilities and error codes

The current versions operation is a GET `PlaybackInfo` without a device profile.
The application then chooses an original file and performs local conversion.
This means it does not ask the server the same question an official client asks.

It also does not explicitly map `ErrorCode` values from PlaybackInfo. A server
can answer HTTP 200 with `NotAllowed`, `NoCompatibleStream` or
`RateLimitExceeded` and no usable media source. A generic malformed/empty
response is not an honest diagnosis and can lead to retries or repeated
playback attempts.

This is the highest-value next change. The requested task is in
[media-server-policy-client-parity-task.md](media-server-policy-client-parity-task.md).

### P1: Device approval, remote access and schedules

The policy reader currently records these as `hasAdditionalRestrictions`, and
the manager refuses the connection with `unsupported-policy`:

- `EnableRemoteAccess` false,
- `EnableAllDevices` false or a non-empty `EnabledDevices`,
- a non-empty access schedule,
- forced remote-source transcoding.

The safe principle is correct: fail closed rather than ignore a restriction.
The compatibility problem is that the UI cannot explain what the owner needs to
change. A later change should expose typed states:

- remote access disabled,
- device pending approval or not allowed,
- access schedule inactive,
- server requires transcoding,
- content policy not supported by this client.

Device approval can use the stable per-connection `DeviceId` and show it in the
connection details. It must never generate a fresh device identity to evade an
approval rule.

### P1: Server-side transcoding and forced transcode

The application deliberately reads original file sources and converts locally.
That avoids loading the remote server's CPU, but it is not enough when:

- the server forces remote-source transcoding,
- the owner disabled the relevant direct-play path,
- a server returns only a `TranscodingUrl`,
- the effective bitrate limit cannot be met by any original version.

The current fail-closed response is safer than bypassing the policy, but it
leaves compatible servers unusable. Supporting provider-side HLS/transcoding
is a separate, larger change. It must consume the server's `TranscodingUrl`,
`PlaySessionId` and required headers, not reconstruct a URL from guesswork.

### P1: MaxActiveSessions versus this app's stream counter

The app's local `streamLimit` counts distinct
`(local user, item, media source)` transfers on one connection. The server
limit is global for the remote account and may include official clients,
phones, TVs and other Stremio Offline instances.

The local counter cannot know those other clients. It should remain a
conservative local guard, but server-side refusal must be authoritative. That
requires the PlaybackInfo `RateLimitExceeded` and HTTP 429 paths above.

There is also a semantic question to verify against both products:
`MaxActiveSessions` may mean sessions rather than simultaneous video streams.
The app currently takes the minimum with `SimultaneousStreamLimit`. That is
safe for avoiding overload, but it should be documented and tested rather than
presented as exact server semantics.

### P2: Content restrictions

Ratings, tags, unrated-item rules and folder restrictions currently fail
closed. This is the correct security default. A later compatibility task must
first prove which list, detail and match endpoints already enforce the policy.

The unified search feature must never reveal a server-hidden title by joining
it with addon metadata. If a title is not returned by the remote server for
this account, search must not manufacture a remote member for it.

### P2: Downloads counted as streams

#456 reserves a quota slot for a download as well as a stream. This is
conservative and protects the server owner, but it may be stricter than the
provider's own stream accounting. Keep it unless real provider semantics prove
otherwise; do not loosen it merely to increase concurrency.

## What Nuvio and official clients do

Nuvio's current media-server implementation:

- uses a stable random device id stored locally,
- sends `Client`, `Device`, `DeviceId` and `Version` in MediaBrowser
  authorization,
- posts to `Items/{id}/PlaybackInfo` with a `DeviceProfile`, a maximum bitrate
  and direct-play/direct-stream/transcoding flags,
- checks `ErrorCode`,
- chooses direct play or a server-provided `TranscodingUrl`,
- carries the returned `PlaySessionId` into the stream URL and playback reports,
- reports start, progress, pause/resume and stop through `Sessions/Playing`.

See [NuvioTVSmart mediaServerRepository.js](https://github.com/NuvioMedia/NuvioTVSmart/blob/d18dbe07fb19a83afa57a72aaae1eeb08402afa3/js/data/mediaserver/mediaServerRepository.js)
and [MediaBrowserClient.js](https://github.com/NuvioMedia/NuvioTVSmart/blob/d18dbe07fb19a83afa57a72aaae1eeb08402afa3/js/data/mediaserver/mediaBrowserClient.js).

The official Jellyfin Android TV client reports playback start/progress/stop
with `PlayMethod`, `CanSeek`, volume/pause state and a queue, and uses the
stream identifier returned by PlaybackInfo ([PlaySessionService.kt](https://github.com/jellyfin/jellyfin-androidtv/blob/master/playback/jellyfin/src/main/kotlin/playsession/PlaySessionService.kt)).
The exact fields are less important than the contract: identify the client and
device, ask PlaybackInfo, obey its result, and report the session.

Neither Nuvio nor an official client can prevent an administrator from
disabling an account. Their advantage is that they look like a normal client,
do not bypass explicit policy, and do not continuously retry a refusal.

## Recommended order

1. Implement the PlaybackInfo/ErrorCode/PlaySessionId task in the companion
   task document.
2. Add visible policy states for device approval, remote access and schedules;
   keep the API fail-closed until each restriction has an exact test.
3. Add provider-side transcode/HLS support only if it is implemented from the
   server's returned URLs and playback session, never by synthesizing a URL.
4. Revisit parental/tag/folder compatibility after proving server-side
   filtering on a disposable local fixture.
5. Keep the new `Search everywhere` fan-out independent: no full-library scan
   on a keystroke, no request amplification, and no use of a remote item as
   authorisation for another source.

## Practical protection against an account ban

- Use your own server or obtain explicit permission from its owner.
- Do not share the account or device outside the people the owner approved.
- Keep one stable device identity per connection.
- Respect bitrate, stream, remote-access, device and content policy.
- Never retry a login, 403 or explicit policy refusal automatically.
- Respect `Retry-After` and back off on 429.
- Do not crawl a whole library or poll every remote item in the background.
- Report playback and stop it promptly; do not leave ghost sessions.
- Do not use a provider transcode URL that the server did not return.

These measures reduce obvious abuse signals. They do not override the server
owner's terms, and they cannot guarantee that an account will never be
restricted.
