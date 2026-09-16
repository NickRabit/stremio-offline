# Trailer playback specification

## Goal

Show a **Watch trailer** action for a title in both places where the product
already shows external title links:

- the catalog detail view;
- the context menu of a matched library folder or file.

The action opens a trailer inside Stremio Offline. The trailer source is chosen
in this strict order:

1. Cinemeta metadata;
2. TMDB, only if Cinemeta has no usable trailer and a TMDB API key is configured.

Do not change the existing ČSFD, TMDB, or IMDb links. They remain external
links and the trailer action is a separate button, not a `SiteLink`.

## Scope and non-goals

The input to this feature is a YouTube video ID. Cinemeta currently returns it
in both `meta.trailers[].source` and `meta.trailerStreams[].ytId`. TMDB's
`/videos` endpoints also return YouTube identifiers.

The current `Player` component and playback service cannot play a YouTube page:
they accept a direct HTTP media address, probe it with FFmpeg, and then proxy or
transcode it. Do **not** treat a `youtube.com/watch` URL as an ordinary stream,
and do not add it to `MediaResources`.

The first implementation must use a dedicated, app-owned full-screen trailer
overlay with a YouTube privacy-enhanced iframe:

`https://www.youtube-nocookie.com/embed/<video-id>?autoplay=1&rel=0`

This is an in-app trailer player, but intentionally does not provide main-player
features such as resume history, track selection, subtitles, download, AirPlay,
or FFmpeg transcoding. Do not introduce `yt-dlp`, server-side YouTube fetching,
or persistent storage of trailers in this change.

### Secure Mode

Secure Mode promises that the browser contacts only this instance. A YouTube
iframe necessarily breaks that promise, even on the nocookie host. Therefore,
do not weaken Secure Mode to make in-app iframe playback work.

Trailer discovery stays available in both modes: it is a server-to-server lookup
like the existing metadata and title-link lookups. The action changes by mode:

- when `settings.secureMode === false`, **TRAILER** opens the in-app
  `TrailerPlayer` overlay;
- when `settings.secureMode === true`, **Open trailer on YouTube** is a normal
  external link to `https://www.youtube.com/watch?v=<video-id>`, with
  `target="_blank"` and `rel="noopener noreferrer"`.

The external action follows the existing ČSFD, TMDB, and IMDb link pattern. It
does not load a third-party frame into the Stremio Offline document; opening the
separate browser tab is an explicit user navigation.

When Secure Mode is off, update `server/src/secure.ts` so the CSP includes:

```text
frame-src 'self' https://www.youtube-nocookie.com
```

Keep `frame-ancestors 'none'` unchanged: it controls who may embed Stremio
Offline, not what Stremio Offline may embed. In Secure Mode, retain the default
`frame-src` inherited from `default-src 'self'`. Add a CSP test for both modes.

## Server design

Create `server/src/trailers.ts`. Keep all source selection, validation, and
caching there; routes must remain thin.

```ts
export interface Trailer {
  youtubeId: string;
  title?: string;
  provider: "cinemeta" | "tmdb";
}

export async function trailerFor(
  addons: AddonRecord[],
  type: string,
  id: string,
  language: string,
  tmdb?: TmdbConfig,
): Promise<Trailer | null>;
```

Only `movie` and `series` are supported. Return `null` for an unsupported type,
an unrecognised ID, an unavailable provider, malformed provider data, or a
transport failure. These conditions are not API errors and must not make the
catalog detail fail.

### Cinemeta lookup

Ask only the enabled addon whose manifest ID is `com.linvo.cinemeta`; do not use
the already-merged `metadata()` result. When a TMDB key is configured,
`metadata()` starts with TMDB and `fillMissingMeta()` intentionally only carries
a fixed set of metadata fields. It neither preserves trailer data nor can enforce
the required Cinemeta-first precedence.

Use the same addon resource construction and timeout behaviour as the existing
metadata code. Cinemeta only supports the title identities it advertises, so
respect the manifest's `meta` support and `idPrefixes` before making a request.

