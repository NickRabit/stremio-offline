package cz.stremiooffline.tv.ui.library

import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.ui.FakeTvApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class LibraryViewModelTest {

  private val dispatcher = StandardTestDispatcher()

  @Before fun setUp() = Dispatchers.setMain(dispatcher)

  @After fun tearDown() = Dispatchers.resetMain()

  private fun folder(path: String, name: String) = BrowseItem.Folder(path = path, name = name)

  @Test
  fun `an empty pending page is asked again while the view model loads`() = runTest(dispatcher) {
    var call = 0
    val api = object : FakeTvApi() {
      override suspend fun browse(path: String?, limit: Int, skip: Int): BrowseResult {
        call++
        return if (call == 1) BrowseResult(path.orEmpty(), emptyList(), 1, pending = true)
        else BrowseResult(path.orEmpty(), listOf(folder("Films", "Films")), 1, false)
      }
    }
    val viewModel = LibraryViewModel(api, pendingDelayMs = 1L)
    viewModel.start()
    advanceUntilIdle()

    assertEquals(2, call)
    assertEquals(listOf("Films"), viewModel.state.current!!.items.map { it.title })
  }

  @Test
  fun `back drops one level and keeps the parent items`() = runTest(dispatcher) {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(folder("Shows", "Shows")), 1, false)
    api.pages["Shows"] = BrowseResult("Shows", listOf(folder("Shows/S1", "S1")), 1, false)

    val viewModel = LibraryViewModel(api)
    viewModel.start()
    advanceUntilIdle()
    viewModel.open("Shows", "Shows")
    advanceUntilIdle()
    assertEquals(2, viewModel.state.pages.size)

    assertTrue(viewModel.back())
    assertEquals(1, viewModel.state.pages.size)
    assertEquals(listOf("Shows"), viewModel.state.current!!.items.map { it.title })
  }

  // Found in review: Back while a nested level was still loading wrote its items into the parent.
  @Test
  fun `back while a nested level loads keeps the parent's items`() = runTest(dispatcher) {
    val api = object : FakeTvApi() {
      override suspend fun browse(path: String?, limit: Int, skip: Int): BrowseResult {
        if (path == null) return BrowseResult("", listOf(folder("Shows", "Shows")), 1, false)
        kotlinx.coroutines.delay(1_000)
        return BrowseResult(path, listOf(folder("Shows/S1", "S1")), 1, false)
      }
    }
    val viewModel = LibraryViewModel(api, pendingDelayMs = 1L)
    viewModel.start()
    advanceUntilIdle()
    viewModel.open("Shows", "Shows")
    advanceTimeBy(100)

    viewModel.back()
    advanceUntilIdle()

    assertEquals(1, viewModel.state.pages.size)
    assertEquals(listOf("Shows"), viewModel.state.current!!.items.map { it.title })
  }
}
