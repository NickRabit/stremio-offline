# Filmography of a person

Status: implemented in 0.7.105 on the server, the web and Android TV.
Decided with the owner on 2026-11-14, after two independent readings of the
code at `e0ccabd8` (0.7.104).
The execution order is in
[person-filmography-agent-task.md](person-filmography-agent-task.md).

## Goal

Selecting a person in the title detail shows what that person made. Today it
only submits the name as a text search, and the answer is whatever each source
does with a name: Cinemeta returns documentaries about the person and part of
the filmography, and a film the household already has is missing because the
libraries are searched by title.

This is the **first, smaller version**. It gives the complete, ordered
filmography with the household's own copies first. Since 0.7.106 Back from the
person returns to the title it was opened from, on the web and the television.

## Decisions

| Question | Decision |
| --- | --- |
| Where the filmography comes from | TMDB, read by the server. Without a TMDB key nothing changes. |
| What a person opens | A person view of its own, on the web, the desktop apps and Android TV. |
| How the filmography is divided | Two sections: acting, and directing or writing. Films and series together, each tile labelled with its type. |
| IMDb ids | Not resolved for the whole filmography. One title is resolved when it is opened. |
| Titles already owned | Marked and listed first, for **local libraries only**. |
| Leaving the title detail | The person opens over the detail, which stays as it was. Back from the person returns to that title (0.7.106; the first version left the detail). |

## What already exists

- `tmdbTitleExtras` (`server/src/tmdb.ts`) reads `credits`,
  `aggregate_credits` and `created_by`. `TmdbExtraCredit` has no `id`, so the
  person's TMDB id is dropped before `TitlePerson`
  (`server/src/title-extras.ts`) is built.
- `GET /api/meta/:type/:id/extras` (`server/src/routes/catalog.ts`) is the
  model for the new route: it normalises the language, takes a disconnect
  signal, composes what depends on the viewer after the shared TMDB part, and
  rewrites artwork through `imageProxy.rewriteExtras`.
- `tmdbIds` (`server/src/tmdb-ids.ts`, table `tmdb_ids`) keeps both directions
  of the TMDB and IMDb pairing that earlier lookups learned:
  `imdbOf(kind, tmdbId)` and `tmdbOf(kind, imdbId)`.
- `tmdbExternalIdResult` (`server/src/tmdb.ts`) resolves one TMDB id to IMDb
  and distinguishes `found`, `none` and a failure; a found pair is remembered
  in `tmdbIds`.
- A local library record carries one id: `tt…`, or `tmdb:<n>` when TMDB knows
  no IMDb id (`server/src/library-match.ts`, `library-candidates.ts`).
- The detail, the extras, local copies and media-server matching accept
  `tmdb:<n>` ids. Addon streams do not, unless the addon declares that prefix
  (`streamCandidates` in `server/src/addons.ts`).
- On the web, `searchPerson` (`web/src/App.tsx`) closes the detail and submits
  the name. On Android TV, `openPersonSearch` (`ui/shell/Shell.kt`) does the
  same with `SearchPreset(query = name)`.

Two statements in the roadmap's earlier analysis were wrong and are corrected
here: the extras' `inLibrary` check covers local libraries only, not
Jellyfin or Emby; and `/person/{id}/combined_credits` alone does not carry the
person's own name and portrait.

## Data model

`TitlePerson` gains `id?: number`, the TMDB person id. It is present for
people read from TMDB and absent for names an addon supplied. The web type
(`web/src/types.ts`) and the TV DTO follow.

Entries of the title-extras disk cache written before the change have no ids
and would be served for up to 24 hours. Bump `DISK_VERSION` in
`server/src/title-extras.ts`; an old file is then ignored and replaced on the
next read. No migration and no mass delete.

Nothing new is stored. The filmography cache is memory only.

## API

Both routes are under `/api`, need a session, and are for every signed-in
account.

### `GET /person/:tmdbId`

`:tmdbId` is a positive integer. `language` is optional and defaults to the
account's interface language, as the extras route does.

```json
{
  "id": 138,
  "name": "Quentin Tarantino",
  "photo": "…",
  "sections": [
    { "key": "crew", "titles": [
      { "type": "movie", "tmdbId": 680, "id": "tt0110912", "name": "Pulp Fiction",
        "year": "1994", "poster": "…", "role": "Director, Writer", "inLibrary": true }
    ] },
    { "key": "acting", "titles": [
      { "type": "movie", "tmdbId": 500, "id": "tmdb:500", "name": "Reservoir Dogs",
        "year": "1992", "poster": "…", "role": "Mr. Brown" }
    ] }
  ]
}
```

- One TMDB request: `/person/{id}?append_to_response=combined_credits` in the
  requested language, through the same guarded fetch, timeout and size cap as
  the other TMDB calls.
