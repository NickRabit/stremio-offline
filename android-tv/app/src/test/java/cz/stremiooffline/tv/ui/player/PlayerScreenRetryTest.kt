@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.input.key.Key
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.AddonSubtitleDto
import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerScreenRetryTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  @Test
  fun `a failed start retries the start when Try again is pressed`() {
    val api = FlakyStartApi()
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(key = "movie:tt1", title = "It", resume = false, sourceId = "src1"),
        onExit = {},
      )
    }
    compose.waitForIdle()
    assertEquals(1, api.starts)

    assertEquals(1, compose.onAllNodesWithText("Try again").fetchSemanticsNodes().size)
    compose.onNodeWithText("Try again").assertIsFocused()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    assertEquals(0, compose.onAllNodesWithText("Try again").fetchSemanticsNodes().size)
    assertEquals(2, api.starts)
  }

  @Test
  fun `Try again works while the controls are hidden`() {
    val api = GatedStartApi()
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(key = "movie:tt1", title = "It", resume = false, sourceId = "src1"),
        onExit = {},
      )
    }
    compose.waitForIdle()
    assertEquals(1, api.starts)

    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
    compose.onNodeWithTag(TAG_OSD_PLAY).assertDoesNotExist()

    api.gate.completeExceptionally(ApiError(ApiFailure.Unreachable))
    compose.waitForIdle()
    compose.onNodeWithText("Try again").assertExists()
    assertEquals(1, api.starts)
    compose.onNodeWithTag(TAG_OSD_PLAY).assertDoesNotExist()

    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    assertEquals(2, api.starts)
  }

  @Test
  fun `a retry reads the addon subtitles again before it starts`() {
    val api = FlakyStartApi().apply {
      subtitlesValue = listOf(AddonSubtitleDto(subtitleId = "sid", lang = "cs", addonName = "OpenSubtitles"))
    }
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(
          key = "movie:tt1",
          title = "It",
          resume = false,
          sourceId = "src1",
          subtitleType = "movie",
          subtitleTarget = "tt1",
        ),
        onExit = {},
      )
    }
    compose.waitForIdle()
    assertEquals(1, api.subtitlesRequests.size)

    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    assertEquals(2, api.subtitlesRequests.size)
    assertEquals(listOf(listOf("sid"), listOf("sid")), api.offered)
  }

  private class FlakyStartApi : FakeTvApi() {
    var starts = 0
    val offered = mutableListOf<List<String>>()

    override suspend fun startPlayback(
      sourceId: String,
      capabilities: ClientCapabilitiesDto,
      time: Double,
      subtitleIds: List<String>,
    ): PlaybackDescriptorDto {
      starts += 1
      offered += subtitleIds
      if (starts == 1) throw ApiError(ApiFailure.Unreachable)
      return PlaybackDescriptorDto(id = "p1", url = "/stream.mp4")
    }
  }

  private class GatedStartApi : FakeTvApi() {
    val gate = CompletableDeferred<Unit>()
    var starts = 0

    override suspend fun startPlayback(
      sourceId: String,
      capabilities: ClientCapabilitiesDto,
      time: Double,
      subtitleIds: List<String>,
    ): PlaybackDescriptorDto {
      starts += 1
      if (starts == 1) {
        gate.await()
        throw ApiError(ApiFailure.Unreachable)
      }
      return PlaybackDescriptorDto(id = "p1", url = "/stream.mp4")
    }
  }
}
