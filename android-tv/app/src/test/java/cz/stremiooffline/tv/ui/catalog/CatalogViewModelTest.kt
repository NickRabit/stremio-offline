package cz.stremiooffline.tv.ui.catalog

import cz.stremiooffline.tv.data.CatalogDto
import cz.stremiooffline.tv.data.MetaDto
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
class CatalogViewModelTest {

  private val dispatcher = StandardTestDispatcher()

  @Before fun setUp() = Dispatchers.setMain(dispatcher)

  @After fun tearDown() = Dispatchers.resetMain()

  private fun meta(id: String) = MetaDto(id = id, type = "movie", name = id)

  private fun api(vararg pages: List<MetaDto>): FakeTvApi {
    val api = FakeTvApi()
    api.catalogsValue = listOf(CatalogDto(addonKey = "a", addonName = "A", type = "movie", id = "top"))
    api.catalogPages["a"] = pages.toList()
    return api
  }

  @Test
  fun `an empty page stops paging`() = runTest(dispatcher) {
    val api = api(listOf(meta("tt1"), meta("tt2")))
    val viewModel = CatalogViewModel(api)
    viewModel.start()
    advanceUntilIdle()
    assertEquals(2, viewModel.state.items.size)
    assertTrue(viewModel.state.hasMore)

    viewModel.loadMore()
    advanceUntilIdle()

    assertFalse(viewModel.state.hasMore)
    assertEquals(2, viewModel.state.items.size)
  }

  @Test
  fun `an addon that ignores skip stops paging once nothing new arrives`() = runTest(dispatcher) {
    val api = api(listOf(meta("tt1"), meta("tt2")), listOf(meta("tt1"), meta("tt2")))
    val viewModel = CatalogViewModel(api)
    viewModel.start()
    advanceUntilIdle()

    viewModel.loadMore()
    advanceUntilIdle()

    assertFalse(viewModel.state.hasMore)
    assertEquals(listOf("tt1", "tt2"), viewModel.state.items.map { it.id })
  }
}
