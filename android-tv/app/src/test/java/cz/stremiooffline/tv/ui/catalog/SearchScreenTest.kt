@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.input.key.Key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.unit.dp
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.SearchScope
import cz.stremiooffline.tv.data.SearchResultDto
import cz.stremiooffline.tv.data.SearchableCatalogDto
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class SearchScreenTest {

  @get:Rule val compose = createComposeRule()

  private fun meta(id: String, name: String = id) = MetaDto(id = id, type = "movie", name = name)

  private var scope = mutableStateOf(SearchScope())

  private fun searchable(
    addonKey: String,
    addonName: String,
    type: String = "movie",
    id: String = "top",
    name: String = id,
    globalSearch: Boolean = true,
  ) = SearchableCatalogDto(addonKey, addonName, globalSearch, type, id, name)

  private fun mount(api: FakeTvApi, initial: SearchScope = SearchScope()) {
    scope = mutableStateOf(initial)
    compose.setContent {
      SearchScreen(
        api = api,
        scope = scope.value,
        onScopeChange = { scope.value = it },
        onOpenDetail = {},
        imageUrl = { null },
      )
    }
  }

  private fun type(query: String) {
    focusBy(TagSearchField, Key.DirectionLeft)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSearchInput).performTextInput(query)
    compose.onNodeWithTag(TagSearchInput).performImeAction()
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focused(tag: String): Boolean =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .any { it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag }

  private fun focusBy(tag: String, key: Key, times: Int = 10) {
    repeat(times) {
      if (focused(tag)) return
      press(key)
    }
    compose.onNodeWithTag(tag).assertIsFocused()
  }

  @Test
  fun `the field takes focus without opening the IME`() {
    mount(FakeTvApi())
    compose.waitForIdle()

    compose.onNodeWithTag(TagSearchField).assertIsFocused()
    compose.onNodeWithText("Type a title, then press Done.").assertExists()
  }

  @Test
  fun `Done runs one search with the typed query`() {
    val api = FakeTvApi()
    api.searchPages[""] = SearchResultDto(items = listOf(meta("tt9", "Matrix")), cursor = "c1", hasMore = true)
    mount(api)
    compose.waitForIdle()

    type("matrix")

    val request = api.searchRequests.single()
    assertEquals("matrix", request.query)
    assertEquals(null, request.cursor)
    assertEquals(SearchScope(), request.scope)
  }

  @Test
  fun `the results grid shows what the search answered`() {
    val api = FakeTvApi()
    api.searchPages[""] = SearchResultDto(items = listOf(meta("tt9", "Matrix")), cursor = "c1", hasMore = false)
    mount(api)
    compose.waitForIdle()

    type("matrix")

    compose.onNodeWithTag(posterTag(meta("tt9", "Matrix"))).assertExists()
  }

  @Test
  fun `hasMore loads the next cursor`() {
    val api = FakeTvApi()
    api.searchPages[""] = SearchResultDto(items = (1..7).map { meta("tt$it") }, cursor = "c1", hasMore = true)
    api.searchPages["c1"] = SearchResultDto(items = listOf(meta("tt8")), cursor = "c2", hasMore = false)
    mount(api)
    compose.waitForIdle()

    type("it")
    press(Key.DirectionDown)
    // Six columns at 960 dp: from the first row, left to the first poster, then down to the last row.
    press(Key.DirectionLeft)
    press(Key.DirectionDown)
    compose.onNodeWithTag(posterTag(meta("tt7"))).assertIsFocused()

    assertTrue(api.searchRequests.any { it.query == "it" && it.cursor == "c1" })
  }

  @Test
  fun `the scope panel lists the addon groups from searchable`() {
    val api = FakeTvApi()
    api.searchableValue = listOf(
      searchable("a", "Alpha", type = "movie", id = "popular", name = "Popular"),
      searchable("a", "Alpha", type = "series", id = "shows", name = "Shows"),
      searchable("b", "Beta", type = "movie", id = "films", name = "Films", globalSearch = false),
    )
    mount(api)
    compose.waitForIdle()

    press(Key.DirectionRight)
    compose.onNodeWithTag(TagSearchScopeChip).assertIsFocused().assertTextContains("all addons", substring = true)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSearchScopePanel).assertExists()
    compose.onNodeWithTag(TagSearchScopeAll).assertIsFocused()
    compose.onNodeWithText("Alpha").assertExists()
    compose.onNodeWithTag(scopeAddonTag("a")).assertTextContains("All catalogs", substring = true)
    compose.onNodeWithTag(scopeCatalogTag("series", "shows")).assertTextContains("Shows (series)", substring = true)
    compose.onNodeWithText("Beta ·").assertExists()
    compose.onNodeWithText("Only searched when picked").assertExists()
  }

  @Test
  fun `choosing a catalogue points the search scope at it`() {
    val api = FakeTvApi()
    api.searchableValue = listOf(
      searchable("a", "Alpha", type = "movie", id = "popular", name = "Popular"),
      searchable("a", "Alpha", type = "series", id = "shows", name = "Shows"),
    )
    api.searchPages[""] = SearchResultDto(items = listOf(meta("tt9", "Matrix")), cursor = "", hasMore = false)
    mount(api)
    compose.waitForIdle()

    press(Key.DirectionRight)
    press(Key.DirectionCenter)
    focusBy(scopeCatalogTag("series", "shows"), Key.DirectionDown)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSearchScopeChip).assertIsFocused().assertTextContains("Alpha · Shows (series)", substring = true)
    type("matrix")

    val request = api.searchRequests.last()
    assertEquals("matrix", request.query)
    assertEquals(SearchScope("a", "series", "shows"), request.scope)
  }

  @Test
  fun `changing the scope re-runs a submitted query`() {
    val api = FakeTvApi()
    api.searchableValue = listOf(searchable("a", "Alpha"))
    api.searchPages[""] = SearchResultDto(items = listOf(meta("tt9", "Matrix")), cursor = "", hasMore = false)
    mount(api)
    compose.waitForIdle()

    type("matrix")
    assertEquals(SearchScope(), api.searchRequests.last().scope)

    press(Key.DirectionRight)
    press(Key.DirectionCenter)
    focusBy(scopeAddonTag("a"), Key.DirectionDown)
    press(Key.DirectionCenter)

    assertEquals(SearchScope(addonKey = "a"), api.searchRequests.last().scope)
    assertEquals("matrix", api.searchRequests.last().query)
  }

  @Test
  fun `the chip shows the scope the shell preset`() {
    val api = FakeTvApi()
    api.searchableValue = listOf(searchable("a", "Alpha", type = "series", id = "shows", name = "Shows"))
    mount(api, initial = SearchScope("a", "series", "shows"))
    compose.waitForIdle()

    compose.onNodeWithTag(TagSearchScopeChip).assertTextContains("Alpha · Shows (series)", substring = true)
  }

  @Test
  fun `the panel re-reads searchable every time it opens`() {
    val api = FakeTvApi()
    api.searchableValue = listOf(searchable("a", "Alpha"))
    mount(api)
    compose.waitForIdle()
    val afterInit = api.searchableCalls

    api.searchableValue = listOf(searchable("a", "Alpha"), searchable("b", "Beta"))
    press(Key.DirectionRight)
    press(Key.DirectionCenter)
    compose.waitForIdle()

    assertTrue("the panel did not re-read searchable", api.searchableCalls > afterInit)
    compose.onNodeWithTag(scopeAddonTag("b")).assertExists()
  }

  @Test
  fun `an empty searchable leaves only the all addons row`() {
    mount(FakeTvApi())
    compose.waitForIdle()

    press(Key.DirectionRight)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagSearchScopeAll).assertIsFocused()
    val options = compose.onAllNodes(
      hasClickAction() and hasAnyAncestor(hasTestTag(TagSearchScopePanel)),
    ).fetchSemanticsNodes()
    assertEquals(1, options.size)
  }

  @Test
  fun `a long scope label stays within the chip width`() {
    val api = FakeTvApi()
    api.searchableValue = listOf(
      searchable(
        "a",
        "An addon whose name runs far past the row",
        type = "series",
        id = "shows",
        name = "A catalogue whose name runs even further past the row",
      ),
    )
    mount(api, initial = SearchScope("a", "series", "shows"))
    compose.waitForIdle()

    val bounds = compose.onNodeWithTag(TagSearchScopeChip).getBoundsInRoot()
    val width = bounds.right - bounds.left
    assertTrue("the chip is $width wide", width <= 300.dp)
  }
}
