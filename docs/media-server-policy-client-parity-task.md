# Implementation task: honour media-server playback capabilities and policy errors

## Goal

Make Stremio Offline ask Jellyfin/Emby the same playback question as a normal
client and obey the answer, before attempting to open an original stream.

The change should:

1. obtain playback information with a truthful device profile and the effective
   bitrate limit,
2. understand `ErrorCode` instead of treating an empty response as a generic
   failure,
3. use the server-issued `PlaySessionId` for the stream and playback reports,
4. report the actual playback method,
5. surface unsupported account restrictions without retry loops or policy
   bypasses.

Read the analysis in
[media-server-policy-client-parity.md](media-server-policy-client-parity.md)
before starting.

## Dependencies and boundaries

This task builds on:

- PR #456, already merged: bitrate, stream quota, pacing and 429 handling.
- PR #457, merged: playback session reporting.
- PR #458, optional for the web/server portion; it only adds the Android TV
  reporting side and must not block the server work.

Do not implement provider-side HLS/transcoding in this task. If the server says
that only a transcoding URL is available and the application cannot consume it,
return a precise unsupported state. Never fall back to a static original stream
after the server refused direct play.

Do not implement parental/tag filtering in this task. Keep unsupported content
restrictions fail-closed until their server-side filtering has been proved on a
local fixture.

Do not widen the media-server API surface. This is a server/provider change,
not a new browse route.

## Required reading

- `server/src/media-server-provider.ts`
- `server/src/media-server-security.ts`
- `server/src/media-server-manager.ts`
- `server/src/media-server-sources.ts`
- `server/src/media-server-quota.ts`
- `server/src/media-server-playing.ts`
- `server/src/media-server-types.ts`
- `server/src/routes/playback.ts`
- `server/src/routes/media-servers.ts`
- `server/src/api-types.ts`
- `server/src/errors.ts`
- `docs/media-server-foundation.md`
- `docs/media-server-management.md`
- `docs/media-server-policy-client-parity.md`

Branch from current `main`, which already includes PR #457. Do not duplicate
its reporter or its session route.

## Provider operation

Add one internal, allow-listed operation for a validated playback-info request.
It must be built entirely from server-owned values and cannot accept an
upstream URL, headers or a client-provided body.

A possible shape:

```ts
interface ProviderPlaybackInfoRequest {
  itemId: string;
  mediaSourceId?: string;
  maxStreamingBitrate?: number;
  startPositionTicks?: number;
  audioStreamIndex?: number;
  subtitleStreamIndex?: number;
}

interface ProviderPlaybackInfo {
  mediaSources: ProviderPlaybackSource[];
  playSessionId?: string;
  errorCode?: "NotAllowed" | "NoCompatibleStream" | "RateLimitExceeded";
}

interface ProviderPlaybackSource {
  id: string;
  name?: string;
  container?: string;
  bitrate?: number;
  supportsDirectPlay: boolean;
  supportsDirectStream: boolean;
  supportsTranscoding: boolean;
  playSessionId?: string;
  mediaSourceId: string;
  directStreamUrl?: never; // Never store or return an upstream URL.
  transcodingRequired: boolean;
}
```

The exact field names may follow the existing style. The following requirements
are normative:

- send `POST /Items/{itemId}/PlaybackInfo`;
- include the authenticated user id from the captured session;
- include `MediaSourceId` only when it is already proved to belong to the item;
- include `DeviceProfile`, `EnableDirectPlay`, `EnableDirectStream`,
  `EnableTranscoding` and `IsPlayback` with fixed validated values;
- include `MaxStreamingBitrate` when the account or application has an effective
  limit;
- include a bounded `StartTimeTicks` only when resuming;
- reject malformed or oversized responses before retaining anything;
- never parse or return arbitrary URLs, headers or provider text to the client.

The operation must be available only through the scoped media-server transport,
with the same DNS/private-address policy, abort handling, response ceiling,
429 cooldown and request accounting as other provider calls.

## Device profile

