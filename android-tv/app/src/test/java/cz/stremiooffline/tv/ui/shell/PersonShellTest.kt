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
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.PersonFilmographyDto
import cz.stremiooffline.tv.data.PersonHitDto
import cz.stremiooffline.tv.data.PersonSearchDto
import cz.stremiooffline.tv.data.PersonSectionDto
import cz.stremiooffline.tv.data.PersonTitleDto
import cz.stremiooffline.tv.data.RelatedTitleDto
import cz.stremiooffline.tv.data.TitleExtrasDto
import cz.stremiooffline.tv.data.TitlePersonDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.TagCatalogPrimary
import cz.stremiooffline.tv.ui.detail.relatedTitleTag
import cz.stremiooffline.tv.ui.detail.titlePersonTag
import cz.stremiooffline.tv.ui.person.TagPersonScreen
import cz.stremiooffline.tv.ui.person.TagPersonSearchAsText
import cz.stremiooffline.tv.ui.person.personTileTag
import cz.stremiooffline.tv.ui.search.TagGlobalSearchField
import cz.stremiooffline.tv.ui.search.TagGlobalSearchInput
import cz.stremiooffline.tv.ui.search.globalSearchPersonTag
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

  private fun api(vararg people: TitlePersonDto): FakeTvApi {
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
      titleExtrasValue = TitleExtrasDto(people = people.toList())
      metaValues["movie:tt1"] = MetaDto(id = "tt1", type = "movie", name = "It, the film")
      metaValues["movie:tt2"] = MetaDto(id = "tt2", type = "movie", name = "Pulp Fiction")
      metaValues["movie:tt3"] = MetaDto(id = "tt3", type = "movie", name = "Reservoir Dogs")
    }
  }

  private fun launch(api: FakeTvApi, start: Section = Section.Library) {
    scenario = ActivityScenario.launch(
      Intent(ApplicationProvider.getApplicationContext(), ComponentActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = start, api = api, username = "demo", onSignOut = {}) }
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

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun back() {
    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
  }

  private fun waitFocused(tag: String) {
    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(tag).assertIsFocused() }.isSuccess
    }
  }

  private fun personTile(id: String, tmdbId: Long, name: String) = PersonTitleDto(
    type = "movie",
    tmdbId = tmdbId,
    id = id,
    name = name,
  )

  @Test
  fun `Back from a person restores the title and the cast card`() {
    val firstCast = TitlePersonDto(id = 1, name = "First Actor", role = "cast")
    val secondCast = TitlePersonDto(id = 138, name = "Quentin Tarantino", role = "cast")
    val api = api(firstCast, secondCast).apply {
      personValue = PersonFilmographyDto(
        id = 138,
        name = "Quentin Tarantino",
        sections = listOf(PersonSectionDto("acting", listOf(personTile("tt2", 680, "Pulp Fiction")))),
      )
    }
    launch(api)
    openCatalogueDetail(api)

    compose.onNodeWithTag(titlePersonTag("Quentin Tarantino"))
      .performSemanticsAction(SemanticsActions.RequestFocus)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.personRequests.isNotEmpty() }

    compose.onNodeWithTag(TagPersonScreen).assertExists()
    back()

    compose.onNodeWithTag(TagCatalogPrimary).assertExists()
    waitFocused(titlePersonTag("Quentin Tarantino"))
  }

  @Test
  fun `Back from a person opened in search restores its card`() {
    val hit = PersonHitDto(id = 138, name = "Quentin Tarantino", knownTitles = listOf("Pulp Fiction"))
    val api = api().apply {
      globalSearchEnabled = true
      peopleSearchHandler = { _, _ -> PersonSearchDto(listOf(hit)) }
      personValue = PersonFilmographyDto(
        id = 138,
        name = "Quentin Tarantino",
        sections = listOf(PersonSectionDto("acting", listOf(personTile("tt2", 680, "Pulp Fiction")))),
      )
    }
    launch(api, Section.Search)
    compose.waitUntil(5_000) {
      runCatching { compose.onNodeWithTag(TagGlobalSearchInput).assertExists() }.isSuccess
    }

    compose.onNodeWithTag(TagGlobalSearchField).performSemanticsAction(SemanticsActions.RequestFocus)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagGlobalSearchInput).performTextInput("Quentin")
    compose.onNodeWithTag(TagGlobalSearchInput).performImeAction()
    compose.waitUntil(5_000) { api.peopleSearchCalls.isNotEmpty() }

    compose.onNodeWithTag(globalSearchPersonTag(138))
      .performSemanticsAction(SemanticsActions.RequestFocus)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.personRequests.isNotEmpty() }
    compose.onNodeWithTag(TagPersonScreen).assertExists()

    back()

    compose.onNodeWithTag(TagPersonScreen).assertDoesNotExist()
    waitFocused(globalSearchPersonTag(138))
  }

  @Test
  fun `Back from a title returns to its person tile and then to the original cast card`() {
    val cast = TitlePersonDto(id = 138, name = "Quentin Tarantino", role = "cast")
    val tile = personTile("tt2", 680, "Pulp Fiction")
    val api = api(cast).apply {
      personValue = PersonFilmographyDto(
        id = 138,
        name = "Quentin Tarantino",
        sections = listOf(
          PersonSectionDto("acting", listOf(personTile("tt4", 4, "Acting credit"))),
          PersonSectionDto("crew", listOf(tile)),
        ),
      )
    }
    launch(api)
    openCatalogueDetail(api)

    compose.onNodeWithTag(titlePersonTag("Quentin Tarantino"))
      .performSemanticsAction(SemanticsActions.RequestFocus)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.personRequests.isNotEmpty() }
    waitFocused(personTileTag(personTile("tt4", 4, "Acting credit")))

    press(Key.DirectionDown)
    waitFocused(personTileTag(tile))
    api.titleExtrasValue = TitleExtrasDto()
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.titleExtrasRequests.any { it.first == "movie" && it.second == "tt2" } }
    compose.onNodeWithTag(TagCatalogPrimary).assertExists()

    back()
    compose.onNodeWithTag(TagPersonScreen).assertExists()
    waitFocused(personTileTag(tile))

    api.titleExtrasValue = TitleExtrasDto(people = listOf(cast))
    back()
    compose.onNodeWithTag(TagCatalogPrimary).assertExists()
    waitFocused(titlePersonTag("Quentin Tarantino"))
  }

  @Test
  fun `two Backs from a related title return to the person tile`() {
    val cast = TitlePersonDto(id = 138, name = "Quentin Tarantino", role = "cast")
    val tile = personTile("tt2", 680, "Pulp Fiction")
    val related = RelatedTitleDto(type = "movie", id = "tt3", name = "Reservoir Dogs")
    val api = api(cast).apply {
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
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.personRequests.isNotEmpty() }
    waitFocused(personTileTag(tile))

    api.titleExtrasValue = TitleExtrasDto(related = listOf(related))
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.titleExtrasRequests.any { it.first == "movie" && it.second == "tt2" } }
    compose.onNodeWithTag(relatedTitleTag("tt3"))
      .performSemanticsAction(SemanticsActions.RequestFocus)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.titleExtrasRequests.any { it.first == "movie" && it.second == "tt3" } }
    compose.onNodeWithTag(TagCatalogPrimary).assertExists()

    back()
    compose.onNodeWithTag(TagCatalogPrimary).assertExists()
    back()

    compose.onNodeWithTag(TagPersonScreen).assertExists()
    waitFocused(personTileTag(tile))
  }

  @Test
  fun `Back from a person and then its title returns to the library origin`() {
    val cast = TitlePersonDto(id = 138, name = "Quentin Tarantino", role = "cast")
    val api = api(cast).apply {
      personValue = PersonFilmographyDto(
        id = 138,
        name = "Quentin Tarantino",
        sections = listOf(PersonSectionDto("acting", listOf(personTile("tt2", 680, "Pulp Fiction")))),
      )
    }
    launch(api)
    openCatalogueDetail(api)

    compose.onNodeWithTag(titlePersonTag("Quentin Tarantino"))
      .performSemanticsAction(SemanticsActions.RequestFocus)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.personRequests.isNotEmpty() }

    back()
    compose.onNodeWithTag(TagCatalogPrimary).assertExists()
    waitFocused(titlePersonTag("Quentin Tarantino"))
    back()

    compose.onNodeWithTag(TagCatalogPrimary).assertDoesNotExist()
    waitFocused("It")
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
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.globalStartCalls.isNotEmpty() }
    compose.waitForIdle()

    compose.onNodeWithTag(TagPersonScreen).assertDoesNotExist()
    compose.onNodeWithTag(TagGlobalSearchInput).assertTextContains("Quentin Tarantino")
    assertEquals("Quentin Tarantino", api.globalStartCalls.last().query)
  }

  @Test
  fun `search as text opens Search with the name and leaves the person`() {
    val cast = TitlePersonDto(id = 138, name = "Quentin Tarantino", role = "cast")
    val api = api(cast).apply {
      globalSearchEnabled = true
      personValue = PersonFilmographyDto(
        id = 138,
        name = "Quentin Tarantino",
        sections = listOf(PersonSectionDto("acting", listOf(personTile("tt2", 680, "Pulp Fiction")))),
      )
    }
    launch(api)
    openCatalogueDetail(api)
    compose.waitUntil(5_000) { api.globalSearchEnabledCalls > 0 }

    compose.onNodeWithTag(titlePersonTag("Quentin Tarantino"))
      .performSemanticsAction(SemanticsActions.RequestFocus)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.personRequests.isNotEmpty() }
    compose.onNodeWithTag(TagPersonSearchAsText)
      .performSemanticsAction(SemanticsActions.RequestFocus)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.globalStartCalls.isNotEmpty() }
    compose.waitForIdle()

    compose.onNodeWithTag(TagPersonScreen).assertDoesNotExist()
    compose.onNodeWithTag(TagGlobalSearchInput).assertTextContains("Quentin Tarantino")
    assertEquals("Quentin Tarantino", api.globalStartCalls.last().query)
  }
}
