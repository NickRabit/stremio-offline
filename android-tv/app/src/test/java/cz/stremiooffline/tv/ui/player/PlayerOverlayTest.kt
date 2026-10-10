@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.tv.material3.Text
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Robolectric does not deliver `Key.Back` to a Compose view, so Back's rule (hide, then leave) is
 * covered by [PlayerKeysTest]. Everything else the OSD does is driven here through a focusable
 * "video" area, the way the hidden-OSD state gives the video the remote.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerOverlayTest {

  @get:Rule val compose = createComposeRule()

  private var pauses = 0
  private var exits = 0
  private val seeks = mutableListOf<Double>()

  private fun mount(
    position: Double = 100.0,
    duration: Double = 1_000.0,
    playing: Boolean = false,
    initiallyShown: Boolean = true,
  ) {
    compose.setContent {
      PlayerOverlayShell(
        position = position,
        duration = duration,
        playing = playing,
        title = "It",
        eyebrow = "Direct play",
        playFocus = FocusRequester(),
        initiallyShown = initiallyShown,
        onSeek = { seeks += it },
        onTogglePause = { pauses++ },
        onExit = { exits++ },
      ) {
        val video = androidx.compose.runtime.remember { FocusRequester() }
        Box(
          Modifier
            .fillMaxSize()
            .testTag("video")
            .focusRequester(video)
            .focusable()
            .background(Color.Black),
        )
        androidx.compose.runtime.LaunchedEffect(Unit) { video.requestFocus() }
      }
    }
  }

  /**
   * The same shell with content that is not focusable, the way `PlayerScreen`'s `PlayerView` is.
   * The widget takes no focus, so once the OSD is gone the overlay itself is the only target left.
   */
  private fun mountWithoutFocusableContent(
    position: Double = 100.0,
    duration: Double = 1_000.0,
    playing: Boolean = true,
  ) {
    compose.setContent {
      PlayerOverlayShell(
        position = position,
        duration = duration,
        playing = playing,
        title = "It",
        eyebrow = "Direct play",
        playFocus = FocusRequester(),
        initiallyShown = true,
        onSeek = { seeks += it },
        onTogglePause = { pauses++ },
        onExit = { exits++ },
      ) {
        Box(Modifier.fillMaxSize().testTag("video").background(Color.Black))
      }
    }
  }

  @Test
  fun `the seek buttons carry the ten label`() {
    mount()

    assertEquals(2, compose.onAllNodesWithText("10").fetchSemanticsNodes().size)
  }

  @Test
  fun `with controls hidden OK pauses and shows them`() {
    mount(initiallyShown = false)
    compose.onNodeWithTag(TAG_OSD_SEEK_BACK).assertDoesNotExist()

    compose.onNodeWithTag("video").performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    assertEquals(1, pauses)
    compose.onNodeWithTag(TAG_OSD_PLAY).assertExists()
  }

  @Test
  fun `with controls hidden left and right seek and show a bubble`() {
    mount(initiallyShown = false)

    compose.onNodeWithTag("video").performKeyInput { pressKey(Key.DirectionRight) }
    compose.waitForIdle()
    assertEquals(listOf(110.0), seeks)
    compose.onNodeWithTag(TAG_OVERLAY_BUBBLE).assertExists()

    compose.onNodeWithTag("video").performKeyInput { pressKey(Key.DirectionLeft) }
    compose.waitForIdle()
    assertEquals(listOf(110.0, 90.0), seeks)
  }

  @Test
  fun `the controls hide after five seconds of playback with no input`() {
    mount(playing = true)
    compose.onNodeWithTag(TAG_OSD_SEEK_BACK).assertExists()

    compose.mainClock.advanceTimeBy(CONTROLS_HIDE_MS + 100)
    compose.waitForIdle()

    assertTrue(compose.onAllNodes(hasTestTag(TAG_OSD_SEEK_BACK)).fetchSemanticsNodes().isEmpty())
  }

  @Test
  fun `with controls hidden back leaves the player`() {
    mount(initiallyShown = false)

    compose.onNodeWithTag("video").performKeyInput { pressKey(Key.Back) }
    compose.waitForIdle()

    assertEquals(1, exits)
  }

  // Bug 1: the shell never took focus when the OSD hid, so a non-focusable video left nothing to
  // press and the remote went dead. The overlay root has to own focus in the hidden state.
  @Test
  fun `after auto-hide OK pauses and shows the controls again`() {
    mountWithoutFocusableContent()

    compose.mainClock.advanceTimeBy(CONTROLS_HIDE_MS + 100)
    compose.waitForIdle()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    assertEquals(1, pauses)
    compose.onNodeWithTag(TAG_OSD_PLAY).assertExists()
  }

  // Bug 1: with the OSD hidden nothing held focus, so Back was dropped instead of leaving.
  @Test
  fun `after auto-hide back leaves the player`() {
    mountWithoutFocusableContent()

    compose.mainClock.advanceTimeBy(CONTROLS_HIDE_MS + 100)
    compose.waitForIdle()
    compose.onRoot().performKeyInput { pressKey(Key.Back) }
    compose.waitForIdle()

    assertEquals(1, exits)
  }
}
