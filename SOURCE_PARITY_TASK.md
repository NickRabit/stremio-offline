# One favourite, one position, one play: the same title whatever it is played from

Task brief for an agent working in this repository. Read `AGENTS.md` first; it is the only set of
rules that governs the work. This document is a local working note (keep it out of git).

## Why

The viewer should not have to know where a title comes from. Today the same film can appear twice:
once as a file of the account's own library and once as a catalogue title, with two stars, two
continue-watching cards and two labels saying where it was played from. A film starred as a file
is not starred when it is opened from the catalogue, and a film watched from an addon is not the
same film as the copy sitting in the library.

Make one title one thing:

- one favourite per title, whichever source it was starred from;
- one saved position per title's episode, whichever source it was watched from;
- one continuous-watching card per title;
- one way to play it, and one "next" from it.

The interface never says where a title came from: not in Favourites, not in Continue watching, not
in the app and not on the TV.

## What exists today (read before changing anything)

- **Two favourite stores.** `server/src/routes/personal.ts`: `GET/POST/DELETE /api/watchlist` keeps
  starred *titles* by `type:id`; the library's own stars are paths in the account's `favorites`
  (`POST /api/library/favorite`, and `GET /api/favorites` for the Favourites page). The TV client
  reads both (`android-tv/.../data/ApiClient.kt`, `data/Favorites.kt`).
- **One progress store, two key shapes.** `server/src/routes/personal.ts` and `server/src/home.ts`:
  a library file is stored as `file:<path>`, a catalogue play as `movie:<id>` or
  `series:<id>:<season>:<episode>`. `server/src/routes/home.ts` already merges the halves of one
  title through `mergeResume`/`boundCards` when they carry the same identity, so Home's Continue
  watching is mostly right today -- the Resume page (`/api/resume`, drawn by `web/src/ResumeView.tsx`
  and the TV's `ui/resume`), the library tiles and the details are not.
- **Identity already exists.** `GET /api/library/identity?path=` (`server/src/routes/curate.ts`)
  answers which catalogue title a file or folder is bound to, and `GET /api/library/browse` marks
  the rows (`item.id`, `titleType`, `match`). A play started from a bound file already carries that
  identity into the player (`playbackIdentity` in `web/src/playback-identity.ts`, the player's
  subject in `web/src/App.tsx`), which is why progress from a library play can land on the title.
- **One player already.** A library file plays through `playLocal` and everything else through the
  catalogue path, both in the same `Player` (`web/src/Player.tsx`), and both can switch sources
  (`loadPlaybackSources`/`switchPlaybackSource` in `web/src/App.tsx`). What still differs is what
  "next" means: a file hands over the next file in its folder, a title its next episode.

## Scope

1. **Favourites become one list.**
   - Starring a library file or folder that is bound to a title writes the title's watchlist entry,
     and the file's own star state reads from it. An unbound file keeps its path star.
   - `GET /api/favorites` (and whatever the Favourites page draws from it) returns one entry per
     title: a path star whose file is bound is folded into the title's entry rather than listed
     beside it. Unbound files are unaffected.
   - The star on a library tile, on a library detail and on a catalogue detail all show that one
     state, and all write it.
   - Unstarring from either place clears it for both.
2. **One continuous-watching entry per title**, in Home's row, on the Resume page and in any other
   list that shows it (the app and the TV). A part-watched file whose title is also in the
   catalogue progress is one card, showing the position the player would resume from, and
   forgetting that card forgets every key it stands for (the server already has
   `/api/progress/forget` for that).
3. **One play flow.** Playing a bound file and playing its catalogue entry are the same session:
   the same title, the same progress key, the same "next" (a series continues with its next
   episode; a film has none). A file that is bound to a title must not offer the library's
   next-file as "next", and must not write `file:` progress while the title's identity is known.
4. **The TV client reads the same thing.** The Kotlin client must not draw its own source labels
   or its own merge: after this change both the web app and the TV show one favourite and one card
   per title. Change the client only where it disagrees with the server's answer.

## Constraints

- Branch off `main`, English everywhere (code, comments, commit, PR), one PR, version bumped for
  the user-facing change, `node scripts/check-versions.mjs` green.
- Keep the existing test layers honest: server unit tests for the store and the merge, web unit
  tests for the components that draw the star and the card, Playwright journeys for the flows that
  cross them (there is a fixtures stack with a movie, a series and a library the tests seed).
- The catalogue's own rows and the media server's rows must keep working for accounts that bind
  nothing; a title with no library copy keeps its catalogue star and progress exactly as today.
- Do not add a migration that loses an existing star or position: star files that are already
  starred must keep being starred after their title is bound.

## Definition of done

- A film starred from its file in the library shows a filled star on the same film opened from the
  catalogue, and the Favourites page holds one row for it, not two.
- The same film watched from either place shows one Continue watching card, at the position the
  player resumes from, in the app and in the TV client.
- Playing a film bound to a title from the library and playing it from the catalogue write the same
  progress key; a series continues with its next episode from both.
- No interface string, badge or label says which source a title came from.
- Tests above pass, the Docker deploy comes up healthy, and the PR is mergeable without help.

## Useful starting points

| Area | File |
| --- | --- |
| Watchlist and path favourites | `server/src/routes/personal.ts` |
| The resume/continue merge | `server/src/home.ts`, `server/src/routes/home.ts` |
| Identity of a file | `server/src/routes/curate.ts`, `web/src/playback-identity.ts` |
| Stars and lists in the app | `web/src/App.tsx`, `web/src/LibraryTile.tsx`, `web/src/FavoritesView.tsx`, `web/src/ResumeView.tsx` |
| The shared detail | `web/src/LibraryTitleDetail.tsx`, `web/src/CatalogueTitleDetail.tsx` |
| The TV client | `android-tv/app/src/main/java/cz/stremiooffline/tv/{data,ui/favorites,ui/resume}` |
