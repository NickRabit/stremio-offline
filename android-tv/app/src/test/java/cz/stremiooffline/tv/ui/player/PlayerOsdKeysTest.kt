@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.TagSourcesPanel
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The whole OSD button row as the remote reaches it on a device: real key events through the
 * window, not `performKeyInput`. Bug on the emulator: after UP showed the controls, RIGHT did not
 * move the ring and OK landed on Play.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerOsdKeysTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private val alpha = StreamDto(sourceId = "srcA", kind = "remote", playable = true, name = "small", title = "Czech 1 GB", addonName = "Alpha")
  private val beta = StreamDto(sourceId = "srcB", kind = "remote", playable = true, name = "big", title = "Czech 8 GB", addonName = "Beta")

  private val api = FakeTvApi().apply {
    startAnswer = PlaybackDescriptorDto(id = "p1", url = "/stream.mp4")
  }

  private fun mount() {
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(key = "movie:tt1", title = "It", resume = false, sourceId = "srcB"),
        onExit = {},
        sources = listOf(alpha, beta),
      )
    }
    compose.waitForIdle()
  }

  /** A real remote key: it travels through the window instead of straight into Compose. */
  private fun realKey(keyCode: Int) {
    compose.runOnUiThread {
      compose.activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
      compose.activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, keyCode))
    }
    compose.waitForIdle()
  }

  private fun assertFocused(tag: String) {
    compose.onNodeWithTag(tag).assertIsFocused().assert(SemanticsMatcher.expectValue(OsdFocused, true))
  }

  @Test
  fun `UP shows the controls on Play and RIGHT walks the whole row to the sources button`() {
    mount()

    // Hide the controls first, the way they are while a title plays.
    realKey(KeyEvent.KEYCODE_BACK)
    compose.onNodeWithTag(TAG_OSD_PLAY).assertDoesNotExist()

    realKey(KeyEvent.KEYCODE_DPAD_UP)
    assertFocused(TAG_OSD_PLAY)

    realKey(KeyEvent.KEYCODE_DPAD_RIGHT)
    assertFocused(TAG_OSD_SEEK_FORWARD)
    realKey(KeyEvent.KEYCODE_DPAD_RIGHT)
    assertFocused(TAG_OSD_TRACKS)
    realKey(KeyEvent.KEYCODE_DPAD_RIGHT)
    assertFocused(TAG_OSD_SOURCES)

    realKey(KeyEvent.KEYCODE_DPAD_CENTER)
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
  }

  // Bug on the emulator: the controls appeared but the D-pad was dead. A full-screen focus target
  // has nothing beside it, so a remote that landed on the overlay root could not reach a control.
  @Test
  fun `while the controls are up the overlay root is not a focus target`() {
    mount()

    assertFocused(TAG_OSD_PLAY)
    compose.onNodeWithTag(TAG_OVERLAY_ROOT)
      .assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.Focused))
  }

  @Test
  fun `with the controls hidden the overlay root takes the remote`() {
    mount()

    realKey(KeyEvent.KEYCODE_BACK)

    compose.onNodeWithTag(TAG_OSD_PLAY).assertDoesNotExist()
    compose.onNodeWithTag(TAG_OVERLAY_ROOT)
      .assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Focused))
  }
}
