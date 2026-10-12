package cz.stremiooffline.tv.ui.catalog

import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.RecentSearchDto
import cz.stremiooffline.tv.data.SearchStateDto
import cz.stremiooffline.tv.ui.FakeTvApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The search history the ViewModel keeps in step with the server: record, forget and read. */
@OptIn(ExperimentalCoroutinesApi::class)
class SearchHistoryViewModelTest {

  private val dispatcher = StandardTestDispatcher()

  @Before fun setUp() = Dispatchers.setMain(dispatcher)

  @After fun tearDown() = Dispatchers.resetMain()

  private fun recent(vararg queries: String): List<RecentSearchDto> = queries.map { RecentSearchDto(it, "now") }

  @Test
  fun `submitting a query records it once`() = runTest(dispatcher) {
    val api = FakeTvApi()
    val viewModel = SearchViewModel(api)
    advanceUntilIdle()

    viewModel.submit("  Heat  ")
    advanceUntilIdle()

    assertEquals(listOf("Heat"), api.recordedSearches)
  }

  @Test
  fun `a blank submission records nothing`() = runTest(dispatcher) {
    val api = FakeTvApi()
    val viewModel = SearchViewModel(api)
    advanceUntilIdle()

    viewModel.submit("   ")
    advanceUntilIdle()

    assertTrue(api.recordedSearches.isEmpty())
  }

  @Test
  fun `nothing is recorded while the account keeps no history`() = runTest(dispatcher) {
    val api = FakeTvApi()
    api.searchStateValue = SearchStateDto(saveHistory = false)
    val viewModel = SearchViewModel(api)
    advanceUntilIdle()

    viewModel.submit("Heat")
    advanceUntilIdle()

    assertTrue(api.recordedSearches.isEmpty())
  }

  @Test
  fun `forgetting a query removes just that entry`() = runTest(dispatcher) {
    val api = FakeTvApi()
    api.searchStateValue = SearchStateDto(recent = recent("Heat", "Ronin", "Alien"))
    val viewModel = SearchViewModel(api)
    advanceUntilIdle()
    assertEquals(3, viewModel.state.recent.size)

    viewModel.forget("Ronin")
    advanceUntilIdle()

    assertEquals(listOf("Heat", "Alien"), viewModel.state.recent.map { it.query })
    assertEquals(listOf("Ronin"), api.forgottenSearches)
  }

  @Test
  fun `a state read that fails leaves the list empty`() = runTest(dispatcher) {
    val api = FakeTvApi()
    api.searchStateFailure = ApiFailure.Generic
    val viewModel = SearchViewModel(api)
    advanceUntilIdle()

    assertTrue(viewModel.state.recent.isEmpty())
  }

  @Test
  fun `the history is read once on open and again after a submit`() = runTest(dispatcher) {
    val api = FakeTvApi()
    val viewModel = SearchViewModel(api)
    advanceUntilIdle()
    assertEquals(1, api.searchStateCalls)

    viewModel.submit("Heat")
    advanceUntilIdle()

    assertEquals(2, api.searchStateCalls)
  }
}
