@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.input.key.Key
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerOverlaySkipTest {
  @get:Rule val compose = createComposeRule()

  @Test
  fun `with controls hidden OK skips without showing them`() {
    var skips = 0
    compose.setContent {
      val playFocus = remember { FocusRequester() }
      PlayerOverlayShell(
        position = 10.0,
        duration = 100.0,
        playing = false,
        onSeek = {},
        onTogglePause = {},
        onExit = {},
        title = "It",
        eyebrow = "Direct play",
        playFocus = playFocus,
        initiallyShown = false,
        skipLabel = "Skip intro",
        onSkip = { skips += 1 },
      ) {
        Box(Modifier.fillMaxSize().testTag("video").background(Color.Black))
      }
    }
    compose.onNodeWithTag(TAG_OVERLAY_ROOT).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    assertEquals(1, skips)
    compose.onNodeWithTag(TAG_OSD_PLAY).assertDoesNotExist()
  }

  @Test
  fun `without a skip hidden controls still reveal the OSD`() {
    compose.setContent {
      val playFocus = remember { FocusRequester() }
      PlayerOverlayShell(
        position = 10.0,
        duration = 100.0,
        playing = false,
        onSeek = {},
        onTogglePause = {},
        onExit = {},
        title = "It",
        eyebrow = "Direct play",
        playFocus = playFocus,
        initiallyShown = false,
      ) {
        Box(Modifier.fillMaxSize().testTag("video").background(Color.Black))
      }
    }
    compose.onNodeWithTag(TAG_OVERLAY_ROOT).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    compose.onNodeWithTag(TAG_OSD_PLAY).assertExists()
  }

  @Test
  fun `a modal hides the skip chip`() {
    compose.setContent {
      val playFocus = remember { FocusRequester() }
      PlayerOverlayShell(
        position = 10.0,
        duration = 100.0,
        playing = false,
        onSeek = {},
        onTogglePause = {},
        onExit = {},
        title = "It",
        eyebrow = "Direct play",
        playFocus = playFocus,
        initiallyShown = false,
        modal = true,
        skipLabel = "Skip intro",
        onSkip = {},
      ) {
        Box(Modifier.fillMaxSize().testTag("video"))
      }
    }
    compose.onNodeWithTag(TAG_PLAYER_SKIP).assertDoesNotExist()
  }
}
