package cz.stremiooffline.tv.ui.detail

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.remember
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.catalog.episodeCardTag
import cz.stremiooffline.tv.ui.components.SpoilerHiddenKey
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Unwatched episode stills carry [SpoilerHiddenKey] only while the account hides spoilers. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class SeriesRowsSpoilerTest {

  @get:Rule val compose = createComposeRule()

  private val episodes = listOf(
    VideoDto(id = "e1", title = "One", season = 1, episode = 1),
    VideoDto(id = "e2", title = "Two", season = 1, episode = 2),
    VideoDto(id = "e3", title = "Three", season = 1, episode = 3),
    VideoDto(id = "e4", title = "Four", season = 1, episode = 4),
  )

  private fun mount(
    hideSpoilers: Boolean,
    videos: List<VideoDto> = episodes,
    season: Int = 1,
    resumeEpisode: VideoDto? = null,
    cardProgress: ((VideoDto) -> Float?)? = null,
    cardCompleted: ((VideoDto) -> Boolean)? = null,
  ) {
    compose.setContent {
      Column {
        SeriesRows(
          videos = videos,
          season = season,
          onSeason = {},
          resumeEpisode = resumeEpisode,
          focusVideo = resumeEpisode,
          seriesPosition = 0.0,
          seriesDuration = 0.0,
          imageUrl = { null },
          onSelect = {},
          focusRequester = remember { FocusRequester() },
          seasonFocus = remember { FocusRequester() },
          extras = remember { TitleExtrasState() },
          cardProgress = cardProgress,
          cardCompleted = cardCompleted,
          hideSpoilers = hideSpoilers,
        )
      }
    }
    compose.waitForIdle()
  }

  private fun spoilerHidden(video: VideoDto): Boolean {
    val tag = episodeCardTag(video)
    val marked = SemanticsMatcher.expectValue(SpoilerHiddenKey, true)
    val onCard = hasTestTag(tag) and marked
    val onDescendant = hasAnyAncestor(hasTestTag(tag)) and marked
    return compose.onAllNodes(onCard or onDescendant, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
  }

  @Test
  fun `watched and in-progress episodes stay sharp and the rest are hidden`() {
    mount(
      hideSpoilers = true,
      cardCompleted = { it.id == "e1" },
      cardProgress = { if (it.id == "e2") 0.4f else null },
    )

    assertEquals(false, spoilerHidden(episodes[0]))
    assertEquals(false, spoilerHidden(episodes[1]))
    assertEquals(true, spoilerHidden(episodes[2]))
    assertEquals(true, spoilerHidden(episodes[3]))
  }

  @Test
  fun `nothing is hidden while the preference is off`() {
    mount(
      hideSpoilers = false,
      cardCompleted = { it.id == "e1" },
      cardProgress = { if (it.id == "e2") 0.4f else null },
    )

    episodes.forEach { assertEquals(false, spoilerHidden(it)) }
  }

  @Test
  fun `a catalogue row hides only the episodes after the one to continue`() {
    mount(hideSpoilers = true, resumeEpisode = episodes[2])

    assertEquals(false, spoilerHidden(episodes[0]))
    assertEquals(false, spoilerHidden(episodes[1]))
    assertEquals(true, spoilerHidden(episodes[3]))
  }

  @Test
  fun `a season before the one to continue reads as watched`() {
    val next = VideoDto(id = "s2e1", title = "Next", season = 2, episode = 1)
    val special = VideoDto(id = "s0e1", title = "Special", season = 0, episode = 1)
    mount(hideSpoilers = true, videos = episodes + next + special, season = 1, resumeEpisode = next)

    episodes.forEach { assertEquals(false, spoilerHidden(it)) }
  }

  @Test
  fun `specials are not ordered before the season being continued`() {
    assertEquals(false, watchedBefore(VideoDto(id = "s0", season = 0, episode = 1), VideoDto(id = "x", season = 2, episode = 1)))
    assertEquals(true, watchedBefore(VideoDto(id = "a", season = 1, episode = 9), VideoDto(id = "x", season = 2, episode = 1)))
    assertEquals(false, watchedBefore(VideoDto(id = "b", season = 3, episode = 1), VideoDto(id = "x", season = 2, episode = 1)))
  }
}
