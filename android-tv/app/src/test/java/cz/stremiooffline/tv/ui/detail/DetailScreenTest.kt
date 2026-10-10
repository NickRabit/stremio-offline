@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.detail

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.ProgressDto
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class DetailScreenTest {

  @get:Rule val compose = createComposeRule()

  private val progress = mutableMapOf<String, ProgressDto>()

  private fun file(path: String, label: String = path.substringAfterLast('/')) =
    BrowseItem.File(path = path, label = label)

  private fun detail(
    files: List<BrowseItem.File>,
    title: String = "It",
  ) = DetailData(
    gridPath = "Films/It",
    title = title,
    year = "2017",
    description = null,
    poster = null,
    wide = null,
    size = 41_000_000.0,
    fileCount = files.size,
    files = files,
  )

  private fun mount(data: DetailData) {
    compose.setContent {
      DetailScreen(
        detail = data,
        imageUrl = { null },
        onPlay = {},
        onBack = {},
        progress = { key -> progress[key] },
        restoreToken = 0,
      )
    }
  }

  @Test
  fun `no stored progress shows Play focused and no Start over`() {
    mount(detail(listOf(file("Films/It/It.mkv"))))

    compose.onNodeWithTag(TagDetailPrimary).assertIsFocused()
    compose.onNodeWithText("Play").assertIsDisplayed()
    compose.onNodeWithTag(TagDetailStartOver).assertDoesNotExist()
    compose.onNodeWithTag(TagDetailWatched).assertDoesNotExist()
  }

  @Test
  fun `progress above thirty seconds shows Resume, Start over and the watched bar`() {
    progress["file:Films/It/It.mkv"] = ProgressDto(38.6, 120.0)
    mount(detail(listOf(file("Films/It/It.mkv"))))

    compose.onNodeWithTag(TagDetailPrimary).assertIsFocused()
    compose.onNodeWithText("Resume").assertIsDisplayed()
    compose.onNodeWithTag(TagDetailStartOver).assertExists()
    compose.onNodeWithTag(TagDetailWatched).assertIsDisplayed()
  }

  @Test
  fun `progress under thirty seconds or completed shows Play`() {
    progress["file:Films/It/It.mkv"] = ProgressDto(10.0, 120.0)
    mount(detail(listOf(file("Films/It/It.mkv"))))
    compose.onNodeWithText("Play").assertIsDisplayed()
    compose.onNodeWithTag(TagDetailStartOver).assertDoesNotExist()
  }

  @Test
  fun `becoming visible again re-reads progress and focuses Resume`() {
    val watched = detail(listOf(file("Films/It/It.mkv")))
    var token by mutableStateOf(0)
    compose.setContent {
      DetailScreen(
        detail = watched,
        imageUrl = { null },
        onPlay = {},
        onBack = {},
        progress = { key -> progress[key] },
        restoreToken = token,
      )
    }
    compose.onNodeWithText("Play").assertIsDisplayed()
    compose.onNodeWithTag(TagDetailPrimary).assertIsFocused()

    // The player saved 38.6 s while the detail was away, and the shell bumps the restore token.
    progress["file:Films/It/It.mkv"] = ProgressDto(38.6, 120.0)
    token = 1
    compose.waitForIdle()

    compose.onNodeWithText("Resume").assertIsDisplayed()
    compose.onNodeWithTag(TagDetailPrimary).assertIsFocused()
    compose.onNodeWithTag(TagDetailStartOver).assertExists()
    compose.onNodeWithTag(TagDetailWatched).assertIsDisplayed()
  }

  @Test
  fun `returning to the detail moves focus back to the primary action`() {
    progress["file:Films/It/It.mkv"] = ProgressDto(38.6, 120.0)
    val data = detail(listOf(file("Films/It/It.mkv")))
    var token by mutableStateOf(0)
    compose.setContent {
      DetailScreen(
        detail = data,
        imageUrl = { null },
        onPlay = {},
        onBack = {},
        progress = { key -> progress[key] },
        restoreToken = token,
      )
    }
    compose.onNodeWithTag(TagDetailPrimary).assertIsFocused()

    // Focus is lost while the player is open; the return must put it back on the primary action.
    compose.onNodeWithTag(TagDetailStartOver).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    token = 1
    compose.waitForIdle()

    compose.onNodeWithTag(TagDetailPrimary).assertIsFocused()
  }

  @Test
  fun `the first not completed episode is focused when the row is entered`() {
    progress["file:Films/It/S1.mkv"] = ProgressDto(600.0, 600.0)
    val data = detail(
      listOf(
        file("Films/It/S1.mkv", "S1").copy(season = 1, episode = 1),
        file("Films/It/S2.mkv", "S2").copy(season = 1, episode = 2),
        file("Films/It/S3.mkv", "S3").copy(season = 1, episode = 3),
      ),
    )
    mount(data)
    // The row is below the actions; DOWN from the primary action enters it.
    compose.onNodeWithTag(TagDetailPrimary).performKeyInput { pressKey(Key.DirectionDown) }
    compose.waitForIdle()

    compose.onNodeWithTag("Films/It/S2.mkv").assertIsFocused()
  }
}
