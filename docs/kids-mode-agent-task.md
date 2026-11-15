# Agent task: kids mode

Read `AGENTS.md`, [the specification](kids-mode-spec.md), [users.md](users.md)
and [ui-conventions.md](ui-conventions.md) before editing. The specification is
the design contract; this file is its execution order. Do not start a slice
whose decisions in the specification are still marked **decide**.

## Do not

- Do not add a role. The child is a flag on an ordinary account.
- Do not put the flag in a session token, and do not decide anything from what
  the client says about itself.
- Do not hide a button and call it enforcement: every refusal is on the
  server, with a test that calls the route directly.
- Do not filter by age rating or guess suitability.
- Do not run Docker, docker compose or an Android emulator from a worker
  session.

## Execute in this order

The slices are commits on one feature branch and one pull request; nothing is
released until the last one lands.

1. **Server policy.** `child` and `catalogue` on `UserRecord` and the public
   user; the administrator writes them in the users route; validation (never
   on an administrator, cleared on promotion); `permissionsVersion` bump.
   `CHILD_ALLOWED` in `roles.ts` and the choice in `roleMiddleware`; the table
   in `roles.test.ts`. The handler rules: profile targets, follows,
   `FollowService.mayQueue`, artwork writes. `accessLost` for the version
   change. `GET /auth/me` carries both flags. The whole server acceptance
   list.
2. **Administrator dialog.** **Settings → Users** → account: *Child account*
   and, under it, *Catalogue browsing*, with the strings in all ten
   catalogues. The child's languages in the same dialog (decision 7).
3. **Web child interface.** Navigation, detail, player and Home as the
   specification lists; the profile switcher as the way out. Component tests
   and one Playwright scenario on the desktop and phone projects.
4. **Android TV child interface.** Rail, account item to the switcher, detail
   and library actions. D-pad tests that fail first; `strings.keys`;
   `lintDebug`.
5. **Documentation.** A *Child accounts* section in [users.md](users.md); the
   roadmap entry; the specification marked implemented with the version.
6. **Verify and deliver.** Patch version bump; unit suites, the end-to-end
   suite in the CI image, the local Docker step on a port of your own; then a
   supervised walkthrough on a phone and the TV: find a favourite, play it,
   go home, leave with a PIN.

## Things that are easy to get wrong

- **A profile set to *Nothing*.** Today any switcher member enters it without
  a secret. From a child this is the whole escape; it must be refused on the
  live record at write time, not only left out of the list.
- **Follows that already download.** An automatic follow created before the
  account became a child keeps queueing unless `mayQueue` checks the flag.
- **Two allow-lists drifting.** `CHILD_ALLOWED` must be a subset of
  `USER_ALLOWED`; pin that with a test so a rule cannot be child-only.
- **Reads that write.** Browsing can schedule artwork beside the media; a
  child's request must not.
- **Hiding instead of not calling.** A child client that still asks for
  addons, catalogues, the watchlist or the download queue gets a 403 and shows
  an error or retries for ever. Remove the call, then the control.
- **The shared television detail.** A library title opens the catalogue
  detail; with `/meta` refused it must still list the episodes from the files.
- **A child that owes a password change** can never pay it. The server clears
  the debt; do not reintroduce it in a client flow.
- **The desktop shell.** Its server menu and tray switch saved sessions
  without a secret.
- **The administrator dialog's dormant ticks.** Promoting a child clears the
  flag; demoting back does not bring it back silently.