Create one pure, tested profile builder. It must describe the actual playback
capabilities of the backend, not an optimistic universal codec table and not
the browser or TV player's separate capabilities.

For this server, the backend can obtain an original file and perform local
FFmpeg conversion. That does not authorise it to claim provider transcoding is
available. In this task use:

```text
EnableDirectPlay: true
EnableDirectStream: false
EnableTranscoding: false
```

Represent a server transcode requirement as unsupported until the follow-up HLS
task. Do not request a server-side conversion that the client cannot consume.

The profile must at minimum express:

- video direct-play containers and codecs the backend can consume unchanged;
- no audio/video conversion requirement unless the server explicitly chooses
  a supported direct-play source;
- max streaming bitrate equal to `min(account bitrateLimit, application
  ceiling)` when either exists;
- no unbounded arrays or provider-controlled values.

Keep the profile in a versioned function with unit tests. Do not copy Nuvio's
hard-coded `h264/aac/mp4` profile; our backend and player capabilities differ.

## Effective bitrate

The effective bitrate is the lower of:

- `RemoteClientBitrateLimit` from the account policy, when present;
- the application's configured original-stream ceiling, if one is introduced;
- no explicit value when both are absent.

Rules:

- Never send a bitrate above the account limit merely to persuade the server to
  direct play.
- A source with a known bitrate above the effective limit must not be opened.
- A source with an unknown bitrate remains refused while a limit exists,
  regardless of a direct-play flag in the provider response.
- A server-side `RateLimitExceeded` is authoritative even when the local quota
  thinks a slot is free.

## ErrorCode mapping

Map the provider's playback error to a fixed internal error and a translated
client response. Do not expose provider strings.

| Playback error | Local result |
| --- | --- |
| `NotAllowed` | 403 `err.mediaServerRestricted` or a more specific existing media-server key |
| `NoCompatibleStream` | fixed "server cannot provide a compatible stream" state; no retry |
| `RateLimitExceeded` | 429 `err.mediaServerBusy`, with bounded `Retry-After` when present; otherwise use the existing 30-second cooldown |
| malformed response | 502 unavailable/invalid-response, never a retry loop |
| disabled account | existing forbidden/disabled behavior |
| remote access disabled | typed `remote-access-disabled` state |
| device not approved | typed `device-not-approved` state |

An explicit `NotAllowed`, `NoCompatibleStream` or device/remote-access refusal
must not be retried automatically. `RateLimitExceeded` may be retried only by an
explicit user action after the bounded cooldown.

## PlaySessionId

Use the server-issued `PlaySessionId` when the response provides one:

- put it into the original stream request where the provider requires it;
- use it in `Sessions/Playing`, `Progress` and `Stopped`;
- preserve the existing locally generated id only as a compatibility fallback
  when the server omits one;
- bind the id to the exact item and media source;
- discard it when the media source or connection generation changes.

Do not expose the id as a reusable public resource or put it in a client URL.

## Playback reporting

After PR #457 is in the branch:

- set `PlayMethod` from the actual path:
  - `DirectPlay` for an original static stream,
  - `DirectStream` only when a server-provided direct-stream path is used,
  - `Transcode` only when a provider transcode path is used;
- set `CanSeek` to the truth for the chosen path;
- include the server-issued `PlaySessionId`;
- never report a start for a source that was refused by PlaybackInfo;
- send a stop for an idle, failed or abandoned session;
- keep report ordering and failure handling from #457.

Do not add a new playback session model or a second reporter. Extend the
existing contract.

## Device, remote access and schedule diagnostics

This task should not silently convert every restriction into
`unsupported-policy`. Add typed policy facts for:

- `EnableRemoteAccess === false`;
- `EnableAllDevices === false` with a non-empty `EnabledDevices`;
- an access-schedule list that is present and non-empty;
- `ForceRemoteSourceTranscoding === true`.

For device access:

- use the stable connection `DeviceId`;
- compare it against the server-reported approved device list when that list is
  available;
- if it is not in the list, return a device-approval state;
- show the same stable id in the admin connection details so the server owner
  can approve it;