Accept a YouTube ID only when it matches:

```ts
/^[A-Za-z0-9_-]{11}$/
```

Read these forms in this order:

1. `trailers[]` entries where `type === "Trailer"` and `source` is valid;
2. `trailerStreams[]` entries where `ytId` is valid;
3. future Stremio stream-shaped trailer entries only when a valid YouTube ID can
   be extracted without accepting a URL supplied by an addon.

Do not select a Cinemeta `Clip` when a `Trailer` is available. If no Trailer
exists, return `null` rather than silently turning the button into a clip.

### TMDB fallback

Add a focused TMDB helper in `server/src/tmdb.ts`, for example:

```ts
export async function tmdbTrailer(
  type: "movie" | "series",
  id: string,
  config: TmdbConfig,
  fetchImpl?: FetchLike,
): Promise<{ youtubeId: string; title?: string } | null>;
```

Reuse the existing IMDb-to-TMDB `resolveId()` cache. It already handles direct
`tmdb:<number>` IDs and IMDb IDs; do not query Wikidata solely for trailers.
Use `GET /movie/<id>/videos` for movies and `GET /tv/<id>/videos` for series.

From `results`, accept only records with `site === "YouTube"`, `type ===
"Trailer"`, and a valid 11-character `key`. Choose deterministically:

1. `official === true`;
2. a video in the UI language;
3. English;
4. a record without a language or the first remaining result.

Within otherwise equal candidates, use TMDB's returned order. The API request
uses the same interface language policy as existing TMDB metadata. If a language
parameter is used for series, retain fallback candidates rather than filtering
them out at the request level.

Do not return an arbitrary TMDB `Teaser`, `Clip`, `Featurette`, or a video from a
non-YouTube host. Do not leak the TMDB API key to the browser.

### Cache and invalidation

Cache a result, including `null`, by `type:id:language` for six hours. Bound the
cache (for example clear it when it exceeds 300 entries), matching `metaCache`'s
behaviour. Negative caching is important because a library menu can be opened
repeatedly.

Clear this cache whenever `tmdbApiKey` changes or UI language changes, alongside
the existing `metaCache.clear()` in `PATCH /api/settings`. Cinemeta-first results
also need invalidation on language changes because a later provider can vary its
result by language.

### HTTP API

Add these authenticated endpoints near the existing title-link endpoints in
`server/src/index.ts`:

```text
GET /api/trailer/:type/:id?language=<ui language>
GET /api/library/trailer?path=<library path>&language=<ui language>
```

Both always respond with HTTP 200 and one of:

```json
{ "trailer": { "youtubeId": "kM8I4yDQS5w", "title": "…", "provider": "cinemeta" } }
```

```json
{ "trailer": null }
```

For the library endpoint, resolve the path through `knownTitleEntry(libraryKey(...),
metaStore.qualifiedMeta())`, exactly as `/api/library/links` does. An unmatched
path returns `{ "trailer": null }` and must not trigger an online lookup.

Use `normalizeLanguage()` and the stored UI language the same way as the link
endpoints. URL-decode route parameters in the normal Express manner; the client
must still use `encodeURIComponent()` for an ID.

## Client design

### Types and API client

In `web/src/types.ts` add:

```ts
export interface Trailer {
  youtubeId: string;
  title?: string;
  provider: "cinemeta" | "tmdb";
}
```

In `web/src/api.ts` add `trailer(type, id, language)` and
`libraryTrailer(path, language)`, both resolving `{ trailer: Trailer | null }`.

### Fetch timing and state

Follow the existing links pattern in `web/src/App.tsx`:

- When opening catalog metadata, request title links and trailer independently;
  neither may delay metadata or stream loading.
- Guard the catalog trailer response with the same request-token lifecycle as
  `titleLinks`, so a late response never attaches a trailer to a newly selected
  title.
- In the library, request a trailer lazily only when the matched item's menu is
  opened. Cache the result by `item.path`, including a no-trailer result, for the
  session.
