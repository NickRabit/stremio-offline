@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.data.FavoriteToggleDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.TagDetailFavourite
import cz.stremiooffline.tv.ui.library.FavoritesPath
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A star toggled in a library detail has to show up again when the title is reopened, and the
 * root's Favourites card has to follow it without dropping the remote off the card it came from.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class LibraryFavouriteReturnTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>

  @Before
  fun launchHost() {
    scenario = ActivityScenario.launch(
      Intent(ApplicationProvider.getApplicationContext(), ComponentActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
  }

  @After
  fun closeHost() {
    scenario.close()
  }

  /** A library whose star state lives in the fake, so a browse after a toggle sees the new state. */
  private class LibraryFake : FakeTvApi() {
    val starred = mutableSetOf<String>()
    var root: List<BrowseItem> = emptyList()
    var folder: Map<String, List<BrowseItem.File>> = emptyMap()

    override suspend fun browse(path: String?, limit: Int, skip: Int): BrowseResult {
      browseCalls += path to skip
      val items = if (path == null) root else folder[path].orEmpty()
      return BrowseResult(path.orEmpty(), items.map(::withFavorite), items.size, false)
    }

    override suspend fun favorites(limit: Int, skip: Int): BrowseResult {
      favoritesCalls += skip
      val items = root.filter { it.path in starred }.map(::withFavorite)
      return BrowseResult(FavoritesPath, items, items.size, false)
    }

    override suspend fun setFavorite(path: String, favorite: Boolean): FavoriteToggleDto {
      libraryFavoriteCalls += path to favorite
      if (favorite) starred += path else starred -= path
      return FavoriteToggleDto(path, favorite)
    }

    private fun withFavorite(item: BrowseItem): BrowseItem = when (item) {
      is BrowseItem.Folder -> item.copy(favorite = item.path in starred)
      is BrowseItem.File -> item.copy(favorite = item.path in starred)
      is BrowseItem.Library -> item
    }
  }

  private fun library() = LibraryFake().apply {
    root = listOf(BrowseItem.Folder(path = "It", name = "It", fileCount = 1))
    folder = mapOf("It" to listOf(BrowseItem.File(path = "It/It.mkv", label = "It.mkv")))
  }

  private fun mount(api: FakeTvApi) {
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = Section.Library, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focused(tag: String): Boolean =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .any { it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag }

  /** RIGHT from the detail's Play button reaches the star. */
  private fun focusFavourite() {
    repeat(4) {
      if (focused(TagDetailFavourite)) return
      press(Key.DirectionRight)
    }
    compose.onNodeWithTag(TagDetailFavourite).assertIsFocused()
  }

  private fun back() {
    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
  }

  /** The root's only folder, which opens a library detail because it holds files, not folders. */
  private fun openIt() {
    compose.onNodeWithTag("It").assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitForIdle()
  }

  @Test
  fun `a star toggled in the library detail is shown when the title is reopened`() {
    val api = library()
    mount(api)

    openIt()
    focusFavourite()
    press(Key.DirectionCenter)
    assertEquals(listOf("It" to true), api.libraryFavoriteCalls)

    back()
    openIt()

    compose.onNodeWithTag(TagDetailFavourite).assertTextContains("★")
  }

  @Test
  fun `the Favourites card follows the star and keeps focus on the card it came from`() {
    val api = library()
    mount(api)

    compose.onNodeWithTag(FavoritesPath).assertDoesNotExist()
    openIt()
    focusFavourite()
    press(Key.DirectionCenter)
    back()

    compose.onNodeWithTag(FavoritesPath).assertExists()
    compose.onNodeWithTag("It").assertIsFocused()

    openIt()
    focusFavourite()
    press(Key.DirectionCenter)
    back()

    compose.onNodeWithTag(FavoritesPath).assertDoesNotExist()
    compose.onNodeWithTag("It").assertIsFocused()
  }
}
