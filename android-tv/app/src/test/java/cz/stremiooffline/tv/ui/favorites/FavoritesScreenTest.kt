@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.favorites

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
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.data.FavoriteFilter
import cz.stremiooffline.tv.data.FavoriteItemDto
import cz.stremiooffline.tv.data.FavoritesPage
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.CatalogDetailArgs
import cz.stremiooffline.tv.ui.detail.DetailData
import cz.stremiooffline.tv.ui.file
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The one Favourites grid: the filter chips, where OK goes and how the remote keeps its place. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class FavoritesScreenTest {

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

  private fun library(path: String, label: String = path, kind: String = "file") =
    FavoriteItemDto.Library(path = path, label = label, itemKind = kind)

  private fun catalog(id: String, name: String = id, type: String = "movie") =
    FavoriteItemDto.Catalog(type = type, id = id, name = name)

  private fun mount(
    api: FakeTvApi,
    onOpenDetail: (DetailData) -> Unit = {},
    onOpenCatalog: (CatalogDetailArgs) -> Unit = {},
    onOpenLibrary: (String) -> Unit = {},
  ) {
    scenario.onActivity { activity ->
      activity.setContent {
        FavoritesRoute(api = api, onOpenDetail = onOpenDetail, onOpenCatalog = onOpenCatalog, onOpenLibrary = onOpenLibrary)
      }
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

  private fun focusBy(tag: String, key: Key, times: Int = 8) {
    repeat(times) {
      if (focused(tag)) return
      press(key)
    }
    compose.onNodeWithTag(tag).assertIsFocused()
  }

  @Test
  fun `the filter chips send the filter they name`() {
    val api = FakeTvApi()
    api.favoritesValue = FavoritesPage(emptyList(), 0, false)
    mount(api)

    compose.onNodeWithTag(favoritesFilterTag(FavoriteFilter.All)).assertIsFocused()
    focusBy(favoritesFilterTag(FavoriteFilter.Library), Key.DirectionRight)
    press(Key.DirectionCenter)

    assertEquals(listOf(FavoriteFilter.All, FavoriteFilter.Library), api.favoritesRequests)
  }

  @Test
  fun `up from the grid reaches the chips and narrows the list`() {
    val api = FakeTvApi()
    api.favoritesValue = FavoritesPage(listOf(library("browse/A.mkv", "A")), 1, false)
    mount(api)

    compose.onNodeWithTag(favoriteCardTag(library("browse/A.mkv"))).assertIsFocused()
    press(Key.DirectionUp)
    focusBy(favoritesFilterTag(FavoriteFilter.All), Key.DirectionLeft)
    focusBy(favoritesFilterTag(FavoriteFilter.Library), Key.DirectionRight)
    press(Key.DirectionCenter)

    assertEquals(listOf(FavoriteFilter.All, FavoriteFilter.Library), api.favoritesRequests)
  }

  @Test
  fun `ok on a library file favourite opens its detail`() {
    val api = FakeTvApi()
    api.favoritesValue = FavoritesPage(listOf(library("browse/It.mkv", "It")), 1, false)
    val details = mutableListOf<DetailData>()
    mount(api, onOpenDetail = { details += it })

    compose.onNodeWithTag(favoriteCardTag(library("browse/It.mkv"))).assertIsFocused()
    press(Key.DirectionCenter)

    assertEquals(1, details.size)
    assertEquals("browse/It.mkv", details[0].gridPath)
    assertEquals("It", details[0].title)
  }

  @Test
  fun `ok on a library folder favourite opens the folder's detail`() {
    val api = FakeTvApi()
    api.pages["browse/Show"] = BrowseResult("browse/Show", listOf(file("browse/Show/S1E1.mkv")), 1, false)
    api.favoritesValue = FavoritesPage(listOf(library("browse/Show", "Show", kind = "folder")), 1, false)
    val details = mutableListOf<DetailData>()
    mount(api, onOpenDetail = { details += it })

    compose.onNodeWithTag(favoriteCardTag(library("browse/Show", kind = "folder"))).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitForIdle()

    assertEquals(1, details.size)
    assertEquals("browse/Show", details[0].gridPath)
    assertEquals(1, details[0].files.size)
  }

  @Test
  fun `a folder favourite that holds folders opens the library instead`() {
    val api = FakeTvApi()
    api.pages["browse/Show"] = BrowseResult("browse/Show", listOf(BrowseItem.Folder(path = "browse/Show/S1", name = "S1")), 1, false)
    api.favoritesValue = FavoritesPage(listOf(library("browse/Show", "Show", kind = "folder")), 1, false)
    val paths = mutableListOf<String>()
    mount(api, onOpenLibrary = { paths += it })

    compose.onNodeWithTag(favoriteCardTag(library("browse/Show", kind = "folder"))).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitForIdle()

    assertEquals(listOf("browse/Show"), paths)
  }

  @Test
  fun `ok on a catalogue favourite opens the catalogue detail`() {
    val api = FakeTvApi()
    api.favoritesValue = FavoritesPage(listOf(catalog("tt2", "Show", type = "series")), 1, false)
    val opened = mutableListOf<CatalogDetailArgs>()
    mount(api, onOpenCatalog = { opened += it })

    compose.onNodeWithTag(favoriteCardTag(catalog("tt2", type = "series"))).assertIsFocused()
    press(Key.DirectionCenter)

    assertEquals(1, opened.size)
    assertEquals("tt2", opened[0].meta.id)
    assertEquals("series", opened[0].type)
    assertEquals("", opened[0].addonName)
  }
}
