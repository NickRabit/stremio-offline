package cz.stremiooffline.tv.ui.library

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.LibraryApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/** One level of the library grid: its path, the breadcrumb title, the query it is narrowed by and
 *  the rows loaded so far. A level keeps its own committed search, so going into a title and coming
 *  back lands on the parent's own list rather than on everything under it. */
data class LibraryPage(
  val path: String,
  val title: String,
  val items: List<BrowseItem> = emptyList(),
  val total: Int = 0,
  val search: String = "",
  /** Whether this level can be narrowed at all. The library root with more than one library
   *  configured lists the libraries themselves, which the server never filters; every other level
   *  is a directory and stays searchable even while it is loading, empty or broken. */
  val searchable: Boolean = false,
)

data class LibraryState(
  val pages: List<LibraryPage> = emptyList(),
  val loading: Boolean = false,
  val loadingMore: Boolean = false,
  val error: Boolean = false,
) {
  val current: LibraryPage? get() = pages.lastOrNull()
}

/** The library tree: the root, a stack of nested folders, paging and the error state. */
class LibraryViewModel(
  private val api: LibraryApi,
  private val pendingDelayMs: Long = PENDING_DELAY_MS,
) : ViewModel() {

  var state by mutableStateOf(LibraryState(loading = true))
    private set

  /** The card the grid last focused, kept across a section swap. */
  var selectedPath by mutableStateOf("")

  private var job: Job? = null
  private var pollJob: Job? = null
  private var requestEpoch = 0
  private var deepLinked = false
  private var searchEngine = false

  /** True while the section is showing a folder a Home card asked for, not the library root. */
  val needsRootReset: Boolean get() = deepLinked

  fun setSearchEngine(enabled: Boolean) {
    searchEngine = enabled
  }

  fun start() {
    deepLinked = false
    cancelRequests()
    state = LibraryState(pages = listOf(LibraryPage(path = "", title = "")), loading = true)
    val mine = requestEpoch
    job = viewModelScope.launch { load(null, "", mine) }
  }

  fun open(path: String, title: String) {
    cancelRequests()
    // A library card was opened: whatever the next answer holds, this level is a real directory.
    state = state.copy(pages = state.pages + LibraryPage(path, title, searchable = true), loading = true, error = false)
    val mine = requestEpoch
    job = viewModelScope.launch { load(path, "", mine) }
  }

  /** Opens a folder a Home card asked for, on top of the library root so Back leaves the folder. */
  fun openHere(path: String, title: String) {
    cancelRequests()
    deepLinked = true
    val root = state.pages.firstOrNull() ?: LibraryPage(path = "", title = "")
    state = state.copy(pages = listOf(root, LibraryPage(path, title, searchable = true)), loading = true, error = false)
    val mine = requestEpoch
    job = viewModelScope.launch {
      val rootRead = readOrNull(null, 0, root.search)
      requireCurrent(mine)
      if (rootRead != null) {
        applyPage(0, rootRead.page, mergeTail = false)
      }
      val pageRead = readOrNull(path, 0, "")
      requireCurrent(mine)
      if (pageRead != null) {
        applyPage(1, pageRead.page, mergeTail = false)
      }
      state = state.copy(loading = false, error = pageRead == null)
      pollJob = viewModelScope.launch {
        pageRead?.let { pollPending(1, path, "", it, mine) }
        rootRead?.let { pollPending(0, null, root.search, it, mine) }
      }
    }
  }

  /** Pushes a level whose rows were already fetched, so a folder is not browsed twice. */
  fun push(path: String, title: String, items: List<BrowseItem>, total: Int) {
    cancelRequests()
    state = state.copy(
      pages = state.pages + LibraryPage(path, title, items, total, searchable = true),
      loading = false,
      error = false,
    )
  }

  fun retry() {
    val page = state.current ?: return
    cancelRequests()
    state = state.copy(loading = true, error = false)
    val mine = requestEpoch
    job = viewModelScope.launch { load(page.path.ifEmpty { null }, page.search, mine) }
  }

  /** Re-reads the level on screen in the background: the old rows stay until the answer lands. */
  fun refresh() {
    val page = state.current ?: return
    if (state.loading || state.loadingMore) return
    val index = state.pages.lastIndex
    cancelRequests()
    val mine = requestEpoch
    job = viewModelScope.launch {
      val read = readOrNull(page.path.ifEmpty { null }, 0, page.search) ?: return@launch
      requireCurrent(mine)
      applyPage(index, read.page, mergeTail = true)
      pollJob = viewModelScope.launch {
        pollPending(index, page.path.ifEmpty { null }, page.search, read, mine)
      }
    }
  }

  /**
   * Commits one search to the level on screen: the server narrows the level itself, so the page
   * starts again from its first row. An empty query clears the narrowing. The query is remembered
   * by the level, so a retry, a refresh or paging keeps it, and a child level starts without it.
   */
  fun search(query: String) {
    val page = state.current ?: return
    val wanted = query.trim()
    if (page.search == wanted) return
    cancelRequests()
    // The level is narrowed from the moment the viewer commits the query, not from the moment the
    // answer lands: a failed first read leaves the level searching for exactly this query, so its
    // Retry, its refresh and its paging all carry it, and the search can still be cleared.
    val depth = state.pages.size
    state = state.copy(loading = true, error = false, loadingMore = false)
    update(depth) { it.copy(search = wanted) }
    if (searchEngine) {
      state = state.copy(loading = false)
      return
    }
    val mine = requestEpoch
    job = viewModelScope.launch { load(page.path.ifEmpty { null }, wanted, mine) }
  }

  /** True while there is a level to go back to. */
  fun back(): Boolean {
    if (state.pages.size <= 1) return false
    // A level that is still loading or paging must not land in its parent once it is gone.
    cancelRequests()
    state = state.copy(pages = state.pages.dropLast(1), loading = false, loadingMore = false, error = false)
    return true
  }

  fun loadMore() {
    val page = state.current ?: return
    if (state.loading || state.loadingMore || page.items.size >= page.total) return
    state = state.copy(loadingMore = true)
    val depth = state.pages.size
    val mine = requestEpoch
    job = viewModelScope.launch {
      try {
        val next = readPage(page.path.ifEmpty { null }, page.items.size, page.search)
        requireCurrent(mine)
        update(depth) { it.copy(items = it.items + next.items, total = next.total.coerceAtLeast(it.total)) }
      } catch (_: ApiError) {
      } finally {
        if (mine == requestEpoch) state = state.copy(loadingMore = false)
      }
    }
  }

  private data class PageRead(val page: BrowsePage, val attempts: Int)

  private suspend fun readPage(path: String?, skip: Int, query: String): BrowsePage =
    api.browse(path, limit = PAGE, skip = skip, query = query).let {
      BrowsePage(it.path, it.items, it.total, it.pending)
    }

  private suspend fun readOrNull(path: String?, skip: Int, query: String): PageRead? = try {
    readInitial(path, skip, query)
  } catch (cancelled: CancellationException) {
    throw cancelled
  } catch (_: ApiError) {
    null
  }

  /** A nonempty pending page is published at once; only an empty one keeps the first load busy. */
  private suspend fun readInitial(path: String?, skip: Int, query: String): PageRead {
    var read = PageRead(readPage(path, skip, query), 0)
    while (read.page.pending && read.page.items.isEmpty() && read.attempts < PENDING_RETRIES) {
      delay(pendingDelay(read.attempts))
      read = PageRead(readPage(path, skip, query), read.attempts + 1)
    }
    return read
  }

  private suspend fun pollPending(
    index: Int,
    path: String?,
    query: String,
    initial: PageRead,
    mine: Int,
  ) {
    var page = initial.page
    var attempts = initial.attempts
    while (page.pending && attempts < PENDING_RETRIES) {
      delay(pendingDelay(attempts))
      attempts += 1
      val read = try {
        readPage(path, 0, query)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        return
      }
      requireCurrent(mine)
      page = read
      applyPage(index, page, mergeTail = true)
    }
  }

  private fun pendingDelay(attempt: Int): Long {
    val factor = 1L shl attempt.coerceIn(0, 4)
    return minOf(PENDING_MAX_DELAY_MS, pendingDelayMs * factor)
  }

  private fun applyPage(index: Int, page: BrowsePage, mergeTail: Boolean) {
    updateAt(index) { current ->
      val items = if (mergeTail) {
        val headPaths = page.items.mapTo(HashSet()) { it.path }
        val tail = current.items.filterNot { item -> item.path in headPaths }
        (page.items + tail).take(maxOf(page.items.size, page.total))
      } else {
        page.items
      }
      current.copy(path = page.path, items = items, total = page.total)
    }
  }

  private suspend fun load(path: String?, query: String, mine: Int) {
    val index = state.pages.lastIndex
    try {
      val read = readInitial(path, 0, query)
      requireCurrent(mine)
      applyPage(index, read.page, mergeTail = false)
      updateAt(index) {
        it.copy(
          search = query,
          // The libraries themselves are all a multi-library root lists, and the server narrows
          // nothing there; every other level is a directory and stays searchable, empty or broken.
          searchable = read.page.items.none { item -> item is BrowseItem.Library },
        )
      }
      state = state.copy(loading = false, error = false)
      pollJob = viewModelScope.launch {
        pollPending(index, path, query, read, mine)
      }
    } catch (_: ApiError) {
      if (mine == requestEpoch) state = state.copy(loading = false, error = true)
    }
  }

  /** Applies an answer to the level it was asked for; a level the user has since left is skipped. */
  private fun update(depth: Int, transform: (LibraryPage) -> LibraryPage) {
    if (state.pages.isEmpty() || state.pages.size != depth) return
    val pages = state.pages.toMutableList()
    pages[pages.lastIndex] = transform(pages.last())
    state = state.copy(pages = pages)
  }

  /** Applies an answer to the level it was asked for, wherever it sits in the stack. */
  private fun updateAt(index: Int, transform: (LibraryPage) -> LibraryPage) {
    if (index !in state.pages.indices) return
    val pages = state.pages.toMutableList()
    pages[index] = transform(pages[index])
    state = state.copy(pages = pages)
  }

  private fun cancelRequests() {
    requestEpoch++
    job?.cancel()
    job = null
    pollJob?.cancel()
    pollJob = null
  }

  private suspend fun requireCurrent(mine: Int) {
    currentCoroutineContext().ensureActive()
    if (mine != requestEpoch) throw CancellationException("Library request was replaced")
  }

  companion object {
    const val PAGE = 60
    private const val PENDING_RETRIES = 8
    private const val PENDING_DELAY_MS = 1_500L
    private const val PENDING_MAX_DELAY_MS = 8_000L

    fun factory(api: LibraryApi, pendingDelayMs: Long = PENDING_DELAY_MS) =
      viewModelFactory { initializer { LibraryViewModel(api, pendingDelayMs) } }
  }
}

private data class BrowsePage(val path: String, val items: List<BrowseItem>, val total: Int, val pending: Boolean)
