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
import cz.stremiooffline.tv.data.SearchScope
import cz.stremiooffline.tv.data.SearchableCatalogDto
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

data class SearchState(
  val query: String = "",
  /** Where the query looks: every addon, one addon, or one catalogue. */
  val scope: SearchScope = SearchScope(),
  /** The catalogues `GET /api/searchable` offers for the scope panel. */
  val searchable: List<SearchableCatalogDto> = emptyList(),
  val items: List<MetaDto> = emptyList(),
  val cursor: String? = null,
  val hasMore: Boolean = false,
  val loading: Boolean = false,
  val loadingMore: Boolean = false,
  val error: Boolean = false,
) {
  val submitted: Boolean get() = query.isNotEmpty()
}

/** One committed query and its pages, paged with the server's cursor and scoped like the web. */
class SearchViewModel(private val api: CatalogApi) : ViewModel() {

  var state by mutableStateOf(SearchState())
    private set

  private var job: Job? = null

  init {
    viewModelScope.launch {
      state = state.copy(searchable = try {
        api.searchable()
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        emptyList()
      })
    }
  }

  /** Re-reads the catalogues the scope panel offers; it is asked each time the panel opens, so an
   *  addon switched on elsewhere shows up without a new session. A failed read keeps the last list. */
  fun refreshSearchable() {
    viewModelScope.launch {
      val list = try {
        api.searchable()
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        return@launch
      }
      state = state.copy(searchable = list)
    }
  }

  fun submit(query: String) {
    val trimmed = query.trim()
    job?.cancel()
    if (trimmed.isEmpty()) {
      state = SearchState(scope = state.scope, searchable = state.searchable)
      return
    }
    state = state.copy(query = trimmed, items = emptyList(), cursor = null, hasMore = false, loading = true, loadingMore = false, error = false)
    job = viewModelScope.launch { load(reset = true) }
  }

  /** Changing the scope re-runs a submitted query; an empty one just remembers the scope. */
  fun setScope(scope: SearchScope) {
    if (scope == state.scope) return
    state = state.copy(scope = scope)
    if (state.query.isEmpty()) return
    job?.cancel()
    state = state.copy(items = emptyList(), cursor = null, hasMore = false, loading = true, loadingMore = false, error = false)
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
      api.search(state.query, if (reset) null else state.cursor, state.scope)
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
