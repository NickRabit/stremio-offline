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
import kotlinx.coroutines.delay
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
  private var deepLinked = false

  /** True while the section is showing a folder a Home card asked for, not the library root. */
  val needsRootReset: Boolean get() = deepLinked

  fun start() {
    deepLinked = false
    job?.cancel()
    state = LibraryState(pages = listOf(LibraryPage(path = "", title = "")), loading = true)
    job = viewModelScope.launch { load(null, "") }
  }

  fun open(path: String, title: String) {
    job?.cancel()
    // A library card was opened: whatever the next answer holds, this level is a real directory.
    state = state.copy(pages = state.pages + LibraryPage(path, title, searchable = true), loading = true, error = false)
    job = viewModelScope.launch { load(path, "") }
  }

  /** Opens a folder a Home card asked for, on top of the library root so Back leaves the folder. */
  fun openHere(path: String, title: String) {
    job?.cancel()
    deepLinked = true
    val root = state.pages.firstOrNull() ?: LibraryPage(path = "", title = "")
    state = state.copy(pages = listOf(root, LibraryPage(path, title, searchable = true)), loading = true, error = false)
    job = viewModelScope.launch {
      val rootPage = pageOrNull(null, 0, root.search)
      if (rootPage != null) updateAt(0) { it.copy(path = rootPage.path, items = rootPage.items, total = rootPage.total) }
      val page = pageOrNull(path, 0, "")
      if (page != null) updateAt(1) { it.copy(path = page.path, items = page.items, total = page.total) }
      state = state.copy(loading = false, error = page == null)
    }
  }

  /** Pushes a level whose rows were already fetched, so a folder is not browsed twice. */
  fun push(path: String, title: String, items: List<BrowseItem>, total: Int) {
    job?.cancel()
    state = state.copy(
      pages = state.pages + LibraryPage(path, title, items, total, searchable = true),
      loading = false,
      error = false,
    )
  }

  fun retry() {
    val page = state.current ?: return
    job?.cancel()
    state = state.copy(loading = true, error = false)
    job = viewModelScope.launch { load(page.path.ifEmpty { null }, page.search) }
  }

  /** Re-reads the level on screen in the background: the old rows stay until the answer lands. */
  fun refresh() {
    val page = state.current ?: return
    if (state.loading || state.loadingMore) return
    val depth = state.pages.size
    job?.cancel()
    job = viewModelScope.launch {
      val next = pageOrNull(page.path.ifEmpty { null }, 0, page.search) ?: return@launch
      update(depth) { current ->
        // A level the viewer had paged keeps the rows they had already scrolled to: the first page
        // is re-read (a star or a stored position may have moved) and every row beyond it stays,
        // deduped by path and clamped to what the level now holds.
        val head = next.items
        val headPaths = head.mapTo(HashSet()) { it.path }
        val tail = current.items.filterNot { item -> item.path in headPaths }
        val merged = (head + tail).take(maxOf(head.size, next.total))
        current.copy(path = next.path, items = merged, total = next.total)
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
    job?.cancel()
    // The level is narrowed from the moment the viewer commits the query, not from the moment the
    // answer lands: a failed first read leaves the level searching for exactly this query, so its
    // Retry, its refresh and its paging all carry it, and the search can still be cleared.
    val depth = state.pages.size
    state = state.copy(loading = true, error = false, loadingMore = false)
    update(depth) { it.copy(search = wanted) }
    job = viewModelScope.launch { load(page.path.ifEmpty { null }, wanted) }
  }

  /** True while there is a level to go back to. */
  fun back(): Boolean {
    if (state.pages.size <= 1) return false
    // A level that is still loading or paging must not land in its parent once it is gone.
    job?.cancel()
    state = state.copy(pages = state.pages.dropLast(1), loading = false, loadingMore = false, error = false)
    return true
  }

  fun loadMore() {
    val page = state.current ?: return
    if (state.loading || state.loadingMore || page.items.size >= page.total) return
    state = state.copy(loadingMore = true)
    val depth = state.pages.size
    job = viewModelScope.launch {
      try {
        val next = loadPage(page.path.ifEmpty { null }, page.items.size, page.search)
        update(depth) { it.copy(items = it.items + next.items, total = next.total.coerceAtLeast(it.total)) }
      } catch (_: ApiError) {
      } finally {
        state = state.copy(loadingMore = false)
      }
    }
  }

  /** The server answers before its first walk of a library has finished; an empty pending page
   *  is asked again instead of being shown as empty. */
  private suspend fun loadPage(path: String?, skip: Int, query: String): BrowsePage {
    var page = api.browse(path, limit = PAGE, skip = skip, query = query)
    var attempts = 0
    while (page.pending && page.items.isEmpty() && attempts++ < PENDING_RETRIES) {
      delay(pendingDelayMs)
      page = api.browse(path, limit = PAGE, skip = skip, query = query)
    }
    return BrowsePage(page.path, page.items, page.total)
  }

  private suspend fun pageOrNull(path: String?, skip: Int, query: String): BrowsePage? = try {
    loadPage(path, skip, query)
  } catch (cancelled: CancellationException) {
    throw cancelled
  } catch (_: ApiError) {
    null
  }

  private suspend fun load(path: String?, query: String) {
    val depth = state.pages.size
    try {
      val page = loadPage(path, 0, query)
      update(depth) {
        it.copy(
          path = page.path,
          items = page.items,
          total = page.total,
          search = query,
          // The libraries themselves are all a multi-library root lists, and the server narrows
          // nothing there; every other level is a directory and stays searchable, empty or broken.
          searchable = page.items.none { item -> item is BrowseItem.Library },
        )
      }
      state = state.copy(loading = false, error = false)
    } catch (_: ApiError) {
      state = state.copy(loading = false, error = true)
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

  companion object {
    const val PAGE = 60
    private const val PENDING_RETRIES = 5
    private const val PENDING_DELAY_MS = 1_500L

    fun factory(api: LibraryApi, pendingDelayMs: Long = PENDING_DELAY_MS) =
      viewModelFactory { initializer { LibraryViewModel(api, pendingDelayMs) } }
  }
}

private data class BrowsePage(val path: String, val items: List<BrowseItem>, val total: Int)
