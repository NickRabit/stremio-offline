@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.detail

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.TitleExtrasDto
import cz.stremiooffline.tv.data.TitlePersonDto
import cz.stremiooffline.tv.data.TitleRatingsDto
import cz.stremiooffline.tv.ui.FakeTvApi
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class DetailScreenTest {

  @get:Rule val compose = createComposeRule()

  private val progress = mutableMapOf<String, ProgressDto>()
  private val favouriteCalls = mutableListOf<Pair<String, Boolean>>()
  private var favouriteGate: CompletableDeferred<Unit>? = null
  private var favouriteFailure: ApiFailure? = null

  private fun file(path: String, label: String = path.substringAfterLast('/')) =
    BrowseItem.File(path = path, label = label)

  private fun detail(
    files: List<BrowseItem.File>,
    title: String = "It",
  ) = DetailData(
    gridPath = "Films/It",
    title = title,
    year = "2017",
    description = null,
    poster = null,
    wide = null,
    size = 41_000_000.0,
    fileCount = files.size,
    files = files,
  )

  private fun mount(
    data: DetailData,
    forgetProgress: suspend (List<String>) -> Unit = {},
    sourcesApi: FakeTvApi? = null,
  ) {
    compose.setContent {
      DetailScreen(
        detail = data,
        imageUrl = { null },
        onPlay = {},
        onBack = {},
        progress = { key -> progress[key] },
        setFavorite = { path, wanted ->
          favouriteCalls += path to wanted
          favouriteGate?.await()
          favouriteFailure?.let { throw ApiError(it) }
          wanted
        },
        forgetProgress = forgetProgress,
        restoreToken = 0,
        sourcesApi = sourcesApi,
      )
    }
  }

  @Test
  fun `the action row names the file Play acts on and follows the episode change`() {
    val first = file("Shows/Show/S01/Show.S01E01.mkv", "S1 · E1")
      .copy(size = 1_000_000_000.0, season = 1, episode = 1)
    val second = file("Shows/Show/S01/Show.S02E02.mkv", "S1 · E2")
      .copy(size = 2_000_000_000.0, season = 1, episode = 2)
    compose.setContent {
      DetailScreen(
        detail = detail(listOf(first, second)),
        imageUrl = { null },
        onPlay = {},
        onBack = {},
        progress = { key -> progress[key] },
        forgetProgress = {},
        markWatched = { watched ->
          progress[cz.stremiooffline.tv.playback.Progress.libraryKey(watched.path)] =
            ProgressDto(position = 1.0, duration = 1.0)
        },
      )
    }

    compose.onNodeWithTag(TagDetailPickCaption).assertTextContains("S1 · E1", substring = true)
    compose.onNodeWithTag(TagDetailMarkWatched).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.onNodeWithTag(TagDetailMarkWatched).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    compose.onNodeWithTag(TagDetailPickCaption).assertTextContains("S1 · E2", substring = true)
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  /** RIGHT from the primary action reaches the star, whether or not Start over sits between. */
  private fun focusFavourite() {
    repeat(4) {
      val tags = compose.onAllNodes(isFocused()).fetchSemanticsNodes()
        .map { it.config.getOrElse(SemanticsProperties.TestTag) { "" } }
      if (TagDetailFavourite in tags) return
      press(Key.DirectionRight)
    }
    compose.onNodeWithTag(TagDetailFavourite).assertIsFocused()
  }

  /** RIGHT from the primary action reaches Forget, which sits between Start over and the star. */
  private fun focusForget() {
    repeat(4) {
      val tags = compose.onAllNodes(isFocused()).fetchSemanticsNodes()
        .map { it.config.getOrElse(SemanticsProperties.TestTag) { "" } }
      if (TagDetailForget in tags) return
      press(Key.DirectionRight)
    }
    compose.onNodeWithTag(TagDetailForget).assertIsFocused()
  }

  @Test
  fun `no stored progress shows Play focused and no Start over`() {
    mount(detail(listOf(file("Films/It/It.mkv"))))

    compose.onNodeWithTag(TagDetailPrimary).assertIsFocused()
    compose.onNodeWithText("Play").assertIsDisplayed()
    compose.onNodeWithTag(TagDetailStartOver).assertDoesNotExist()
    compose.onNodeWithTag(TagDetailWatched).assertDoesNotExist()
  }

  @Test
  fun `progress above thirty seconds shows Resume, Start over and the watched bar`() {
    progress["file:Films/It/It.mkv"] = ProgressDto(38.6, 120.0)
    mount(detail(listOf(file("Films/It/It.mkv"))))

    compose.onNodeWithTag(TagDetailPrimary).assertIsFocused()
    compose.onNodeWithText("Resume").assertIsDisplayed()
    compose.onNodeWithTag(TagDetailStartOver).assertExists()
    compose.onNodeWithTag(TagDetailWatched).assertIsDisplayed()
  }

  @Test
  fun `progress under thirty seconds or completed shows Play`() {
    progress["file:Films/It/It.mkv"] = ProgressDto(10.0, 120.0)
    mount(detail(listOf(file("Films/It/It.mkv"))))
    compose.onNodeWithText("Play").assertIsDisplayed()
    // The early position is still offered a fresh start beside Play.
    compose.onNodeWithTag(TagDetailStartOver).assertExists()
  }

  @Test
  fun `an early position keeps Play and adds the bar and a Start over`() {
    progress["file:Films/It/It.mkv"] = ProgressDto(10.0, 600.0)
    mount(detail(listOf(file("Films/It/It.mkv"))))

    compose.onNodeWithText("Play").assertIsDisplayed()
    compose.onNodeWithTag(TagDetailStartOver).assertExists()
    compose.onNodeWithTag(TagDetailWatched).assertTextContains("1 % watched")
  }

  @Test
  fun `a completed position keeps the bar and a Start over`() {
    progress["file:Films/It/It.mkv"] = ProgressDto(600.0, 600.0)
    mount(detail(listOf(file("Films/It/It.mkv"))))

    compose.onNodeWithText("Play").assertIsDisplayed()
    compose.onNodeWithTag(TagDetailStartOver).assertExists()
    compose.onNodeWithTag(TagDetailWatched).assertTextContains("100 % watched")
  }

  @Test
  fun `becoming visible again re-reads progress and focuses Resume`() {
    val watched = detail(listOf(file("Films/It/It.mkv")))
    var token by mutableStateOf(0)
    compose.setContent {
      DetailScreen(
        detail = watched,
        imageUrl = { null },
        onPlay = {},
        onBack = {},
        progress = { key -> progress[key] },
        forgetProgress = {},
        restoreToken = token,
      )
    }
    compose.onNodeWithText("Play").assertIsDisplayed()
    compose.onNodeWithTag(TagDetailPrimary).assertIsFocused()

    // The player saved 38.6 s while the detail was away, and the shell bumps the restore token.
    progress["file:Films/It/It.mkv"] = ProgressDto(38.6, 120.0)
    token = 1
    compose.waitForIdle()

    compose.onNodeWithText("Resume").assertIsDisplayed()
    compose.onNodeWithTag(TagDetailPrimary).assertIsFocused()
    compose.onNodeWithTag(TagDetailStartOver).assertExists()
    compose.onNodeWithTag(TagDetailWatched).assertIsDisplayed()
  }

  @Test
  fun `returning to the detail moves focus back to the primary action`() {
    progress["file:Films/It/It.mkv"] = ProgressDto(38.6, 120.0)
    val data = detail(listOf(file("Films/It/It.mkv")))
    var token by mutableStateOf(0)
    compose.setContent {
      DetailScreen(
        detail = data,
        imageUrl = { null },
        onPlay = {},
        onBack = {},
        progress = { key -> progress[key] },
        forgetProgress = {},
        restoreToken = token,
      )
    }
    compose.onNodeWithTag(TagDetailPrimary).assertIsFocused()

    // Focus is lost while the player is open; the return must put it back on the primary action.
    compose.onNodeWithTag(TagDetailStartOver).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    token = 1
    compose.waitForIdle()

    compose.onNodeWithTag(TagDetailPrimary).assertIsFocused()
  }

  @Test
  fun `the first not completed episode is focused when the row is entered`() {
    progress["file:Films/It/S1.mkv"] = ProgressDto(600.0, 600.0)
    val data = detail(
      listOf(
        file("Films/It/S1.mkv", "S1").copy(season = 1, episode = 1),
        file("Films/It/S2.mkv", "S2").copy(season = 1, episode = 2),
        file("Films/It/S3.mkv", "S3").copy(season = 1, episode = 3),
      ),
    )
    mount(data)
    // The row is below the actions; DOWN from the primary action enters it.
    compose.onNodeWithTag(TagDetailPrimary).performKeyInput { pressKey(Key.DirectionDown) }
    compose.waitForIdle()

    compose.onNodeWithTag("Films/It/S2.mkv").assertIsFocused()
  }

  @Test
  fun `the star toggles with OK and sends the path and the wanted state`() {
    mount(detail(listOf(file("Films/It/It.mkv"))))

    compose.onNodeWithTag(TagDetailFavourite).assertTextContains("☆")
    focusFavourite()
    press(Key.DirectionCenter)

    assertEquals(listOf("Films/It" to true), favouriteCalls)
    compose.onNodeWithTag(TagDetailFavourite).assertTextContains("★")
  }

  @Test
  fun `a favourite already set starts as a full star`() {
    mount(detail(listOf(file("Films/It/It.mkv"))).copy(favorite = true))

    compose.onNodeWithTag(TagDetailFavourite).assertTextContains("★")
  }

  @Test
  fun `a second star press while the first is in flight is ignored`() {
    val gate = CompletableDeferred<Unit>()
    favouriteGate = gate
    mount(detail(listOf(file("Films/It/It.mkv"))))

    focusFavourite()
    press(Key.DirectionCenter)
    press(Key.DirectionCenter)

    assertEquals(1, favouriteCalls.size)
    gate.complete(Unit)
    compose.waitForIdle()
    compose.onNodeWithTag(TagDetailFavourite).assertTextContains("★")
  }

  @Test
  fun `a failing favourite reverts the star`() {
    favouriteFailure = ApiFailure.Generic
    mount(detail(listOf(file("Films/It/It.mkv"))))

    focusFavourite()
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagDetailFavourite).assertTextContains("☆")
  }

  @Test
  fun `no stored progress shows no Forget button`() {
    mount(detail(listOf(file("Films/It/It.mkv"))))

    compose.onNodeWithTag(TagDetailForget).assertDoesNotExist()
  }

  @Test
  fun `forgetting clears the stored position and turns Resume into Play`() {
    progress["file:Films/It/It.mkv"] = ProgressDto(38.6, 120.0)
    val forgotten = mutableListOf<List<String>>()
    mount(
      detail(listOf(file("Films/It/It.mkv"))),
      forgetProgress = { keys -> forgotten += keys; keys.forEach { progress.remove(it) } },
    )

    compose.onNodeWithTag(TagDetailForget).assertExists()
    focusForget()

    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagDetailForgetPanel).assertExists()
    compose.onNodeWithTag(TagDetailForgetCancel).assertIsFocused()
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    compose.waitForIdle()

    assertEquals(listOf(listOf("file:Films/It/It.mkv")), forgotten)
    compose.onNodeWithText("Play").assertIsDisplayed()
    compose.onNodeWithTag(TagDetailStartOver).assertDoesNotExist()
    compose.onNodeWithTag(TagDetailForget).assertDoesNotExist()
  }

  @Test
  fun `a Continue card's keys stop offering Forget once they are forgotten`() {
    progress["file:Films/It/It.mkv"] = ProgressDto(38.6, 120.0)
    mount(
      detail(listOf(file("Films/It/It.mkv"))).copy(forgetKeys = listOf("file:Films/It/It.mkv")),
      forgetProgress = { keys -> keys.forEach { progress.remove(it) } },
    )

    focusForget()
    press(Key.DirectionCenter)
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    compose.waitForIdle()

    compose.onNodeWithTag(TagDetailForget).assertDoesNotExist()
  }

  @Test
  fun `forget sends every stored episode key of the show`() {
    progress["file:Films/Show/S1E1.mkv"] = ProgressDto(100.0, 600.0)
    progress["file:Films/Show/S1E2.mkv"] = ProgressDto(200.0, 600.0)
    val forgotten = mutableListOf<List<String>>()
    mount(
      detail(
        listOf(
          file("Films/Show/S1E1.mkv", "S1E1").copy(season = 1, episode = 1),
          file("Films/Show/S1E2.mkv", "S1E2").copy(season = 1, episode = 2),
        ),
        title = "Show",
      ),
      forgetProgress = { keys -> forgotten += keys; keys.forEach { progress.remove(it) } },
    )

    focusForget()
    press(Key.DirectionCenter)
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    compose.waitForIdle()

    assertEquals(
      listOf(listOf("file:Films/Show/S1E1.mkv", "file:Films/Show/S1E2.mkv")),
      forgotten,
    )
  }

  @Test
  fun `a failed forget keeps the position, the favourite and shows the failure`() {
    progress["file:Films/It/It.mkv"] = ProgressDto(38.6, 120.0)
    mount(
      detail(listOf(file("Films/It/It.mkv"))),
      forgetProgress = { throw ApiError(ApiFailure.Generic) },
    )

    focusForget()
    press(Key.DirectionCenter)
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    compose.waitForIdle()

    focusFavourite()
    press(Key.DirectionCenter)
    assertEquals(listOf("Films/It" to true), favouriteCalls)

    compose.onNodeWithText("Resume").assertIsDisplayed()
    compose.onNodeWithTag(TagDetailWatched).assertTextContains("32 % watched")
    compose.onNodeWithTag(TagDetailFavourite).assertTextContains("★")
    compose.onNodeWithText("Something went wrong. Try again.").assertIsDisplayed()
  }

  @Test
  fun `a bound library file loads extras for the bound title`() {
    val path = "Films/It/It.mkv"
    val api = FakeTvApi().apply {
      libraryTitleValues[path] = LibraryTitleDto(type = "movie", id = "tt1", name = "It")
      titleExtrasValue = TitleExtrasDto(
        people = listOf(TitlePersonDto(name = "Tom Hanks", role = "cast", character = "Woody")),
      )
    }
    mount(detail(listOf(file(path))), sourcesApi = api)
    compose.waitUntil(5_000) { api.titleExtrasRequests.isNotEmpty() }
    compose.waitForIdle()

    assertEquals(Triple("movie", "tt1", null), api.titleExtrasRequests.single())
    compose.onNodeWithText("Cast and crew").assertIsDisplayed()
    compose.onNodeWithText("Tom Hanks").assertExists()
  }

  @Test
  fun `an unbound library file asks for no extras and draws no rows`() {
    val path = "Films/Loose.mkv"
    val api = FakeTvApi()
    mount(detail(listOf(file(path))), sourcesApi = api)
    compose.waitUntil(5_000) { api.libraryTitleRequests.isNotEmpty() }
    compose.waitForIdle()

    assertEquals(listOf(path), api.libraryTitleRequests)
    assertTrue(api.titleExtrasRequests.isEmpty())
    compose.onNodeWithText("Cast and crew").assertDoesNotExist()
  }

  @Test
  fun `DOWN from a bound file's action row reaches the first portrait`() {
    val path = "Films/It/It.mkv"
    val api = FakeTvApi().apply {
      libraryTitleValues[path] = LibraryTitleDto(type = "movie", id = "tt1", name = "It")
      titleExtrasValue = TitleExtrasDto(
        people = listOf(TitlePersonDto(name = "Tom Hanks", role = "cast", character = "Woody")),
      )
    }
    mount(detail(listOf(file(path))), sourcesApi = api)
    compose.waitUntil(5_000) { api.titleExtrasRequests.isNotEmpty() }
    compose.waitForIdle()

    compose.onNodeWithTag(TagDetailPrimary).assertIsFocused()
    press(Key.DirectionDown)
    compose.onNodeWithTag(titlePersonTag("Tom Hanks")).assertIsFocused()
    compose.onNodeWithTag(titlePersonTag("Tom Hanks")).assertIsDisplayed()
  }

  @Test
  fun `a bound library file shows ratings from its title extras`() {
    val path = "Films/It/It.mkv"
    val api = FakeTvApi().apply {
      libraryTitleValues[path] = LibraryTitleDto(type = "movie", id = "tt1", name = "It")
      titleExtrasValue = TitleExtrasDto(
        ratings = TitleRatingsDto(imdb = "9.3", tmdb = 8.7, tmdbVotes = 31_720),
      )
    }
    mount(detail(listOf(file(path))), sourcesApi = api)
    compose.waitUntil(5_000) { api.titleExtrasRequests.isNotEmpty() }
    compose.waitForIdle()

    compose.onNodeWithTag(TagTitleExtrasImdb).assertExists()
    compose.onNodeWithTag(TagTitleExtrasTmdb).assertExists()
  }
}