- `id` of a title is the IMDb id when `tmdbIds.imdbOf` already knows it,
  otherwise `tmdb:<n>`. The route makes **no** `external_ids` request.
- A section with no titles is left out. The section a person is known for
  (`known_for_department`: `Acting` gives `acting`, anything else `crew`)
  comes first.
- Titles are sorted inside a section: owned first, then by TMDB popularity
  descending, then by date descending, then by name.
- At most 200 titles per section, cut after sorting.
- `photo` and `poster` go through the image proxy exactly as the extras'
  artwork does. In secure mode they are proxy ids; otherwise they are the
  original addresses, as today.

**What is kept from `combined_credits`:**

- Cast rows as `acting`. `role` is the character.
- Crew rows whose job is one of `Director`, `Writer`, `Screenplay`, `Story`,
  `Teleplay`, `Novel`, `Creator`, as `crew`. `role` lists the jobs, without
  repeats.
- A title the person both acted in and has a kept crew job on appears once, in
  `crew`, with the character appended to `role`.
- Rows are merged by `media_type` and `id`. `media_type` `movie` is a film and
  `tv` a series; any other value is dropped.

**What is dropped:**

- adult titles;
- series with the TMDB genre 10767 (talk) or 10763 (news);
- cast rows whose character, case-insensitively, is `Self`, `Himself`,
  `Herself`, `Themselves`, or begins with `Self ` or `Self -`, or contains
  `archive footage` or `uncredited`;
- rows without a name.

