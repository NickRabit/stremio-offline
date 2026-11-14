# Agent task: filmography of a person

Read `AGENTS.md`, [the specification](person-filmography-spec.md),
[title-detail-spec.md](title-detail-spec.md) and
[ui-conventions.md](ui-conventions.md) before editing. The specification is the
design contract; this file is its execution order.

## Goal

Selecting a person in the title detail opens a person view with the complete
filmography from TMDB, in two sections, with the titles the household already
has in its local libraries first. Web, desktop and Android TV. Without a TMDB
key, and for a name without an id, today's name search stays and says what it
is.

## Do not

- Do not call TMDB from a client. One server route serves every client.
- Do not resolve the filmography to IMDb ids up front, and do not make an
  `external_ids` request in the person route. One title is resolved when it is
  opened.
- Do not write anything about a person to the data directory. The cache is in
  memory.
- Do not cache ownership, grants or proxied artwork with the filmography. They
  depend on the viewer and are applied per request.
- Do not ask Jellyfin or Emby whether a title is owned. That is deferred.
- Do not build the way back to the cast row, a general screen stack, a
  biography or a "People" search group. They are listed as not in this
  version.
- Do not add the person screen to the catalogue detail composable on Android
  TV. It is a separate file.
- Do not run Docker, docker compose or an Android emulator from a worker
  session. The reviewer builds and deploys once.

## Execute in this order

The slices are commits on one feature branch and one pull request.

1. **Baseline.** Branch from current `main`. Run `npm test` and note the
   result. Read `server/src/tmdb.ts`, `title-extras.ts`, `tmdb-ids.ts`,
   `routes/catalog.ts` (the extras route), `roles.ts`, `local-sources.ts` and
   their tests.

2. **Settle the open points with a real key.** The owner's instance has a TMDB
   key; ask for a way to use it rather than copying it into a file. Fetch
   `/person/{id}?append_to_response=combined_credits` for an actor, a director
   who also acts, and a series creator. Save trimmed answers as test fixtures,
   and write what you found under *Open points* in the specification. If
   `Creator` does not appear in crew rows, say so and drop it from the kept
   jobs in the same commit.

3. **Server: the person id.** Tests first.
   - `tmdb.ts`: `id` on `TmdbExtraCredit` and on what `tmdbTitleExtras`
     returns for cast, crew and `created_by`.
   - `title-extras.ts`: `id?: number` on `TitlePerson`; bump `DISK_VERSION`.
   - Every test and fixture that builds a `TitlePerson` or compares one
     deeply: `server/src/title-extras.test.ts`, the web's `TitleExtras.test.tsx`
     and `types.ts`, the TV DTO and `TitleExtrasTest.kt`. Grep for each
     construction; a harness left without the field hides the behaviour.

4. **Server: the routes.** Tests first, in a new `routes` test beside the
   catalogue ones, against the fixtures from step 2.
   - A small module for the TMDB call and the normalisation: merge, the kept
     jobs, the drops, the order, the cut. Pure where it can be, so the rules
     are tested without a server.
   - The memory cache with shared in-flight calls and an injected clock.
   - The owned set from the viewer's visible local records and `tmdbIds`.
   - `GET /api/person/:tmdbId` and `GET /api/person/title/:type/:tmdbId`,
     modelled on the extras route, with the disconnect signal passed through.
   - `roles.ts` and `roles.test.ts`: both routes in `USER_ALLOWED`.
   - Error keys in `errors.ts`.
   - The whole [server acceptance list](person-filmography-spec.md#acceptance).

5. **Web.** The person on `TitleExtrasActions`, the new `View`, the person
   view component, opening a tile through the title route, the name-search
   notice. Strings in **all ten** catalogues, written before any parallel work
   starts. Component tests as the acceptance list names them, and one
   Playwright scenario on the desktop and phone projects; see
   [testing.md](testing.md) for where it belongs.

6. **Android TV.** `ApiClient` calls and DTOs, `PersonScreen.kt`, sections on
   `PosterGrid` without changing existing callers, the shell state that holds
   the person screen under the catalogue detail, focus back on the opened
   tile. D-pad tests that fail first. Add the keys to `strings.keys` and
   regenerate. Run `lintDebug` before pushing.

7. **Documentation.** Describe the behaviour in the guide that documents the
   title detail, update the roadmap entry, and mark the specification as
   implemented with the version.

8. **Verify and deliver.** Bump the patch version as `AGENTS.md` describes;
   read `main`'s version and tags right before bumping. Build, unit tests, the
   end-to-end suite in the CI image, then the local Docker step on a port of
   your own. Visual checks once, at the end: the person view on a phone
   upright and sideways, a tablet and a desktop; on the TV emulators API 31
   and API 34 and an API 28 phone image as a crash check, with the remote
   only. Attach screenshots to the pull request.

## Things that are easy to get wrong

- **The route in `USER_ALLOWED`.** Forgetting it answers every ordinary
  account with 403 while an administrator sees nothing wrong.
- **Ownership in the shared cache.** Two accounts with different library
  grants must get different marks from one cached filmography. Test exactly
  that.
- **"None" and "failed" are different.** A title TMDB has no IMDb id for opens
  with a notice. A lookup that failed opens nothing and can be retried.
- **Old disk entries.** Without the version bump the detail keeps serving
  people without ids for a day and the feature looks broken after a deploy.
- **A person on both sides of one title.** One tile, in the crew section.
- **The clicked card is not the truth.** Take the name and portrait from the
  person route's answer, not from the cast card that was selected.
- **A key removed later.** The detail may still hold people with ids from the
  cache; the person route then answers `err.personUnavailable` and the client
  must fall back to the name search rather than show a broken view.
- **Large filmographies.** A prolific actor has several hundred credits. Cut
  on the server and do not render tiles the viewer cannot reach yet.
- **The local Docker instance on port 8090 is shared.** Use another port and
  remove your containers afterwards.

## Done means

Every item of the [acceptance list](person-filmography-spec.md#acceptance) has
a test that failed before the change; the open points are answered in the
specification; the checks in step 8 are green; the documentation describes
what shipped rather than what was planned.
