@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.CatalogDto
import cz.stremiooffline.tv.data.CatalogExtraDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class CatalogScreenTest {

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

  private fun feature(name: String, addonKey: String = "a", id: String = "top", genres: List<String> = emptyList()) =
    CatalogDto(addonKey = addonKey, addonName = name, type = "movie", id = id, name = name, extra = genreExtra(genres))

  private fun genreExtra(genres: List<String>): List<CatalogExtraDto>? =
    if (genres.isEmpty()) null else listOf(CatalogExtraDto(name = "genre", options = genres))

  private fun meta(id: String, name: String = id, type: String = "movie") = MetaDto(id = id, type = type, name = name)

  private fun mount(api: FakeTvApi) {
    scenario.onActivity { activity ->
      host = activity
      activity.setContent {
        CatalogScreen(
          api = api,
          onOpenDetail = {},
          onOpenSearch = {},
          imageUrl = { null },
        )
      }
    }
  }

  /** tv-material controls activate on DPAD_CENTER once focused; a plain click does not reach them. */
  private fun click(tag: String) {
    compose.onNodeWithTag(tag).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    compose.onNodeWithTag(tag).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
  }

  @Test
  fun `chips focus left and right`() {
    val api = FakeTvApi()
    api.catalogsValue = listOf(feature("Open Movies"))
    api.catalogPages["a"] = listOf(listOf(meta("tt1")))
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogChip).assertIsFocused()
    compose.onNodeWithTag(TagCatalogChip).performKeyInput { pressKey(Key.DirectionLeft) }
    compose.onNodeWithTag(TagCatalogSearchChip).assertIsFocused()
    compose.onNodeWithTag(TagCatalogSearchChip).performKeyInput { pressKey(Key.DirectionRight) }
    compose.onNodeWithTag(TagCatalogChip).assertIsFocused()
  }

  @Test
  fun `the catalog chip opens the panel and choosing one reloads the grid and returns focus`() {
    val api = FakeTvApi()
    api.catalogsValue = listOf(feature("Open Movies", addonKey = "a"), feature("Films", addonKey = "b", id = "films"))
    api.catalogPages["a"] = listOf(listOf(meta("ttA", name = "Alpha")))
    api.catalogPages["b"] = listOf(listOf(meta("ttB", name = "Beta")))
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogChip).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.onNodeWithTag(TagCatalogPanel).assertExists()
    compose.onNodeWithTag(catalogOptionTag(0)).assertExists()
    compose.onNodeWithTag(catalogOptionTag(1)).assertExists()

    click(catalogOptionTag(1))

    compose.onNodeWithTag(posterTag(meta("ttB", name = "Beta"))).assertExists()
    compose.onNodeWithTag(TagCatalogChip).assertIsFocused()
  }

  @Test
  fun `back closes the panel without changing the grid`() {
    val api = FakeTvApi()
    api.catalogsValue = listOf(feature("Open Movies"))
    api.catalogPages["a"] = listOf(listOf(meta("ttA", name = "Alpha")))
    mount(api)
    compose.waitForIdle()

    click(TagCatalogChip)
    compose.onNodeWithTag(TagCatalogPanel).assertExists()

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogPanel).assertDoesNotExist()
    compose.onNodeWithTag(posterTag(meta("ttA", name = "Alpha"))).assertExists()
  }

  @Test
  fun `the genre chip asks the catalogue for the chosen genre`() {
    val api = FakeTvApi()
    api.catalogsValue = listOf(feature("Open Movies", genres = listOf("Action", "Comedy")))
    api.catalogPages["a"] = listOf(listOf(meta("ttA", name = "Alpha")))
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogChip).performKeyInput { pressKey(Key.DirectionRight) }
    compose.onNodeWithTag(TagCatalogGenreChip).assertIsFocused()
    click(TagCatalogGenreChip)
    compose.onNodeWithTag(TagGenreAll).assertIsFocused()
    compose.onNodeWithTag(TagGenreAll).performKeyInput { pressKey(Key.DirectionDown) }
    compose.onNodeWithTag(genreOptionTag(0)).assertIsFocused()
    click(genreOptionTag(0))

    assertEquals("Action", api.catalogRequests.last().genre)
  }

  @Test
  fun `focus reaching the last row asks for the next skip`() {
    val api = FakeTvApi()
    api.catalogsValue = listOf(feature("Open Movies"))
    api.catalogPages["a"] = listOf((1..7).map { meta("tt$it") }, listOf(meta("tt8")))
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(posterTag(meta("tt7"))).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()

    assertEquals(7, api.catalogRequests.last().skip)
  }

  @Test
  fun `the error state shows Try again and retries`() {
    val api = FakeTvApi()
    api.catalogsValue = listOf(feature("Open Movies"))
    api.failCatalog = true
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogRetry).assertIsDisplayed()

    api.failCatalog = false
    api.catalogPages["a"] = listOf(listOf(meta("ttA", name = "Alpha")))
    click(TagCatalogRetry)

    compose.onNodeWithTag(posterTag(meta("ttA", name = "Alpha"))).assertExists()
  }
}
