@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.playback.IntroQuery
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerScreenSegmentsTest {
  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  @Test
  fun `a series target reads segments once with its season and episode`() {
    val api = FakeTvApi().apply {
      startAnswer = PlaybackDescriptorDto(id = "p1", url = "/stream.mp4", duration = 600.0)
    }
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(key = "series:tt0903747:1:2", title = "Breaking Bad", resume = false, sourceId = "src1"),
        onExit = {},
      )
    }

    compose.waitUntil(5_000) { api.introSegmentRequests.isNotEmpty() }
    assertEquals(listOf(IntroQuery("tt0903747", 1, 2)), api.introSegmentRequests)
  }

  @Test
  fun `a file target asks for no segments`() {
    val api = FakeTvApi().apply {
      startAnswer = PlaybackDescriptorDto(id = "p1", url = "/stream.mp4", duration = 600.0)
    }
    compose.setContent {
      PlayerScreen(
        api = api,
        target = PlayTarget(
          key = Progress.libraryKey("Films/a.mkv"),
          title = "A",
          resume = false,
          path = "Films/a.mkv",
        ),
        onExit = {},
      )
    }
    compose.waitUntil(5_000) { api.startedSources.isNotEmpty() }

    assertTrue(api.introSegmentRequests.isEmpty())
  }
}
