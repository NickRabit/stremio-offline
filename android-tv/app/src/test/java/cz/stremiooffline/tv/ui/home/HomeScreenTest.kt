@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.home

import android.content.Context
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.catalog.ResumeEpisode
import cz.stremiooffline.tv.data.DownloadDto
import cz.stremiooffline.tv.data.DownloadsResponseDto
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.HomeCardsJson
import cz.stremiooffline.tv.data.HomeOrderEntry
import cz.stremiooffline.tv.data.HomeResponseDto
import cz.stremiooffline.tv.data.HomeRowDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.CatalogDetailArgs
import cz.stremiooffline.tv.ui.detail.PlayTarget
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Home's focus contract, its lazy carousels, its retries and where OK goes. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class HomeScreenTest {

  @get:Rule val compose = createComposeRule()

  private val context: Context get() = ApplicationProvider.getApplicationContext()

  private fun row(vararg cards: HomeCard, partial: Boolean = false, status: String = "ok") = HomeRowDto(
    status = status,
    items = cards.map { HomeCardsJson.encodeToJsonElement(HomeCard.serializer(), it) as JsonObject },
    partial = partial,
  )

  private fun serve(api: FakeTvApi, order: List<HomeOrderEntry>, rows: Map<String, HomeRowDto>) {
    api.homeHandler = { asked -> if (asked.isEmpty()) HomeResponseDto(order = order) else HomeResponseDto(order = order, rows = rows) }
  }

  private fun mount(
    api: FakeTvApi,
    refreshToken: MutableState<Int> = mutableIntStateOf(0),
    onAction: (HomeAction) -> Unit = {},
    onHint: (String) -> Unit = {},
  ) {
    compose.setContent {
      HomeScreen(api = api, onAction = onAction, onHint = onHint, refreshToken = refreshToken.value)
    }
  }

  private fun resumeFile(key: String, title: String, path: String = "browse/$key") =
    HomeCard.ResumeFile(key = key, title = title, path = path, progress = null)

  private fun discovery(key: String, id: String, name: String = key) =
    HomeCard.Discovery(key = key, type = "movie", id = id, name = name, title = name)

  private fun order(vararg ids: String) = ids.map { HomeOrderEntry(it) }

  @Test
  fun `the first card of the first row takes focus and the backdrop shows its title`() {
    val api = FakeTvApi()
    serve(api, order("resume"), mapOf("resume" to row(resumeFile("a", "First"), resumeFile("b", "Second"))))
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(homeCardTag("a")).assertIsFocused()
    compose.onNodeWithTag(TagBackdropTitle).assertTextEquals("First")
  }

  @Test
  fun `right moves within the row and the backdrop follows`() {
    val api = FakeTvApi()
    serve(api, order("resume"), mapOf("resume" to row(resumeFile("a", "First"), resumeFile("b", "Second"))))
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(homeCardTag("a")).performKeyInput { pressKey(Key.DirectionRight) }
    compose.waitForIdle()

    compose.onNodeWithTag(homeCardTag("b")).assertIsFocused()
    compose.onNodeWithTag(TagBackdropTitle).assertTextEquals("Second")
  }

  @Test
  fun `down then up returns to the card last focused in the first row`() {
    val api = FakeTvApi()
    serve(
      api,
      order("resume", "episodes"),
      mapOf(
        "resume" to row(resumeFile("a", "First"), resumeFile("b", "Second")),
        "episodes" to row(resumeFile("c", "Third")),
      ),
    )
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(homeCardTag("a")).performKeyInput { pressKey(Key.DirectionRight) }
    compose.onNodeWithTag(homeCardTag("b")).assertIsFocused()
    compose.onNodeWithTag(homeCardTag("b")).performKeyInput { pressKey(Key.DirectionDown) }
    compose.waitForIdle()
    compose.onNodeWithTag(homeCardTag("c")).assertIsFocused()
    compose.onNodeWithTag(homeCardTag("c")).performKeyInput { pressKey(Key.DirectionUp) }
    compose.waitForIdle()

    compose.onNodeWithTag(homeCardTag("b")).assertIsFocused()
  }

  @Test
  fun `the focused row stays inside the rows area as focus walks down eight rows`() {
    val api = FakeTvApi()
    val ids = listOf("resume", "favorites", "tonight", "episodes", "completed", "recent", "r7", "r8")
    serve(api, order(*ids.toTypedArray()), ids.associateWith { row(resumeFile(it, it)) })
    mount(api)
    compose.waitForIdle()

    var current = "resume"
    compose.onNodeWithTag(homeCardTag(current)).assertIsFocused()
    ids.drop(1).forEach { id ->
      compose.onNodeWithTag(homeCardTag(current)).performKeyInput { pressKey(Key.DirectionDown) }
      compose.waitForIdle()
      compose.onNodeWithTag(homeCardTag(id)).assertIsFocused()
      compose.onNodeWithTag(homeCardTag(id)).assertIsDisplayed()
      // The whole card, not just a sliver: the row is scrolled fully into the rows area.
      val root = compose.onRoot().fetchSemanticsNode().boundsInRoot
      val card = compose.onNodeWithTag(homeCardTag(id)).fetchSemanticsNode().boundsInRoot
      assertTrue(
        "card $id $card is not inside the root $root",
        card.left >= root.left && card.top >= root.top && card.right <= root.right && card.bottom <= root.bottom,
      )
      current = id
    }
  }

  @Test
  fun `a catalogue row is a placeholder until focus is one row above it`() {
    val api = FakeTvApi()
    val catalog = "catalog:addon:movie:top"
    serve(
      api,
      order("resume", catalog),
      mapOf(
        "resume" to row(resumeFile("a", "First")),
        catalog to row(discovery("movie:tt1", "tt1")),
      ),
    )
    mount(api)
    compose.waitForIdle()

    assertEquals(1, api.homeRequests.count { it == listOf(catalog) })
  }

  @Test
  fun `a partial catalogue row is retried at 2,5 s and stops after three`() {
    val api = FakeTvApi()
    val catalog = "catalog:addon:movie:top"
    serve(
      api,
      order("resume", catalog),
      mapOf(
        "resume" to row(resumeFile("a", "First")),
        catalog to row(discovery("movie:tt1", "tt1"), partial = true),
      ),
    )
    mount(api)
    compose.waitForIdle()
    assertEquals(1, api.homeRequests.count { it == listOf(catalog) })

    repeat(PARTIAL_RETRIES) {
      compose.mainClock.advanceTimeBy(PARTIAL_RETRY_MS + 100)
      compose.waitForIdle()
    }
    assertEquals(1 + PARTIAL_RETRIES, api.homeRequests.count { it == listOf(catalog) })

    compose.mainClock.advanceTimeBy(PARTIAL_RETRY_MS + 100)
    compose.waitForIdle()
    assertEquals(1 + PARTIAL_RETRIES, api.homeRequests.count { it == listOf(catalog) })
  }

  @Test
  fun `the D-pad reaches an error row and OK retries that row only`() {
    val api = FakeTvApi()
    serve(
      api,
      order("resume", "episodes", "tonight"),
      mapOf(
        "resume" to row(resumeFile("a", "First")),
        "episodes" to row(status = "error"),
        "tonight" to row(resumeFile("c", "Third")),
      ),
    )
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(homeCardTag("a")).assertIsFocused()
    compose.onNodeWithTag(homeCardTag("a")).performKeyInput { pressKey(Key.DirectionDown) }
    compose.waitForIdle()
    compose.onNodeWithText(context.getString(R.string.home_row_failed)).assertExists()
    compose.onNodeWithTag(homeRetryTag("episodes")).assertIsFocused()

    // The retry button does not trap the remote: DOWN still reaches the row below it.
    compose.onNodeWithTag(homeRetryTag("episodes")).performKeyInput { pressKey(Key.DirectionDown) }
    compose.waitForIdle()
    compose.onNodeWithTag(homeCardTag("c")).assertIsFocused()

    compose.onNodeWithTag(homeCardTag("c")).performKeyInput { pressKey(Key.DirectionUp) }
    compose.waitForIdle()
    compose.onNodeWithTag(homeRetryTag("episodes")).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    assertEquals(listOf("episodes"), api.homeRequests.last())
  }

  @Test
  fun `an error row in the first slot still gives the panel something to focus`() {
    val api = FakeTvApi()
    serve(api, order("resume"), mapOf("resume" to row(status = "error")))
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(homeRetryTag("resume")).assertIsFocused()
  }

  @Test
  fun `the D-pad reaches a partial row and its Try again retries it`() {
    val api = FakeTvApi()
    val catalog = "catalog:addon:movie:top"
    serve(
      api,
      order("resume", catalog),
      mapOf(
        "resume" to row(resumeFile("a", "First")),
        catalog to row(partial = true),
      ),
    )
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(homeCardTag("a")).performKeyInput { pressKey(Key.DirectionDown) }
    compose.waitForIdle()
    compose.onNodeWithText(context.getString(R.string.home_partial)).assertExists()
    compose.onNodeWithTag(homeRetryTag(catalog)).assertIsFocused()
    val before = api.homeRequests.count { it == listOf(catalog) }
    compose.onNodeWithTag(homeRetryTag(catalog)).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    assertEquals(before + 1, api.homeRequests.count { it == listOf(catalog) })
  }

  @Test
  fun `the whole page failure shows its panel and Try again recovers`() {
    val api = FakeTvApi()
    serve(api, order("resume"), mapOf("resume" to row(resumeFile("a", "First"))))
    api.failHome = true
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithText(context.getString(R.string.tv_home_load_error)).assertExists()

    api.failHome = false
    compose.onNodeWithText(context.getString(R.string.home_retry)).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    compose.onNodeWithTag(homeCardTag("a")).assertIsFocused()
  }

  @Test
  fun `an account with every row empty shows the empty panel`() {
    val api = FakeTvApi()
    serve(api, order("resume", "favorites"), mapOf("resume" to row(), "favorites" to row()))
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithText(context.getString(R.string.home_empty_title)).assertExists()
    compose.onNodeWithText(context.getString(R.string.home_empty_text)).assertExists()
  }

  @Test
  fun `the partial retry counter starts again when Home is entered again`() {
    val api = FakeTvApi()
    val catalog = "catalog:addon:movie:top"
    serve(
      api,
      order("resume", catalog),
      mapOf(
        "resume" to row(resumeFile("a", "First")),
        catalog to row(discovery("movie:tt1", "tt1"), partial = true),
      ),
    )
    val token = mutableIntStateOf(0)
    mount(api, refreshToken = token)
    compose.waitForIdle()

    compose.mainClock.advanceTimeBy(PARTIAL_RETRY_MS + 100)
    compose.waitForIdle()
    assertEquals(2, api.homeRequests.count { it == listOf(catalog) })

    token.value = 1
    compose.waitForIdle()
    val afterRefresh = api.homeRequests.count { it == listOf(catalog) }
    repeat(PARTIAL_RETRIES) {
      compose.mainClock.advanceTimeBy(PARTIAL_RETRY_MS + 100)
      compose.waitForIdle()
    }
    assertEquals(afterRefresh + PARTIAL_RETRIES, api.homeRequests.count { it == listOf(catalog) })
  }

  @Test
  fun `ok on a resume-file card plays the file directly`() {
    val api = FakeTvApi()
    serve(api, order("resume"), mapOf("resume" to row(resumeFile("a", "It", path = "browse/Films/It.mkv"))))
    val actions = mutableListOf<HomeAction>()
    mount(api, onAction = { actions += it })
    compose.waitForIdle()

    compose.onNodeWithTag(homeCardTag("a")).performKeyInput { pressKey(Key.DirectionCenter) }

    assertEquals(
      HomeAction.Play(PlayTarget(key = "file:browse/Films/It.mkv", title = "It", resume = true, path = "browse/Films/It.mkv")),
      actions.single(),
    )
  }

  @Test
  fun `ok on a file favourite plays it`() {
    val api = FakeTvApi()
    serve(
      api,
      order("favorites"),
      mapOf("favorites" to row(HomeCard.Favorite(key = "file:c", path = "browse/c", itemKind = "file", label = "Fav"))),
    )
    val actions = mutableListOf<HomeAction>()
    mount(api, onAction = { actions += it })
    compose.waitForIdle()
    compose.onNodeWithTag(homeCardTag("file:c")).performKeyInput { pressKey(Key.DirectionCenter) }

    assertEquals(
      HomeAction.Play(PlayTarget(key = "file:browse/c", title = "Fav", resume = true, path = "browse/c")),
      actions.single(),
    )
  }

  @Test
  fun `ok on a folder favourite opens the library at that folder`() {
    val api = FakeTvApi()
    serve(
      api,
      order("favorites"),
      mapOf("favorites" to row(HomeCard.Favorite(key = "folder:f", path = "browse/Films", itemKind = "folder", label = "Films"))),
    )
    val actions = mutableListOf<HomeAction>()
    mount(api, onAction = { actions += it })
    compose.waitForIdle()
    compose.onNodeWithTag(homeCardTag("folder:f")).performKeyInput { pressKey(Key.DirectionCenter) }

    assertEquals(HomeAction.OpenLibrary("browse/Films"), actions.single())
  }

  @Test
  fun `ok on a completed card plays the file`() {
    val api = FakeTvApi()
    serve(
      api,
      order("completed"),
      mapOf("completed" to row(HomeCard.Completed(key = "file:b", title = "Done", path = "browse/Films/Done.mkv"))),
    )
    val actions = mutableListOf<HomeAction>()
    mount(api, onAction = { actions += it })
    compose.waitForIdle()

    compose.onNodeWithTag(homeCardTag("file:b")).performKeyInput { pressKey(Key.DirectionCenter) }

    assertEquals(
      HomeAction.Play(PlayTarget(key = "file:browse/Films/Done.mkv", title = "Done", resume = true, path = "browse/Films/Done.mkv")),
      actions.single(),
    )
  }

  @Test
  fun `ok on a recent card plays the file`() {
    val api = FakeTvApi()
    serve(
      api,
      order("recent"),
      mapOf("recent" to row(HomeCard.Recent(key = "file:d", path = "browse/New.mkv", label = "New"))),
    )
    val actions = mutableListOf<HomeAction>()
    mount(api, onAction = { actions += it })
    compose.waitForIdle()

    compose.onNodeWithTag(homeCardTag("file:d")).performKeyInput { pressKey(Key.DirectionCenter) }

    assertEquals(
      HomeAction.Play(PlayTarget(key = "file:browse/New.mkv", title = "New", resume = true, path = "browse/New.mkv")),
      actions.single(),
    )
  }

  @Test
  fun `ok on a tonight file plays it and a tonight folder opens the library`() {
    val api = FakeTvApi()
    serve(
      api,
      order("tonight"),
      mapOf(
        "tonight" to row(
          HomeCard.Tonight(key = "file:e", path = "browse/Ton.mkv", itemKind = "file", label = "Ton", year = "1999"),
          HomeCard.Tonight(key = "folder:f", path = "browse/Films", itemKind = "folder", label = "Films", year = "2001"),
        ),
      ),
    )
    val actions = mutableListOf<HomeAction>()
    mount(api, onAction = { actions += it })
    compose.waitForIdle()

    compose.onNodeWithTag(homeCardTag("file:e")).performKeyInput { pressKey(Key.DirectionCenter) }
    assertEquals(
      HomeAction.Play(PlayTarget(key = "file:browse/Ton.mkv", title = "Ton", resume = true, path = "browse/Ton.mkv")),
      actions.single(),
    )

    compose.onNodeWithTag(homeCardTag("file:e")).performKeyInput { pressKey(Key.DirectionRight) }
    compose.onNodeWithTag(homeCardTag("folder:f")).performKeyInput { pressKey(Key.DirectionCenter) }
    assertEquals(HomeAction.OpenLibrary("browse/Films"), actions.last())
  }

  @Test
  fun `ok on a resume-catalogue card opens the catalogue at its episode`() {
    val api = FakeTvApi()
    serve(
      api,
      order("resume"),
      mapOf(
        "resume" to row(
          HomeCard.ResumeCatalogue(
            key = "series:x:1:2",
            title = "Show",
            type = "series",
            id = "tt1",
            name = "Show",
            season = 1,
            episode = 2,
          ),
        ),
      ),
    )
    val actions = mutableListOf<HomeAction>()
    mount(api, onAction = { actions += it })
    compose.waitForIdle()

    compose.onNodeWithTag(homeCardTag("series:x:1:2")).performKeyInput { pressKey(Key.DirectionCenter) }

    val action = actions.single() as HomeAction.OpenCatalog
    assertEquals("series", action.args.type)
    assertEquals("tt1", action.args.meta.id)
    assertEquals(ResumeEpisode("series:x:1:2", 1, 2), action.args.episode)
  }

  @Test
  fun `ok on an episode card opens the catalogue at the episode`() {
    val api = FakeTvApi()
    serve(
      api,
      order("episodes"),
      mapOf(
        "episodes" to row(
          HomeCard.Episode(key = "episode:f:v", type = "series", metaId = "tt2", name = "Show", season = 2, episode = 4),
        ),
      ),
    )
    val actions = mutableListOf<HomeAction>()
    mount(api, onAction = { actions += it })
    compose.waitForIdle()

    compose.onNodeWithTag(homeCardTag("episode:f:v")).performKeyInput { pressKey(Key.DirectionCenter) }

    val action = actions.single() as HomeAction.OpenCatalog
    assertEquals("series", action.args.type)
    assertEquals("tt2", action.args.meta.id)
    assertEquals(ResumeEpisode("episode:f:v", 2, 4), action.args.episode)
  }

  @Test
  fun `ok on a discovery card opens the catalogue title`() {
    val api = FakeTvApi()
    serve(api, order("tonight"), mapOf("tonight" to row(discovery("movie:tt3", "tt3", "Dis"))))
    val actions = mutableListOf<HomeAction>()
    mount(api, onAction = { actions += it })
    compose.waitForIdle()

    compose.onNodeWithTag(homeCardTag("movie:tt3")).performKeyInput { pressKey(Key.DirectionCenter) }

    val action = actions.single() as HomeAction.OpenCatalog
    assertEquals("movie", action.args.type)
    assertEquals("tt3", action.args.meta.id)
    assertNull(action.args.episode)
  }

  @Test
  fun `after returning the same card is focused, and a gone card leaves its neighbour`() {
    val api = FakeTvApi()
    val order = order("resume")
    serve(api, order, mapOf("resume" to row(resumeFile("a", "First"), resumeFile("b", "Second"), resumeFile("c", "Third"))))
    val token = mutableIntStateOf(0)
    mount(api, refreshToken = token)
    compose.waitForIdle()

    compose.onNodeWithTag(homeCardTag("a")).performKeyInput { pressKey(Key.DirectionRight) }
    compose.onNodeWithTag(homeCardTag("b")).assertIsFocused()

    token.value = 1
    compose.waitForIdle()
    compose.onNodeWithTag(homeCardTag("b")).assertIsFocused()

    // The server no longer returns the focused card; the neighbour in the same row takes over.
    serve(api, order, mapOf("resume" to row(resumeFile("a", "First"), resumeFile("c", "Third"))))
    token.value = 2
    compose.waitForIdle()
    assertEquals(3, api.homeRequests.count { it == listOf("resume") })
    compose.onNodeWithTag(homeCardTag("b")).assertDoesNotExist()
    compose.onNodeWithTag(homeCardTag("c")).assertIsFocused()
  }

  @Test
  fun `the downloads strip is hidden without jobs`() {
    val api = FakeTvApi()
    serve(api, order("resume"), mapOf("resume" to row(resumeFile("a", "First"))))
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(TagDownloadsStrip).assertDoesNotExist()
  }

  // Found on the owner's server: the focused first card's left border and glow were cut off.
  @Test
  fun `the focused first card is not clipped by its row`() {
    val api = FakeTvApi()
    serve(api, order("resume"), mapOf("resume" to row(resumeFile("a", "First"), resumeFile("b", "Second"))))
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(homeCardTag("a")).assertIsFocused()
    val card = compose.onNodeWithTag(homeCardTag("a")).getBoundsInRoot()
    val row = compose.onNodeWithTag(homeRowTag("resume")).getBoundsInRoot()
    // A poster grows by 8 % on focus; the whole scaled card has to stay inside the row viewport.
    val half = (card.right - card.left) * 0.08f / 2
    assertTrue(
      "the scaled card ${card.left - half}..${card.right + half} does not fit the row ${row.left}..${row.right}",
      card.left - half >= row.left && card.right + half <= row.right,
    )
  }

  @Test
  fun `the downloads strip counts the jobs, marks attention and answers OK with a hint`() {
    val api = FakeTvApi()
    serve(api, emptyList(), emptyMap())
    api.downloadsValue = DownloadsResponseDto(
      listOf(DownloadDto(id = "j", title = "It", status = "failed", order = 0, mine = true)),
    )
    var hint: String? = null
    mount(api, onHint = { hint = it })
    compose.waitForIdle()

    compose.onNodeWithText(context.resources.getQuantityString(R.plurals.home_downloads_summary, 1, 1)).assertExists()
    compose.onNodeWithText(context.resources.getQuantityString(R.plurals.home_attention, 1, 1)).assertExists()
    compose.onNodeWithTag(TagDownloadsStrip).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    assertEquals(context.getString(R.string.tv_downloads_later), hint)
  }

  @Test
  fun `the Favourites row renders its items in the server's order`() {
    val api = FakeTvApi()
    serve(
      api,
      order("favorites"),
      mapOf(
        "favorites" to row(
          HomeCard.Favorite(key = "file:a", path = "browse/A.mkv", label = "A"),
          HomeCard.Favorite(key = "file:b", path = "browse/B.mkv", label = "B"),
        ),
      ),
    )
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(homeCardTag("file:a")).assertIsFocused()
    compose.onNodeWithTag(TagBackdropTitle).assertTextEquals("A")
    compose.onNodeWithTag(homeCardTag("file:a")).performKeyInput { pressKey(Key.DirectionRight) }
    compose.waitForIdle()
    compose.onNodeWithTag(homeCardTag("file:b")).assertIsFocused()
    compose.onNodeWithTag(TagBackdropTitle).assertTextEquals("B")
  }

  @Test
  fun `a favourites row of folders shows each folder's artwork`() {
    val urls = mutableListOf<String>()
    val api = object : FakeTvApi() {
      override fun url(path: String): String {
        urls += path
        return super.url(path)
      }
    }
    serve(
      api,
      order("favorites"),
      mapOf(
        "favorites" to row(
          HomeCard.Favorite(
            key = "folder:f",
            path = "browse/Films",
            itemKind = "folder",
            label = "Films",
            poster = "lib_1/Films/cover.jpg",
          ),
        ),
      ),
    )
    mount(api)
    compose.waitForIdle()

    compose.onNodeWithTag(homeCardTag("folder:f")).assertIsFocused()
    assertTrue("the folder poster was not resolved: $urls", "lib_1/Films/cover.jpg" in urls)
  }
}
