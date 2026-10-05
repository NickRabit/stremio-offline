# Home: review and responsive design

Status: proposed, not implemented. Reviewed 2026-10-05 against `main`
`3b613fc` (0.5.8). This is an additive review of
[PR #302](https://github.com/NickRabit/stremio-offline/pull/302), not a second
implementation. Apply the decisions below when revising its Home specification;
where they differ, these are the proposed replacements. No runtime or release
version change is included.

## Keep the direction

Home is a personal overview: Downloads, Continue watching, Ready to play and
Favourites. Keep the catalogue as the default landing view. Keep horizontal
shelves, existing artwork and the charcoal/coral visual language. Avoid a hero,
an extra search box, global statistics and nested vertical scroll containers.
An empty queue disappears; a busy queue occupies only one shelf.

## Findings that must be resolved before implementation

| Finding | Evidence on the reviewed main | Proposed correction |
| --- | --- | --- |
| Follow show is no longer a future dependency. | `web/src/App.tsx` has `following`, `newEpisodes`, `FollowingPage` and `NewEpisodesRow`; `server/src/routes/follows.ts` exposes `/api/follows/new-episodes`. | Retain Following as a navigation destination. Reuse the existing row in a later Home slice after checking its grant semantics; do not design another following service. |
| The existing endpoints do not satisfy the promise of no addon requests and no disk reads. | `/api/progress` awaits `cachedMeta` for every owed marker before slicing to 40; `/api/library/resume` resolves stored paths before paging and removes `seriesKey` from its response. | Say “no recursive scan or new addon discovery on Home.” Existing resolution may touch storage and cached metadata may miss. Bound the Home read path explicitly; a client-side 20-card slice is not a server work bound. |
| A merged resume shelf has neither a complete identity nor a complete destination. | Local resume and catalogue progress currently have different grouping rules and different full-list views. `:resume` only covers library items. | Add a canonical identity and a unified full-list destination before claiming one card per show, an exact total or unified Show all. |
| The addon permission statement is stronger than the current code. | `/api/progress` applies `allowedAddons` to next-episode markers; its stored-progress filter checks paths, not `addonKey`. | Cover stored catalogue progress as well as markers with server-side visibility checks before selecting or counting. Client presentation filters do not establish permission. |
| The duplicate-check dependency needs a fresh assessment. | `server/src/downloads.ts` already uses `ownedBy(job, ownerUserId)` in URL, torrent and pending-video duplicate checks. | Recheck the landed behavior and cross-account tests instead of retaining #294 as an unconditional blocker. |
| Adding Home now produces eight admin destinations, not seven. | Main already adds Following to catalogue, library, downloads, addons, settings and admin statistics. | Introduce a five-slot compact navigation with More. Do not squeeze eight items into a 293 px rail or a phone bottom bar. |
| Missing files contradict “Ready to play.” | The original proposal retains missing files in this shelf as unavailable. | Only playable, accessible files belong here. Missing files stay actionable through Downloads; a stale card that disappears after rendering gets an inline unavailable result and refresh. |

These are design/contract findings, not claims that the unimplemented Home view
currently causes production regressions. Sources are the named files at the
reviewed commit; recheck them when starting each slice.

## Navigation and responsive layout

One permission-aware destination model drives every presentation. Desktop keeps
all allowed destinations in its labelled sidebar. Compact navigation has exactly
**Home, Catalogue, Library, Downloads, More**. More contains Following, Addons,
Settings and Statistics for administrators only. When a secondary destination is
active, More is marked active and announces that destination. Give More an
accessible new-episode indicator when Following has updates, using only the
account's visible data.

On a phone, More opens an accessible sheet; in landscape or tablet rail mode it
opens an anchored menu. Use the existing dialog/focus handling, close with Escape
or a selection, restore focus to the trigger and allow the menu itself to scroll
in a short viewport. Keep account and sign-out controls reachable from that
surface too when their existing chrome is suppressed. No hover-only actions.
A five-slot rail needs 220 px for 44 px targets; with 8 px padding at either end
it fits 293 px without a brand or account block consuming the remaining height.

| Viewport | Navigation | Home content |
| --- | --- | --- |
| PC, 1440×900 and 1280×760 | Existing labelled sidebar | One content column; bounded shelves span the available width. Queue cards approximately 240 px; landscape media cards 200–224 px. |
| Tablet portrait, 820×1180 | Compact rail, 64–72 px | Touch-sized shelf controls and 180–200 px landscape cards. No permanent secondary panel. |
| Tablet landscape, 1180×820 | Labelled sidebar | Same hierarchy as PC, 200–224 px media cards and touch targets. |
| Phone portrait, 390×844; also 320 px wide | Five-slot bottom bar | 16 px gutters, 12 px shelf gaps, media cards around 144 px; about 2.3 cards at 390 px and 1.9 at 320 px. Queue cards around 244 px for readable actions. |
| Phone landscape, 844×390 and 802×293 | Five-slot rail; compact top chrome | 12 px gutters; 144–168 px media cards, 16:9 art. Full title/action area remains readable. Aim to expose the first complete shelf in 293 px; lower shelves use ordinary document scrolling. |

Follow the project's existing 700 px and 980 px breakpoints and short-landscape
rule, then validate the listed geometries. Use available width and height rather
than device detection. Leave safe-area space at the rail, bottom bar and content
edges; include the bottom bar in scroll padding. At 200% zoom, let headings wrap
instead of forcing a heading, count and Show all into one line. Card actions
remain at least 44×44 CSS px even when the artwork gets smaller.

Preserve each shelf's horizontal offset when returning from playback, and the
page's vertical offset when returning from another view. Polls must not reorder
focused or actively touched cards; apply a pending reorder after interaction
ends. A second Home activation resets the page and its shelf offsets.

## Queue shelf

Keep one horizontal shelf, with text-first cards rather than large posters.
Each card shows title, episode if known, state, a progress bar only when meaningful,
and one primary action. On wide screens, add rate and destination when useful.
Do not invent an ETA when size or rate is unknown.

Priority: failure or blocked dependency; manual pause; checking/downloading;
waiting; queued. Within a group use persisted queue order, then job ID as a
stable tie-breaker. A changing byte count must not reorder cards. Completed jobs
leave this shelf; they may enter Ready to play after file resolution.

- Failed: Retry, with the failure reason visible as text.
- Manually paused: Resume.
- Storage/library/permission blocked: show the reason and Open downloads;
  resuming must not imply that Home can repair a missing grant or disabled library.
- Checking/downloading/waiting/queued: Pause when the existing action supports it.
- Card title and Show all open Downloads. Make Home's Show all owner-filtered,
  including for administrators; add that filter if the existing view lacks it.
- Mutations disable only that card while pending. Failure stays on that card;
  restore its prior state. Cancel remains in Downloads.

Use sibling native buttons for the title and action, never a clickable parent
containing another button. Do not announce every progress poll to screen readers.
Announce the result of a user action and meaningful state transitions.

## Continue watching: identity and truthful actions

A local in-progress file says **Resume** and displays progress. A catalogue entry
says **Open episode** (or Open title for a film) because opening metadata does not
guarantee immediate playback. A pending next episode says **Next episode** and
has no fabricated 0% progress bar. Always include episode numbering when known.
Respect `showResumeRow` and each library/addon's `showInContinueWatching` setting.

The final merged contract must supply a stable card ID, source, progress keys,
optional canonical metadata identity, target and freshness timestamp:

1. Filter permissions and visibility preferences first, on the server.
2. Deduplicate identical local paths using the qualified library ID and path.
3. Group a show only by a verified canonical series identity. Do not match names,
   guess seasons or strip metadata namespaces. Unknown identities remain separate.
4. For a known show, the newest actual playback wins; a playable local copy wins
   only when the episode and timestamp agree. A pending next episode never
   replaces unfinished playback of that show. Break remaining ties by stable ID.
5. Sort by playback/marker timestamp descending, tie-break by ID, then take 20.
   Do not use a download's completion time as a viewing timestamp.

The client cannot fully implement step 3 with the current library response.
Introduce the identity in the Home server contract, or keep **Local** and
**Catalogue** as explicitly labelled subgroups in the first slice. Do not promise
perfect deduplication from title text. The final mockup depicts the merged state.

Show all must open a Home resume list containing the same merged items and
ordering, with pagination. Until that exists, offer separate **In library** and
**In catalogue** destinations and avoid an exact merged count. Ready to play's
Show all similarly needs the same resolved owner-scoped list, not the generic
library root. Favourites can reuse the existing library favourites destination.

Removal needs an explicit product decision: the existing
`DELETE /api/progress/:key` forgets progress and can remove a next-episode marker.
For the first slice, name the action **Forget progress**, explain that the saved
position will be lost and require confirmation before calling the existing API.
A later **Hide from Home** action needs a separate per-account dismissal contract
and must preserve the position. Do not label a destructive forget as a harmless
hide. For merged cards, forget all represented keys in one owner-scoped operation;
a failure must not leave an apparently removed show that reappears next poll.

## Data, failure and loading boundaries

Introduce a discriminated Home card union (download, local resume, catalogue
resume, next episode, completed file, favourite) with actions valid for that kind.
Do not expose raw server filesystem paths. Row responses distinguish success,
partial success and failure. An error row has no pretend empty count. A partial
row may retain usable local cards while catalogue enrichment is unavailable;
its Retry retries that source without clearing the local cards.

If using exact `total` and `truncated`, calculate both after visibility and
identity resolution over the complete eligible set, not a previously capped
endpoint. If the cost is not bounded, return a cursor/`hasMore` and omit `total`.
Never assert “at most 20 stat calls” while also promising an exact playable total
over arbitrary completed history. Limit candidate reads, metadata concurrency
and each dependency timeout separately; choose numeric budgets from measurement
before implementing the endpoint. Timeouts leave the next-episode marker intact.

Home opening must not trigger a scan or a fresh follow-discovery cycle. Fetch
local and catalogue sources independently so a slow addon cannot hold the page.
Give each first-load shelf a fixed-height skeleton. During refresh keep existing
cards with a quiet loading state. A first-load global empty state appears only
when all applicable sources have successfully answered empty. A failed or still
loading source is not an empty account.

On account switch, discard all Home state and in-flight responses. On grant loss,
remove cards, artwork, counts and cached totals for the revoked source before
rendering another stale response. Validate permission again at every action.
Use the existing restricted-account gate: a restricted account does not mount
Home or issue its requests. Apply `private, no-store` to the Home endpoint.

## Delivery and acceptance

1. Resolve compact navigation and owner filtering; ship the Home shell and queue.
2. Ship independent local/catalogue resume reads with truthful action labels and
   source destinations, or include the server identity contract and unified list
   in this slice. Fix stored-addon visibility before exposing these entries.
3. Add resolved Ready to play, its full-list route and refresh on job completion.
4. Add library Favourites; optionally reuse the existing NewEpisodesRow below it.
5. Persist first-seen data for Recently added separately. Row customization and
   opt-in landing remain later work.

All interface text goes through the locale catalogue. Validate every currently
present locale; do not hard-code the old count of ten. Add keys for More, source
labels, Open episode, unknown progress, partial loading, Forget progress and its
confirmation as needed, reusing equivalent existing keys first.

Functional gates: two accounts and admin ownership; revoked addon/library;
identical show across local and catalogue records; unknown identity; next episode
versus unfinished episode; missing completed file; one source timeout; queue
mutation failure; account switch during fetch; correct full-list targets; and
forgetting a merged card without losing unrelated progress.

After those gates are stable, run visual/accessibility checks once across the
viewport matrix above, plus the existing WebKit landscape project. Verify 44 px
touch targets, keyboard access to shelf overflow, More focus/escape, long German
and Czech labels, 200% zoom, safe areas, no page-level horizontal overflow, and
restored offsets after playback and rotation. Validate busy, empty, partial,
failed and revoked states. Mockups are layout proposals, not evidence that the
application has passed these tests.
