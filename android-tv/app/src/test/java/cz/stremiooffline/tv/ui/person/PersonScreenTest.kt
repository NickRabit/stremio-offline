@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.person

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.PersonFilmographyDto
import cz.stremiooffline.tv.data.PersonSectionDto
import cz.stremiooffline.tv.data.PersonTitleDto
import cz.stremiooffline.tv.data.PersonTitleResolutionDto
import cz.stremiooffline.tv.data.RelatedTitleDto
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PersonScreenTest {

  @get:Rule val compose = createComposeRule()

  private val crewTitle = PersonTitleDto(
    type = "movie",
    tmdbId = 680,
    id = "tt0110912",
    name = "Pulp Fiction",
    year = "1994",
    inLibrary = true,
  )
  private val actingTitle = PersonTitleDto(
    type = "series",
    tmdbId = 500,
    id = "tmdb:500",
    name = "Reservoir Dogs",
    year = "1992",
  )

  private fun person(
    first: PersonSectionDto = PersonSectionDto("crew", listOf(crewTitle)),
    second: PersonSectionDto = PersonSectionDto("acting", listOf(actingTitle)),
  ) = PersonFilmographyDto(
    id = 138,
    name = "Quentin Tarantino",
    sections = listOf(first, second),
  )

  private fun mount(
    api: FakeTvApi,
    restoreFocusToken: Int = 0,
    onOpenTitle: (RelatedTitleDto, Boolean) -> Unit = { _, _ -> },
    onUnavailable: (String) -> Unit = {},
  ) {
    compose.setContent {
      PersonScreen(
        api = api,
        args = PersonArgs(138, "Quentin Tarantino"),
        language = "en",
        imageUrl = { null },
        restoreFocusToken = restoreFocusToken,
        onOpenTitle = onOpenTitle,
        onUnavailable = onUnavailable,
        onBack = {},
      )
    }
    compose.waitUntil(5_000) { api.personRequests.isNotEmpty() }
    compose.waitForIdle()
  }

  @Test
  fun `sections keep server order and focus starts on the first tile`() {
    val api = FakeTvApi().apply { personValue = person() }
    mount(api)

    compose.onNodeWithTag(personSectionTag(PersonSectionDto("crew"))).assertExists()
    compose.onNodeWithTag(personSectionTag(PersonSectionDto("acting"))).assertExists()
    val crewTop = compose.onNodeWithTag(personSectionTag(PersonSectionDto("crew"))).fetchSemanticsNode().boundsInRoot.top
    val actingTop = compose.onNodeWithTag(personSectionTag(PersonSectionDto("acting"))).fetchSemanticsNode().boundsInRoot.top
    assertTrue(crewTop < actingTop)
    compose.onNodeWithText("Pulp Fiction").assertExists()
    compose.onNodeWithText("Reservoir Dogs").assertExists()
    compose.onNodeWithTag(personTileTag(crewTitle)).assertIsFocused()
    assertEquals(listOf(138L to "en"), api.personRequests)
  }

  @Test
  fun `DOWN from the last row of a section focuses the next section`() {
    val api = FakeTvApi().apply {
      personValue = person(
        first = PersonSectionDto("acting", listOf(actingTitle.copy(id = "tt500"))),
        second = PersonSectionDto("crew", listOf(crewTitle)),
      )
    }
    mount(api)

    compose.onNodeWithTag(personTileTag(actingTitle.copy(id = "tt500"))).assertIsFocused()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionDown) }
    compose.waitForIdle()

    compose.onNodeWithTag(personTileTag(crewTitle)).assertIsFocused()
  }

  @Test
  fun `OK on an IMDb tile opens it directly`() {
    val api = FakeTvApi().apply {
      personValue = person(first = PersonSectionDto("crew", listOf(crewTitle)), second = PersonSectionDto("acting"))
    }
    var opened: Pair<RelatedTitleDto, Boolean>? = null
    mount(api, onOpenTitle = { title, noImdb -> opened = title to noImdb })

    compose.onNodeWithTag(personTileTag(crewTitle)).assertIsFocused()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    assertEquals("tt0110912", opened?.first?.id)
    assertEquals(false, opened?.second)
  }

  @Test
  fun `a TMDB tile resolves before it opens`() {
    val api = FakeTvApi().apply {
      personValue = person(first = PersonSectionDto("acting", listOf(actingTitle)), second = PersonSectionDto("crew"))
      personTitleValue = PersonTitleResolutionDto(id = "tt0105236")
    }
    var opened: Pair<RelatedTitleDto, Boolean>? = null
    mount(api, onOpenTitle = { title, noImdb -> opened = title to noImdb })

    compose.onNodeWithTag(personTileTag(actingTitle)).assertIsFocused()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { opened != null }

    assertEquals(listOf("series" to 500L), api.personTitleRequests)
    assertEquals("tt0105236", opened?.first?.id)
    assertEquals(false, opened?.second)
  }

  @Test
  fun `an unresolved IMDb id opens the TMDB id with the no IMDb flag`() {
    val api = FakeTvApi().apply {
      personValue = person(first = PersonSectionDto("acting", listOf(actingTitle)), second = PersonSectionDto("crew"))
      personTitleValue = PersonTitleResolutionDto(id = "tmdb:500", imdb = "none")
    }
    var opened: Pair<RelatedTitleDto, Boolean>? = null
    mount(api, onOpenTitle = { title, noImdb -> opened = title to noImdb })

    compose.onNodeWithTag(personTileTag(actingTitle)).assertIsFocused()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { opened != null }

    assertEquals("tmdb:500", opened?.first?.id)
    assertEquals(true, opened?.second)
  }

  @Test
  fun `a title lookup failure notices and does not navigate`() {
    val api = FakeTvApi().apply {
      personValue = person(first = PersonSectionDto("acting", listOf(actingTitle)), second = PersonSectionDto("crew"))
      personTitleFailure = ApiError(ApiFailure.Generic, messageKey = "err.personLookupFailed")
    }
    var opened: RelatedTitleDto? = null
    mount(api, onOpenTitle = { title, _ -> opened = title })

    compose.onNodeWithTag(personTileTag(actingTitle)).assertIsFocused()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { api.personTitleRequests.isNotEmpty() }
    compose.waitForIdle()

    assertNull(opened)
    compose.onNodeWithText("The filmography could not be loaded. Try again later.").assertExists()
  }

  @Test
  fun `an unavailable person falls back with their name`() {
    val api = FakeTvApi().apply {
      personFailure = ApiError(ApiFailure.NotFound, messageKey = "err.personUnavailable")
    }
    var unavailable = ""
    compose.setContent {
      PersonScreen(
        api = api,
        args = PersonArgs(138, "Quentin Tarantino"),
        language = null,
        imageUrl = { null },
        restoreFocusToken = 0,
        onOpenTitle = { _, _ -> },
        onUnavailable = { unavailable = it },
        onBack = {},
      )
    }
    compose.waitUntil(5_000) { unavailable.isNotEmpty() }

    assertEquals("Quentin Tarantino", unavailable)
  }

  @Test
  fun `a lookup failure focuses retry and OK fetches again`() {
    val api = FakeTvApi().apply {
      personFailure = ApiError(ApiFailure.Generic, messageKey = "err.personLookupFailed")
    }
    mount(api)

    compose.onNodeWithTag(TagPersonRetry).assertIsFocused()
    api.personFailure = null
    api.personValue = person()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { api.personRequests.size == 2 }
    compose.waitForIdle()

    compose.onNodeWithTag(personTileTag(crewTitle)).assertExists()
    assertEquals(2, api.personRequests.size)
  }
}
