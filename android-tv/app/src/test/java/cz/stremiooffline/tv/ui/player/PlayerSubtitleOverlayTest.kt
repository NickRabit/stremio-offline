@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The cue layer sits above the picture and the OSD scrim, clear of the controls while they are
 * shown. Bug on the emulator: the first cue appeared behind the OSD button row, faint on the
 * dimmed video.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerSubtitleOverlayTest {

  @get:Rule val compose = createComposeRule()

  private fun mount() {
    compose.setContent {
      PlayerOverlayShell(
        position = 10.0,
        duration = 100.0,
        playing = true,
        title = "It",
        eyebrow = "Direct play",
        playFocus = FocusRequester(),
        initiallyShown = true,
        subtitleText = "A line of dialogue",
        onSeek = {},
        onTogglePause = {},
        onExit = {},
      ) {
        Box(Modifier.fillMaxSize().background(Color.Black))
      }
    }
    compose.waitForIdle()
  }

  @Test
  fun `the cue sits above the osd row while the controls are shown`() {
    mount()

    val cue = compose.onNodeWithTag(TagSubtitleOverlay).getUnclippedBoundsInRoot()
    val osd = compose.onNodeWithTag(TAG_OSD_PLAY).getUnclippedBoundsInRoot()
    assertTrue("cue $cue must sit above the OSD row $osd", cue.bottom.value <= osd.top.value)
  }

  @Test
  fun `the cue drops to the bottom margin once the controls hide`() {
    mount()

    compose.mainClock.advanceTimeBy(CONTROLS_HIDE_MS + 100)
    compose.waitForIdle()
    compose.onNodeWithTag(TAG_OSD_PLAY).assertDoesNotExist()

    val cue = compose.onNodeWithTag(TagSubtitleOverlay).getUnclippedBoundsInRoot()
    val root = compose.onRoot().getUnclippedBoundsInRoot()
    assertEquals(SUBTITLE_BOTTOM.value.toDouble(), (root.bottom - cue.bottom).value.toDouble(), 1.0)
  }
}
