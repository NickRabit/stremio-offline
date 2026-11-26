# Responsive UX audit · 26 November 2026

## Scope and walkthrough plan

The subject was the Czech web interface on the local Docker deployment, version 0.7.165. The source reference is `4ebf9b23`. The walkthrough used a signed-in administrator with local and remote libraries, installed addons, watch history and a completed download.

1. Visit each of the eleven primary views at 1440 × 900, 820 × 1180, 390 × 844 and 844 × 390. Enter secondary phone destinations through More. Check headings, available actions, horizontal overflow and the space left for content.
2. Exercise selection, return navigation, filtering, loading, empty results and partial source failure. Use 320 × 568 for the narrower controls. Compare the keyboard behavior of visually identical controls.
3. Trace observed behavior to the component that owns it. Record a reproduction and a user-visible completion criterion for each proposed change. Keep visual preferences separate from observed interaction failures.

**Catalogue contract.** Selecting a result opens its source chooser in the catalogue. The wide layout pairs the list with the selected item. The phone gives the chooser the available space and provides a Results button. Keep both paths, including the ability to choose another source. A full title detail remains a separate, optional action.

## Page-by-page results

| View | Task and observation | Decision |
| --- | --- | --- |
| Home | The page exposes search, continue-watching cards and links from catalogue shelf headings. On a 390 px phone the first measured shelf link was 156 × 14 px. Its chevron belongs to the same button. | Enlarge the shelf link hit area. Retain direct navigation to its catalogue. |
| Catalogue | Selected a film on desktop, inspected the source chooser at 320 px and used Results to return. Working HTTP sources and retryable remote-library errors appeared together. Play and save actions became available as sources arrived. | Preserve the selection flow. Improve the retry target without displacing working sources. |
| Library | At the root the local folders appeared first. Remote roots then appeared above them. Opening a local folder exposed a breadcrumb, filter, sorting and view tools. | Stabilize the root list while remote discovery is pending. Keep the breadcrumb on entry into a folder. |
| Search everywhere | Submitted a title query, opened a person's filmography, changed its type and returned. The previous query and results were present on return. | Preserve the separate person search and the contextual back action. |
| Favourites | Switching All to Series briefly showed the newly selected filter over film cards. The eventual empty state named the type and explained how to add a series. | Keep the specific empty state. Address the transition between filters. |
| Continue watching | Switching to Series briefly left a film among the cards under the selected Series filter. The card menu remains a separate action from opening the item. | Handle data ownership together with Favourites. |
| Following | Right Arrow moved focus and selection from Overview to Calendar. The list and month modes and the month navigation have distinct labels. | Use this keyboard behavior as the reference for Settings. |
| Downloads | Opened and closed the completed section. It exposed details, reveal-in-library and remove actions. On the 390 px phone its disclosure occupied 336 × 28 px across the row. | Lower priority than the small adjacent reorder arrows. If increasing row height, keep the whole heading clickable. |
| Addons | Opened an installed addon's editor and dismissed it. At 390 px the card's two priority arrows measured 24 × 18 px apiece, directly next to each other. Reordering has an immediate effect. | Give adjacent arrows distinct touch targets and retain disabled end states. |
| Settings | Opened all seven tabs at 320 px. Selecting Account scrolled the strip to reveal it. At 390 px the strip measured 355 px for 439 px of content. Right Arrow on Libraries left focus and selection there. | Keep horizontal reveal and align keyboard navigation with Following. |
| Statistics | Switched the reporting period and returned to 30 days. On entry the page briefly said there was nothing to measure while also showing a loading message. It then displayed historical totals. | Show the empty statement only after a successful empty response. |

The four primary viewport sweeps found no document-level horizontal overflow on the sampled landing states. The Settings tab strip scrolls internally. Neither observation establishes that every dialog or every data-dependent row fits.

## Prioritized work

### 1. Keep the active filter and its results together

**Reproduce.** In Favourites, start with films under All and choose Series. In Continue watching, repeat with a mixed history. Check the cards immediately after the pressed state changes. On this deployment the old cards were briefly visible under the new label.

