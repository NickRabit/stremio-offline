@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The panels as the remote reaches them: opened from the OSD with the D-pad, they take focus on
 * the row in use, keep it, and hand it back to the button that opened them. Bug on the emulator:
 * the panel never took the remote and the OSD drew over it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerPanelFocusTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private val api = FakeTvApi().apply {
    startAnswer = PlaybackDescriptorDto(
      id = "p1",
      url = "/stream.mp4",
      audioTracks = tracks(
        """{"index":0,"language":"en","codec":"aac","channels":2}""",
        """{"index":1,"language":"cs","codec":"eac3","channels":6}""",
      ),
      audioTrack = 0,
      subtitleTracks = tracks("""{"index":0,"language":"cs","codec":"subrip"}"""),
      subtitleTrack = 0,
    )
  }

  private fun mount() {
    compose.setContent {
      PlayerScreen(api = api, target = PlayTarget(key = "movie:tt1", title = "It", resume = false, sourceId = "src1"), onExit = {})
    }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun back() {
    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
  }

  /** A real remote Back, the way Android 14 delivers it to the window. */
  private fun backKey() {
    compose.runOnUiThread {
      compose.activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK))
      compose.activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK))
    }
    compose.waitForIdle()
  }

  @Test
  fun `the tracks panel takes the remote on the audio in use and Back returns it`() {
    mount()

    compose.onNodeWithTag(TAG_OSD_PLAY).assertIsFocused()
    press(Key.DirectionRight)
    compose.onNodeWithTag(TAG_OSD_SEEK_FORWARD).assertIsFocused()
    press(Key.DirectionRight)
    compose.onNodeWithTag(TAG_OSD_TRACKS).assertIsFocused()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagTracksPanel).assertExists()
    compose.onNodeWithTag(audioRowTag(0)).assertIsFocused()
    press(Key.DirectionDown)
    compose.onNodeWithTag(audioRowTag(1)).assertIsFocused()

    back()

    compose.onNodeWithTag(TagTracksPanel).assertDoesNotExist()
    compose.onNodeWithTag(TAG_OSD_TRACKS).assertIsFocused()
  }

  @Test
  fun `the diagnostics panel takes the remote and Back returns it to the i button`() {
    mount()

    press(Key.DirectionRight)
    press(Key.DirectionRight)
    press(Key.DirectionRight)
    compose.onNodeWithTag(TAG_OSD_DIAG).assertIsFocused()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagDiagPanel).assertExists()
    assertTrue("the OSD must not keep the remote behind the panel", focusedTags().none { it.startsWith("osd_") })

    back()

    compose.onNodeWithTag(TagDiagPanel).assertDoesNotExist()
    compose.onNodeWithTag(TAG_OSD_DIAG).assertIsFocused()
  }

  // Bug on the emulator: after Back closed the tracks panel the remote landed on Play instead of
  // the button that opened the panel.
  @Test
  fun `a real back key returns the remote to the tracks button`() {
    mount()

    press(Key.DirectionRight)
    press(Key.DirectionRight)
    compose.onNodeWithTag(TAG_OSD_TRACKS).assertIsFocused()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagTracksPanel).assertExists()

    backKey()

    compose.onNodeWithTag(TagTracksPanel).assertDoesNotExist()
    compose.onNodeWithTag(TAG_OSD_TRACKS).assertIsFocused()
  }

  @Test
  fun `the panel is drawn over the OSD, not under it`() {
    mount()

    press(Key.DirectionRight)
    press(Key.DirectionRight)
    press(Key.DirectionCenter)

    assertEquals(listOf(TAG_OSD_PLAY, TagTracksPanel), drawnOrder())
  }

  @Test
  fun `the tracks button names itself and keeps a mark without a language`() {
    api.startAnswer = PlaybackDescriptorDto(
      id = "p1",
      url = "/stream.mp4",
      audioTracks = tracks("""{"index":0,"codec":"aac","channels":2}"""),
    )
    mount()

    compose.onNodeWithTag(TAG_OSD_TRACKS).assertContentDescriptionEquals("Audio and subtitles")
    compose.onNodeWithText("CC").assertExists()
  }

  private fun focusedTags(): List<String> =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .mapNotNull { it.config.getOrNull(SemanticsProperties.TestTag) }

  /** The tagged nodes in the order the tree draws them: later means on top. */
  private fun drawnOrder(): List<String> =
    compose.onAllNodes(hasTestTag(TagTracksPanel) or hasTestTag(TAG_OSD_PLAY)).fetchSemanticsNodes()
      .mapNotNull { it.config.getOrNull(SemanticsProperties.TestTag) }

  private fun tracks(vararg items: String): List<JsonObject> =
    items.map { Json.parseToJsonElement(it).jsonObject }
}
