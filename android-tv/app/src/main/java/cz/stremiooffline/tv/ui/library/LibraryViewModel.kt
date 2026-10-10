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
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** One level of the library grid: its path, the breadcrumb title and the rows loaded so far. */
data class LibraryPage(
  val path: String,
  val title: String,
  val items: List<BrowseItem> = emptyList(),
  val total: Int = 0,
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

  fun start() {
    job?.cancel()
    state = LibraryState(pages = listOf(LibraryPage(path = "", title = "")), loading = true)
    job = viewModelScope.launch { load(null) }
  }

  fun open(path: String, title: String) {
    job?.cancel()
    state = state.copy(pages = state.pages + LibraryPage(path, title), loading = true, error = false)
    job = viewModelScope.launch { load(path) }
  }

  /** Pushes a level whose rows were already fetched, so a folder is not browsed twice. */
  fun push(path: String, title: String, items: List<BrowseItem>, total: Int) {
    job?.cancel()
    state = state.copy(pages = state.pages + LibraryPage(path, title, items, total), loading = false, error = false)
  }

  fun retry() {
    val page = state.current ?: return
    job?.cancel()
    state = state.copy(loading = true, error = false)
    job = viewModelScope.launch { load(page.path.ifEmpty { null }) }
  }

  /** Re-reads the level on screen in the background: the old rows stay until the answer lands. */
  fun refresh() {
    val page = state.current ?: return
    if (state.loading || state.loadingMore) return
    val depth = state.pages.size
    job?.cancel()
    job = viewModelScope.launch {
      val next = runCatching { loadPage(page.path.ifEmpty { null }, 0) }.getOrNull() ?: return@launch
      update(depth) { it.copy(path = next.path, items = next.items, total = next.total) }
    }
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
        val next = loadPage(page.path.ifEmpty { null }, page.items.size)
        update(depth) { it.copy(items = it.items + next.items, total = next.total.coerceAtLeast(it.total)) }
      } catch (_: ApiError) {
      } finally {
        state = state.copy(loadingMore = false)
      }
    }
  }

  /** The server answers before its first walk of a library has finished; an empty pending page
   *  is asked again instead of being shown as empty. */
  private suspend fun loadPage(path: String?, skip: Int): BrowsePage {
    var page = api.browse(path, limit = PAGE, skip = skip)
    var attempts = 0
    while (page.pending && page.items.isEmpty() && attempts++ < PENDING_RETRIES) {
      delay(pendingDelayMs)
      page = api.browse(path, limit = PAGE, skip = skip)
    }
    return BrowsePage(page.path, page.items, page.total)
  }

  private suspend fun load(path: String?) {
    val depth = state.pages.size
    try {
      val page = loadPage(path, 0)
      update(depth) { it.copy(path = page.path, items = page.items, total = page.total) }
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

  companion object {
    const val PAGE = 60
    private const val PENDING_RETRIES = 5
    private const val PENDING_DELAY_MS = 1_500L

    fun factory(api: LibraryApi, pendingDelayMs: Long = PENDING_DELAY_MS) =
      viewModelFactory { initializer { LibraryViewModel(api, pendingDelayMs) } }
  }
}

private data class BrowsePage(val path: String, val items: List<BrowseItem>, val total: Int)
