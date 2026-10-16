@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.activity.ComponentActivity
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.ClientCapabilitiesDto
import cz.stremiooffline.tv.data.NextFileDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Try again after a next-episode start fails must restart that episode. Bumping the attempt used to
 * replay the title the player was opened on, because the start effect still read that target.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerScreenNextRetryTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private val api = FlakyNextApi().apply {
    libraryNextValue = NextFileDto(path = "Films/B.mkv", title = "B \u00b7 S1 \u00b7 E2")
  }

  @Test
  fun `Try again after a failed next start plays the next episode`() {
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(
          key = Progress.libraryKey("Films/A.mkv"),
          title = "A \u00b7 S1 \u00b7 E1",
          resume = false,
          path = "Films/A.mkv",
        ),
        onExit = {},
      )
    }
    compose.waitForIdle()
    compose.waitUntil(5_000) { api.libraryNextRequests.isNotEmpty() }
    assertEquals(listOf("src:Films/A.mkv"), api.startedSources)

    compose.onNodeWithTag(TAG_OSD_NEXT).requestFocus()
    compose.onNodeWithTag(TAG_OSD_NEXT).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.waitUntil(5_000) { api.startedSources.size == 2 }
    compose.onNodeWithText("Try again").assertExists()

    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.waitUntil(5_000) { api.startedSources.size == 3 }

    assertEquals(listOf("src:Films/A.mkv", "src:Films/B.mkv", "src:Films/B.mkv"), api.startedSources)
  }

  /** The first episode starts; the next one always fails, so Try again has to try it again. */
  private class FlakyNextApi : FakeTvApi() {
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
      startedCapabilities += capabilities
      startedSubtitleIds += subtitleIds
      if (sourceId == "src:Films/B.mkv") throw ApiError(ApiFailure.Unreachable)
      return PlaybackDescriptorDto(id = "p1", url = "/stream.mp4", duration = 600.0)
    }
  }
}
