@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The OSD controls must draw their focused look (`Tokens.Accent2` ring, `Tokens.Panel2` fill).
 * Bug on the emulator: `onFocusChanged` sat after `focusable()`, so it never saw the control's
 * own focus and the look never appeared -- the same bug fixed in `TvTextField` (#355). The drawn
 * look is not readable from a test, so the state behind it is exposed as [OsdFocused].
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerOsdFocusTest {

  @get:Rule val compose = createComposeRule()

  private fun focused(value: Boolean) = SemanticsMatcher.expectValue(OsdFocused, value)

  private fun mount() {
    compose.setContent {
      PlayerOverlayShell(
        position = 10.0,
        duration = 100.0,
        playing = false,
        title = "It",
        eyebrow = "Direct play",
        playFocus = FocusRequester(),
        initiallyShown = true,
        onSeek = {},
        onTogglePause = {},
        onExit = {},
        onTracks = {},
        tracksText = "EN",
        tracksLabel = "Audio and subtitles",
        onDiagnostics = {},
        diagnosticsLabel = "Diagnostics",
      ) {}
    }
    compose.waitForIdle()
  }

  @Test
  fun `the button the remote lands on draws focus and the others do not`() {
    mount()

    compose.onNodeWithTag(TAG_OSD_PLAY).assertIsFocused().assert(focused(true))
    compose.onNodeWithTag(TAG_OSD_TRACKS).assert(focused(false))
    compose.onNodeWithTag(TAG_OSD_DIAG).assert(focused(false))

    compose.onRoot().performKeyInput { pressKey(Key.DirectionRight) }
    compose.waitForIdle()
    compose.onNodeWithTag(TAG_OSD_SEEK_FORWARD).assertIsFocused().assert(focused(true))
    compose.onNodeWithTag(TAG_OSD_PLAY).assert(focused(false))

    compose.onRoot().performKeyInput { pressKey(Key.DirectionRight) }
    compose.waitForIdle()
    compose.onNodeWithTag(TAG_OSD_TRACKS).assertIsFocused().assert(focused(true))
    compose.onNodeWithTag(TAG_OSD_SEEK_FORWARD).assert(focused(false))
  }

  @Test
  fun `the progress bar draws its focus mark too`() {
    mount()

    compose.onRoot().performKeyInput { pressKey(Key.DirectionUp) }
    compose.waitForIdle()

    compose.onNodeWithTag(TAG_OSD_TIMELINE).assertIsFocused().assert(focused(true))
    compose.onNodeWithTag(TAG_OSD_PLAY).assert(focused(false))
  }
}
