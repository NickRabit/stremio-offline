package cz.stremiooffline.tv.ui.library

import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.ui.FakeTvApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
      override suspend fun browse(path: String?, limit: Int, skip: Int, query: String): BrowseResult {
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
  fun `a nonempty pending page is shown at once and its composed mosaic arrives in the background`() = runTest(dispatcher) {
    var call = 0
    val api = object : FakeTvApi() {
      override suspend fun browse(path: String?, limit: Int, skip: Int, query: String): BrowseResult {
        call++
        val poster = if (call == 1) null else "/api/library/mosaic?dir=lib_1&v=ready"
        return BrowseResult(
          path.orEmpty(),
          listOf(BrowseItem.Library(path = "lib_1", name = "Films", mosaicImage = poster)),
          1,
          pending = call == 1,
        )
      }
    }
    val viewModel = LibraryViewModel(api, pendingDelayMs = 1L)
    viewModel.selectedPath = "lib_1"

    viewModel.start()
    runCurrent()

    assertEquals(1, call)
    assertFalse(viewModel.state.loading)
    assertEquals(listOf("lib_1"), viewModel.state.current!!.items.map { it.path })
    assertEquals(null, (viewModel.state.current!!.items.single() as BrowseItem.Library).mosaicImage)

    advanceTimeBy(1)
    runCurrent()

    assertEquals(2, call)
    assertEquals(
      "/api/library/mosaic?dir=lib_1&v=ready",
      (viewModel.state.current!!.items.single() as BrowseItem.Library).mosaicImage,
    )
    assertEquals("lib_1", viewModel.selectedPath)
  }

  @Test
  fun `navigating away cancels a pending artwork refresh before it can touch the new level`() = runTest(dispatcher) {
    var rootCalls = 0
    val api = object : FakeTvApi() {
      override suspend fun browse(path: String?, limit: Int, skip: Int, query: String): BrowseResult {
        if (path == "lib_1") return BrowseResult(path, listOf(folder("lib_1/Films", "Films")), 1, false)
        rootCalls++
        return BrowseResult(
          "",
          listOf(BrowseItem.Library(path = "lib_1", name = "Films", mosaicImage = null)),
          1,
          pending = true,
        )
      }
    }
    val viewModel = LibraryViewModel(api, pendingDelayMs = 1L)
    viewModel.start()
    runCurrent()
    assertEquals(1, rootCalls)

    viewModel.open("lib_1", "Films")
    advanceUntilIdle()

    assertEquals(2, viewModel.state.pages.size)
    assertEquals("lib_1", viewModel.state.current!!.path)
    assertEquals(listOf("Films"), viewModel.state.current!!.items.map { it.title })
    assertEquals(1, rootCalls)
  }

  @Test
  fun `pending artwork polling is bounded and keeps the last usable rows`() = runTest(dispatcher) {
    var calls = 0
    val api = object : FakeTvApi() {
      override suspend fun browse(path: String?, limit: Int, skip: Int, query: String): BrowseResult {
        calls++
        return BrowseResult(
          path.orEmpty(),
          listOf(BrowseItem.Library(path = "lib_1", name = "Films", mosaicImage = null)),
          1,
          pending = true,
        )
      }
    }
    val viewModel = LibraryViewModel(api, pendingDelayMs = 1L)
    viewModel.start()
    advanceUntilIdle()

    assertEquals(9, calls)
    assertEquals(listOf("lib_1"), viewModel.state.current!!.items.map { it.path })
  }

  @Test
  fun `paging while artwork is pending cannot let stale jobs touch a new root`() = runTest(dispatcher) {
    val pollGate = CompletableDeferred<Unit>()
    val pageGate = CompletableDeferred<Unit>()
    var calls = 0
    val api = object : FakeTvApi() {
      override suspend fun browse(path: String?, limit: Int, skip: Int, query: String): BrowseResult {
        calls++
        return when (calls) {
          1 -> BrowseResult(
            "",
            listOf(BrowseItem.Library(path = "Films", name = "Films", mosaicImage = null)),
            2,
            pending = true,
          )
          2 -> {
            withContext(NonCancellable) { pollGate.await() }
            BrowseResult(
              "",
              listOf(BrowseItem.Library(path = "Films", name = "Films", mosaicImage = "/new.jpg")),
              2,
              pending = true,
            )
          }
          3 -> {
            withContext(NonCancellable) { pageGate.await() }
            BrowseResult("", listOf(BrowseItem.Library(path = "Films/page", name = "Page")), 2, pending = true)
          }
          else -> BrowseResult("", listOf(BrowseItem.Library(path = "Shows", name = "Shows")), 1, pending = false)
        }
      }
    }
    val viewModel = LibraryViewModel(api, pendingDelayMs = 1L)
    viewModel.start()
    runCurrent()
    advanceTimeBy(1)
    runCurrent()
    assertEquals(2, calls)

    viewModel.loadMore()
    runCurrent()
    assertEquals(3, calls)
    viewModel.start()
    runCurrent()
    assertEquals(listOf("Shows"), viewModel.state.current!!.items.map { it.path })

    pollGate.complete(Unit)
    pageGate.complete(Unit)
    advanceUntilIdle()

    assertEquals(listOf("Shows"), viewModel.state.current!!.items.map { it.path })
    assertEquals(1, viewModel.state.pages.size)
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

  @Test
  fun `a failed deep link settles its loading state and keeps the target level`() = runTest(dispatcher) {
    val api = object : FakeTvApi() {
      override suspend fun browse(path: String?, limit: Int, skip: Int, query: String): BrowseResult {
        if (path == null) return BrowseResult("", listOf(folder("Films", "Films")), 1, false)
        throw ApiError(ApiFailure.Unreachable)
      }
    }
    val viewModel = LibraryViewModel(api)

    viewModel.openHere("Films/It", "It")
    advanceUntilIdle()

    assertFalse(viewModel.state.loading)
    assertTrue(viewModel.state.error)
    assertEquals("Films/It", viewModel.state.current!!.path)
    assertEquals(2, viewModel.state.pages.size)
  }

  // Found in review: Back while a nested level was still loading wrote its items into the parent.
  @Test
  fun `back while a nested level loads keeps the parent's items`() = runTest(dispatcher) {
    val api = object : FakeTvApi() {
      override suspend fun browse(path: String?, limit: Int, skip: Int, query: String): BrowseResult {
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

  @Test
  fun `a committed search narrows the level and is kept by its retry, refresh and paging`() = runTest(dispatcher) {
    val api = FakeTvApi()
    api.pages["Shows"] = BrowseResult("Shows", listOf(folder("Shows/S1", "S1")), 1, false)
    api.browseQueries["Shows|S1"] = BrowseResult("Shows", listOf(folder("Shows/S1", "S1")), 3, false)

    val viewModel = LibraryViewModel(api)
    viewModel.open("Shows", "Shows")
    advanceUntilIdle()
    assertEquals(listOf("Shows"), api.browseRequests.map { it.path })

    viewModel.search("S1")
    advanceUntilIdle()

    assertEquals("S1", viewModel.state.current!!.search)
    assertEquals("S1", api.browseRequests.last().query)

    viewModel.retry()
    advanceUntilIdle()
    assertEquals("S1", api.browseRequests.last().query)

    viewModel.refresh()
    advanceUntilIdle()
    assertEquals("S1", api.browseRequests.last().query)

    // The narrowed level holds three rows and shows one, so a page is still owed.
    viewModel.loadMore()
    advanceUntilIdle()
    val pages = api.browseRequests.filter { it.skip > 0 }
    assertTrue("paging keeps the committed query", pages.isNotEmpty() && pages.all { it.query == "S1" })
  }

  @Test
  fun `a child level starts without the parent's search and back keeps the parent's own list`() = runTest(dispatcher) {
    val api = FakeTvApi()
    api.browseQueries["Shows|S1"] = BrowseResult("Shows", listOf(folder("Shows/S1", "S1")), 1, false)
    api.pages["Shows/S1"] = BrowseResult("Shows/S1", listOf(folder("Shows/S1/E1", "E1")), 1, false)

    val viewModel = LibraryViewModel(api)
    viewModel.open("Shows", "Shows")
    advanceUntilIdle()
    viewModel.search("S1")
    advanceUntilIdle()
    val narrowed = viewModel.state.current!!.items

    viewModel.open("Shows/S1", "S1")
    advanceUntilIdle()

    assertEquals("", viewModel.state.current!!.search)
    assertEquals("", api.browseRequests.last().query)

    assertTrue(viewModel.back())
    // The parent keeps the rows its own search answered with, and that search is still committed.
    assertEquals(narrowed, viewModel.state.current!!.items)
    assertEquals("S1", viewModel.state.current!!.search)
  }

  @Test
  fun `a query whose first read fails is kept for its retry`() = runTest(dispatcher) {
    val queries = mutableListOf<String>()
    val api = object : FakeTvApi() {
      override suspend fun browse(path: String?, limit: Int, skip: Int, query: String): BrowseResult {
        queries += query
        if (query.isNotEmpty() && queries.count { it == query } == 1) throw ApiError(ApiFailure.Generic)
        return if (query.isEmpty()) {
          BrowseResult(path.orEmpty(), listOf(folder("Shows", "Shows")), 1, false)
        } else {
          BrowseResult(path.orEmpty(), listOf(folder("Shows/S1", "S1")), 1, false)
        }
      }
    }
    val viewModel = LibraryViewModel(api)
    viewModel.open("Shows", "Shows")
    advanceUntilIdle()

    viewModel.search("S1")
    advanceUntilIdle()

    // The failed read leaves the level narrowed by exactly the query the viewer committed.
    assertTrue(viewModel.state.error)
    assertEquals("S1", viewModel.state.current!!.search)
    assertTrue("an empty level stays searchable", viewModel.state.current!!.searchable)

    viewModel.retry()
    advanceUntilIdle()

    assertEquals(listOf("S1", "S1"), queries.takeLast(2))
    assertEquals(listOf("S1"), viewModel.state.current!!.items.map { it.title })
    assertFalse(viewModel.state.error)
  }

  @Test
  fun `a library search on the shared engine leaves the browsed level untouched`() = runTest(dispatcher) {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(folder("Shows", "Shows")), 1, false)
    api.pages["Shows"] = BrowseResult("Shows", listOf(folder("Shows/S1", "S1")), 1, false)
    val readsBefore = api.browseRequests.size
    val viewModel = LibraryViewModel(api)
    viewModel.open("Shows", "Shows")
    advanceUntilIdle()
    assertEquals(readsBefore + 1, api.browseRequests.size)

    viewModel.setSearchEngine(true)
    viewModel.search("S1")
    advanceUntilIdle()

    assertEquals("S1", viewModel.state.current!!.search)
    assertEquals(readsBefore + 1, api.browseRequests.size)
    assertEquals(listOf("Shows/S1"), viewModel.state.current!!.items.map { it.path })
  }

  @Test
  fun `a root listing the libraries is not searchable`() = runTest(dispatcher) {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult(
      "",
      listOf(
        BrowseItem.Library(path = "lib_1", name = "Films", fileCount = 3),
        BrowseItem.Library(path = "lib_2", name = "Shows", fileCount = 4),
      ),
      2,
      false,
    )

    val viewModel = LibraryViewModel(api)
    viewModel.start()
    advanceUntilIdle()

    assertFalse(viewModel.state.current!!.searchable)
  }

  @Test
  fun `a refresh keeps the rows a level had already paged`() = runTest(dispatcher) {
    val first = (1..60).map { folder("Shows/F$it", "F$it") }
    val tail = (61..72).map { folder("Shows/F$it", "F$it") }
    val requests = mutableListOf<Triple<String?, Int, String>>()
    val api = object : FakeTvApi() {
      override suspend fun browse(path: String?, limit: Int, skip: Int, query: String): BrowseResult {
        requests += Triple(path, skip, query)
        val all = first + tail
        return BrowseResult(path.orEmpty(), all.drop(skip).take(limit), all.size, false)
      }
    }
    val viewModel = LibraryViewModel(api)
    viewModel.open("Shows", "Shows")
    advanceUntilIdle()
    viewModel.loadMore()
    advanceUntilIdle()
    assertEquals(72, viewModel.state.current!!.items.size)
    viewModel.selectedPath = "Shows/F70"
    val reads = requests.size

    // A return from a detail re-reads the first page only: the level's own tail stays where it was,
    // and the library is not walked to rebuild it.
    viewModel.refresh()
    advanceUntilIdle()

    val page = viewModel.state.current!!
    assertEquals(reads + 1, requests.size)
    assertEquals(0, requests.last().second)
    assertEquals(72, page.items.size)
    assertEquals(72, page.items.map { it.path }.distinct().size)
    assertTrue("the selected row is still there", page.items.any { it.path == "Shows/F70" })
    assertEquals("Shows/F70", viewModel.selectedPath)
    assertEquals(72, page.total)
  }

  @Test
  fun `a refresh clamps a shrunken level and keeps its first page fresh`() = runTest(dispatcher) {
    var grown = true
    val api = object : FakeTvApi() {
      override suspend fun browse(path: String?, limit: Int, skip: Int, query: String): BrowseResult {
        if (grown) {
          val all = (1..72).map { folder("Shows/F$it", "F$it") }
          return BrowseResult(path.orEmpty(), all.drop(skip).take(limit), all.size, false)
        }
        // The refresh finds the level shorter than the rows the viewer had already scrolled to.
        return BrowseResult(path.orEmpty(), listOf(folder("Shows/F1", "F1 renamed")), 1, false)
      }
    }
    val viewModel = LibraryViewModel(api)
    viewModel.open("Shows", "Shows")
    advanceUntilIdle()
    viewModel.loadMore()
    advanceUntilIdle()
    assertEquals(72, viewModel.state.current!!.items.size)

    grown = false
    viewModel.refresh()
    advanceUntilIdle()

    val page = viewModel.state.current!!
    assertEquals(listOf("F1 renamed"), page.items.map { it.title })
    assertEquals(1, page.total)
  }
}
