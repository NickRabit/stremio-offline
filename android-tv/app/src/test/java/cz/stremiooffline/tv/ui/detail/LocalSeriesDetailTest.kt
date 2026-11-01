@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.detail

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.data.LibraryApi
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.ProgressEntryDto
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.ui.catalog.seasonChipTag
import cz.stremiooffline.tv.ui.FakeTvApi
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A show on disk opens the way a media-server series does: seasons, one card per episode, and
 *  Play on the next episode not yet finished. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class LocalSeriesDetailTest {

  @get:Rule val compose = createComposeRule()

  private val progress = mutableMapOf<String, ProgressDto>()
  private val played = mutableListOf<PlayTarget>()

  private fun episode(season: Int, number: Int, suffix: String = "", size: Double = 1e9) = BrowseItem.File(
    path = "Shows/Show/0$season serie/Show - S0${season}E0$number - Title $season$number$suffix.mkv",
    label = "Show - S0${season}E0$number - Title $season$number$suffix",
    season = season,
    episode = number,
    size = size,
  )

  private val s1e1 = episode(1, 1)
  private val s1e2 = episode(1, 2, size = 2e9)
  private val s1e2Copy = episode(1, 2, " (2)", size = 1e9)
  private val s1e3 = episode(1, 3)
  private val s2e1 = episode(2, 1)

  private fun mount() {
    compose.setContent {
      DetailScreen(
        detail = DetailData(
          gridPath = "Shows/Show",
          title = "Show",
          year = null,
          description = null,
          poster = null,
          wide = null,
          size = 0.0,
          fileCount = 4,
          files = listOf(s1e1, s1e2, s1e2Copy, s2e1),
        ),
        imageUrl = { null },
        onPlay = { played += it },
        onBack = {},
        progress = { key -> progress[key] },
        forgetProgress = {},
      )
    }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  @Test
  fun `Play stands for the next unfinished episode and down from the actions reaches the seasons`() {
    progress[Progress.libraryKey(s1e1.path)] = ProgressDto(position = 1300.0, duration = 1300.0)
    mount()

    compose.onNodeWithTag(TagDetailPickCaption).assertTextContains(s1e2.label, substring = true)
    compose.onNodeWithTag(seasonChipTag(1)).assertTextContains("1", substring = true)
    compose.onNodeWithTag(seasonChipTag(2)).assertTextContains("2", substring = true)
    // The two copies of one episode fold into a single card: the larger one stands for it.
    compose.onNodeWithTag(s1e2.path).assertTextContains("S1 · E2", substring = true)
    assertEquals(0, compose.onAllNodesWithTagCount(s1e2Copy.path))

    compose.onNodeWithTag(TagDetailPrimary).performSemanticsAction(SemanticsActions.RequestFocus)
    press(Key.DirectionDown)
    compose.onNodeWithTag(seasonChipTag(1)).assertIsFocused()

    compose.onNodeWithTag(TagDetailPrimary).performSemanticsAction(SemanticsActions.RequestFocus)
    press(Key.DirectionCenter)
    assertEquals(s1e2.path, played.single().path)
  }

  @Test
  fun `another season makes its first episode the one Play acts on`() {
    mount()

    compose.onNodeWithTag(seasonChipTag(2)).performSemanticsAction(SemanticsActions.RequestFocus)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagDetailPickCaption).assertTextContains(s2e1.label, substring = true)
    compose.onNodeWithTag(s2e1.path).assertTextContains("S2 · E1", substring = true)
  }

  @Test
  fun `a show's files are read through its season folders`() = runBlocking {
    val tree = mapOf(
      "Shows/Show" to listOf<BrowseItem>(BrowseItem.Folder(path = "Shows/Show/01 serie", titleType = "series")),
      "Shows/Show/01 serie" to listOf<BrowseItem>(s1e1, s1e2),
    )
    val api = object : LibraryApi {
      override suspend fun browse(path: String?, limit: Int, skip: Int, query: String): BrowseResult {
        val items = tree[path].orEmpty()
        return BrowseResult(path.orEmpty(), items.drop(skip).take(limit), items.size, false)
      }
    }
    assertEquals(listOf(s1e1.path, s1e2.path), seriesFiles(api, "Shows/Show")?.map { it.path })
  }

  @Test
  fun `the episode title is what the file name says after its number`() {
    assertEquals("Title 12", episodeTitleOf(s1e2))
    assertNull(episodeTitleOf(s1e2.copy(label = "Show - S01E02")))
    assertEquals("Title 12", episodeTitleOf(s1e2Copy))
  }

  @Test
  fun `Play continues the episode the viewer is in the middle of, not the first one never started`() {
    progress[Progress.libraryKey(s2e1.path)] = ProgressDto(position = 300.0, duration = 1300.0)
    mount()

    compose.onNodeWithTag(TagDetailPickCaption).assertTextContains(s2e1.label, substring = true)
    compose.onNodeWithTag(TagDetailPrimary).assertTextContains("Resume")
  }

  @Test
  fun `a finished episode uses the server's next episode marker when the file has no progress`() {
    val api = FakeTvApi().apply {
      libraryTitleValues[s1e1.path] = LibraryTitleDto(type = "series", id = "tt-show")
      progressEntries = listOf(
        ProgressEntryDto(series = ProgressEntryDto.Series(id = "tt-show", season = 1, episode = 3)),
      )
    }
    compose.setContent {
      DetailScreen(
        detail = DetailData(
          gridPath = "Shows/Show",
          title = "Show",
          year = null,
          description = null,
          poster = null,
          wide = null,
          size = 0.0,
          fileCount = 4,
          files = listOf(s1e1, s1e2, s1e3, s2e1),
        ),
        imageUrl = { null },
        onPlay = { played += it },
        onBack = {},
        progress = { null },
        forgetProgress = {},
        sourcesApi = api,
      )
    }
    compose.waitUntil(5_000) { api.progressListCalls > 0 }
    compose.waitForIdle()

    compose.onNodeWithTag(TagDetailPickCaption).assertTextContains(s1e3.label, substring = true)
    compose.onNodeWithTag(TagDetailPrimary).performSemanticsAction(SemanticsActions.RequestFocus)
    press(Key.DirectionCenter)
    assertEquals(s1e3.path, played.single().path)
  }

  private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onAllNodesWithTagCount(tag: String): Int =
    onAllNodes(androidx.compose.ui.test.hasTestTag(tag)).fetchSemanticsNodes().size
}
