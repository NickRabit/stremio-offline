package cz.stremiooffline.tv.ui.library

import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemsPageDto
import cz.stremiooffline.tv.data.RemoteLibraryApi
import cz.stremiooffline.tv.data.RemoteLibraryDto
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** A failed page never throws away the rows already loaded, and a cursor the server no longer
 *  accepts is dropped rather than retried forever. */
@OptIn(ExperimentalCoroutinesApi::class)
class RemoteLibraryViewModelTest {

  private val dispatcher = StandardTestDispatcher()

  @Before fun setUp() = Dispatchers.setMain(dispatcher)

  @After fun tearDown() = Dispatchers.resetMain()

  private class FakeRemoteApi : RemoteLibraryApi {
    /** One page per cursor; `""` stands for the first, uncursored page. */
    val pages = mutableMapOf<String, RemoteItemsPageDto>()
    val episodePages = mutableMapOf<String, RemoteItemsPageDto>()
    val cursors = mutableListOf<String?>()
    val episodeRequests = mutableListOf<Pair<String, String?>>()
    var failure: ApiError? = null

    override suspend fun remoteItems(
      libraryId: String,
      limit: Int,
      cursor: String?,
      search: String?,
      type: String?,
    ): RemoteItemsPageDto {
      cursors += cursor
      failure?.let { throw it }
      return pages[cursor ?: ""] ?: RemoteItemsPageDto()
    }

    override suspend fun remoteEpisodes(
      libraryId: String,
      itemId: String,
      limit: Int,
      cursor: String?,
    ): RemoteItemsPageDto {
      episodeRequests += itemId to cursor
      failure?.let { throw it }
      return episodePages["$itemId|${cursor ?: ""}"] ?: RemoteItemsPageDto()
    }
  }

  private fun item(id: String) = RemoteItemDto(id = id, name = id, type = "movie")

  private fun page(items: List<RemoteItemDto>, cursor: String? = null, total: Int = items.size) =
    RemoteItemsPageDto(items = items, total = total, cursor = cursor)

  private fun library() = RemoteLibraryDto(id = "rlibA", name = "Filmy", provider = "jellyfin")

  private fun state(vm: RemoteLibraryViewModel) = vm.state.current!!.state

  @Test
  fun `an append failure keeps the loaded rows and raises the append error`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.pages[""] = page(listOf(item("a")), cursor = "c1", total = 5)
    val vm = RemoteLibraryViewModel(api)
    vm.openLibrary(library())
    advanceUntilIdle()
    assertEquals(listOf("a"), state(vm).items.map { it.id })

    api.failure = ApiError(ApiFailure.Generic)
    vm.loadMore()
    advanceUntilIdle()

    assertEquals(listOf("a"), state(vm).items.map { it.id })
    assertNotNull(state(vm).appendError)
    assertNull(state(vm).error)
    // The cursor is still usable, so the viewer can ask for that same page again.
    assertTrue(state(vm).hasMore)
    assertFalse(state(vm).loadingMore)
  }

  @Test
  fun `retrying an append asks the same cursor again and adds the page`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.pages[""] = page(listOf(item("a")), cursor = "c1", total = 5)
    api.pages["c1"] = page(listOf(item("b")), total = 5)
    val vm = RemoteLibraryViewModel(api)
    vm.openLibrary(library())
    advanceUntilIdle()

    api.failure = ApiError(ApiFailure.Generic)
    vm.loadMore()
    advanceUntilIdle()
    api.failure = null
    vm.retryAppend()
    advanceUntilIdle()

    assertEquals(listOf("a", "b"), state(vm).items.map { it.id })
    assertNull(state(vm).appendError)
    // First page, then the failed attempt, then the retry -- all of them on the same cursor.
    assertEquals(listOf(null, "c1", "c1"), api.cursors)
  }

  @Test
  fun `a stale cursor is dropped and an explicit retry reloads the first page`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.pages[""] = page(listOf(item("a")), cursor = "c1", total = 5)
    val vm = RemoteLibraryViewModel(api)
    vm.openLibrary(library())
    advanceUntilIdle()

    api.failure = ApiError(ApiFailure.Generic, status = 409)
    vm.loadMore()
    advanceUntilIdle()

    assertTrue(state(vm).staleCursor)
    assertNull(state(vm).nextCursor)
    assertNull(state(vm).error)
    assertEquals(listOf("a"), state(vm).items.map { it.id })

    api.failure = null
    api.pages[""] = page(listOf(item("a"), item("x")), cursor = null, total = 2)
    vm.retry()
    advanceUntilIdle()

    assertEquals(listOf("a", "x"), state(vm).items.map { it.id })
    assertFalse(state(vm).staleCursor)
    assertEquals(listOf(null, "c1", null), api.cursors)
  }

  @Test
  fun `appending the same id twice never draws the row twice`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.pages[""] = page(listOf(item("a")), cursor = "c1", total = 5)
    api.pages["c1"] = page(listOf(item("a"), item("b")), total = 5)
    val vm = RemoteLibraryViewModel(api)
    vm.openLibrary(library())
    advanceUntilIdle()

    vm.loadMore()
    advanceUntilIdle()

    assertEquals(listOf("a", "b"), state(vm).items.map { it.id })
  }

  @Test
  fun `a first page failure with no rows is a full error`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.failure = ApiError(ApiFailure.Generic)
    val vm = RemoteLibraryViewModel(api)
    vm.openLibrary(library())
    advanceUntilIdle()

    assertEquals(RemoteErrorKind.Failed, state(vm).error)
    assertTrue(state(vm).items.isEmpty())
    assertNull(state(vm).appendError)
  }

  @Test
  fun `openSeries seeds an episodes level without browsing the library root`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.episodePages["s1|"] = page(listOf(RemoteItemDto(id = "e1", name = "Pilot", type = "episode", season = 1, episode = 1)))
    val vm = RemoteLibraryViewModel(api)

    vm.openSeries("rlibA", "Filmy", "jellyfin", RemoteItemDto(id = "s1", name = "Show", type = "series"))
    advanceUntilIdle()

    assertEquals("episodes:rlibA:s1", vm.state.current!!.key)
    assertEquals(listOf("e1"), state(vm).items.map { it.id })
    assertTrue(api.cursors.isEmpty())
    assertEquals(listOf("s1" to null), api.episodeRequests)
  }
}
