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
  every track in `mode = "hidden"` and copies the active cues into React state
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
  which is correct at any speed. Segment auto-skip and the Up next trigger fire
  on a position crossing (`Player.tsx:1883-1896`), so the larger jumps at 2×
  still trigger them.
- **Conversion limit (the important one).** FFmpeg reads with `-readrate 3`
  for a remux and `-readrate 1.5` for a transcode
  (`server/src/playback.ts:2081`; overridable with `FFMPEG_READRATE[_REMUX]`).
  After the 30-second initial burst, a transcode cannot keep up above 1.5×
  and will stall repeatedly. A remux keeps up to about 3×. Direct play is
  unaffected.
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
- **Applying it.** A pure `applySpeed(video, speed)` sets both
  `defaultPlaybackRate` and `playbackRate`. It runs on change and again on
  `loadedmetadata`, so every reload path keeps the speed. It also sets
  `preservesPitch = true` (and `webkitPreservesPitch`). Pitch preservation
  cannot be turned off.
- **Persistence.** Per device in `localStorage`, on the pattern of
  `player-volume.ts`, unless the owner prefers a reset on every open (Q1).
  Never per account.
- **Ends at.** `endsAt(now, position, duration, speed = 1)` divides the
  remaining time by the speed. The same change goes into `PlayerClock.kt`.
- **UI.** A select row in the player settings panel next to Quality
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
bitstream, the sink cannot change speed. The row must then be disabled with a
short reason. Check on the Android 9 Philips set.

### Tests

- **Unit:**
  - `endsAt` with a speed.
  - `applySpeed` writes both rate fields.
  - Stored speed is clamped (like `player-volume.test.ts`).
- **Playwright:**
  - The speed survives a seek restart and a quality change, checked by
    asserting `video.playbackRate` afterwards. This test must fail without the
    `defaultPlaybackRate` fix.
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
    `webkitSupportsPresentationMode("picture-in-picture")` is true.
  - Key `p`. Entering PiP leaves overlay fullscreen first.
  - `nativeVideoFullscreen` grows into `nativeVideoPresentation`, which also
    listens to `enterpictureinpicture`, `leavepictureinpicture` and
    `webkitpresentationmodechanged` in the existing effect
    (`Player.tsx:609-624`). Tracks switch to `"showing"` during PiP. That
    gives subtitles on Safari and Firefox; on Chromium and Electron the
    tooltip says subtitles are not shown in PiP.
  - Closing the player exits PiP.
- **v2: Document PiP on Chromium (M, spike first).** Move the existing host
  node (the video plus `.player-subtitles`) into the PiP window, keeping the
  same element so playback continues. Move it back on the window's `pagehide`
  before React unmounts it. This gives subtitles and their styling, but it
  works around React's DOM ownership.
- **v3: PiP while browsing the app (L).** Keep the Player mounted and hidden
  while PiP is active. This touches App's `playerOpen`, the focus trap,
  progress reporting, Up next and the session watchdogs.

### Risks and tests

- **Risks:**
  - Element reloads after a quality, track or seek change may drop PiP
    **[verify]**.
  - Up next and the end-of-playback close would close a PiP window.
  - When the user closes the PiP window, Chrome pauses the video; `onPause`
    already copes.
  - The desktop display guard must still see the media playing.
- **Unit:** the presentation-mode helper.
- **Playwright** (stub the API if headless Chromium lacks it):
  - The button appears only with support.
  - Entering PiP turns the mirrored track to `"showing"`, and leaving turns it
    back.
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
  - Split by `splitSettings` (`routes/settings.ts:228-250`) and written by the
    PATCH handler (`:500-545`). The backup covers them (`backup.ts:157`).
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
prefs.subtitleStyle?: SubtitleStyle;     // absent = today's look
prefs.subtitleStyleHdr?: SubtitleStyle;  // absent = same as subtitleStyle
```

A server-side `normalizeSubtitleStyle` clamps or rejects unknown values. A
PATCH writes only the keys sent and nothing when the value is unchanged, in
line with the NAS disk-write rule.

### Web

- **Player:**
  - It chooses `subtitleStyleHdr` when `session.playing.hdr` is set.
  - It sets CSS variables on `.player-overlay`: `--sub-scale`, `--sub-color`,
    `--sub-bg`, `--sub-shadow` and `--sub-lift`. The existing rules at
    `style.css:195`, `863-864`, `900` and the phone rule consume them.
  - `background: line` needs each line in its own span with
    `box-decoration-break: clone`, so `subtitleText` is split on line breaks.
  - The same values go into a `video::cue` rule for the native paths. iOS
    system caption settings may override them **[unverified]**.
- **Settings:**
  - A new section, *Subtitle appearance*, under Settings → Playback
    (`SettingsPage.tsx:339-360`).
  - Plain `SettingControl` selects, following
    [UI conventions](ui-conventions.md).
  - A live preview: a 16:9 box with a sample line drawn by the same component
    and variables as the player, with an SDR/HDR switch.
  - One PATCH per change.
  - Check the section in the viewport matrix, including phones upright and
    sideways.
- **HDR on the web:** in browsers CSS white is SDR reference white, so the
  "blinding" complaint matters mostly on the TV. The HDR style is still offered
  on both clients.

### Android TV

- **Compose renderer:** `SubtitleOverlay(text, lifted, style)` maps the
  presets to a size multiplier, colour and alpha, stroke or shadow, a
  background and extra bottom padding.
- **Media3 renderer:**
  `subtitleView.setStyle(CaptionStyleCompat(...))`,
  `setFractionalTextSize`, `setBottomPaddingFraction`,
  `setApplyEmbeddedStyles(false)` and `setApplyEmbeddedFontSizes(false)`, so
  the user's style beats ASS styling (Q5).
- **Settings:**
  - Read from `/api/settings`, which the TV already loads.
  - Written with a new structured `updateSubtitleStyle` call; today
    `updateSettingFlag`, `data/ApiClient.kt:387`, writes only booleans.
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
  - Server: normalisation and clamping, PATCH writes only what changed,
    `splitSettings` round-trip, a child account gets 403.
  - Web: style → CSS variables, and choosing the HDR style from
    `playing.hdr`.
  - TV: preset → Compose and `CaptionStyleCompat` mapping (JVM tests).
- **Playwright** (extend `player-subtitles.spec.ts` and
  `player-embedded-subtitles.spec.ts`):
  - The computed style of `.player-subtitles` follows the saved preference.
  - The HDR style applies when the fixture session reports `hdr`.
  - The Settings preview changes live.
  - A layout invariant for the new section.
  - Snapshots go through the update-snapshots workflow.
- **Manual:**
  - iPhone native fullscreen (`::cue`).
  - Android 9 TV: both renderers, embedded ASS with embedded styles off, an
    HDR10 or Dolby Vision title on the Philips set.

Size: server + web **M**, TV **M**.

## 4. Order and PR boundaries

Every item edits `Player.tsx` (2,074 lines), so the PRs land one after another,
never in parallel.

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

## 5. Open questions for the owner

1. **Remembering the speed:** per device like the volume, or reset every time
   the player opens?
2. **Transcode above 1.5×:** a stall hint only, or should the server raise its
   read rate for that session (more NAS reads)?
3. **PiP scope:** v1 only (no subtitles in PiP on Chromium), also Document PiP
   (subtitles on Chromium), or watching while browsing the app?
4. **Child accounts:** today's default style, or let an administrator set a
   child's style in the user manager?
5. **ASS on the TV:** should the user's style override the file's own ASS
   styling in Media3 (recommended: yes)?
