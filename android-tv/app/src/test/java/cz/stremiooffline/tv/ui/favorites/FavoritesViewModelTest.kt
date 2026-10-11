package cz.stremiooffline.tv.ui.favorites

import cz.stremiooffline.tv.data.FavoriteFilter
import cz.stremiooffline.tv.data.FavoriteItemDto
import cz.stremiooffline.tv.data.FavoritesPage
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class FavoritesViewModelTest {

  private val dispatcher = StandardTestDispatcher()

  @Before fun setUp() = Dispatchers.setMain(dispatcher)

  @After fun tearDown() = Dispatchers.resetMain()

  private fun one() = FavoriteItemDto.Catalog(type = "movie", id = "tt1", name = "One")

  @Test
  fun `choosing a filter asks the server for it`() = runTest(dispatcher) {
    val api = FakeTvApi()
    api.favoritesValue = FavoritesPage(listOf(one()), 1, false)
    val viewModel = FavoritesViewModel(api)
    viewModel.start()
    advanceUntilIdle()
    assertEquals(listOf(FavoriteFilter.All), api.favoritesRequests)

    viewModel.select(FavoriteFilter.Catalog)
    advanceUntilIdle()

    assertEquals(listOf(FavoriteFilter.All, FavoriteFilter.Catalog), api.favoritesRequests)
    assertEquals(FavoriteFilter.Catalog, viewModel.state.filter)
    assertEquals(1, viewModel.state.items.size)
  }

  @Test
  fun `a refusal shows the error state and retry asks again`() = runTest(dispatcher) {
    val api = FakeTvApi()
    api.failFavorites = true
    val viewModel = FavoritesViewModel(api)
    viewModel.start()
    advanceUntilIdle()
    assertTrue(viewModel.state.error)

    api.failFavorites = false
    api.favoritesValue = FavoritesPage(listOf(one()), 1, false)
    viewModel.retry()
    advanceUntilIdle()

    assertFalse(viewModel.state.error)
    assertEquals(1, viewModel.state.items.size)
  }

  @Test
  fun `load more appends the second page`() = runTest(dispatcher) {
    val all = (1..61).map { FavoriteItemDto.Catalog(type = "movie", id = "tt$it", name = "T$it") }
    val api = object : FakeTvApi() {
      override suspend fun favorites(filter: FavoriteFilter, limit: Int, skip: Int): FavoritesPage {
        favoritesRequests += filter
        return FavoritesPage(all.drop(skip).take(limit), all.size, false)
      }
    }
    val viewModel = FavoritesViewModel(api)
    viewModel.start()
    advanceUntilIdle()
    assertEquals(60, viewModel.state.items.size)
    assertEquals(61, viewModel.state.total)

    viewModel.loadMore()
    advanceUntilIdle()

    assertEquals(61, viewModel.state.items.size)
  }
}
