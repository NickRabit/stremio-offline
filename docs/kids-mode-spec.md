# Kids mode

Status: design contract. **The owner confirmed every decision below on
2026-11-15.** The server slice, the administrator switch and the child interfaces on
the web and Android TV are implemented on the feature branch. Still open: the
desktop shell's server menu, the television check on the API 28 and API 31
images, the *Child accounts* section in [users.md](users.md) and the version
bump. Nothing is
released until the last slice lands. Written against `main` at `b4c4d591`
(0.7.105). The execution order is in
[kids-mode-agent-task.md](kids-mode-agent-task.md).

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

| # | Question | Decision |
| --- | --- | --- |
| 1 | How is a child marked | A flag `child: true` on an ordinary account, set in **Settings → Users** → account. Not a third role: everything a role decides today stays as it is, and the flag only takes things away. An administrator can never be a child; promoting a child clears the flag. |
| 2 | Where it is enforced | A second allow-list `CHILD_ALLOWED` in `server/src/roles.ts`, a strict subset of `USER_ALLOWED`, chosen in `roleMiddleware` from the freshly read account. Default deny, like the role gate: a route added later is closed to children until somebody opens it. |
| 3 | Addon catalogues | **Off by default.** A child sees only granted libraries (local, Jellyfin, Emby). The administrator can tick *Catalogue browsing* for one child account, which opens catalogues, search, streams, the catalogue watchlist and follows of that account's granted addons. An addon is never age-filtered; the tick says so. |
| 4 | TMDB detail extras and person pages | Off for a child. The detail shows the library's own metadata; no cast row, no similar titles, no filmography, no trailers. With catalogue browsing ticked: still off in this version. |
| 5 | Leaving the child account | Only through the profile switcher, into an account that needs **its PIN or password**. A child never sees, and the server never lets it enter, a profile set to *Nothing*, another child, or anything outside the switcher. Sign-out is allowed and grants nothing. |
| 6 | Follows | Only with *Catalogue browsing*: a follow reads its episodes from the addons, so without the tick every follow route is refused. With it a child may follow a series for new-episode notices; automatic download, retention and episode retry or skip are refused. |
| 7 | Personal settings | A child may read its settings and the language list (both clients need them to start and the player takes its languages from them) and may not change any. The interface language, audio and subtitle languages are set by the administrator in the account dialog. |
| 8 | Own password and PIN | A child may not change its password or PIN; the administrator does. Otherwise a child could lock the parent out of the child's account. A password an administrator sets for a child is therefore final: it does not owe a change, and marking an account as a child clears a change it owed. |
| 9 | Home | Exactly three rows, fixed by the server: Continue watching, favourites, recently added. No addon feed, no customisation, and the layout the account stored before it became a child is ignored, not deleted. |
| 10 | Television | Same policy; the rail shows Home, Library, Search and the profile switch. No Settings, no Downloads. |
| 11 | Detail of a library title | Drawn from the library's own records only: name, year, description, artwork and the files. `GET /meta` stays closed without *Catalogue browsing*, so a series shows its files by season and episode number, without episode names or stills from an addon. Opening `/meta` for titles bound in a granted library was considered and left out of this version. |
| 12 | Handing the device over | The app does not lock itself into the child profile. A parent switches to the child before handing over the phone or the remote; a television left in an adult profile is an adult session. See *Not in this version*. |
| 13 | Artwork written while a child browses | Allowed, as for any other viewer; see *Rules inside handlers*. Skipping the generation for a child's request was rejected: it leaves blank tiles. |

## What a child may reach

`CHILD_ALLOWED` keeps, from today's `USER_ALLOWED`:

- **Session:** `GET /auth/me`, `POST /auth/login`, `POST /auth/logout`,
  `GET /profiles`, `POST /profiles/switch` (with the target rule below).
- **Own rows:** progress (read, write, forget), library favourites,
  `GET /resume`, `GET /library/resume`, `GET /favorites`,
  `POST /library/favorite`, `GET /views`, `PATCH /views`, search state and
  history.
