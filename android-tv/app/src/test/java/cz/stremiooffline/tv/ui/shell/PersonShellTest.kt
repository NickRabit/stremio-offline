@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.PersonFilmographyDto
import cz.stremiooffline.tv.data.PersonSectionDto
import cz.stremiooffline.tv.data.PersonTitleDto
import cz.stremiooffline.tv.data.TitleExtrasDto
import cz.stremiooffline.tv.data.TitlePersonDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.TagCatalogPrimary
import cz.stremiooffline.tv.ui.detail.titlePersonTag
import cz.stremiooffline.tv.ui.person.TagPersonScreen
import cz.stremiooffline.tv.ui.person.personTileTag
import cz.stremiooffline.tv.ui.search.TagGlobalSearchInput
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PersonShellTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>

  @After
  fun closeHost() {
    scenario.close()
  }

  private fun api(person: TitlePersonDto): FakeTvApi {
    val path = "It/It.mkv"
    return FakeTvApi().apply {
      pages[null] = BrowseResult(
        path = "",
        items = listOf(BrowseItem.Folder(path = "It", name = "It", fileCount = 1)),
        total = 1,
        pending = false,
      )
      pages["It"] = BrowseResult(
        path = "It",
        items = listOf(BrowseItem.File(path = path, label = "It.mkv")),
        total = 1,
        pending = false,
      )
      libraryTitleValues[path] = LibraryTitleDto(type = "movie", id = "tt1", name = "It, the film")
      titleExtrasValue = TitleExtrasDto(people = listOf(person))
      metaValues["movie:tt1"] = MetaDto(id = "tt1", type = "movie", name = "It, the film")
      metaValues["movie:tt2"] = MetaDto(id = "tt2", type = "movie", name = "Pulp Fiction")
    }
  }

  private fun launch(api: FakeTvApi) {
    scenario = ActivityScenario.launch(
      Intent(ApplicationProvider.getApplicationContext(), ComponentActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = Section.Library, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()
  }

  private fun openCatalogueDetail(api: FakeTvApi) {
    compose.onNodeWithText("Files").performSemanticsAction(SemanticsActions.RequestFocus)
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.onNodeWithTag("It").performSemanticsAction(SemanticsActions.RequestFocus)
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { api.titleExtrasRequests.isNotEmpty() }
    compose.waitForIdle()
  }

  @Test
  fun `a person opens over the detail and Back returns from their title to the tile`() {
    val tile = PersonTitleDto(
      type = "movie",
      tmdbId = 680,
      id = "tt2",
      name = "Pulp Fiction",
      year = "1994",
    )
    val api = api(TitlePersonDto(id = 138, name = "Quentin Tarantino", role = "cast")).apply {
      personValue = PersonFilmographyDto(
        id = 138,
        name = "Quentin Tarantino",
        sections = listOf(PersonSectionDto("acting", listOf(tile))),
      )
    }
    launch(api)
    openCatalogueDetail(api)

    compose.onNodeWithTag(titlePersonTag("Quentin Tarantino"))
      .performSemanticsAction(SemanticsActions.RequestFocus)
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { api.personRequests.isNotEmpty() }
    compose.waitForIdle()

    compose.onNodeWithTag(TagPersonScreen).assertExists()
    compose.onNodeWithTag(TagCatalogPrimary).assertDoesNotExist()
    compose.onNodeWithTag(personTileTag(tile)).assertIsFocused()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    compose.onNodeWithTag(TagCatalogPrimary).assertExists()
    assertEquals("movie:tt2", api.titleExtrasRequests.last().let { "${it.first}:${it.second}" })
    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()

    compose.onNodeWithTag(TagPersonScreen).assertExists()
    compose.onNodeWithTag(personTileTag(tile)).assertIsFocused()
    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()

    compose.onNodeWithTag(TagPersonScreen).assertDoesNotExist()
    compose.onNodeWithTag(TagCatalogPrimary).assertDoesNotExist()
  }

  @Test
  fun `a person without an id still opens search with the name`() {
    val api = api(TitlePersonDto(name = "Quentin Tarantino", role = "cast")).apply {
      globalSearchEnabled = true
    }
    launch(api)
    openCatalogueDetail(api)
    compose.waitUntil(5_000) { api.globalSearchEnabledCalls > 0 }

    compose.onNodeWithTag(titlePersonTag("Quentin Tarantino"))
      .performSemanticsAction(SemanticsActions.RequestFocus)
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { api.globalStartCalls.isNotEmpty() }
    compose.waitForIdle()

    compose.onNodeWithTag(TagPersonScreen).assertDoesNotExist()
    compose.onNodeWithTag(TagGlobalSearchInput).assertTextContains("Quentin Tarantino")
    assertEquals("Quentin Tarantino", api.globalStartCalls.last().query)
  }
}