- never generate a new id to bypass approval.

For remote access and schedules:

- report the state to the authenticated client with a fixed key;
- do not poll repeatedly while the restriction is active;
- do not retry a forbidden login or stream open;
- allow the user to retry manually after the condition changes.

Content restrictions (rating/tags/folder lists) remain unsupported in this
task and must continue to fail closed.

## Security and authorization

- Re-read the local account, grant, connection generation and secret after every
  await, as the existing manager does.
- Re-check the account policy after a successful PlaybackInfo response and
  before opening the original.
- Keep the existing 30-second session-facts cache; document that a tightened
  upstream limit may take up to that window to affect new opens.
- Count the PlaybackInfo call and all playback reports in provider statistics.
- Do not log query strings, tokens, URLs, upstream error bodies or account
  identifiers.
- Do not automatically reauthenticate after a 401. Mark the connection as
  `reauthentication-required`.

## Tests

### Provider tests

- exact POST path and fixed body shape;
- no unknown body fields;
- bounded device profile;
- effective max bitrate from account policy;
- `ErrorCode` mapping for all three values;
- malformed/missing media-source response;
- PlaySessionId propagation;
- direct-play, direct-stream and transcode-required source classification.

### Manager and route tests

- PlaybackInfo refusal happens before any original stream is opened;
- a refused source never reports `Sessions/Playing`;
- a valid start uses the returned PlaySessionId;
- progress and stop use the same id;
- 401 marks reauthentication and does not retry;
- 429 sets the cooldown and returns a bounded busy response;
- remote access disabled, device-not-approved, access schedule and forced
  transcode have distinct stable errors;
- ordinary/restricted accounts and revoked grants cannot reach a stream.

### Fixture tests

Use disposable local Jellyfin and Emby fixtures only. Never test against a
third-party server.

- user with a 1 Mbit/s limit and 2 sessions;
- device allowlist containing and excluding the connection DeviceId;
- `NotAllowed` response;
- `NoCompatibleStream` response;
- `RateLimitExceeded` response;
- response with a PlaySessionId and direct-play source;
- response with only a TranscodingUrl (must fail closed in this task);
- malformed JSON and oversized body.

### Regression tests

- existing #456 quota/pacing tests;
- existing #457 session reporter tests;
- existing catalog, library and home tests;
- no changed `/api/search`, `/api/catalog` or library browse behavior.

## Acceptance criteria

The task is complete when:

1. playback uses a validated POST PlaybackInfo request with a truthful profile;
2. the effective bitrate is supplied to the provider and still enforced locally;
3. `ErrorCode` never becomes an unclassified malformed response;
4. a refused playback opens no original stream and sends no playing report;
5. successful playback uses the provider's PlaySessionId when available;
6. direct-play and transcode-required are reported truthfully;
7. device/remote-access/schedule restrictions produce stable, actionable errors;
8. no automatic retry occurs for 401, 403, NotAllowed, NoCompatibleStream or an
   active schedule;
9. all unit and integration tests pass, including the disposable server tests;
10. documentation and provider statistics reflect the new operation.

## Validation

Run the normal project gates:

```bash
npm test
npm run build
node scripts/check-versions.mjs
```

Use the local Docker setup from `AGENTS.md` for a functional health check. Do
not point the test suite at a third-party Jellyfin/Emby server.

## Deliverables

- Provider and transport changes with a strict operation contract.
- Manager and route error mapping.
- PlaySessionId propagation and truthful playback method.
- Typed policy states for remote access, device approval, schedules and forced
  transcode.
- Tests and fixture coverage.
- Updated media-server docs.
- Patch version bump because this is a user-facing compatibility fix.

## Explicitly deferred

- Provider-side HLS/transcode playback. This needs a separate design for
  consuming server-issued `TranscodingUrl`, HLS proxying, retries and cleanup.
- Full parental-control/tag compatibility.
- A WebSocket session/remote-control loop.
- Any "unban" or policy-evasion behavior.
- Any change to Jellyfin/Emby library scans or full-library indexing.