- **Reading its own settings:** `GET /settings`, `GET /languages`.
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
`/stream-sources/*`, `/streams/*`, `/subtitles/*`, `GET /addons`,
`GET /watchlist`, `POST /watchlist`, `GET /source-profiles` (the player
orders addon sources by it) and the follow routes of decision 6.

Refused for every child, whatever the ticks:

| Route | Why |
| --- | --- |
| every `/downloads` route, `/device-download*` | no downloads of any kind |
| `/library/folders` | a destination picker for downloads and moves |
| `/links/*`, `/library/links` | external sites |
| `/trailer/*`, `/library/trailer` | external video |
| `/meta/:type/:id/extras`, `/person/*` (the filmography and the People search) | decision 4 |
| `/follows/calendar-feed` (GET, POST) | an unauthenticated export of the child's rows |
| `/follows/:id/episodes/:key/(skip\|retry)` | queues or removes downloads |
| `PATCH /settings`, `PUT /follows/defaults` | decision 6 and 7 |
| `PATCH /auth/password`, `PATCH /auth/pin` | decision 8 |
| `PUT /addons/order` | a setting |
| `/auth/pair/inspect`, `/auth/pair/approve`, `/auth/pair/deny` | a child does not sign in other devices |

`DELETE /device-transfers*` stays open so an old transfer can be cleared.

`roles.test.ts` names every `USER_ALLOWED` rule for a child one way or the
other, so a rule added to the ordinary list fails the suite until somebody
decides it for a child as well.

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
- **Home.** `GET /home` and `GET /home/layout` answer a child with the three
  rows of decision 9 and nothing else, also when a feed row is named in the
  request. No addon is asked.
- **Download rights.** `mayDownloadToLibrary` and `mayDownloadToDevice` are
  false for a child whatever the two ticks say; the ticks are kept and count
  again when the flag is cleared. Setting the flag therefore pauses the
  account's queued downloads and drops its device tickets and running device
  transfers, through the same path as taking the permission away.
- **Artwork (decision 13).** A child's read schedules artwork like anybody
  else's: the write is the one any other viewer of the same library triggers
  and happens once per file.

## Revocation

Setting or clearing the flag, and ticking or clearing *Catalogue browsing*,
bump the account's `permissionsVersion`, exactly like a grant change. The
moment an account stops reaching addons (it becomes a child without the tick,
or the tick is cleared) the same sweep that follows a demotion ends its addon
playback, its addon media transfers and pauses its addon downloads; a film
from a granted library keeps playing. `accessLost` refuses every later request
that names an addon.

The flag is never written into a session token; it is read from the account on
every request.

## Interface

`GET /auth/me` carries `child: true` and `catalogue: boolean`. The clients
draw from it; it is not enforcement.

### Every client

- **No refused call at all.** Hiding a navigation item is not enough: a child
  session must not *make* the calls the server refuses, at start or in the
  background. Today both clients read addons, catalogues, the watchlist and
  poll the download queue on the way in, and the web shows an error for the
  failed catalogue read. The child start-up is: `auth/me`, settings,
  languages, Home, libraries, and nothing about addons, downloads or follows
  unless *Catalogue browsing* is ticked. A test per client pins the list.
- **A detail without the catalogue.** By decision 11 the detail
  of a library title is drawn from the library alone and must not wait for, or
  show an error from, `/meta`, `/addons`, `/watchlist` or the extras.
- **The star.** On a library title it is the library favourite
  (`POST /library/favorite`); the catalogue watchlist exists only with
  *Catalogue browsing*. A star that fails after it has turned is a defect.
- **Leaving and signing out.** The profile switcher is the only way out that
  the interface offers first. Sign-out lives inside it, as its last and least
  prominent action, and is the only action when there is nobody to switch to:
  a child signed in directly, outside any switcher group, must still be able
  to leave. Signing out grants nothing, but on a television it costs the
  parent a new sign-in, so it is never one press away.
- **After a switch** nothing of the previous profile is drawn: the web already
  clears its stored Home and reloads, and the television rebuilds its session.
  The remembered start page is per browser, not per account, so a child always
  starts on Home.

### Web and desktop

