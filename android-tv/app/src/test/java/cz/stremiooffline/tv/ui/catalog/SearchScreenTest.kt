@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.SearchResultDto
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

  private fun mount(api: FakeTvApi) {
    compose.setContent {
      SearchScreen(api = api, onOpenDetail = {}, imageUrl = { null })
    }
  }

  private fun type(query: String) {
    compose.onNodeWithTag(TagSearchField).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.onNodeWithTag(TagSearchInput).performTextInput(query)
    compose.onNodeWithTag(TagSearchInput).performImeAction()
    compose.waitForIdle()
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

    assertEquals(listOf("matrix" to null), api.searchRequests)
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
    compose.onNodeWithTag(posterTag(meta("tt7"))).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()

    assertTrue(api.searchRequests.contains("it" to "c1"))
  }
}
