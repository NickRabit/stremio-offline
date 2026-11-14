# Agent task: profile switching with a PIN

Read `AGENTS.md`, [the specification](profile-switching-spec.md),
[users.md](users.md) and [ui-conventions.md](ui-conventions.md) before
editing. The specification is the design contract; this file is its execution
order. Look at the [prototype](profile-switching-prototype/README.md) for the
intended screens.

## Goal

A signed-in device changes to another household account from a switcher, with
nothing, a PIN or the password, as the administrator chose for that account.
The administrator decides per account whether it is in the switcher, and that
one mark works both ways: only accounts in it see the profiles and may switch,
and only among themselves. Web, desktop and Android TV all get it.

## Do not

- Do not add profiles under an account, a profile id, or a second key to any
  personal data. A profile is an account.
- Do not add a start-up profile chooser, a household-device token, or anything
  that works without a valid session. The sign-in screen does not change.
- Do not check a PIN in a client, and do not keep another account's session,
  PIN or password in client state, storage or memory after the request.
- Do not persist attempt counters. Do not write the state file on a failed
  attempt.
- Do not build kids mode, avatars or age filtering here.
- Do not add the deferred "first entry on a device by password" rule or any
  per-device record. Do not split the mark into separate rights.
- Do not log or return a PIN, its hash or its length.

## Execute in this order

The slices are commits on one feature branch and one pull request, in this
order. If the work is split between agents, slice 1 lands first and its API is
frozen as specified; a later slice that needs a change to it changes the
specification in the same commit.

1. **Baseline.** Branch from current `main`. Run `npm test` and note the
   result. Read `server/src/auth.ts`, `users.ts`, `roles.ts`, `restricted.ts`,
   `revocation.ts`, `routes/auth.ts`, `routes/users.ts` and their tests.

2. **Server.** Tests first, in `server/src/routes/profiles.test.ts` and beside
   the modules they cover, written to fail before the code exists.
   - `users.ts`: the three fields, the PIN format, the effective unlock rule,
     `PublicUser`.
   - A small pure module for the per-account attempt guard, with an injected
     clock like `LoginThrottle`.
   - `routes/profiles.ts`: `GET /api/profiles`, `POST /api/profiles/switch`.
     Register it in `index.ts` next to the auth routes.
   - `routes/auth.ts`: `PATCH /api/auth/pin`, `canSwitch` and `hasPin` on
     `/api/auth/me`, clearing the PIN lock on a password sign-in.
   - `routes/users.ts`: `switcher` and `unlock` on the edit, the PIN route, the
     promotion repair.
   - `roles.ts`: the three `USER_ALLOWED` entries, with a test in
     `roles.test.ts`. Forgetting this answers ordinary accounts with 403 and
     has happened repeatedly in this project.
   - `auth.ts`: let `sessionCookie` take an explicit lifetime so the switched
     session's cookie ends with the token.
   - Error keys in `errors.ts`, `en.ts`, `cs.ts`.
   - The whole [server acceptance list](profile-switching-spec.md#acceptance).
   The switch re-checks inside the mutator after the awaited hash, the same
   way `assertStillAdmin` is used: an account disabled, removed from the
   switcher or re-passworded while scrypt runs must not be entered.

3. **Web: administration and own PIN.** The Profile switching block in the
   account dialog (`web/src/UserManager.tsx`), the marker in the user list, and
   Profile PIN in Settings -> Account. Component tests for each state: switch
   off, each unlock method, administrator without *Nothing*, set and remove.

4. **Web: the switcher.** A new component on the standard dialog shell, the
   two entry points, the confirm when playback or a device transfer is
   running, `clearHomeCache` and reload after success. Component tests for the
   choose and unlock steps, wrong PIN, wait, locked PIN, password fallback.
   One Playwright scenario with two accounts on the desktop and the phone
   projects; see [testing.md](testing.md) for where it belongs.

5. **Android TV.** `ApiClient` calls and DTOs, the switcher screen, the PIN
   pad, the Settings entry, the long-press on the rail's account item, and the
   session hand-over in `SessionViewModel`. Instrumented D-pad tests that fail
   first. Watch the composable size: a screen that grows too large fails
   bytecode verification on a device only, so keep the switcher, the pad and
   the password step as separate composables. Run `lintDebug` before pushing.
   Add the new string keys to `strings.keys`; do not edit generated resources.

6. **Documentation.** Move the behaviour into [users.md](users.md) (a new
   *Switching profiles* section and the PIN paragraphs), update the roadmap
   entry, and mark the specification as implemented with the version.

7. **Verify and deliver.** Bump the patch version as `AGENTS.md` describes.
   Build, unit tests, the end-to-end suite in the CI image, then the local
   Docker step. Visual checks once, at the end, in the viewport matrix from
   [testing.md](testing.md): the switcher and the PIN step on a phone upright
   with the keyboard open, a phone sideways, a tablet upright and a desktop;
   on the TV emulators API 28 and API 31 with the remote only. Attach
   before/after screenshots to the pull request.

## Things that are easy to get wrong

- Check the **caller's** membership as well as the target's. A guest account
  with a valid session must get an empty list and a 404 from the switch, even
  for a member whose method is `none`. Checking only the target is the
  obvious implementation and it is wrong.
- The attempt guard is keyed by the target account. Keying it by `req.ip`
  makes it useless behind a reverse proxy.
- The new session takes the **old session's expiry**. Issuing 30 fresh days
  turns a PIN into a way to stay signed in forever.
- `revoked` lives on the **previous** account's record and `lastSeenAt` on the
  target's: one `store.update`, two records.
- A target that owes a password change is not offered, and a caller that owes
  one cannot switch; the existing gate already refuses the caller.
- `unlock: "none"` on an administrator must be impossible through every path:
  the edit, the creation body, and a role change.
- The web switcher must not render the application of the new account from
  cached state. Reload.
- On a phone held sideways the keyboard takes most of the screen. Check the
  unlock step there before calling the web slice done.
- The local Docker instance on port 8090 is shared with other agents. Use your
  own port for verification and remove your containers afterwards.

## Done means

Every item of the [acceptance list](profile-switching-spec.md#acceptance) has
a test that failed before the change; the checks in step 7 are green; the
documentation describes what shipped rather than what was planned.
