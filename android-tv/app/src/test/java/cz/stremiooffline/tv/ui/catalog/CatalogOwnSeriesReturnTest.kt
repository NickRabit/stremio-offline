@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import cz.stremiooffline.tv.catalog.ResumeEpisode
import cz.stremiooffline.tv.data.BehaviorHintsDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.Rule
import org.junit.Test
import org.junit.Assert.assertTrue
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h1600dp-xhdpi")
class CatalogOwnSeriesReturnTest {

  @get:Rule val compose = createComposeRule()

  private val paths = (1..3).map { "Shows/Local/Season 01/Local - S01E0$it.mp4" }

  private fun row(path: String) = StreamDto(
    sourceId = "file:$path",
    kind = "library",
    playable = true,
    name = path.substringAfterLast('/'),
    localPath = path,
    behaviorHints = BehaviorHintsDto(filename = path.substringAfterLast('/')),
  )

  private fun args() = CatalogDetailArgs(
    meta = MetaDto(
      id = "local:Shows/Local",
      type = "series",
      name = "Local",
      videos = paths.mapIndexed { index, path ->
        VideoDto(
          id = "local:$path",
          season = 1,
          episode = index + 1,
          title = path.substringAfterLast('/'),
        )
      },
    ),
    addonName = "",
    type = "series",
    episode = ResumeEpisode("series:local:${paths.first()}", 1, 1),
    backend = LibraryBackend(
      rows = paths.associate { path -> "local:$path" to listOf(row(path)) },
      favouritePath = "Shows/Local",
      favourite = false,
    ),
  )

  @Test
  fun `a finished own episode moves the selection to the last episode when all are done`() {
    val api = FakeTvApi()
    val args = args()
    val token = mutableIntStateOf(0)
    compose.setContent {
      CatalogDetailScreen(
        api = api,
        args = args,
        imageUrl = { null },
        onPlay = {},
        onBack = {},
        restoreToken = token.intValue,
      )
    }
    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogMarkWatched).assertExists() }.isSuccess
    }
    compose.waitForIdle()
    compose.runOnIdle {
      paths.forEach { api.progressValues["file:$it"] = ProgressDto(1.0, 1.0) }
      token.intValue = 1
    }
    compose.waitForIdle()

    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogChosenSource).assertTextContains("Local - S01E03.mp4", substring = true) }.isSuccess
    }
    compose.onNodeWithTag(TagCatalogChosenSource).assertTextContains("Local - S01E03.mp4", substring = true)
    val texts = compose.onNodeWithTag(TagCatalogChosenSource).fetchSemanticsNode().config[SemanticsProperties.Text].map { it.text }
    assertTrue(texts.none { it.contains("Local - S01E01.mp4") })
    compose.onAllNodesWithText("✓", useUnmergedTree = true).assertCountEquals(3)
  }

  @Test
  fun `a finished own episode moves the selection to the next unfinished episode`() {
    val api = FakeTvApi()
    val args = args()
    val token = mutableIntStateOf(0)
    compose.setContent {
      CatalogDetailScreen(
        api = api,
        args = args,
        imageUrl = { null },
        onPlay = {},
        onBack = {},
        restoreToken = token.intValue,
      )
    }
    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogMarkWatched).assertExists() }.isSuccess
    }
    compose.waitForIdle()
    compose.runOnIdle {
      api.progressValues["file:${paths.first()}"] = ProgressDto(1.0, 1.0)
      token.intValue = 1
    }
    compose.waitForIdle()

    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagCatalogChosenSource).assertTextContains("Local - S01E02.mp4", substring = true) }.isSuccess
    }
    compose.onNodeWithTag(TagCatalogChosenSource).assertTextContains("Local - S01E02.mp4", substring = true)
  }
}
