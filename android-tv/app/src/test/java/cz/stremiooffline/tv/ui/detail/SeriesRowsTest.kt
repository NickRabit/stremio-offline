package cz.stremiooffline.tv.ui.detail

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.remember
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.catalog.episodeCardTag
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The season picker and episode row a series detail draws under its actions. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class SeriesRowsTest {

  @get:Rule val compose = createComposeRule()

  private val videos = (1..12).map { VideoDto(id = "s1e$it", title = "Episode $it", season = 1, episode = it) } +
    VideoDto(id = "s0e1", title = "Special", season = 0, episode = 1)

  private fun mount(focusVideo: VideoDto?) {
    compose.setContent {
      Column {
        SeriesRows(
          videos = videos,
          season = 1,
          onSeason = {},
          resumeEpisode = focusVideo,
          focusVideo = focusVideo,
          seriesPosition = 0.0,
          seriesDuration = 0.0,
          imageUrl = { null },
          onSelect = {},
          focusRequester = remember { FocusRequester() },
          seasonFocus = remember { FocusRequester() },
          extras = remember { TitleExtrasState() },
        )
      }
    }
    compose.waitForIdle()
  }

  @Test
  fun `the episode to continue is in view before focus reaches the row`() {
    val tenth = videos.first { it.id == "s1e10" }
    mount(tenth)

    compose.onNodeWithTag(episodeCardTag(tenth)).assertIsDisplayed().assertIsNotFocused()
  }

  @Test
  fun `season zero is named specials`() {
    mount(null)

    compose.onNodeWithText("Specials").assertExists()
    compose.onNodeWithText("Season 0").assertDoesNotExist()
  }
}
