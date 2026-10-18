package cz.stremiooffline.tv.ui.catalog

import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.CatalogSearchPollDto
import cz.stremiooffline.tv.data.CatalogSearchSnapshotDto
import cz.stremiooffline.tv.data.CatalogSearchStartResultDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.SearchResultDto
import cz.stremiooffline.tv.ui.FakeTvApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CatalogSearchViewModelTest {

  private val dispatcher = StandardTestDispatcher()

  @Before fun setUp() = Dispatchers.setMain(dispatcher)

  @After fun tearDown() = Dispatchers.resetMain()

  @Test
  fun `load more starts the same search again when the session has expired`() = runTest(dispatcher) {
    val api = FakeTvApi()
    api.catalogStartHandler = { request ->
      CatalogSearchStartResultDto(
        id = "cs_${request.generation}",
        snapshot = CatalogSearchSnapshotDto(
          revision = 1,
          state = "complete",
          items = listOf(MetaDto(id = "tt1", type = "movie", name = "One"), MetaDto(id = "tt${request.generation + 1}", type = "movie", name = "More")),
          sources = 1,
          hasMore = true,
        ),
      )
    }
    api.catalogPageHandler = { throw ApiError(ApiFailure.NotFound, status = 410) }
    val viewModel = SearchViewModel(api, catalogSessions = true)
    advanceUntilIdle()
    viewModel.submit("matrix")
    advanceUntilIdle()
    assertEquals(1, api.catalogStartCalls.size)

    viewModel.loadMore()
    advanceUntilIdle()

    assertEquals(2, api.catalogStartCalls.size)
    assertFalse(viewModel.state.error)
    assertEquals(listOf("tt1", "tt3"), viewModel.state.items.map { it.id })
    assertEquals("the restart is not a new search in the history", listOf("matrix"), api.recordedSearches)
  }

  @Test
  fun `the first snapshot paints while the session is still partial`() = runTest(dispatcher) {
    val api = FakeTvApi()
    val poll = CompletableDeferred<CatalogSearchPollDto>()
    api.catalogStartHandler = {
      CatalogSearchStartResultDto(
        id = "cs_1",
        snapshot = CatalogSearchSnapshotDto(
          revision = 1,
          state = "partial",
          items = listOf(MetaDto(id = "tt1", type = "movie", name = "Fast")),
          sources = 2,
          pending = 1,
          hasMore = true,
        ),
      )
    }
    api.catalogPollHandler = { _, _ -> poll.await() }
    val viewModel = SearchViewModel(api, catalogSessions = true)
    advanceUntilIdle()

    viewModel.submit("matrix")
    advanceUntilIdle()

    assertEquals(listOf("tt1"), viewModel.state.items.map { it.id })
    assertFalse(viewModel.state.loading)
    assertTrue(viewModel.state.hasMore)

    poll.complete(
      CatalogSearchPollDto(
        changed = true,
        revision = 2,
        snapshot = CatalogSearchSnapshotDto(
          revision = 2,
          state = "complete",
          items = listOf(
            MetaDto(id = "tt1", type = "movie", name = "Fast"),
            MetaDto(id = "tt2", type = "movie", name = "Slow"),
          ),
          sources = 2,
          hasMore = false,
        ),
      ),
    )
    advanceUntilIdle()
    assertEquals(listOf("tt1", "tt2"), viewModel.state.items.map { it.id })
  }

  @Test
  fun `a 404 from the session start falls back to the legacy search`() = runTest(dispatcher) {
    val api = FakeTvApi()
    api.catalogStartHandler = { throw ApiError(ApiFailure.NotFound, status = 404) }
    api.searchPages[""] = SearchResultDto(
      items = listOf(MetaDto(id = "tt1", type = "movie", name = "Legacy")),
      cursor = "",
      hasMore = false,
      sources = 1,
    )
    val viewModel = SearchViewModel(api, catalogSessions = true)
    advanceUntilIdle()

    viewModel.submit("matrix")
    advanceUntilIdle()

    assertEquals(1, api.searchRequests.size)
    assertEquals(listOf("tt1"), viewModel.state.items.map { it.id })
  }

  @Test
  fun `history is recorded once while snapshots keep arriving`() = runTest(dispatcher) {
    val api = FakeTvApi()
    var revision = 1
    api.catalogStartHandler = {
      CatalogSearchStartResultDto(
        id = "cs_1",
        snapshot = CatalogSearchSnapshotDto(
          revision = revision,
          state = "partial",
          items = listOf(MetaDto(id = "tt1", type = "movie", name = "Fast")),
          hasMore = true,
        ),
      )
    }
    api.catalogPollHandler = { _, _ ->
      revision += 1
      CatalogSearchPollDto(
        changed = true,
        revision = revision,
        snapshot = CatalogSearchSnapshotDto(
          revision = revision,
          state = "complete",
          items = listOf(MetaDto(id = "tt1", type = "movie", name = "Fast")),
          hasMore = false,
        ),
      )
    }
    val viewModel = SearchViewModel(api, catalogSessions = true)
    advanceUntilIdle()

    viewModel.submit("Heat")
    advanceUntilIdle()

    assertEquals(listOf("Heat"), api.recordedSearches)
  }
}
