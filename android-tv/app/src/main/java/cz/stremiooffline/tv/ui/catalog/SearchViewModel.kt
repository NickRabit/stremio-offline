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
import cz.stremiooffline.tv.data.CatalogSearchScopeDto
import cz.stremiooffline.tv.data.CatalogSearchSnapshotDto
import cz.stremiooffline.tv.data.CatalogSearchStartDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.RecentSearchDto
import cz.stremiooffline.tv.data.SearchScope
import cz.stremiooffline.tv.data.SearchStateDto
import cz.stremiooffline.tv.data.SearchableCatalogDto
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.UUID

data class SearchState(
  val query: String = "",
  /** Where the query looks: every addon, one addon, or one catalogue. */
  val scope: SearchScope = SearchScope(),
  /** The catalogues `GET /api/searchable` offers for the scope panel. */
  val searchable: List<SearchableCatalogDto> = emptyList(),
  /** The account's recent searches, newest first; empty while none are kept or the read failed. */
  val recent: List<RecentSearchDto> = emptyList(),
  /** False once the account has switched history saving off: nothing is recorded then. */
  val saveHistory: Boolean = true,
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
class SearchViewModel(
  private val api: CatalogApi,
  private val catalogSessions: Boolean = false,
) : ViewModel() {

  var state by mutableStateOf(SearchState())
    private set

  private var job: Job? = null
  private val catalogSlotId = UUID.randomUUID().toString().replace("-", "")
  private var catalogGeneration = 0
  private var catalogSessionId: String? = null
  private var catalogRevision = 0
  private var catalogUnsupported = false

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
    // The history is shared with the web, so it is read once here and again after every submit.
    viewModelScope.launch { loadRecent() }
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
    deleteCatalogSession()
    if (trimmed.isEmpty()) {
      state = state.copy(query = "", items = emptyList(), cursor = null, hasMore = false, loading = false, loadingMore = false, error = false)
      return
    }
    state = state.copy(query = trimmed, items = emptyList(), cursor = null, hasMore = false, loading = true, loadingMore = false, error = false)
    job = viewModelScope.launch { load(reset = true) }
    noteQuery(trimmed)
  }

  /** Reports the query to the account and re-reads the history the list shows. A failure of the
   *  write never reaches the search: the server only keeps what it is allowed to. */
  private fun noteQuery(query: String) {
    viewModelScope.launch {
      if (state.saveHistory) {
        try {
          api.recordSearch(query)
        } catch (cancelled: CancellationException) {
          throw cancelled
        } catch (_: ApiError) {
        }
      }
      loadRecent()
    }
  }

  /** Changing the scope re-runs a submitted query; an empty one just remembers the scope. */
  fun setScope(scope: SearchScope) {
    if (scope == state.scope) return
    state = state.copy(scope = scope)
    if (state.query.isEmpty()) return
    job?.cancel()
    deleteCatalogSession()
    state = state.copy(items = emptyList(), cursor = null, hasMore = false, loading = true, loadingMore = false, error = false)
    job = viewModelScope.launch { load(reset = true) }
  }

  fun loadMore() {
    val usesCatalogSession = catalogSessions && !catalogUnsupported
    if (state.loading || state.loadingMore || !state.hasMore || (!usesCatalogSession && state.cursor.isNullOrEmpty())) return
    state = state.copy(loadingMore = true)
    job = viewModelScope.launch { load(reset = false) }
  }

  fun retry() {
    if (state.query.isEmpty()) return
    job?.cancel()
    deleteCatalogSession()
    state = state.copy(items = emptyList(), cursor = null, loading = true, loadingMore = false, error = false)
    job = viewModelScope.launch { load(reset = true) }
  }

  /** Drops one recent query. The row goes at once; the server's answer is what stays. */
  fun forget(query: String) {
    val trimmed = query.trim()
    if (trimmed.isEmpty()) return
    state = state.copy(recent = state.recent.filterNot { it.query == trimmed })
    viewModelScope.launch {
      val next = try {
        api.forgetSearch(trimmed)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        loadRecent()
        return@launch
      }
      applySearchState(next)
    }
  }

  /** Reads the shared history. A failure leaves the list empty instead of showing an error. */
  private suspend fun loadRecent() {
    val next = try {
      api.searchState()
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      return
    }
    applySearchState(next)
  }

  private fun applySearchState(next: SearchStateDto) {
    state = state.copy(recent = next.recent, saveHistory = next.saveHistory)
  }

  private suspend fun load(reset: Boolean) {
    try {
      if (catalogSessions && !catalogUnsupported) loadCatalog(reset)
      else loadLegacy(reset)
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      state = if (reset) state.copy(items = emptyList(), loading = false, loadingMore = false, error = true, hasMore = false)
      else state.copy(loadingMore = false)
    }
  }

  private suspend fun loadCatalog(reset: Boolean) {
    val existing = if (reset) emptyList() else state.items
    val seen = existing.map { "${it.type}:${it.id}" }.toHashSet()
    var gained = false

    fun apply(snapshot: CatalogSearchSnapshotDto) {
      for (item in snapshot.items) {
        if (seen.add("${item.type}:${item.id}")) gained = true
      }
      val settled = snapshot.items.isNotEmpty() || snapshot.state == "complete"
      state = state.copy(
        items = snapshot.items,
        cursor = null,
        hasMore = snapshot.hasMore && !(snapshot.state == "complete" && !reset && !gained),
        loading = reset && !settled,
        loadingMore = !reset && !settled,
        error = false,
      )
    }

    // A session that ended meanwhile (it expired while idle) is started again for the same query
    // rather than failing the next page.
    val pagedRevision = if (reset) null else catalogSessionId?.let { id ->
      try {
        api.pageCatalogSearch(id)
      } catch (error: ApiError) {
        if (error.status == 404 || error.status == 410) null else throw error
      }
    }
    if (!reset && pagedRevision == null) catalogSessionId = null
    val currentState = if (reset || pagedRevision == null) {
      val scope = state.scope
      catalogGeneration += 1
      val started = try {
        api.startCatalogSearch(
          CatalogSearchStartDto(
            query = state.query,
            type = scope.catalogType?.takeIf { it == "movie" || it == "series" },
            scope = scope.addonKey?.takeIf { it.isNotEmpty() }?.let {
              CatalogSearchScopeDto(
                addonKey = it,
                catalogType = scope.catalogType?.takeIf { value -> value.isNotEmpty() },
                catalogId = scope.catalogId?.takeIf { value -> value.isNotEmpty() },
              )
            },
            slotId = catalogSlotId,
            generation = catalogGeneration,
          ),
        )
      } catch (error: ApiError) {
        if (error.status == 404) {
          catalogUnsupported = true
          loadLegacy(reset = true)
          return
        }
        throw error
      }
      catalogSessionId = started.id
      apply(started.snapshot)
      catalogRevision = started.snapshot.revision
      started.snapshot.state
    } else {
      val before = catalogRevision
      catalogRevision = pagedRevision
      if (catalogRevision == before) {
        state = state.copy(loadingMore = false)
        return
      }
      "partial"
    }
    pollCatalog(currentState, ::apply)
  }

  private suspend fun pollCatalog(
    initialState: String,
    apply: (CatalogSearchSnapshotDto) -> Unit,
  ) {
    var currentState = initialState
    while (currentState != "complete") {
      val id = catalogSessionId ?: return
      val answer = api.pollCatalogSearch(id, catalogRevision)
      if (answer.changed) {
        val snapshot = answer.snapshot ?: throw ApiError(cz.stremiooffline.tv.data.ApiFailure.Generic)
        catalogRevision = snapshot.revision
        currentState = snapshot.state
        apply(snapshot)
      } else {
        catalogRevision = answer.revision
        if (currentState == "partial") delay(250) else break
      }
    }
  }

  private suspend fun loadLegacy(reset: Boolean) {
    val result = try {
      api.search(state.query, if (reset) null else state.cursor, state.scope)
    } catch (cancelled: CancellationException) {
      throw cancelled
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

  private fun deleteCatalogSession() {
    val id = catalogSessionId
    catalogSessionId = null
    catalogRevision = 0
    if (id != null) viewModelScope.launch { api.deleteCatalogSearch(id) }
  }

  override fun onCleared() {
    val id = catalogSessionId
    catalogSessionId = null
    if (id != null) {
      CoroutineScope(SupervisorJob() + Dispatchers.IO).launch { api.deleteCatalogSearch(id) }
    }
    super.onCleared()
  }

  companion object {
    fun factory(api: CatalogApi, catalogSessions: Boolean = false) = viewModelFactory {
      initializer { SearchViewModel(api, catalogSessions) }
    }
  }
}
