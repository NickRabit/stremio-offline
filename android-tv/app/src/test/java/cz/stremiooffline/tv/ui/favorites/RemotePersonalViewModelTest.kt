package cz.stremiooffline.tv.ui.favorites

import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.RemoteLibraryApi
import cz.stremiooffline.tv.data.RemotePersonalPage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** A failed or partial remote personal page never degrades into a successful empty list. */
@OptIn(ExperimentalCoroutinesApi::class)
class RemotePersonalViewModelTest {

  private val dispatcher = StandardTestDispatcher()

  @Before fun setUp() = Dispatchers.setMain(dispatcher)

  @After fun tearDown() = Dispatchers.resetMain()

  private class FakeRemoteApi : RemoteLibraryApi {
    val pages = mutableMapOf<Int, RemotePersonalPage>()
    val requests = mutableListOf<Int>()
    var failure: ApiError? = null
    var gate: CompletableDeferred<Unit>? = null

    override suspend fun remotePersonal(filter: String, skip: Int, limit: Int): RemotePersonalPage {
      requests += skip
      gate?.await()
      failure?.let { throw it }
      return pages[skip] ?: RemotePersonalPage(emptyList(), 0, false)
    }
  }

  private fun card(key: String) = HomeCard.Remote(
    key = key,
    title = key,
    provider = "jellyfin",
    libraryId = "rlibA",
    libraryName = "Filmy",
    itemId = key,
    itemType = "movie",
  )

  @Test
  fun `a failed first page is an error, not a successful empty list`() = runTest(dispatcher) {
    val api = FakeRemoteApi().apply { failure = ApiError(ApiFailure.Generic) }
    val viewModel = RemotePersonalViewModel(api, "favorites")
    viewModel.start()
    advanceUntilIdle()

    assertTrue(viewModel.state.error)
    assertFalse(viewModel.state.loading)
    assertEquals(0, viewModel.state.items.size)
  }

  @Test
  fun `a partial page keeps its cards and flags partial`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.pages[0] = RemotePersonalPage(listOf(card("a"), card("b")), total = 5, partial = true)
    val viewModel = RemotePersonalViewModel(api, "favorites")
    viewModel.start()
    advanceUntilIdle()

    assertEquals(listOf("a", "b"), viewModel.state.items.map { it.key })
    assertTrue(viewModel.state.partial)
    assertFalse(viewModel.state.error)
  }

  @Test
  fun `a failed load more keeps the loaded cards and shows the error`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.pages[0] = RemotePersonalPage(listOf(card("a")), total = 5, partial = false)
    val viewModel = RemotePersonalViewModel(api, "favorites")
    viewModel.start()
    advanceUntilIdle()

    api.failure = ApiError(ApiFailure.Generic)
    viewModel.loadMore()
    advanceUntilIdle()

    assertEquals(listOf("a"), viewModel.state.items.map { it.key })
    assertTrue(viewModel.state.error)
    assertFalse(viewModel.state.loadingMore)
  }

  @Test
  fun `a failed refresh keeps the cards and raises the error`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.pages[0] = RemotePersonalPage(listOf(card("a")), total = 1, partial = false)
    val viewModel = RemotePersonalViewModel(api, "favorites")
    viewModel.start()
    advanceUntilIdle()

    api.failure = ApiError(ApiFailure.Generic)
    viewModel.refresh()
    advanceUntilIdle()

    assertEquals(listOf("a"), viewModel.state.items.map { it.key })
    assertTrue(viewModel.state.error)
    assertFalse(viewModel.state.loading)
  }

  @Test
  fun `load more dedups repeated keys and uses the page's own total`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.pages[0] = RemotePersonalPage(listOf(card("a")), total = 3, partial = false)
    api.pages[1] = RemotePersonalPage(listOf(card("a"), card("b")), total = 2, partial = false)
    val viewModel = RemotePersonalViewModel(api, "favorites")
    viewModel.start()
    advanceUntilIdle()

    viewModel.loadMore()
    advanceUntilIdle()

    assertEquals(listOf("a", "b"), viewModel.state.items.map { it.key })
    assertEquals(2, viewModel.state.total)
  }

  @Test
  fun `cancelling an in-flight load more clears its loading flag`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.pages[0] = RemotePersonalPage(listOf(card("a")), total = 5, partial = false)
    val viewModel = RemotePersonalViewModel(api, "favorites")
    viewModel.start()
    advanceUntilIdle()

    api.gate = CompletableDeferred()
    viewModel.loadMore()
    runCurrent()
    assertTrue(viewModel.state.loadingMore)

    api.gate = null
    api.pages[0] = RemotePersonalPage(listOf(card("a")), total = 1, partial = false)
    viewModel.retry()
    advanceUntilIdle()

    assertFalse(viewModel.state.loadingMore)
    assertEquals(listOf("a"), viewModel.state.items.map { it.key })
  }
}
