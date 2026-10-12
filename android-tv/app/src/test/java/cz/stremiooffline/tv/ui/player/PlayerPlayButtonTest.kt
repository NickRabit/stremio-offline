@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The play button follows the viewer's intent, not the instant the first frame is out: a film
 * that is still buffering already offers Pause, so the button does not flip from Play to Pause a
 * moment after the start.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerPlayButtonTest {

  @get:Rule val compose = createComposeRule()

  private fun mount(playing: Boolean, pauseShown: Boolean) {
    compose.setContent {
      PlayerOverlayShell(
        position = 0.0,
        duration = 100.0,
        playing = playing,
        pauseShown = pauseShown,
        onSeek = {},
        onTogglePause = {},
        onExit = {},
        title = "It",
        eyebrow = "",
        playFocus = FocusRequester(),
        onTracks = {},
        tracksText = "CZ",
        tracksLabel = "Audio and subtitles",
        onNext = null,
        nextLabel = "Next episode",
        onDiagnostics = {},
        diagnosticsLabel = "Diagnostics",
      ) {}
    }
  }

  @Test
  fun `a film that is still buffering already offers Pause`() {
    mount(playing = false, pauseShown = true)

    compose.onNodeWithTag(TAG_OSD_PLAY).assertContentDescriptionEquals("Pause")
  }

  @Test
  fun `a film the viewer paused offers Play`() {
    mount(playing = false, pauseShown = false)

    compose.onNodeWithTag(TAG_OSD_PLAY).assertContentDescriptionEquals("Play")
  }
}
