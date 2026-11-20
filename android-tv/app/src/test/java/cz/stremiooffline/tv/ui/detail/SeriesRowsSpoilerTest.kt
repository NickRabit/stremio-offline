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
  fun `a catalogue row shows only the episode being continued`() {
    mount(hideSpoilers = true, resumeEpisode = episodes[2], cardProgress = { if (it.id == "e3") 0.2f else null })

    assertEquals(true, spoilerHidden(episodes[0]))
    assertEquals(true, spoilerHidden(episodes[1]))
    assertEquals(false, spoilerHidden(episodes[2]))
    assertEquals(true, spoilerHidden(episodes[3]))
  }

  @Test
  fun `a season before the one to continue stays hidden without its own progress`() {
    val next = VideoDto(id = "s2e1", title = "Next", season = 2, episode = 1)
    mount(hideSpoilers = true, videos = episodes + next, season = 1, resumeEpisode = next)

    episodes.forEach { assertEquals(true, spoilerHidden(it)) }
  }

  @Test
  fun `an earlier season episode with its own progress stays sharp`() {
    val next = VideoDto(id = "s2e1", title = "Next", season = 2, episode = 1)
    mount(
      hideSpoilers = true,
      videos = episodes + next,
      season = 1,
      resumeEpisode = next,
      cardCompleted = { it.id == "e1" },
      cardProgress = { if (it.id == "e2") 0.3f else null },
    )

    assertEquals(false, spoilerHidden(episodes[0]))
    assertEquals(false, spoilerHidden(episodes[1]))
    assertEquals(true, spoilerHidden(episodes[2]))
  }
}
