package cz.stremiooffline.tv.ui.library

import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemsPageDto
import cz.stremiooffline.tv.data.RemoteLibraryApi
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.data.RemotePreviewDto
import cz.stremiooffline.tv.data.StreamDto
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.withContext
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
    /** One page per cursor; `""` stands for the first, uncursored root page. */
    val pages = mutableMapOf<String, RemoteItemsPageDto>()
    val episodePages = mutableMapOf<String, RemoteItemsPageDto>()
    /** One page per `folderId|cursor` for a nested directory. */
    val folderPages = mutableMapOf<String, RemoteItemsPageDto>()
    val cursors = mutableListOf<String?>()
    val episodeRequests = mutableListOf<Pair<String, String?>>()
    val folderRequests = mutableListOf<Pair<String, String?>>()
    /** Every browse call in order, with its full query, so a test can name the request. */
    val calls = mutableListOf<BrowseCall>()
    var failure: ApiError? = null
    val previewPages = mutableMapOf<String, List<String>>()
    val previewRequests = mutableListOf<Pair<String, String?>>()
    var previewFailure: ApiError? = null
    var previewGate: CompletableDeferred<Unit>? = null
    var previewsInFlight = 0
    var mostPreviewsAtOnce = 0
    /** Folders are never playable, so a folder flow must never ask for their sources. */
    var sourceCalls = 0

    override suspend fun remoteSources(libraryId: String, itemId: String): List<StreamDto> {
      sourceCalls++
      return emptyList()
    }

    override suspend fun remotePreview(libraryId: String, parentId: String?): RemotePreviewDto {
      previewRequests += libraryId to parentId
      previewsInFlight++
      mostPreviewsAtOnce = maxOf(mostPreviewsAtOnce, previewsInFlight)
      try {
        previewGate?.let { withContext(currentCoroutineContext()) { it.await() } }
        previewFailure?.let { throw it }
        return RemotePreviewDto(previewPages["$libraryId|${parentId ?: ""}"].orEmpty())
      } finally {
        previewsInFlight--
      }
    }

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

    override suspend fun remoteBrowse(
      libraryId: String,
      limit: Int,
      cursor: String?,
      search: String?,
      type: String?,
      parentId: String?,
      mode: String?,
      sort: String?,
      order: String?,
    ): RemoteItemsPageDto {
      calls += BrowseCall(libraryId, limit, cursor, search, type, parentId, mode)
      if (parentId != null && (type == "episode" || mode == "titles")) {
        episodeRequests += parentId to cursor
        failure?.let { throw it }
        return episodePages["$parentId|${cursor ?: ""}"] ?: RemoteItemsPageDto()
      }
      if (parentId == null) {
        cursors += cursor
        failure?.let { throw it }
        return pages[cursor ?: ""] ?: RemoteItemsPageDto()
      }
      folderRequests += parentId to cursor
      failure?.let { throw it }
      return folderPages["$parentId|${cursor ?: ""}"] ?: RemoteItemsPageDto()
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

  @Test
  fun `opening a library reads exactly one browse page, with the default limit`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.pages[""] = page(listOf(item("a")), total = 3)
    val vm = RemoteLibraryViewModel(api)

    vm.openLibrary(library())
    advanceUntilIdle()

    // One request for the first page and never a follow-up cursor: nothing is scanned ahead.
    assertEquals(1, api.calls.size)
    val call = api.calls.single()
    assertEquals(RemoteLibraryViewModel.BROWSE_LIMIT, call.limit)
    assertNull(call.parentId)
    assertNull(call.cursor)
    assertEquals(RemoteLibraryViewModel.TITLES_MODE, call.mode)
    assertEquals(listOf("a"), state(vm).items.map { it.id })
  }

  @Test
  fun `a mixed library browses folders and a movie library browses titles`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.pages[""] = page(listOf(item("a")))
    val vm = RemoteLibraryViewModel(api)

    vm.openLibrary(RemoteLibraryDto(id = "rlibA", name = "Mixed", provider = "emby", type = "mixed"))
    advanceUntilIdle()
    assertEquals(RemoteLibraryViewModel.FOLDERS_MODE, api.calls.last().mode)

    vm.openLibrary(RemoteLibraryDto(id = "rlibA", name = "Movies", provider = "emby", type = "movie"))
    advanceUntilIdle()
    assertEquals(RemoteLibraryViewModel.TITLES_MODE, api.calls.last().mode)

    // An explicit browseMode wins over the type-derived default.
    vm.openLibrary(RemoteLibraryDto(id = "rlibA", name = "Mixed", provider = "emby", type = "mixed", browseMode = "titles"))
    advanceUntilIdle()
    assertEquals(RemoteLibraryViewModel.TITLES_MODE, api.calls.last().mode)
  }

  @Test
  fun `a folder level keeps its opaque parent id and never asks for sources`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.pages[""] = page(listOf(RemoteItemDto(id = "f1", name = "Shows", type = "folder")))
    api.folderPages["f1|"] = page(listOf(RemoteItemDto(id = "f2", name = "Season 1", type = "folder")))
    api.folderPages["f2|"] = page(listOf(item("movie1")))
    val vm = RemoteLibraryViewModel(api)
    vm.openLibrary(RemoteLibraryDto(id = "rlibA", name = "Mixed", provider = "emby", type = "mixed"))
    advanceUntilIdle()

    val folder = state(vm).items.single()
    vm.openFolder(folder)
    advanceUntilIdle()
    val second = state(vm).items.single()
    vm.openFolder(second)
    advanceUntilIdle()

    // Two nested directory levels, each with its own opaque parent and the folders mode.
    assertEquals(listOf("dir:rlibA:root:folders", "dir:rlibA:f1:folders", "dir:rlibA:f2:folders"), vm.state.levels.map { it.key })
    assertEquals("f1", (vm.state.levels[1] as RemoteLevel.Directory).parentId)
    assertEquals("f2", (vm.state.levels[2] as RemoteLevel.Directory).parentId)
    assertEquals("f2", api.calls.last().parentId)
    assertEquals(RemoteLibraryViewModel.FOLDERS_MODE, api.calls.last().mode)
    assertEquals(listOf("movie1"), state(vm).items.map { it.id })
    // A folder is navigable, never playable: no source lookup ever ran.
    assertEquals(0, api.sourceCalls)
  }

  @Test
  fun `a folder level keeps its folders rather than flattening them`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.pages[""] = page(listOf(RemoteItemDto(id = "f1", name = "Shows", type = "folder")))
    api.folderPages["f1|"] = page(
      listOf(
        RemoteItemDto(id = "f2", name = "Season 1", type = "folder"),
        RemoteItemDto(id = "m1", name = "Film", type = "movie"),
      ),
    )
    val vm = RemoteLibraryViewModel(api)
    vm.openLibrary(RemoteLibraryDto(id = "rlibA", name = "Mixed", provider = "emby", type = "mixed"))
    advanceUntilIdle()
    vm.openFolder(state(vm).items.single())
    advanceUntilIdle()

    // In folders mode the hierarchy survives: the child folder and the media stay side by side.
    assertEquals(listOf("f2", "m1"), state(vm).items.map { it.id })
  }

  @Test
  fun `a folders filter keeps the folders and narrows only the media`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.pages[""] = page(listOf(RemoteItemDto(id = "f1", name = "Shows", type = "folder")))
    api.folderPages["f1|"] = page(
      listOf(
        RemoteItemDto(id = "f2", name = "Season 1", type = "folder"),
        RemoteItemDto(id = "m1", name = "Film", type = "movie"),
        RemoteItemDto(id = "s9", name = "Show", type = "series"),
      ),
    )
    val vm = RemoteLibraryViewModel(api)
    vm.openLibrary(RemoteLibraryDto(id = "rlibA", name = "Mixed", provider = "emby", type = "mixed"))
    advanceUntilIdle()
    vm.openFolder(state(vm).items.single())
    advanceUntilIdle()

    vm.filter(RemoteTypeFilter.Movies)
    advanceUntilIdle()

    // The folder survives the filter and only the movie stays beside it: the tree is not flattened.
    assertEquals(listOf("f2", "m1"), state(vm).items.map { it.id })
    assertEquals("movie", api.calls.last().type)
  }

  @Test
  fun `paging is never eager and a search resets to the first cursor`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.pages[""] = page(listOf(item("a")), cursor = "c1", total = 5)
    api.pages["c1"] = page(listOf(item("b")), total = 5)
    val vm = RemoteLibraryViewModel(api)
    vm.openLibrary(library())
    advanceUntilIdle()

    // The first page named a cursor but the client did not follow it on its own.
    assertEquals(listOf<String?>(null), api.calls.map { it.cursor })
    vm.search("film")
    advanceUntilIdle()
    assertEquals(listOf<String?>(null, null), api.calls.map { it.cursor })
    assertEquals("film", api.calls.last().search)
  }

  @Test
  fun `a library with the mosaic off never asks for a preview`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.pages[""] = page(listOf(RemoteItemDto(id = "f1", name = "Shows", type = "folder")))
    val vm = RemoteLibraryViewModel(api)
    vm.openLibrary(RemoteLibraryDto(id = "rlibA", name = "Mixed", provider = "emby", type = "mixed", mosaic = false))
    advanceUntilIdle()

    vm.loadPreview("rlibA|f1", "rlibA", "f1", mosaic = false)
    advanceUntilIdle()
    assertTrue(api.previewRequests.isEmpty())
  }

  @Test
  fun `the preview cache dedupes and at most two load at once`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.previewGate = CompletableDeferred()
    val vm = RemoteLibraryViewModel(api)

    vm.loadPreview("rlibA|", "rlibA", null, mosaic = true)
    vm.loadPreview("rlibA|", "rlibA", null, mosaic = true)
    vm.loadPreview("rlibA|f1", "rlibA", "f1", mosaic = true)
    vm.loadPreview("rlibA|f2", "rlibA", "f2", mosaic = true)
    advanceUntilIdle()

    // The repeat of the first key was deduped, and only two of the three distinct requests left.
    assertEquals(2, api.previewRequests.size)
    assertEquals(2, api.mostPreviewsAtOnce)

    api.previewGate!!.complete(Unit)
    advanceUntilIdle()
    assertEquals(3, api.previewRequests.size)
    assertEquals(2, api.mostPreviewsAtOnce)
  }

  @Test
  fun `leaving the half cancels an in-flight preview and a return asks again`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.previewGate = CompletableDeferred()
    val vm = RemoteLibraryViewModel(api)

    vm.loadPreview("rlibA|", "rlibA", null, mosaic = true)
    advanceUntilIdle()
    assertEquals(1, api.previewRequests.size)

    // Leaving the half drops the half-finished load; its late answer never lands.
    vm.onHidden()
    api.previewGate!!.complete(Unit)
    advanceUntilIdle()
    assertNull(vm.preview("rlibA|"))

    vm.loadPreview("rlibA|", "rlibA", null, mosaic = true)
    advanceUntilIdle()
    assertEquals(2, api.previewRequests.size)
    assertEquals(RemotePreviewState.Ready(emptyList()), vm.preview("rlibA|"))
  }

  @Test
  fun `a failed preview leaves a settled failure the tile can fall back on`() = runTest(dispatcher) {
    val api = FakeRemoteApi()
    api.previewFailure = ApiError(ApiFailure.Generic)
    val vm = RemoteLibraryViewModel(api)

    vm.loadPreview("rlibA|", "rlibA", null, mosaic = true)
    advanceUntilIdle()

    assertEquals(RemotePreviewState.Failed, vm.preview("rlibA|"))
    vm.loadPreview("rlibA|", "rlibA", null, mosaic = true)
    advanceUntilIdle()
    // A settled failure is not retried on every recomposition.
    assertEquals(1, api.previewRequests.size)
  }
}

/** One browse call, with the query it carried. */
data class BrowseCall(
  val libraryId: String,
  val limit: Int,
  val cursor: String?,
  val search: String?,
  val type: String?,
  val parentId: String?,
  val mode: String?,
)