Guest appearances are **not** filtered in this version. `episode_count` is not
a safe test (a lead in a one-part miniseries has one episode), and whether the
field is always present could not be checked without a key. See
[Open points](#open-points).

**Errors.** No TMDB key: `404 err.personUnavailable`. TMDB does not know the
id: the same `404`. TMDB failed or timed out: `502 err.personLookupFailed`.
A client treats the first as "use the name search" and the second as a retry.

### `GET /person/title/:type/:tmdbId`

Resolves one title when its tile is opened. `:type` is `movie` or `series`.

- IMDb id known or found: `{ "id": "tt0110912" }`. The pair is remembered by
  the existing code.
- TMDB has no IMDb id: `{ "id": "tmdb:500", "imdb": "none" }`.
- The lookup failed: `502 err.personLookupFailed`. It must not be reported as
  "none": the two are different facts and `tmdbExternalIdResult` already tells
  them apart.

### Owned titles

Computed for each request, never cached with the filmography:

1. Take the local library records the viewer may see, the way `localCopies` in
   `server/src/index.ts` already narrows them.
2. A record with `tmdb:<n>` counts for that TMDB id. A record with `tt…`
   counts for the TMDB id `tmdbIds.tmdbOf(kind, id)` already knows.
3. A record whose pairing is not known is not marked. No request is made to
   find out.

No file is walked and nothing is written. Jellyfin and Emby libraries are not
consulted in this version.

### Cache

Memory only, shared by all accounts, holding the TMDB part alone:

- key `person:v1:<tmdbId>:<language>:<fingerprint of the API key>`, the
  fingerprint as `keyFingerprint` in `title-extras.ts` computes it;
- 24 hours for an answer, 10 minutes for a failure, at most 200 people, the
  least recently used dropped first;
- concurrent requests for the same key share one TMDB call.

Ownership, grants and proxied artwork are applied after the cache, per request.
Nothing about a person is written to the data directory.

### Gates

- Add both routes to `USER_ALLOWED` in `server/src/roles.ts`, with entries in
  the table in `roles.test.ts`. A route missing there answers ordinary
  accounts with 403; this has happened repeatedly in this project.
- Add nothing to `MUST_CHANGE_ALLOWED` or `OPEN_PATHS`.
- Restricted mode needs no change: both are reads.
- Pass the route's disconnect signal into the TMDB call.

### Errors

New keys in `server/src/errors.ts` and all ten web catalogues:
`err.personUnavailable`, `err.personLookupFailed`.

## Web and desktop

The desktop apps load the web interface; they need no work of their own.

**Selecting a person.** `TitleExtrasActions.searchPerson` receives the person,
not only the name. With an id, the application opens the person view. Without
an id, or when the route answers `err.personUnavailable`, it does what it does
today, and the results carry one line above them: *Searched by name. This may
not be everything the person made.*

**The person view** is a layer over whatever is on screen: a catalogue
detail, a local library detail or a Jellyfin or Emby detail. Nothing under it
is closed or unmounted; it is hidden while the person is shown and gets its
scroll position back afterwards. A title opened from the person goes onto the
same stack as related titles, so closing it returns to the person. Any
navigation entry drops the layer. It shows:

- a header with the portrait, the name, and a Back control (or Escape) that
  returns to the title the person was opened from;
- one grid per section, under the headings *Acting* and *Directing and
  writing*, with the tile the catalogue grid already uses: poster, name, year,
  a *Film* or *Series* label, the role as the second line, and the existing
  in-library marker;
- a loading state, an error state with *Try again*, and an empty state.

**Opening a tile.**

- `id` begins with `tt`: open the catalogue detail as a catalogue tile does.
- `id` begins with `tmdb:`: ask `GET /person/title/…` first; the tile shows
  that it is working and cannot be pressed twice.
  - an IMDb id comes back: open the detail with it;
  - `imdb: "none"`: open the detail with the `tmdb:` id and show the notice
    *TMDB knows no IMDb id for this title. Some sources may be missing.*;
  - a failure: show the error and stay on the person view.

**On a phone** the header takes one line with a small portrait, the grids use
the catalogue's phone columns, and nothing scrolls sideways. Check it upright
and sideways.

The person view is not kept across a reload: a reload returns to the start
view, as an open detail does.

## Android TV

**Selecting a person** with an id opens the person screen; without one, or on
`err.personUnavailable`, the search with the name, as today.

**The person screen** is its own composable in its own file. The catalogue
detail composable has already hit the bytecode verifier's limit on a device
once; nothing is added to it beyond passing the person through. The screen is
held by the shell, like the catalogue detail:

- portrait and name at the top; the two sections below, each a poster grid
  with a heading. Reuse `PosterGrid` and `PosterCard`; add what the sections
  need without changing existing callers.
- focus starts on the first tile; the D-pad moves through a section and from
  one section to the next;
- OK on a tile resolves it if needed and opens the catalogue detail over the
  person screen. Back from the detail returns to the person screen with focus
  on the tile that was opened;
- Back from the person screen returns to the title detail with focus on the
  cast card that was selected. The detail and the person screen share one
  stack (`CatalogDetailStack`), so any chain of titles, people and related
  titles unwinds in order.

Loading, failure with *Try again*, and the no-IMDb notice as on the web.

Add the new string keys to `android-tv/strings.keys` and regenerate; do not
edit the generated resources.

## Not in this version

- **Owned marks for Jellyfin and Emby.** Their items carry TMDB ids, but no
  inventory of them is kept, so marking would cost one provider request per
  title and library. Deferred until an index of provider ids exists.
- A biography, a "People" group in Search everywhere, typing a name into the
  search box to get a filmography.
- A filter for guest appearances.
- Any persisted cache of people.

## Open points

Settled on 2026-11-14 from real TMDB answers committed in
`server/test-fixtures/tmdb-person/`:

- `combined_credits.crew` rows carry `job: "Creator"` for series the person
  created. `Creator` remains in the kept jobs.
- Every TV cast and crew row carries `episode_count`; a `Creator` row has none.
  Guest appearances commonly carry `episode_count: 1`, but guest filtering is
  not part of this version.
- One series can have several cast rows with different characters. They are
  merged by `media_type` and `id`, and the characters are joined without
  repeats.
- `media_type` is either `movie` or `tv`.
- Self appearances include `Self`, `Self - Guest`, `Self - Host`,
  `Self - Narrator (voice)` and `Self - "Walter White"`. Some have no genres.

## Acceptance

Server, as tests against fixtures of real TMDB answers:

- a TMDB credit keeps its person id through `TitlePerson`; an addon name has
  none; a version-1 disk entry is not served;
- the person route makes one TMDB request and no `external_ids` request;
- cast and crew on one title merge into one tile in `crew`;
- talk and news series, self appearances, archive footage and adult titles are
  dropped;
- titles are ordered owned first, then by popularity, and cut at 200;
- a local record bound by `tmdb:<n>` and one bound by `tt…` with a known pair
  are both marked; a record in a library the viewer cannot see is not, and two
  accounts with different grants get different marks from one cached
  filmography;
- no key and an unknown id answer `404`, a TMDB failure `502`;
- the title route answers found, none and failed as three different things;
- an ordinary account reaches both routes; an account owing a password change
  does not;
- concurrent requests share one TMDB call, and a failure is retried after its
  short lifetime;
- no request writes to the data directory.

Web: component tests that a person with an id opens the person view and one
without searches by name with the notice; that a `tt` tile opens the detail,
a `tmdb:` tile resolves first, and the none and failed outcomes show what they
should; that closing the detail returns to the person view. One end-to-end
scenario on the desktop and the phone projects.

Android TV: D-pad tests, each written to fail first: OK on a person opens the
person screen; the D-pad crosses from one section to the next; OK on a tile
opens the detail; Back returns to the person screen with focus on that tile;
Back again leaves it; a person without an id still searches by name.
