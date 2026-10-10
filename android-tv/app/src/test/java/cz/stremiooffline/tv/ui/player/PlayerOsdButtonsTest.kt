@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The player's own buttons on the OSD: tracks, diagnostics and the next episode when there is one. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerOsdButtonsTest {

  @get:Rule val compose = createComposeRule()

  private var tracks = 0
  private var diagnostics = 0
  private var next = 0

  private fun mount(withNext: Boolean) {
    compose.setContent {
      PlayerOverlayShell(
        position = 10.0,
        duration = 100.0,
        playing = false,
        onSeek = {},
        onTogglePause = {},
        onExit = {},
        title = "It",
        eyebrow = "Direct play",
        playFocus = FocusRequester(),
        onTracks = { tracks += 1 },
        tracksText = "CZ",
        tracksLabel = "Audio and subtitles",
        onNext = if (withNext) ({ next += 1 }) else null,
        nextLabel = "Next episode",
        onDiagnostics = { diagnostics += 1 },
        diagnosticsLabel = "Diagnostics",
      ) {}
    }
  }

  @Test
  fun `the tracks and diagnostics buttons ask to open their panels`() {
    mount(withNext = false)

    compose.onNodeWithTag(TAG_OSD_TRACKS).requestFocus()
    compose.onNodeWithTag(TAG_OSD_TRACKS).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.onNodeWithTag(TAG_OSD_DIAG).requestFocus()
    compose.onNodeWithTag(TAG_OSD_DIAG).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    assertEquals(1, tracks)
    assertEquals(1, diagnostics)
    compose.onNodeWithTag(TAG_OSD_NEXT).assertDoesNotExist()
  }

  @Test
  fun `the next episode button only exists when there is a next one`() {
    mount(withNext = true)

    compose.onNodeWithTag(TAG_OSD_NEXT).requestFocus()
    compose.onNodeWithTag(TAG_OSD_NEXT).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    assertEquals(1, next)
  }
}