- Navigation: Home, Library, Search (and Catalogue with decision 3), the
  profile switch. No Downloads, Addons, Settings, Statistics, Following or
  Favourites pages of their own; favourites are a Home row.
- Detail: Play, the episode picker and the favourite star. No download or
  save actions, no trailer, no external links, no cast or similar rows.
- Player: no download buttons; up next and resume as today.
- Touch targets at least 48 CSS pixels; a short path home from every screen.
- **Phone.** The bottom bar holds Home, Library, Search and the profile switch
  as items of their own. There is no *More* sheet for a child: today the
  switch sits inside it, and a sheet with one entry is a detour. The switcher
  and its PIN pad fit a phone held sideways without scrolling.
- **Desktop apps.** The shell can switch between saved servers from its menu
  and tray, each with its own stored session, without any secret. For a child
  session those entries are disabled, and the tray menu is reduced to showing
  and quitting the app. Until that is built the desktop app is not a place to
  leave a child alone, and [users.md](users.md) has to say so.
- A play pressed twice while it starts starts once.

### Android TV

- Rail: Home, Library, Search, and the account item, which opens the profile
  switcher directly instead of Settings.
- Detail: no save-to-library or download panels, no trailer, no cast row.
- Library: no copy queueing.
- **One shared detail.** Library titles open the same detail as catalogue
  titles since the detail was unified. For a child it has to stand on library
  data: the episode list comes from the files, the star is the library
  favourite, and the save, download, trailer, cast and similar rows are absent
  rather than empty.
- **The switcher by remote.** The adult's PIN is entered with the D-pad; focus
  starts on the first digit, Back leaves the PIN pad to the list and a second
  Back returns to where the child was, never to an adult screen.
- **Watch Next on the launcher.** The television publishes Continue watching
  to the system launcher. It is cleared on every profile switch and sign-out
  today; it must also be rebuilt when the account's policy changes while the
  session stays open. A child's own titles may be published: selecting one
  opens it in whichever profile is active, resolved against that profile's
  own list.
- **Old televisions.** The child rail and the switcher are checked on the API
  28 and API 31 images as well as API 34, with the remote only.

## Not in this version

- Age ratings or any automatic suitability filter. A parent chooses libraries;
  granting an addon is an explicit decision and promises nothing.
- Several child profiles under one adult account; a time limit; a bedtime.
- A child-specific PIN to leave; leaving always needs the adult's own secret.
- Locking a device into the child profile. A television or a phone left in an
  adult profile is an adult session (decision 12).
- Removing copies already saved to a device. A file a browser or the desktop
  app downloaded before the account became a child stays on that device; the
  server cannot reach it.

## Known limits

- **A child can delay the adult's switch.** Wrong PINs are counted per target
  profile, not per caller: after five the wait grows to fifteen minutes and
  after ten the PIN is locked and the password is needed. A child guessing
  cannot get in, and can make the parent wait or type the password.
- **Old catalogue rows are hidden, not deleted.** An account that used the
  catalogue before it became a child without *Catalogue browsing* keeps its
  catalogue positions and stars in storage; Continue watching, Favourites and
  the progress list leave them out, and they return with the tick or when the
  flag is cleared.

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
- setting the flag bumps `permissionsVersion`, stops an addon playback started
  before it, pauses the account's queued downloads and drops its device
  tickets, and leaves a library film playing;
- a child's Home has exactly the three rows and asks no addon, also when a
  feed row is named in the request;
- a password an administrator sets for a child owes no change, and marking an
  account that owes one as a child clears it;
- every `USER_ALLOWED` rule is named for a child, open or refused;
- promoting a child to administrator clears the flag; an administrator cannot
  be marked a child.

Web: a test that a child session makes none of the refused calls from sign-in
to an open detail; component tests that the child navigation and detail show
only what is listed above, on the phone layout as well; an end-to-end scenario on the desktop and phone projects that a
child finds a favourite, plays it, and leaves through the switcher with a PIN.

Android TV: D-pad tests that the rail has only the child items, that the
account item opens the switcher, that the detail of a library series lists its
episodes and has no download actions when `/meta` is refused, that the
switcher offers sign-out last, and that a child session makes none of the
refused calls.
