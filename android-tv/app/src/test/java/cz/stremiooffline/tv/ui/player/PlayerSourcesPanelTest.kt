@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
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
import cz.stremiooffline.tv.data.AddonSubtitleDto
import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.TagSourcesLoading
import cz.stremiooffline.tv.ui.catalog.TagSourcesPanel
import cz.stremiooffline.tv.ui.catalog.sourceRowTag
import cz.stremiooffline.tv.ui.detail.PlayTarget
import kotlinx.coroutines.CompletableDeferred
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

  private fun mount(
    api: FakeTvApi,
    sources: List<StreamDto>,
    sourceId: String = "srcB",
    loading: Boolean = false,
    subtitleType: String? = null,
    subtitleTarget: String? = null,
  ) {
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(
          key = "movie:tt1",
          title = "It",
          resume = false,
          sourceId = sourceId,
          subtitleType = subtitleType,
          subtitleTarget = subtitleTarget,
        ),
        onExit = {},
        sources = sources,
        sourcesLoading = loading,
      )
    }
    compose.waitForIdle()
  }

  /** The same player, but the list it is handed can change while the addons answer. */
  private fun mountGrowing(api: FakeTvApi, sourceId: String = "srcA"): () -> Unit {
    var sources by mutableStateOf(listOf(alpha))
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(key = "movie:tt1", title = "It", resume = false, sourceId = sourceId),
        onExit = {},
        sources = sources,
      )
    }
    compose.waitForIdle()
    return { sources = listOf(alpha, beta) }
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun back() {
    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
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

  // A window the caller fills while the viewer watches: the row appears as soon as the addon's
  // source lands, and the panel shows both.
  @Test
  fun `the player's list keeps up while the addons answer`() {
    val api = FakeTvApi()
    val addSecond = mountGrowing(api)

    compose.onNodeWithTag(TAG_OSD_SOURCES).assertDoesNotExist()

    addSecond()
    compose.waitForIdle()

    focusSources()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(sourceRowTag(0)).assertExists()
    compose.onNodeWithTag(sourceRowTag(1)).assertExists()
  }

  // A button that leaves the row while it holds the remote would leave the D-pad with nothing to
  // move from; Play has to catch it.
  @Test
  fun `a sources button that disappears while focused hands the remote to Play`() {
    val api = FakeTvApi()
    var sources by mutableStateOf(listOf(alpha, beta))
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(key = "movie:tt1", title = "It", resume = false, sourceId = "srcB"),
        onExit = {},
        sources = sources,
      )
    }
    compose.waitForIdle()

    // Right places the remote on the Sources button, through the window like a real remote.
    realKey(KeyEvent.KEYCODE_DPAD_RIGHT)
    realKey(KeyEvent.KEYCODE_DPAD_RIGHT)
    realKey(KeyEvent.KEYCODE_DPAD_RIGHT)
    compose.onNodeWithTag(TAG_OSD_SOURCES).assertIsFocused()

    sources = listOf(alpha)
    compose.waitForIdle()

    compose.onNodeWithTag(TAG_OSD_SOURCES).assertDoesNotExist()
    compose.onNodeWithTag(TAG_OSD_PLAY).assertIsFocused().assert(SemanticsMatcher.expectValue(OsdFocused, true))
  }

  // The panels act on the running session, so their buttons have to wait for it: a choice made
  // before the first descriptor lands is silently dropped.
  @Test
  fun `the sources and quality buttons wait for the session`() {
    val api = GatedStartApi()
    mount(api, listOf(alpha, beta), sourceId = "srcA")

    compose.onNodeWithTag(TAG_OSD_SOURCES).assertDoesNotExist()
    compose.onNodeWithTag(TAG_OSD_QUALITY).assertDoesNotExist()

    api.gate.complete(Unit)
    compose.waitForIdle()

    compose.onNodeWithTag(TAG_OSD_SOURCES).assertExists()
    compose.onNodeWithTag(TAG_OSD_QUALITY).assertExists()
  }

  // A source switch is a new session: the addon subtitle ids are minted again, and the cues come
  // back from the new stream's offset.
  @Test
  fun `a switch re-reads the addon subtitles and rebases the cues`() {
    val api = SwitchingApi().apply { settingsValue = SettingsResponse(subtitleLanguage = "cs") }
    mount(api, listOf(alpha, beta), sourceId = "srcA", subtitleType = "movie", subtitleTarget = "tt1")
    compose.waitUntil(5_000) { api.subtitleTextRequests.isNotEmpty() }
    compose.waitForIdle()

    assertEquals(listOf("movie" to "tt1"), api.subtitlesRequests)
    assertEquals("sid1", api.subtitleTextRequests.last().first)
    assertEquals(0.0, api.subtitleTextRequests.last().second, 0.001)

    focusSources()
    press(Key.DirectionCenter)
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.startedSources.size == 2 && api.subtitleTextRequests.size >= 2 }
    compose.waitForIdle()

    assertEquals(listOf("movie" to "tt1", "movie" to "tt1"), api.subtitlesRequests)
    assertEquals("sid2", api.subtitleTextRequests.last().first)
    assertEquals(50.0, api.subtitleTextRequests.last().second, 0.001)
  }

  private class GatedStartApi : FakeTvApi() {
    val gate = CompletableDeferred<Unit>()

    override suspend fun startPlayback(
      sourceId: String,
      capabilities: ClientCapabilitiesDto,
      time: Double,
      subtitleIds: List<String>,
    ): PlaybackDescriptorDto {
      startedSources += sourceId
      startedTimes += time
      startedCapabilities += capabilities
      startedSubtitleIds += subtitleIds
      gate.await()
      return PlaybackDescriptorDto(id = "p1", url = "stream.mp4")
    }
  }

  /** The first source direct, the second one converted, so the cues have an offset to rebase on. */
  private class SwitchingApi : FakeTvApi() {
    private var subtitleCalls = 0

    override suspend fun subtitles(type: String, id: String): List<AddonSubtitleDto> {
      subtitlesRequests += type to id
      subtitleCalls += 1
      return listOf(AddonSubtitleDto(subtitleId = "sid$subtitleCalls", lang = "cs", addonName = "OpenSubtitles"))
    }

    override suspend fun startPlayback(
      sourceId: String,
      capabilities: ClientCapabilitiesDto,
      time: Double,
      subtitleIds: List<String>,
    ): PlaybackDescriptorDto {
      startedSources += sourceId
      startedTimes += time
      startedCapabilities += capabilities
      startedSubtitleIds += subtitleIds
      return if (sourceId == "srcA") {
        PlaybackDescriptorDto(id = "pA", url = "/a.mp4")
      } else {
        PlaybackDescriptorDto(id = "pB", mode = "remux", url = "/b.m3u8", playlist = true, offset = 50.0)
      }
    }
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
