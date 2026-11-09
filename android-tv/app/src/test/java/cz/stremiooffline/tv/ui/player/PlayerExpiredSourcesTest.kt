@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.activity.ComponentActivity
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
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
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.ui.FakeTvApi
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
 * The server forgets a listed source id 30 minutes after listing it. The player's Sources panel
 * holds the rows its episode started with, so a choice made late in a long play must not hand the
 * server an id it no longer knows.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerExpiredSourcesTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private val alpha = StreamDto(sourceId = "srcA", kind = "remote", playable = true, name = "small", title = "Czech 1 GB", addonKey = "alpha", addonName = "Alpha", stableKey = "keyA")
  private val beta = StreamDto(sourceId = "srcB", kind = "remote", playable = true, name = "big", title = "Czech 8 GB", addonKey = "beta", addonName = "Beta", stableKey = "keyB")
  private var now = 1_000_000L

  /** A title whose addon now lists the alpha row under a new id, as the server does once the old one expired. */
  private open class RelistingApi : FakeTvApi() {
    init {
      streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    }

    fun relist(id: String) {
      addonStreams["movie:tt1|alpha"] = listOf(
        StreamDto(sourceId = id, kind = "remote", playable = true, name = "small", title = "Czech 1 GB", addonKey = "alpha", addonName = "Alpha", stableKey = "keyA"),
      )
    }
  }

  /** Every id in [expired] is refused the way the server refuses an id it dropped. */
  private class ExpiringApi(private val expired: Set<String>) : RelistingApi() {
    override suspend fun startPlayback(
      sourceId: String,
      capabilities: ClientCapabilitiesDto,
      time: Double,
      subtitleIds: List<String>,
      audioLanguage: String?,
      subtitleLanguage: String?,
      subtitleOff: Boolean,
    ): PlaybackDescriptorDto {
      startedSources += sourceId
      startedTimes += time
      if (sourceId in expired) throw ApiError(ApiFailure.NotFound, serverMessage = "Media resource expired or unavailable. Select the source again.", status = 410)
      return PlaybackDescriptorDto(id = "p$sourceId", url = "stream.mp4")
    }
  }

  private fun mount(api: FakeTvApi) {
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(
          key = "movie:tt1",
          title = "It",
          resume = false,
          sourceId = "srcB",
          subtitleType = "movie",
          subtitleTarget = "tt1",
          catalogue = true,
        ),
        onExit = {},
        sources = listOf(alpha, beta),
        clock = { now },
      )
    }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun openSources() {
    press(Key.DirectionRight)
    press(Key.DirectionRight)
    press(Key.DirectionRight)
    compose.onNodeWithTag(TAG_OSD_SOURCES).assertIsFocused()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
  }

  /** The playing beta row leads the panel; alpha is the row below it. */
  private fun chooseAlpha() {
    press(Key.DirectionDown)
    compose.onNodeWithTag(sourceRowTag(1)).assertIsFocused()
    press(Key.DirectionCenter)
  }

  @Test
  fun `a panel opened while the list is fresh asks nothing again`() {
    val api = RelistingApi().apply { relist("srcA2") }
    mount(api)
    now += 19 * 60_000L

    openSources()

    assertTrue(api.streamSourcesRequests.isEmpty())
    chooseAlpha()
    assertEquals(listOf("srcB", "srcA"), api.startedSources)
  }

  @Test
  fun `a panel opened after the list grew old reads the title again and starts the row under its new id`() {
    val api = RelistingApi().apply { relist("srcA2") }
    mount(api)
    now += 21 * 60_000L

    openSources()
    compose.waitUntil(5_000) { api.streamsCompleted.isNotEmpty() }
    compose.waitForIdle()

    assertEquals(listOf("movie:tt1"), api.streamSourcesRequests)
    chooseAlpha()
    compose.waitUntil(5_000) { api.startedSources.size == 2 }
    assertEquals(listOf("srcB", "srcA2"), api.startedSources)
  }

  @Test
  fun `a switch refused as expired reads the list again and starts the same row once more`() {
    val api = ExpiringApi(expired = setOf("srcA")).apply { relist("srcA2") }
    mount(api)

    openSources()
    chooseAlpha()
    compose.waitUntil(5_000) { api.startedSources.size == 3 }
    compose.waitForIdle()

    assertEquals(listOf("srcB", "srcA", "srcA2"), api.startedSources)
    assertEquals(listOf("movie:tt1"), api.streamSourcesRequests)
    assertEquals(0, compose.onAllNodesWithText("Try again").fetchSemanticsNodes().size)
  }

  @Test
  fun `an expired switch is retried on its own only once, and Try again looks the row up again`() {
    val api = ExpiringApi(expired = setOf("srcA", "srcA2")).apply { relist("srcA2") }
    mount(api)

    openSources()
    chooseAlpha()
    compose.waitUntil(5_000) { api.startedSources.size == 3 }
    compose.waitForIdle()
    assertEquals(listOf("srcB", "srcA", "srcA2"), api.startedSources)
    assertEquals(1, compose.onAllNodesWithText("Try again").fetchSemanticsNodes().size)

    api.relist("srcA3")
    compose.onNodeWithText("Try again").assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.startedSources.size == 4 }
    compose.waitForIdle()

    assertEquals(listOf("srcB", "srcA", "srcA2", "srcA3"), api.startedSources)
  }
}
