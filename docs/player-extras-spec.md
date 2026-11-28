# Player extras: playback speed, picture in picture, subtitle styling

Status: proposed, not scheduled. Analysed against `origin/main` at `805b0107`
(0.7.169) on 2026-11-28 by an agent working from a clean context; the main
findings were rechecked against the source. Statements about browser or Media3
behaviour that the repository cannot prove are marked **[unverified]** and need
a spike or a device check before they are relied on.

Roadmap entries: [Player extras](roadmap.md#player-extras) and
[Subtitles](roadmap.md#subtitles).

## 0. How the web player draws subtitles today

This decides how all three features are designed.

- The `<track>` elements are attached to the `<video>`
  (`web/src/Player.tsx:1941-1943`). An effect (`Player.tsx:556-638`) keeps
  each mirrored track in `mode = "hidden"` and copies the active cues into React state
  (`showActiveCues`, `Player.tsx:571-583`). That state renders as
  `<div className="player-subtitles">` (`Player.tsx:1945`).
- The text is read with `getCueAsHTML().textContent` (`Player.tsx:578`). This
  drops italics and bold and ignores the cue's own `line` and `position`.
  Every cue is drawn at the bottom centre.
- **Exception: iOS native video fullscreen.** There (`nativeVideoFullscreen`,
  `Player.tsx:227-233`) the tracks switch to `"showing"` and the overlay hides
  (`style.css:195`).
- The overlay exists for a documented reason (`Player.tsx:556-560`). Chromium
  paints native cues below the visible box. On Windows, overlay fullscreen
  promotes the video to a DirectComposition plane, and native cues vanish.
- The fixed style is in `style.css:195`, with overrides at `:863-864`
  (lifted above the controls), `:900` (phone landscape) and `:214` (phones).

**Decision:** keep the HTML overlay as the main renderer and style it through
CSS custom properties. One helper, `nativeVideoPresentation`, switches tracks
to `"showing"` while the video is in iOS fullscreen or native picture in
picture. Those paths get a best-effort copy of the style through `video::cue`.
Do not make `::cue` the main path: it would bring back the Chromium defects
the overlay was built to avoid.

## 1. Playback speed

### Current state

- **Nothing sets a rate.** `playbackRate`, `defaultPlaybackRate` and
  `preservesPitch` appear nowhere in `web/src`, `desktop/src` or the TV
  sources.
- **Shortcuts.** The keys are listed in `SHORTCUT_KEYS` (`Player.tsx:236`) and
  handled at `Player.tsx:1797-1823`. Space/k, ←/→, c/t, `,` and `.` (subtitle
  delay), f and Escape are taken.
- **Ends at.** `endsAt(nowMs, position, duration)` lives in
  `web/src/player-clock.ts:3-8`; the TV copy is `PlayerClock.kt:54`. It
  assumes 1×.
- **Not affected by speed.** Progress, resume and statistics are
  position-based or traffic-based (`player-progress.ts:11-18`,
  `server/src/stats.ts`). The Up next countdown is five seconds of wall time,
  which is correct at any speed. Up next detects a threshold crossing. Intro and recap
  auto-skip also require the sampled position to fall inside the segment
  (`activeSegment` in `player-segments.ts`, `Player.tsx:1883-1896`). A
  time update can jump over a short segment at 2×.
- **Conversion limit (the important one).** FFmpeg reads with `-readrate 3`
  for a remux and `-readrate 1.5` for a transcode
  (`server/src/playback.ts:2081`; overridable with `FFMPEG_READRATE[_REMUX]`).
  The default initial burst is 30 seconds of input on supported FFmpeg builds.
  Once buffered content runs out, sustained playback above the configured
  read rate can stall. Encoding or I/O can limit throughput earlier. Direct
  play bypasses this FFmpeg limit.
- **Buffers are counted in content seconds.** At 2× each covers half as much
  wall time: hls.js `maxBufferLength: 25` (`player-hls.ts:5-16`), the
  optional lead cap (`playback.ts:500-511`) and the 45-second subtitle
  refresh lead (`player-sidecar.ts:5`). Subtitle extraction has no read brake,
  so it should stay ahead **[verify in e2e]**.
- **Reloads reset the rate.** `releaseMediaElement` calls `video.load()`
  (`player-hls.ts:21-26`). Restarts, quality changes, track changes and seek
  restarts all re-attach the source (`Player.tsx:649`, `684`, `690-752`). The
  HTML load algorithm resets `playbackRate` to `defaultPlaybackRate`.

### Design

- **Steps.** 0.5, 0.75, 1, 1.25, 1.5, 1.75 and 2×. Nothing above 2×.
- **Applying it.** A helper `applySpeed(video, speed)` sets both
  `defaultPlaybackRate` and `playbackRate`. It runs on change and again on
  `loadedmetadata`, so every reload path keeps the speed. It also sets
  `preservesPitch = true` (and `webkitPreservesPitch`). Pitch preservation
  cannot be turned off.
- **Persistence.** Per device in `localStorage`, on the pattern of
  `player-volume.ts`, unless the owner prefers a reset on every open (Q1).
  Never per account.
- **Ends at.** `endsAt(now, position, duration, speed = 1)` divides the
  remaining time by the speed. The same change goes into `PlayerClock.kt`.
- **UI.** A select row at the top of the player settings panel, above Quality
  (`Player.tsx:1990+`), in the existing `track-picker` style. A small "1.5×"
  badge in `player-meta` whenever the speed is not 1, so a forgotten speed is
  visible.
- **Keys.** `<` and `>` (Shift+, and Shift+.), added to `SHORTCUT_KEYS`.
  `,` and `.` keep the subtitle delay. These keys are awkward on a Czech
  layout, so the menu is the main way in.
- **Transcode above 1.5×.** v1 shows a one-time hint after a stall above 1.5×
  on a transcoded session. Raising `-readrate` per session is Q2.
- **Out of scope.** Reporting the speed to Jellyfin or Emby.

### Android TV (later PR)

`ExoPlayer.setPlaybackSpeed()`, where Media3 keeps the pitch. It needs one row
in the tracks or quality panel, strings through `android-tv/strings.keys`, and
the speed passed to `PlayerClock`.

**Catch [unverified]:** while audio passthrough sends AC-3, E-AC-3 or DTS as a
bitstream, the sink cannot change speed. Check on the Android 9 Philips set whether Media3 changes
the output path or declines the rate. Show the effective speed in the clock and
controls. Gate the row only on a confirmed playback limitation.

### Tests

- **Unit:**
  - `endsAt` with a speed.
  - `applySpeed` writes both rate fields.
  - Restore each supported speed. Missing, malformed or unsupported values use 1×.
- **Playwright:**
  - The speed survives a seek restart and a quality change, checked by
    asserting `video.playbackRate` after playback resumes on the new source. The
    unit test covers the two rate fields independently.
  - Ends at follows the speed.
  - `<` and `>` change the speed while `,` and `.` still move the subtitle
    timing.
- **Manual:**
  - A 2× transcode on the NAS.
  - Safari on Mac and iPhone (native HLS path).
  - Electron.

Size: web **S**, TV **S–M**.

## 2. Picture in picture

### Current state

- **No PiP code.** The `<video>` (`Player.tsx:1861`) has no
  `disablePictureInPicture`, so a browser's own entry point may already work
  today. If it does, it shows no subtitles, because the tracks are hidden
  **[unverified per browser]**.
- **The player is a full-screen modal.** It is marked `aria-modal`
  (`Player.tsx:1842`) and returns `null` when closed (`Player.tsx:1825`).
  Closing or navigating away unmounts the `<video>` and ends PiP. While the
  player is open it covers the app, so PiP only helps when switching to
  another tab or app.
- **Engines.** The player uses hls.js when it is supported and native HLS
  otherwise (`Player.tsx:684`). Electron 45 loads the server page in a
  sandboxed `WebContentsView` (`desktop/src/main.ts:751-758`).

### Platform matrix (all [unverified] until a spike)

| Platform | API | Subtitles in PiP |
| --- | --- | --- |
| Chrome, Edge | `requestPictureInPicture()`; Document PiP since Chrome 116 | Video PiP draws no text tracks. Document PiP can carry the HTML overlay. |
| Electron 45 | Video PiP as Chromium; Document PiP unknown | As Chrome |
| Safari macOS | Standard API, `webkitSetPresentationMode` | Draws `"showing"` tracks |
| iPhone, iPad | `webkitSetPresentationMode` | Draws `"showing"` tracks; hls.js on ManagedMediaSource to confirm |
| Firefox | No API, only its own toggle | Draws `"showing"` tracks, if its toggle fires the PiP events |

### Design

- **v1: native video PiP while the player is open (S–M).**
  - A button in `player-view-controls` (`Player.tsx:1982-1987`). It is shown
    only when `document.pictureInPictureEnabled` or
    `webkitSupportsPresentationMode("picture-in-picture")` is true. On a
    phone held upright the entry moves into the settings panel instead (see
    [section 4](#4-phone-layout)).
  - The button and `p` toggle the current video's PiP mode. Enable entry
    after video metadata is available and call the supported API directly
    from the user gesture. On success, leave overlay fullscreen if still
    active. On rejection, keep the current presentation and subtitle state.
    [W3C Picture-in-Picture request algorithm](https://www.w3.org/TR/picture-in-picture/#request-pip)
  - `nativeVideoFullscreen` grows into `nativeVideoPresentation`, which also
    listens to `enterpictureinpicture`, `leavepictureinpicture` and
    `webkitpresentationmodechanged` in the existing effect
    (`Player.tsx:609-624`). Read the current presentation at effect setup
    and on each event. Changing the session or addon track rebinds the effect
    while the video may already be in PiP. In native presentation, show only
    mirrored tracks when the viewer has subtitles enabled. Restore the overlay
    on exit. Confirm cue visibility on each platform before adding any
    platform-specific tooltip.
  - Closing the player exits PiP.
- **v2: Document PiP on Chromium (M, spike first).** Move the existing host
  node (the video plus `.player-subtitles`) into the PiP window, keeping the
  same element so playback continues. Move it back on the window's `pagehide`
  before React unmounts it. The spike must also bring the player styles and inherited CSS
  variables into the new document. Verify cue updates, resize, close and
  parent unmount with React still owning the host.
- **v3: PiP while browsing the app (L).** Keep the Player mounted and hidden
  while PiP is active. This touches App's `playerOpen`, the focus trap,
  progress reporting, Up next and the session watchdogs.

### Risks and tests

- **Risks:**
  - Element reloads after a quality, track or seek change may drop PiP
    **[verify]**.
  - Up next and the end-of-playback close would close a PiP window.
  - Check both pause and continued playback when the viewer closes the PiP
    window. Keep the controls in sync with the media element.
  - The desktop display guard must still see the media playing.
- **Unit:** the presentation-mode helper.
- **Playwright** (stub the API if headless Chromium lacks it):
  - The button appears only with support.
  - Entering PiP turns the mirrored track to `"showing"`, and leaving turns it
    back.
  - A track change in PiP retains native mode. Subtitles switched off stay
    off across entry, track changes and exit. A rejected request leaves the
    overlay usable.
  - Closing the player exits PiP.
- **Manual:**
  - Safari on Mac and iPhone (HLS and remux).
  - Electron on macOS and Windows.
  - Firefox's own toggle.

## 3. Subtitle styling

### Current state

- **Web:** the fixed overlay style in section 0.
- **Android TV has two renderers:**
  - Server and addon WebVTT go through the Compose `SubtitleOverlay`: 4.5 %
    of the screen height, white with a black stroke and shadow, and a fixed
    bottom padding (`PlayerSubtitleOverlay.kt:31-70`).
  - Embedded tracks in direct play are drawn by Media3's own `SubtitleView`.
    The `PlayerView` is set up at `PlayerScreen.kt:1336-1346` without
    `setStyle`, so the Media3 default style and system caption settings apply
    **[unverified]**.
- **ASS/SSA:**
  - Embedded ASS is converted to WebVTT by FFmpeg (`playback.ts:1442`,
    `player-sidecars.ts:217`). The conversion drops the styling, and the web
    overlay drops any remaining markup.
  - External `.ass` files are ignored: library sidecars match only `srt` and
    `vtt` (`server/src/library-sidecars.ts:7`).
  - `toWebVtt` handles only SRT (`server/src/subtitle-text.ts:27-33`), so an
    ASS file from an addon probably becomes an unusable VTT **[not tested]**.
  - Conclusion: on the web, user styling never competes with ASS styling. On
    the TV it competes only on the Media3 path.
- **HDR:**
  - The server reports `playing.hdr` (`dolbyVision`, `hdr10`, `hlg`) only when
    the video is copied (`playback.ts:1292`, `1308-1316`).
  - It reaches the web as `session.playing.hdr` (`web/src/types.ts:622`) and
    the TV through `PlayerBadges.kt:29`.
  - A transcode outputs SDR, so the flag is correctly absent there.
- **Per-account preferences:**
  - Stored in `UserPrefs` (`server/src/store.ts:100-130`) and listed in
    `PERSONAL_SETTINGS` (`server/src/users.ts:287-298`).
  - Export includes the exporting account’s preferences. Import rebuilds an
    explicit field list in `parseSettings` (`server/src/backup.ts`) before
    `splitSettings` in `routes/settings.ts` assigns personal keys to that
    account. Add both style keys in both places. Import merges preferences.
    Restoring a backup of an account with an inherited HDR style must clear
    any HDR override currently on the importing account.
  - `GET` and `PATCH /settings` are already open to users
    (`server/src/roles.ts:145`, `175`). **No new route and no `USER_ALLOWED`
    change is needed.**
- **Child accounts:** they cannot change settings, and the server enforces it.

### Data model

Presets rather than free values keep validation, translation and the TV
mapping simple. A missing field means today's look, so nothing changes for
anyone who never opens the setting.

```ts
interface SubtitleStyle {
  size: 75 | 100 | 125 | 150 | 200;                       // % of today's size
  color: "white" | "yellow" | "cyan" | "green" | "grey";
  textOpacity: 100 | 75 | 50;                             // dimming for HDR
  background: "none" | "box" | "line";
  backgroundOpacity: 25 | 50 | 75 | 100;
  edge: "shadow" | "outline" | "none";
  position: 0 | 5 | 10 | 15 | 20;                         // % lift from the bottom
}
interface SubtitlePreferences {
  subtitleStyle?: SubtitleStyle;
  subtitleStyleHdr?: SubtitleStyle;
}
```

For each top-level style key, omission in PATCH preserves its value, a complete
preset object replaces it, and `null` removes the override. Validate the entire
request before writing. Reject malformed objects and unsupported presets with
HTTP 400. Compare validated fields inside the serialized store update. A
style-only request with identical values returns `false` from the mutator
to skip the redundant save. Mixed requests still apply other changes.

### Web

- **Player:**
  - For HDR playback, resolve `subtitleStyleHdr ?? subtitleStyle`. For SDR
    or unknown HDR status, use `subtitleStyle`. When the selected style is
    absent, use the existing renderer defaults on both clients.
  - It sets CSS variables on `.player-overlay`: `--sub-scale`, `--sub-color`,
    `--sub-bg`, `--sub-shadow` and `--sub-lift`. The existing rules at
    `style.css:195`, `863-864`, `900` and the phone rule consume them.
  - `background: line` needs each line in its own span with
    `box-decoration-break: clone`, so `subtitleText` is split on line breaks.
  - Apply supported text styles through `video::cue` in native presentation.
    Keep the HTML overlay responsible for layout and vertical lift. Check
    native cue placement and system caption overrides on a device.
- **Settings:**
  - A new section, *Subtitle appearance*, under Settings → Playback
    (`SettingsPage.tsx:339-360`).
  - Plain `SettingControl` selects, following
    [UI conventions](ui-conventions.md).
  - A live preview: a 16:9 box with a sample line drawn by the same component
    and variables as the player, with an SDR/HDR switch.
  - One PATCH per change. Offer a reset for each profile. Resetting the HDR
    profile resumes inheritance, including subsequent base-style edits.
  - Check the section in the viewport matrix, including phones upright and
    sideways.
- **HDR preview:** the switch selects the HDR preference. Assess perceived
  brightness during HDR playback on a supported display.

### Android TV

- **Compose renderer:** `SubtitleOverlay(text, lifted, style)` maps the
  presets to a size multiplier, colour and alpha, stroke or shadow, a
  background and extra bottom padding.
- **Media3 renderer:**
  `subtitleView.setStyle(CaptionStyleCompat(...))`,
  `setFractionalTextSize`, `setBottomPaddingFraction`,
  and embedded-style controls apply only for an effective custom style. If
  Q5 selects user precedence, disable embedded styles and font sizes while
  that style is active. On reset or a switch to an unstyled title, restore
  the original Media3 settings on the existing view.
- **Settings:**
  - Read from `/api/settings`, which the TV already loads.
  - Model the structured write on `updateHomeLayout` in `data/ApiClient.kt`,
    which already sends an object or null.
  - A *Subtitles* screen with the same presets and a preview line.
- **Strings:** through `android-tv/strings.keys`, never by hand in `res`. Run
  `lintDebug` before pushing.

### Translations

About 25 keys in all ten web catalogues (`web/src/i18n/*.ts`; `cs.ts` is typed
against `en.ts`). Write them before any parallel implementation.

### ASS policy

The user's style always applies to converted text. Full ASS rendering (libass
or JASSUB drawn over the video) is a separate later feature. If it comes, it
brings a per-account "keep the file's own ASS styling" switch. It would not
appear in native PiP either.

### Risks and tests

- **Risks:**
  - Size × interface size × phone landscape can clip a two-line cue. The
    position lift plus the controls lift must not push text off the top.
  - A backup import must round-trip the nested object.
  - The default must render exactly as today.
- **Unit:**
  - Server: test replacement, omission, reset and rejection of an invalid preset. Check a repeated
    PATCH skips persistence and another account keeps its own style. Exercise
    export → parse → import → GET for both profiles and import a legacy backup
    without style keys. A child account gets 403 on PATCH.
  - Web: style → CSS variables, and choosing the HDR style from
    `playing.hdr`.
  - TV: preset → Compose and `CaptionStyleCompat` mapping (JVM tests).
    Exercise custom → absent on the same PlayerView with embedded ASS.
- **Playwright** (extend `player-subtitles.spec.ts` and
  `player-embedded-subtitles.spec.ts`):
  - The computed style of `.player-subtitles` follows the saved preference.
  - An HDR fixture uses its override, inherits the base style after reset,
    and falls back to the current appearance when both keys are absent.
  - The Settings preview changes live.
  - A layout invariant for the new section.
  - Snapshots go through the update-snapshots workflow.
- **Manual:**
  - iPhone native fullscreen (`::cue`).
  - Android 9 TV: both renderers, embedded ASS with embedded styles off, an
    HDR10 or Dolby Vision title on the Philips set.

Size: server + web **M**, TV **M**.

## 4. Phone layout

The player controls on a phone have no spare room. Every PR in this document
must keep them usable on the `mobile`, `mobile-landscape` and
`mobile-landscape-small` projects, and at 360 and 320 px wide, as
`e2e/tests/layout/player.spec.ts` already checks.

### Current budget

- **Phone held upright** (`style.css:990-1007`). Playback (−10, play, +10)
  has its own centred row. Under it, every other button sits in **one row**
  of 44 × 44 px icons, spread edge to edge. The layout test requires a single
  row with even gaps and no horizontal scrolling at 390, 360 and 320 px
  (`player.spec.ts:68-101`). At 320 px the row has about 312 px, which is
  room for **seven** icons and no more. The fullest row today already has
  seven: previous, next, subtitles, fill, sources, settings and fullscreen.
  Fullscreen is absent where the browser has no element fullscreen, for
  example on iPhone.
- **Phone held sideways** (`style.css:894-902`, `924`). One row without
  wrapping. The volume slider is hidden and the gaps shrink to 4 px, or 2 px
  below 380 px. There is room for one more icon at the usual landscape
  widths (about 640 to 850 px).
- **Above the controls.** `player-meta` holds the chapter (it truncates) and
  the finish time (it does not). The settings panel scrolls
  (`style.css:867`, `901`).
- **Subtitles.** On phones the size is
  `clamp(15px, 3vw/ui-scale, 22px)` (`style.css:900`). The layer sits above
  `--player-bottom-height`, under the picture when the phone is upright.

### Rules for these features

- **Speed.**
  - No new bar button. The speed row is the first row of the settings panel,
    above Quality: on `mobile-landscape-small` (360 px tall) the panel shows
    its head and one row, and a row under Quality was measured out of view.
  - The "1.5×" badge goes into `player-meta` before the finish time. It does
    not shrink, and the chapter still truncates first. On an upright 320 px
    phone the chapter, the badge and "Ends at" fit on one line, or the
    chapter yields entirely.
- **Picture in picture.**
  - Phone held upright (`max-width: 700px` and portrait): **no bar button.**
    PiP is a row at the top of the settings panel, so the seven-icon row
    stays as it is.
  - Phone held sideways, tablets and desktop: a bar button in
    `player-view-controls`, before Settings.
  - On Android Chrome the system also offers PiP when the user leaves the
    app with the video playing. That needs no button, but it must behave
    like a PiP entered from the menu (subtitle mode, exit, closing the
    player) **[verify on a device]**.
- **Subtitle styling.**
  - The size presets scale the phone clamp, not a fixed pixel size. At 200 %
    on an upright 320 px phone, a two-line cue must stay inside the viewport
    and must not overlap the transport row or the player head.
  - On phones, cap the result so that a long line takes no more than three
    rows. The cap is applied in CSS (`min()` on the scaled clamp), not by
    changing the saved preference.
  - The position lift adds to the controls lift. While the controls are up,
    the subtitle must stay clear of the transport row. The layout test checks
    this with the highest lift.
  - The settings preview box keeps 16:9 and its own width on phones, so the
    sample line wraps the way the player wraps it.

### Tests

Extend `e2e/tests/layout/player.spec.ts`. These checks must fail on a build
that simply adds the new button to the bar.

- With a session that has previous, next, subtitles, sources and
  fullscreen, plus a PiP stub that reports support:
  - At 390, 360 and 320 px upright, the icon row still has one line, at most
    seven icons, no horizontal scrolling, and every button at least
    44 × 44 px.
  - The PiP row is in the settings panel.
- The same session sideways (`mobile-landscape` and
  `mobile-landscape-small`) shows the PiP bar button inside the viewport.
- The speed badge and "Ends at" are both visible and on one line at 320 px
  upright, with a long chapter name.
- Subtitle styling at size 200 % and the highest lift, with a two-line cue,
  in all three phone projects: the cue box stays inside the viewport and
  does not intersect `.player-bottom` while the controls are visible.
- The settings panel on `mobile-landscape-small`: the speed row is visible
  without scrolling.

### Manual

Check on a real iPhone and an Android phone, both upright and sideways: the
speed menu, the badge, PiP from the settings panel, and subtitles at the
largest size.

## 5. Order and PR boundaries

The first three PRs share `Player.tsx`. Land those changes in sequence.

1. Speed on the web (S).
2. PiP v1 (S–M). It introduces `nativeVideoPresentation`, which step 3 reuses
   for the `::cue` copy.
3. Subtitle styling: server, web player, Settings with preview, translations
   (M).
4. Subtitle styling on Android TV (M).
5. Speed on Android TV (S–M).
6. Optionally PiP v2 or v3, after a spike and the owner's decision.

Steps 1 and 2 are independent and fit a cheaper implementer. Step 3 is
contained but touches the settings contract and the backup, so the reviewer
checks those paths with care.

## 6. Open questions for the owner

1. **Remembering the speed:** per device like the volume, or reset every time
   the player opens?
2. **Transcode above 1.5×:** a stall hint only, or should the server raise its
   read rate for that session (more NAS reads)?
3. **PiP scope:** native video PiP only (cue support to verify), also Document PiP
   (subtitles on Chromium), or watching while browsing the app?
4. **Child accounts:** today's default style, or let an administrator set a
   child's style in the user manager?
5. **ASS on the TV:** should the user's style override the file's own ASS
   styling in Media3 (recommended: yes)?
