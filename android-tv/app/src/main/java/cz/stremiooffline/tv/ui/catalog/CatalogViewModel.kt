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
import cz.stremiooffline.tv.data.CatalogDto
import cz.stremiooffline.tv.data.MetaDto
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

data class CatalogState(
  val catalogs: List<CatalogDto> = emptyList(),
  val catalogIndex: Int = 0,
  val genre: String = "",
  val items: List<MetaDto> = emptyList(),
  val skip: Int = 0,
  val hasMore: Boolean = true,
  val loading: Boolean = true,
  val loadingMore: Boolean = false,
  val error: Boolean = false,
) {
  val current: CatalogDto? get() = catalogs.getOrNull(catalogIndex)
  val genres: List<String> get() = current?.genreOptions.orEmpty()
}

/**
 * The chosen catalogue, its genre and the grid pages so far. Held in a view model so they
 * survive a rail section switch without being persisted anywhere.
 */
class CatalogViewModel(private val api: CatalogApi) : ViewModel() {

  var state by mutableStateOf(CatalogState())
    private set

  private var started = false
  private var job: Job? = null

  fun start() {
    if (started) return
    started = true
    job = viewModelScope.launch {
      state = state.copy(loading = true, error = false)
      val catalogs = try {
        api.catalogs()
      } catch (_: ApiError) {
        state = state.copy(loading = false, error = true)
        return@launch
      }
      state = state.copy(catalogs = catalogs, catalogIndex = 0, genre = "")
      if (catalogs.isNotEmpty()) load(reset = true) else state = state.copy(loading = false, hasMore = false)
    }
  }

  fun select(index: Int) {
    if (index == state.catalogIndex || index !in state.catalogs.indices) return
    job?.cancel()
    // A genre, season or episode belongs to one catalogue; a different one starts clean.
    state = state.copy(
      catalogIndex = index,
      genre = "",
      items = emptyList(),
      skip = 0,
      hasMore = true,
      loading = true,
      loadingMore = false,
      error = false,
    )
    job = viewModelScope.launch { load(reset = true) }
  }

  fun setGenre(genre: String) {
    if (genre == state.genre) return
    job?.cancel()
    state = state.copy(genre = genre, items = emptyList(), skip = 0, hasMore = true, loading = true, loadingMore = false, error = false)
    job = viewModelScope.launch { load(reset = true) }
  }

  fun loadMore() {
    if (state.loading || state.loadingMore || !state.hasMore || state.current == null) return
    state = state.copy(loadingMore = true)
    job = viewModelScope.launch { load(reset = false) }
  }

  fun retry() {
    if (state.current == null) {
      started = false
      start()
      return
    }
    job?.cancel()
    state = state.copy(items = emptyList(), skip = 0, hasMore = true, loading = true, loadingMore = false, error = false)
    job = viewModelScope.launch { load(reset = true) }
  }

  private suspend fun load(reset: Boolean) {
    val catalog = state.current ?: return
    val from = if (reset) 0 else state.skip
    val page = try {
      api.catalog(catalog.addonKey, catalog.type, catalog.id, from, state.genre.ifEmpty { null })
    } catch (_: ApiError) {
      state = if (reset) {
        state.copy(items = emptyList(), loading = false, loadingMore = false, error = true, hasMore = false)
      } else {
        state.copy(loadingMore = false)
      }
      return
    }
    val existing = if (reset) emptyList() else state.items
    val seen = existing.map { key(it, catalog) }.toHashSet()
    val added = page.filter { seen.add(key(it, catalog)) }
    val next = existing + added
    // An addon that ignores `skip` returns page one forever; stop once a page adds nothing.
    val gainedNothing = !reset && next.size == existing.size
    state = state.copy(
      items = next,
      skip = from + page.size,
      hasMore = page.isNotEmpty() && !gainedNothing,
      loading = false,
      loadingMore = false,
      error = false,
    )
  }

  private fun key(item: MetaDto, catalog: CatalogDto): String = "${item.type ?: catalog.type}:${item.id}"

  companion object {
    fun factory(api: CatalogApi) = viewModelFactory { initializer { CatalogViewModel(api) } }
  }
}
