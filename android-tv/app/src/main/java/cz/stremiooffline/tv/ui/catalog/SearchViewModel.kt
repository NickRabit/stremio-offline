package cz.stremiooffline.tv.ui.catalog

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.CatalogApi
import cz.stremiooffline.tv.data.MetaDto
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

data class SearchState(
  val query: String = "",
  val items: List<MetaDto> = emptyList(),
  val cursor: String? = null,
  val hasMore: Boolean = false,
  val loading: Boolean = false,
  val loadingMore: Boolean = false,
  val error: Boolean = false,
) {
  val submitted: Boolean get() = query.isNotEmpty()
}

/** One committed query and its pages. Search everything, paged with the server's cursor. */
class SearchViewModel(private val api: CatalogApi) : ViewModel() {

  var state by mutableStateOf(SearchState())
    private set

  private var job: Job? = null

  fun submit(query: String) {
    val trimmed = query.trim()
    job?.cancel()
    if (trimmed.isEmpty()) {
      state = SearchState()
      return
    }
    state = state.copy(query = trimmed, items = emptyList(), cursor = null, hasMore = false, loading = true, loadingMore = false, error = false)
    job = viewModelScope.launch { load(reset = true) }
  }

  fun loadMore() {
    if (state.loading || state.loadingMore || !state.hasMore || state.cursor.isNullOrEmpty()) return
    state = state.copy(loadingMore = true)
    job = viewModelScope.launch { load(reset = false) }
  }

  fun retry() {
    if (state.query.isEmpty()) return
    job?.cancel()
    state = state.copy(items = emptyList(), cursor = null, loading = true, loadingMore = false, error = false)
    job = viewModelScope.launch { load(reset = true) }
  }

  private suspend fun load(reset: Boolean) {
    val result = try {
      api.search(state.query, if (reset) null else state.cursor)
    } catch (_: ApiError) {
      state = if (reset) state.copy(items = emptyList(), loading = false, loadingMore = false, error = true, hasMore = false)
      else state.copy(loadingMore = false)
      return
    }
    val existing = if (reset) emptyList() else state.items
    val seen = existing.map { "${it.type}:${it.id}" }.toHashSet()
    val added = result.items.filter { seen.add("${it.type}:${it.id}") }
    val next = existing + added
    val gainedNothing = !reset && next.size == existing.size
    state = state.copy(
      items = next,
      cursor = result.cursor,
      hasMore = result.hasMore && !gainedNothing,
      loading = false,
      loadingMore = false,
      error = false,
    )
  }

  companion object {
    fun factory(api: CatalogApi) = viewModelFactory { initializer { SearchViewModel(api) } }
  }
}
