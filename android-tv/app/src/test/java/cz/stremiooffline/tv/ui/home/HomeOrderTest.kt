package cz.stremiooffline.tv.ui.home

import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.HomeCardsJson
import cz.stremiooffline.tv.data.HomeOrderEntry
import cz.stremiooffline.tv.data.HomeResponseDto
import cz.stremiooffline.tv.data.HomeRowDto
import cz.stremiooffline.tv.ui.FakeTvApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

/** The rows the server names are drawn in its order; the ones it cannot answer are skipped. */
@OptIn(ExperimentalCoroutinesApi::class)
class HomeOrderTest {

  private val dispatcher = StandardTestDispatcher()

  @Before fun setUp() = Dispatchers.setMain(dispatcher)

  @After fun tearDown() = Dispatchers.resetMain()

  private fun row(vararg cards: HomeCard): HomeRowDto = HomeRowDto(
    items = cards.map { HomeCardsJson.encodeToJsonElement(HomeCard.serializer(), it) as JsonObject },
  )

  private fun resumeFile(key: String) = HomeCard.ResumeFile(key = key, title = key, path = "browse/$key", progress = null)

  @Test
  fun `rows are drawn in the server's order, without confirm, and unanswered ones are skipped`() = runTest(dispatcher) {
    val order = listOf(
      HomeOrderEntry("resume"),
      HomeOrderEntry("favorites"),
      HomeOrderEntry("tonight"),
      HomeOrderEntry("catalog:addon:movie:top", "Addon · Top"),
      HomeOrderEntry("episodes"),
      HomeOrderEntry("completed"),
      HomeOrderEntry("recent"),
      HomeOrderEntry("confirm"),
    )
    val builtin = listOf("resume", "favorites", "tonight", "episodes", "completed", "recent")
    val api = FakeTvApi()
    api.homeHandler = { rows ->
      if (rows.isEmpty()) HomeResponseDto(order = order)
      else HomeResponseDto(
        order = order,
        rows = buildMap {
          // `recent` is named by the order but the server does not answer it.
          put("favorites", row(resumeFile("favorite")))
          put("episodes", row(resumeFile("episode")))
          put("completed", row(resumeFile("completed")))
        },
      )
    }

    val viewModel = HomeViewModel(api)
    viewModel.start()
    advanceUntilIdle()

    assertEquals(emptyList<String>(), api.homeRequests[0])
    assertEquals(builtin, api.homeRequests[1])
    assertEquals(
      listOf("resume", "favorites", "tonight", "catalog:addon:movie:top", "episodes", "completed", "recent"),
      viewModel.state.rows.map { it.id },
    )
    assertEquals(
      listOf("favorites", "catalog:addon:movie:top", "episodes", "completed"),
      drawnRowIds(viewModel.state.rows),
    )
  }

  @Test
  fun `an id the client has never seen is requested and drawn`() = runTest(dispatcher) {
    val order = listOf(HomeOrderEntry("resume"), HomeOrderEntry("brandNew"))
    val api = FakeTvApi()
    api.homeHandler = { rows ->
      if (rows.isEmpty()) HomeResponseDto(order = order)
      else HomeResponseDto(order = order, rows = mapOf("brandNew" to row(resumeFile("new"))))
    }

    val viewModel = HomeViewModel(api)
    viewModel.start()
    advanceUntilIdle()

    assertEquals(listOf("resume", "brandNew"), api.homeRequests[1])
    assertEquals(listOf("brandNew"), drawnRowIds(viewModel.state.rows))
  }
}