**Implementation.** In [App.tsx](../web/src/App.tsx), both filter effects already clear the list. Their asynchronous loaders apply results, totals and completion state without checking which filter or request still owns them. A late response overwriting a newer one is a risk identified in code. The live walkthrough established the brief mismatch only. Keep the filter identity with the displayed data, guard first-page and load-more responses, and preserve the scroll position during a refresh of the same filter.

**Acceptance.** Delay a film response, switch to series, complete the series response first and release the film response. The selected filter, cards, count and load-more action must still refer to series. Repeat for both screens and for an outstanding second page.

### 2. Stabilize the library root while remote folders arrive

**Reproduce.** Open Library on a narrow phone with local folders and remote libraries configured. Local folders initially occupy the first rows. When the remote region arrives, those same folders move down. A user reaching for a local row can lose their place.

**Implementation.** Review the root composition in [App.tsx](../web/src/App.tsx). One option is a stable local section followed by remote libraries and their loading status. If remote-first ordering is essential, retain enough previous root information to render a stable returning view. Avoid reserving a large empty area for accounts with only local libraries.

**Acceptance.** Delay remote discovery and record the top edge of the first local row before and after success and failure. It should stay in place while visible. A local folder should open while remote discovery is pending.

### 3. Increase touch targets where a miss changes the action

| Where | Measured button | Proposed change and acceptance |
| --- | --- | --- |
| Addon priority | 24 × 18 px at 390 × 844 | Start here because adjacent arrows do opposite things. Give each an independent target of at least 44 × 44 CSS px in touch layouts. Verify a tap near their common boundary invokes only the intended direction. See [AddonManager.tsx](../web/src/AddonManager.tsx). |
| Catalogue source retry | 72 × 16 px at 320 × 568 | Give each failed group's retry a larger target within its own row. Keep retry scoped to that group and keep usable sources selectable. Check two failures alongside working sources at 320 px and in landscape. See [SourceChooser.tsx](../web/src/SourceChooser.tsx). |
| Home catalogue heading | 156 × 14 px at 390 × 844 | Let the shelf heading's existing button use more of the row's vertical space. Aim for a 44 px touch target. Check the poster below and any adjacent shelf action remain separately reachable. See [HomeShelf.tsx](../web/src/HomeShelf.tsx). |

These measurements describe button boxes in the responsive browser. The 44 px target is a proposed design criterion. Verify spacing and hit testing on a touch device before shipping.

### 4. Give Settings the same keyboard interaction as Following

**Reproduce.** Focus Libraries in Settings and press Right Arrow. The active tab stays on Libraries. In Following, the same key on Overview activates Calendar. Both controls expose a tablist and the same underlined styling.

**Implementation.** Reuse the roving-focus interaction from [FollowingPage.tsx](../web/src/FollowingPage.tsx) in [SettingsPage.tsx](../web/src/SettingsPage.tsx). Operate on the tabs visible to the current account. Keep the selected tab in view as the strip scrolls.

**Acceptance.** Tab enters the selected tab once. Left and Right move selection, Home and End reach the visible ends, and Tab continues into the panel. On a 320 px screen, moving to Account reveals its label and focus indicator. Verify with the restricted set of tabs as well.

### 5. Distinguish pending and empty statistics

**Reproduce.** Enter Statistics on an account with history. During initial loading the lead says there is nothing to measure, then changes when the summary arrives. [Stats.tsx](../web/src/Stats.tsx) uses the empty lead both while the summary is null and when a loaded summary lacks a start date.

**Acceptance.** Hold the summary response open. The page should communicate that data is loading. Resolve it with historical totals and check that the empty message never appeared. Resolve it with a genuinely empty summary in a second case and check that the empty explanation appears.

## Verification boundaries

The live audit covered Czech, administrator navigation, browser viewport resizing and keyboard interaction. It did not exercise physical touch accuracy, screen-reader speech, child or restricted accounts, TV remote navigation, or live download and account mutations. The main walkthrough used real local data. The player layout checks use the project's isolated fixture so playback activity stays outside household history.

The three player journeys in [player.spec.ts](../e2e/tests/layout/player.spec.ts) passed on desktop, portrait phone and landscape phone (nine checks). They cover picture stability, overlay reachability, reversible fill-screen mode, dismissing controls and fullscreen interaction.
