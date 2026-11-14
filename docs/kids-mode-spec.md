# Kids mode

Status: proposed design contract, not implemented. Written on 2026-11-14
against `main` at `b4c4d591` (0.7.105) from two independent readings of the
code. **The decisions marked *Owner* below are proposals waiting for the
owner's answer**; nothing is built until they are settled. The execution order
is in [kids-mode-agent-task.md](kids-mode-agent-task.md).

## Goal

A child signed in to their own account can open the app, find a favourite
show, start the intended episode and get back home without adult help, and
cannot reach anything the parent did not allow: not by the interface, not by a
direct request, not by switching to another profile.

This builds on what already exists rather than adding a parallel system:

- per-account **library and addon grants**, with a hidden library answering
  exactly like a missing one ([users.md](users.md#what-an-administrator-grants));
- the two **download permissions**;
- **profile switching** with a PIN or the password
  ([users.md](users.md#switching-profiles), 0.7.104);
- **personal Home** rows, all filtered by the viewer's grants.

## Decisions

| # | Question | Proposal | Owner |
| --- | --- | --- | --- |
| 1 | How is a child marked | A flag `child: true` on an ordinary account, set in **Settings → Users** → account. Not a third role: everything a role decides today stays as it is, and the flag only takes things away. An administrator can never be a child; promoting a child clears the flag. | confirm |
| 2 | Where it is enforced | A second allow-list `CHILD_ALLOWED` in `server/src/roles.ts`, a strict subset of `USER_ALLOWED`, chosen in `roleMiddleware` from the freshly read account. Default deny, like the role gate: a route added later is closed to children until somebody opens it. | confirm |
| 3 | Addon catalogues | **Off by default.** A child sees only granted libraries (local, Jellyfin, Emby). The administrator can tick *Catalogue browsing* for one child account, which opens catalogues, search and streams of that account's granted addons. An addon is never age-filtered; the tick says so. | **decide** |
| 4 | TMDB detail extras and person pages | Off for a child. The detail shows the library's own metadata; no cast row, no similar titles, no filmography, no trailers. With catalogue browsing ticked: still off in this version. | **decide** |
| 5 | Leaving the child account | Only through the profile switcher, into an account that needs **its PIN or password**. A child never sees, and the server never lets it enter, a profile set to *Nothing*, another child, or anything outside the switcher. Sign-out is allowed and grants nothing. | confirm |
| 6 | Follows | A child may follow a series for new-episode notices. Automatic download, retention and episode retry or skip are refused. | **decide** |
| 7 | Personal settings | A child may not change any setting. The interface language, audio and subtitle languages are set by the administrator in the account dialog. | **decide** |
| 8 | Own password and PIN | A child may not change its password or PIN; the administrator does. Otherwise a child could lock the parent out of the child's account. | confirm |
| 9 | Home | At most three rows: Continue watching, favourite shows, recently added. No customisation. | confirm |
| 10 | Television | Same policy; the rail shows Home, Library, Search and the profile switch. No Settings, no Downloads. | confirm |

## What a child may reach

`CHILD_ALLOWED` keeps, from today's `USER_ALLOWED`:

- **Session:** `GET /auth/me`, `POST /auth/login`, `POST /auth/logout`,
  `GET /profiles`, `POST /profiles/switch` (with the target rule below).
- **Own rows:** progress (read, write, forget), library favourites,
  `GET /resume`, `GET /library/resume`, `GET /favorites`,
  `POST /library/favorite`, `GET /views`, `PATCH /views`, search state and
  history.
- **Libraries:** `GET /library`, `/library/browse`, `/library/mosaic`,
  `/library/gallery`, `/library/identity`, `/library/thumb`,
  `/library/next/*`, `/library/previous/*`, `POST /library/source`,
  `GET /libraries`, `GET /library/title`, every read under
  `/remote-libraries` and its personal `state`/`playing`.
- **Home:** `GET /home`, `GET /home/layout`.
- **Playing:** `/inspect`, every `/playback` route, `/shuffle`, `/media/*`,
  `/subtitle/*`, `/local-streams/*`, `/intro-segments`, `/image/*`.
- **Search:** Search everywhere and its session routes; the catalogue part of
  it only with decision 3.
- **Diagnostics:** `POST /client-log`, `POST /client-log/bundle`.

With *Catalogue browsing* (decision 3) also: `/catalogs`, `/catalog`,
`/search`, `/searchable`, `/search/catalog*`, `/meta/:type/:id`,
`/stream-sources/*`, `/streams/*`, `/subtitles/*`, `GET /addons`.

Refused for every child, whatever the ticks:

| Route | Why |
| --- | --- |
| every `/downloads` route, `/device-download*` | no downloads of any kind |
| `/library/folders` | a destination picker for downloads and moves |
| `/links/*`, `/library/links` | external sites |
| `/trailer/*`, `/library/trailer` | external video |
| `/meta/:type/:id/extras`, `/person/*` | decision 4 |
| `/follows/calendar-feed` (GET, POST) | an unauthenticated export of the child's rows |
| `/follows/:id/episodes/:key/(skip\|retry)` | queues or removes downloads |
| `PATCH /settings`, `PUT /follows/defaults` | decision 6 and 7 |
| `PATCH /auth/password`, `PATCH /auth/pin` | decision 8 |
| `PUT /addons/order` | a setting |
| `/auth/pair/inspect`, `/auth/pair/approve`, `/auth/pair/deny` | a child does not sign in other devices |

`DELETE /device-transfers*` stays open so an old transfer can be cleared.

## Rules inside handlers

The allow-list cannot see a request body. These stay in the handler:

- **Profile switch.** When the caller is a child, `GET /profiles` lists only
  targets that are not children and whose effective unlock is `pin` or
  `password`, and `POST /profiles/switch` refuses any other target with
  `err.profileUnavailable` (404), the same answer as a profile that does not
  exist. The check is repeated on the live record at write time, as the
  existing switch already does for the unlock method.
- **Follows.** `POST /follows` and `PATCH /follows/:id` from a child refuse
  `autoDownload`, a download mode and retention (`err.notAllowed`).
  `FollowService.mayQueue` also refuses an owner who is a child, so a follow
  that had automatic download before the account became a child stops
  queueing.
- **Artwork.** Reads by a child never write artwork beside the media; the
  background generation that a browse can schedule is skipped for a child
  request. The app's own cache is not a library write.

## Revocation

Setting or clearing the flag, and ticking or clearing *Catalogue browsing*,
bump the account's `permissionsVersion`, exactly like a grant change. That
signs the account's other devices out of affected work and stops playback that
relied on the old policy. `accessLost` treats the version change as revocation
for playback, search and device resources, not only for downloads.

The flag is never written into a session token; it is read from the account on
every request.

## Interface

`GET /auth/me` carries `child: true` and `catalogue: boolean`. The clients
draw from it; it is not enforcement.

### Web and desktop

- Navigation: Home, Library, Search (and Catalogue with decision 3), the
  profile switch. No Downloads, Addons, Settings, Statistics, Following or
  Favourites pages of their own; favourites are a Home row.
- Detail: Play, the episode picker and the favourite star. No download or
  save actions, no trailer, no external links, no cast or similar rows.
- Player: no download buttons; up next and resume as today.
- Touch targets at least 48 CSS pixels; a short path home from every screen.
- A play pressed twice while it starts starts once.

### Android TV

- Rail: Home, Library, Search, and the account item, which opens the profile
  switcher directly instead of Settings.
- Detail: no save-to-library or download panels, no trailer, no cast row.
- Library: no copy queueing.

## Not in this version

- Age ratings or any automatic suitability filter. A parent chooses libraries;
  granting an addon is an explicit decision and promises nothing.
- Several child profiles under one adult account; a time limit; a bedtime.
- A child-specific PIN to leave; leaving always needs the adult's own secret.

## Acceptance

Server, each a test that fails before the change:

- every route in the refused table answers 403 to a child and still answers an
  ordinary account; `roles.test.ts` pins `CHILD_ALLOWED` row by row the way it
  pins `USER_ALLOWED`;
- without *Catalogue browsing* the catalogue routes answer 403 to a child; with
  it they answer from the child's granted addons only;
- a child's `GET /profiles` omits *Nothing* profiles and other children;
  switching to one answers 404 even with a correct secret, and switching to a
  PIN profile with the right PIN works;
- a child's follow cannot be created or changed to automatic download, and an
  existing automatic follow stops queueing once the account becomes a child;
- setting the flag bumps `permissionsVersion` and stops a playback started
  before it;
- promoting a child to administrator clears the flag; an administrator cannot
  be marked a child.

Web: component tests that the child navigation and detail show only what is
listed above; an end-to-end scenario on the desktop and phone projects that a
child finds a favourite, plays it, and leaves through the switcher with a PIN.

Android TV: D-pad tests that the rail has only the child items, that the
account item opens the switcher, and that the detail has no download actions.