- Clear catalog trailer state on closing the detail view. Clear library trailer
  state when the UI's existing library refresh/reset rules clear link state.

Do not fetch trailers for every catalog tile or every library entry.

### Placement and interaction

Render a `TRAILER` pill beside the existing `titleLinksRow(titleLinks)` beneath
the description header. It uses the same compact shape as the IMDb, TMDB, and
ČSFD pills, with a distinct gold accent and no icon. In library menus, render it
above the existing title-link row, so the primary action is visible before
external links and management actions.

The action appears only after a usable trailer has been resolved. It must not
look enabled while the request is pending and must not leave an empty placeholder
when no trailer exists. When Secure Mode is on, render it as the external YouTube
anchor described above; otherwise render the in-app trailer button.

Clicking it opens a new `TrailerPlayer` component. The overlay must:

- be modal and full-screen, visually consistent with `Player`;
- use an iframe whose source is constructed only from the validated `youtubeId`;
- set `allow="autoplay; encrypted-media; picture-in-picture"`,
  `allowFullScreen`, and a descriptive translated title;
- include a translated Close button and close on Escape;
- stop playback by unmounting the iframe on close;
- not alter `selectedStream`, player return anchors, playback progress, or
  download state.

Use `youtube-nocookie.com`, not `youtube.com`, for the embed. The iframe is an
external third-party player; do not claim in UI text that it provides local
playback or that it is privacy-free.

### Translations

Add every visible string to both `web/src/i18n/en.ts` and
`web/src/i18n/cs.ts`, with typed keys. Expected minimum keys:

```text
trailers.watch
trailers.playerTitle
trailers.close
trailers.openHint
trailers.openOnYouTube
```

Use the same compact `TRAILER` label in English and Czech. Do not hard-code
strings in React components.

## Tests

Add focused unit tests before UI integration.

### `server/src/trailers.test.ts`

- Cinemeta's valid `trailers[].source` wins over a TMDB candidate.
- `trailerStreams[].ytId` works when the legacy array is absent.
- clips, malformed IDs, missing metadata, unsupported types, and an unreachable
  Cinemeta endpoint fall through to TMDB rather than throwing.
- Cinemeta returning no usable trailer calls TMDB only when a key/configuration
  is supplied.
- cache hits avoid a second provider request, including a cached null result.

### `server/src/tmdb.test.ts`

- movie and series use their respective `/videos` endpoint;
- direct TMDB and IMDb-resolved IDs work;
- selection prefers official Trailer, then UI language, then English;
- non-YouTube entries and non-Trailer types are ignored;
- a refused or malformed TMDB response returns `null`.

### Route tests

- catalog response has the stated envelope;
- an unmatched library path returns null without provider calls;
- a matched library record uses its stored type and ID;
- changing the key or language clears the trailer cache.

### Client tests

- catalog and library buttons render only for non-null trailers;
- clicking builds a nocookie embed URL from the ID and opens the overlay;
- closing unmounts the iframe;
- a stale catalog response cannot display a trailer for another title.
- Secure Mode renders a safe external YouTube anchor rather than an iframe;
  insecure mode permits the nocookie iframe through CSP.

Run `npm test` and `npm run build`. Then follow the repository's required Docker
verification (`docker compose up -d --build`, `docker compose ps`, container
logs, and `GET /api/status`) before opening the implementation PR.

## Acceptance criteria

1. A Cinemeta trailer is shown in catalog and matched-library contexts without a
   TMDB key.
2. If Cinemeta has no usable trailer, a configured TMDB key supplies a YouTube
   Trailer when TMDB has one.
3. Cinemeta always wins when both providers have one.
4. No trailer source, provider error, missing key, or unmatched library item
   produces a visible error or blocks ordinary title metadata.
5. With Secure Mode off, the action plays inside the app in an iframe overlay;
   it never enters the direct-stream FFmpeg player pipeline.
6. All new visible copy is translated in English and Czech.
7. With Secure Mode on, the action opens a separate YouTube tab and never adds a
   third-party iframe to the Stremio Offline document.
