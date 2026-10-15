@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.FavoriteFilter
import cz.stremiooffline.tv.data.FavoriteItemDto
import cz.stremiooffline.tv.data.FavoriteToggleDto
import cz.stremiooffline.tv.data.FavoritesPage
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.TagDetailFavourite
import cz.stremiooffline.tv.ui.favorites.favoriteCardTag
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The rail's Favourites section: selection, and returning from a detail with the list refreshed. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class FavoritesNavigationTest {

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

  /** A merged list the test edits, so a star removed in a detail is gone on the next read. */
  private class FavoritesFake : FakeTvApi() {
    val merged = mutableListOf<FavoriteItemDto>()

    override suspend fun favorites(filter: FavoriteFilter, limit: Int, skip: Int): FavoritesPage {
      favoritesRequests += filter
      val items = merged.filter {
        when (filter) {
          FavoriteFilter.All -> true
          FavoriteFilter.Library -> it is FavoriteItemDto.Library
          FavoriteFilter.Catalog -> it is FavoriteItemDto.Catalog
          FavoriteFilter.Remote -> it is FavoriteItemDto.Remote
        }
      }
      return FavoritesPage(items, items.size, false)
    }

    override suspend fun setFavorite(path: String, favorite: Boolean): FavoriteToggleDto {
      libraryFavoriteCalls += path to favorite
      if (!favorite) merged.removeAll { it is FavoriteItemDto.Library && it.path == path }
      return FavoriteToggleDto(path, favorite)
    }
  }

  private fun library(path: String, label: String = path) = FavoriteItemDto.Library(path = path, label = label)

  private fun mount(api: FakeTvApi, start: Section) {
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = start, api = api, username = "demo", onSignOut = {}) }
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

  private fun back() {
    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
  }

  private fun focusFavourite() {
    repeat(4) {
      if (focused(TagDetailFavourite)) return
      press(Key.DirectionRight)
    }
    compose.onNodeWithTag(TagDetailFavourite).assertIsFocused()
  }

  @Test
  fun `the rail opens the Favourites section`() {
    val api = FavoritesFake().apply { merged += library("browse/A.mkv", "A") }
    mount(api, Section.Catalog)

    press(Key.DirectionLeft)
    var guard = 0
    while (!focused(railTag(Section.Favorites)) && guard++ < 8) press(Key.DirectionDown)
    compose.onNodeWithTag(railTag(Section.Favorites)).assertIsFocused()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(favoriteCardTag(library("browse/A.mkv"))).assertIsFocused()
  }

  @Test
  fun `a star removed in the detail disappears and focus lands on a remaining card`() {
    val api = FavoritesFake().apply {
      merged += library("browse/A.mkv", "A")
      merged += library("browse/B.mkv", "B")
    }
    mount(api, Section.Favorites)
    val first = favoriteCardTag(library("browse/A.mkv"))
    val second = favoriteCardTag(library("browse/B.mkv"))

    // Open the second card's detail and unstar it.
    press(Key.DirectionRight)
    compose.onNodeWithTag(second).assertIsFocused()
    press(Key.DirectionCenter)
    focusFavourite()
    press(Key.DirectionCenter)
    assertEquals(listOf("browse/B.mkv" to false), api.libraryFavoriteCalls)

    // Back on the grid the removed card is gone and the remote keeps a card, not the rail.
    back()
    compose.onNodeWithTag(second).assertDoesNotExist()
    compose.onNodeWithTag(first).assertIsFocused()
  }
}
