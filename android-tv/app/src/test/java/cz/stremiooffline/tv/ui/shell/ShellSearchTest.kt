@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.data.CatalogDto
import cz.stremiooffline.tv.data.CatalogExtraDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.SearchableCatalogDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.library.TagLibrarySearchAction
import cz.stremiooffline.tv.ui.search.TagGlobalSearchField
import cz.stremiooffline.tv.ui.search.TagGlobalSearchInput
import cz.stremiooffline.tv.ui.search.TagGlobalSearchLibraryChip
import cz.stremiooffline.tv.ui.search.TagGlobalSearchScopeChip
import cz.stremiooffline.tv.ui.search.globalSearchFilterTag
import cz.stremiooffline.tv.ui.catalog.TagCatalogChip
import cz.stremiooffline.tv.ui.catalog.TagCatalogGenreChip
import cz.stremiooffline.tv.ui.catalog.TagCatalogSearchChip
import cz.stremiooffline.tv.ui.catalog.TagSearchScopeChip
import cz.stremiooffline.tv.ui.catalog.TagSearchField
import androidx.compose.ui.semantics.SemanticsActions
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Search scoped from the catalogue: the preset and the way Back lands. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class ShellSearchTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>
  private var host: ComponentActivity? = null

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

  private fun api(): FakeTvApi {
    val api = FakeTvApi()
    api.catalogsValue = listOf(CatalogDto(addonKey = "a", addonName = "Cinemeta", type = "movie", id = "top", name = "Popular"))
    api.catalogPages["a"] = listOf(listOf(MetaDto(id = "tt1", type = "movie", name = "It")))
    api.searchableValue = listOf(SearchableCatalogDto("a", "Cinemeta", true, "movie", "top", "Popular"))
    return api
  }

  private fun mount(api: FakeTvApi, start: Section) {
    scenario.onActivity { activity ->
      host = activity
      activity.setContent { Shell(start = start, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focus(tag: String) {
    compose.onNodeWithTag(tag).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
  }

  @Test
  fun `the rail's Search opens on all addons by default`() {
    mount(api(), Section.Search)

    compose.onNodeWithTag(TagSearchScopeChip).assertTextContains("all addons", substring = true)
  }

  @Test
  fun `rail Search opens global search when the server flag is on`() {
    val api = api()
    api.globalSearchEnabled = true
    mount(api, Section.Search)

    compose.onNodeWithTag(TagGlobalSearchField).assertExists()
    compose.onNodeWithTag(TagSearchField).assertDoesNotExist()
  }

  @Test
  fun `rail Search keeps the catalog search when the flag is off`() {
    val api = api()
    api.globalSearchEnabled = false
    mount(api, Section.Search)

    compose.onNodeWithTag(TagSearchField).assertExists()
    compose.onNodeWithTag(TagGlobalSearchField).assertDoesNotExist()
  }

  @Test
  fun `Catalog Hledat opens global search with the catalogue preset and Back returns to Catalog`() {
    val api = api()
    api.globalSearchEnabled = true
    mount(api, Section.Catalog)
    compose.waitUntil(5_000) { api.globalSearchEnabledCalls > 0 }
    compose.waitForIdle()

    press(Key.DirectionLeft)
    compose.onNodeWithTag(TagCatalogSearchChip).assertIsFocused()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagGlobalSearchField).assertExists()
    compose.onNodeWithTag(TagSearchField).assertDoesNotExist()
    compose.waitUntil(5_000) { api.searchableCalls > 0 }
    compose.waitForIdle()
    compose.onNodeWithTag(TagGlobalSearchScopeChip).assertTextContains("Cinemeta · Popular (movie)", substring = true)

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    compose.onNodeWithTag(TagCatalogChip).assertIsFocused()
  }

  @Test
  fun `rail Search after a catalogue search starts without the preset`() {
    val api = api()
    api.globalSearchEnabled = true
    mount(api, Section.Catalog)
    compose.waitUntil(5_000) { api.globalSearchEnabledCalls > 0 }
    compose.waitForIdle()

    press(Key.DirectionLeft)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.searchableCalls > 0 }
    compose.onNodeWithTag(TagGlobalSearchScopeChip).assertTextContains("Cinemeta · Popular (movie)", substring = true)

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    compose.onNodeWithTag(TagCatalogChip).assertIsFocused()
    press(Key.DirectionLeft)
    compose.onNodeWithTag(TagCatalogSearchChip).assertIsFocused()
    press(Key.DirectionLeft)
    compose.onNodeWithTag(railTag(Section.Catalog)).assertIsFocused()
    press(Key.DirectionUp)
    press(Key.DirectionUp)
    compose.onNodeWithTag(railTag(Section.Search)).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitForIdle()

    compose.onNodeWithTag(TagGlobalSearchLibraryChip).assertDoesNotExist()
    compose.onNodeWithTag(TagGlobalSearchScopeChip).assertTextContains("all addons", substring = true)

    focus(TagGlobalSearchField)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagGlobalSearchInput).performTextInput("matrix")
    compose.onNodeWithTag(TagGlobalSearchInput).performImeAction()
    compose.waitUntil(5_000) { api.globalStartCalls.isNotEmpty() }
    assertEquals(listOf("catalog", "local", "remote"), api.globalStartCalls.last().sources)
    assertNull(api.globalStartCalls.last().scope)
    assertNull(api.globalStartCalls.last().library)
  }

  @Test
  fun `LEFT from the scope chip walks back to the field`() {
    mount(api(), Section.Search)

    compose.onNodeWithTag(TagSearchField).assertIsFocused()
    press(Key.DirectionRight)
    compose.onNodeWithTag(TagSearchScopeChip).assertIsFocused()
    press(Key.DirectionLeft)
    compose.onNodeWithTag(TagSearchField).assertIsFocused()
  }

  @Test
  fun `LEFT walks the catalogue chip row back to the search chip`() {
    val api = FakeTvApi()
    api.catalogsValue = listOf(
      CatalogDto(
        addonKey = "a",
        addonName = "Cinemeta",
        type = "movie",
        id = "top",
        name = "Popular",
        extra = listOf(CatalogExtraDto(name = "genre", options = listOf("Action", "Comedy"))),
      ),
    )
    api.catalogPages["a"] = listOf(listOf(MetaDto(id = "tt1", type = "movie", name = "It")))
    api.searchableValue = listOf(SearchableCatalogDto("a", "Cinemeta", true, "movie", "top", "Popular"))
    mount(api, Section.Catalog)

    compose.onNodeWithTag(TagCatalogChip).assertIsFocused()
    press(Key.DirectionRight)
    compose.onNodeWithTag(TagCatalogGenreChip).assertIsFocused()
    press(Key.DirectionLeft)
    compose.onNodeWithTag(TagCatalogChip).assertIsFocused()
    press(Key.DirectionLeft)
    compose.onNodeWithTag(TagCatalogSearchChip).assertIsFocused()
  }

  @Test
  fun `Search from the catalogue presets the scope and Back returns to the catalogue chip`() {
    mount(api(), Section.Catalog)

    press(Key.DirectionLeft)
    compose.onNodeWithTag(TagCatalogSearchChip).assertIsFocused()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSearchScopeChip).assertTextContains("Cinemeta · Popular (movie)", substring = true)

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogChip).assertIsFocused()
  }

  @Test
  fun `the rail's Search opens on the last used scope`() {
    mount(api(), Section.Catalog)

    press(Key.DirectionLeft)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSearchScopeChip).assertTextContains("Popular", substring = true)

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()

    // Out to the rail, up to its Search item, and in again.
    compose.onNodeWithTag(TagCatalogChip).assertIsFocused()
    press(Key.DirectionLeft)
    compose.onNodeWithTag(TagCatalogSearchChip).assertIsFocused()
    press(Key.DirectionLeft)
    compose.onNodeWithTag(railTag(Section.Catalog)).assertIsFocused()
    press(Key.DirectionUp)
    press(Key.DirectionUp)
    compose.onNodeWithTag(railTag(Section.Search)).assertIsFocused()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSearchScopeChip).assertTextContains("Cinemeta · Popular (movie)", substring = true)
  }

  @Test
  fun `a library Search opens its page and Back returns to the Search action`() {
    val api = FakeTvApi()
    api.globalSearchEnabled = true
    api.librariesValue = listOf(LibraryDto(id = "lib_ab12cd34", name = "Films"))
    api.pages[null] = BrowseResult("", listOf(BrowseItem.Folder(path = "Shows", name = "Shows")), 1, false)
    mount(api, Section.Library)
    compose.waitUntil(5_000) { api.globalSearchEnabledCalls > 0 && api.librariesCalls > 0 }
    compose.waitForIdle()

    compose.onNodeWithText("Files").performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    press(Key.DirectionCenter)
    compose.waitForIdle()

    focus(TagLibrarySearchAction)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagGlobalSearchField).assertExists()
    compose.onNodeWithTag(globalSearchFilterTag("source_all")).assertExists()
    compose.onNodeWithTag(TagGlobalSearchLibraryChip).assertExists()

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    compose.onNodeWithTag(TagLibrarySearchAction).assertIsFocused()
    compose.onNodeWithTag(TagGlobalSearchField).assertDoesNotExist()
  }
}
