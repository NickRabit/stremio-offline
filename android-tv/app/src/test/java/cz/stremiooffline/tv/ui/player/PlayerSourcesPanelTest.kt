@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.TagSourcesLoading
import cz.stremiooffline.tv.ui.catalog.TagSourcesPanel
import cz.stremiooffline.tv.ui.catalog.sourceRowTag
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The player's own Sources panel: the button appears only when there is a choice, the panel lands
 * on the row that is playing, and choosing another source starts it where the old one stopped.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerSourcesPanelTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private val alpha = StreamDto(sourceId = "srcA", kind = "remote", playable = true, name = "small", title = "Czech 1 GB", addonName = "Alpha")
  private val beta = StreamDto(sourceId = "srcB", kind = "remote", playable = true, name = "big", title = "Czech 8 GB", addonName = "Beta")

  private fun mount(api: FakeTvApi, sources: List<StreamDto>, sourceId: String = "srcB", loading: Boolean = false) {
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(key = "movie:tt1", title = "It", resume = false, sourceId = sourceId),
        onExit = {},
        sources = sources,
        sourcesLoading = loading,
      )
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

  /** Right from Play lands on the Sources button once the title offers a choice. */
  private fun focusSources() {
    press(Key.DirectionRight)
    press(Key.DirectionRight)
    press(Key.DirectionRight)
    compose.onNodeWithTag(TAG_OSD_SOURCES).assertIsFocused().assert(SemanticsMatcher.expectValue(OsdFocused, true))
  }

  @Test
  fun `the sources button is hidden with a single stream`() {
    mount(FakeTvApi(), listOf(alpha))

    compose.onNodeWithTag(TAG_OSD_SOURCES).assertDoesNotExist()
  }

  @Test
  fun `the panel opens on the row that is playing and Back returns the remote to the button`() {
    mount(FakeTvApi(), listOf(alpha, beta), sourceId = "srcB")

    focusSources()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSourcesPanel).assertExists()
    compose.onNodeWithTag(sourceRowTag(1)).assertIsFocused()
    compose.onNodeWithText("Playing").assertExists()
    // The default keeps its own mark, on the other row.
    compose.onNodeWithTag(sourceRowTag(0)).assertExists()
    compose.onNodeWithText("✓ Default").assertExists()

    back()

    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()
    compose.onNodeWithTag(TAG_OSD_SOURCES).assertIsFocused()
  }

  @Test
  fun `a real back key closes the panel and returns the remote to the button`() {
    mount(FakeTvApi(), listOf(alpha, beta))

    focusSources()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSourcesPanel).assertExists()

    compose.runOnUiThread {
      compose.activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK))
      compose.activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK))
    }
    compose.waitForIdle()

    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()
    compose.onNodeWithTag(TAG_OSD_SOURCES).assertIsFocused()
  }

  @Test
  fun `choosing another row stops the old session and starts the new one`() {
    val api = FakeTvApi()
    mount(api, listOf(alpha, beta), sourceId = "srcB")

    focusSources()
    press(Key.DirectionCenter)
    press(Key.DirectionUp)
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()
    compose.onNodeWithTag(TAG_OSD_SOURCES).assertIsFocused()
    assertTrue("the old session must be deleted", api.deletedIds.contains("p1"))
    assertEquals(listOf("srcB", "srcA"), api.startedSources)
  }

  @Test
  fun `choosing the row already playing only closes the panel`() {
    val api = FakeTvApi()
    mount(api, listOf(alpha, beta), sourceId = "srcB")

    focusSources()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(sourceRowTag(1)).assertIsFocused()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()
    assertEquals(listOf("srcB"), api.startedSources)
  }

  @Test
  fun `sources still arriving show what has landed and the loading spinner`() {
    mount(FakeTvApi(), listOf(alpha), loading = true)

    focusSources()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSourcesPanel).assertExists()
    compose.onNodeWithTag(sourceRowTag(0)).assertExists()
    compose.onNodeWithTag(TagSourcesLoading).assertExists()
  }

  // Found only on a device: a switch that fails must leave a way back to the source that worked.
  @Test
  fun `a failed new source offers going back to the previous one`() {
    val api = FlakySwitchApi()
    mount(api, listOf(alpha, beta), sourceId = "srcA")

    focusSources()
    press(Key.DirectionCenter)
    // srcB is the second row; focus is on srcA (the playing one).
    press(Key.DirectionDown)
    compose.onNodeWithTag(sourceRowTag(1)).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitForIdle()

    compose.onNodeWithText("Back to the previous source").assertExists()
    assertEquals(listOf("srcA", "srcB"), api.startedSources)

    // Try again is focused; Right reaches the way back and OK restarts the old source.
    press(Key.DirectionRight)
    compose.onNodeWithText("Back to the previous source").assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitForIdle()

    assertEquals(listOf("srcA", "srcB", "srcA"), api.startedSources)
    compose.onNodeWithText("Back to the previous source").assertDoesNotExist()
  }

  private class FlakySwitchApi : FakeTvApi() {
    override suspend fun startPlayback(
      sourceId: String,
      capabilities: ClientCapabilitiesDto,
      time: Double,
      subtitleIds: List<String>,
    ): PlaybackDescriptorDto {
      startedSources += sourceId
      startedTimes += time
      startedCapabilities += capabilities
      if (sourceId == "srcB") throw ApiError(ApiFailure.Unreachable)
      return PlaybackDescriptorDto(id = "p1", url = "stream.mp4")
    }
  }
}
