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
import cz.stremiooffline.tv.data.WatchlistEntryDto
import kotlinx.coroutines.CancellationException
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
  /** The watchlist entries behind the virtual My list entry, and how many there are. */
  val watchlist: List<WatchlistEntryDto> = emptyList(),
  val watchlistCount: Int = 0,
  /** True while the grid shows the watchlist instead of an addon catalogue. */
  val onWatchlist: Boolean = false,
) {
  val current: CatalogDto? get() = catalogs.getOrNull(catalogIndex)
  val genres: List<String> get() = if (onWatchlist) emptyList() else current?.genreOptions.orEmpty()
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
      refreshWatchlistCount()
      if (catalogs.isNotEmpty()) load(reset = true) else state = state.copy(loading = false, hasMore = false)
    }
  }

  fun select(index: Int) {
    // Leaving My list for the catalogue it was showing must still reload it.
    if (index !in state.catalogs.indices || (index == state.catalogIndex && !state.onWatchlist)) return
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
      onWatchlist = false,
    )
    job = viewModelScope.launch { load(reset = true) }
  }

  /** Chooses the virtual My list entry, which reads `GET /api/watchlist` instead of an addon. */
  fun selectWatchlist() {
    if (state.onWatchlist) return
    job?.cancel()
    state = state.copy(
      onWatchlist = true,
      genre = "",
      items = emptyList(),
      skip = 0,
      hasMore = false,
      loading = true,
      loadingMore = false,
      error = false,
    )
    job = viewModelScope.launch { loadWatchlist() }
  }

  fun setGenre(genre: String) {
    if (state.onWatchlist || genre == state.genre) return
    job?.cancel()
    state = state.copy(genre = genre, items = emptyList(), skip = 0, hasMore = true, loading = true, loadingMore = false, error = false)
    job = viewModelScope.launch { load(reset = true) }
  }

  fun loadMore() {
    if (state.onWatchlist || state.loading || state.loadingMore || !state.hasMore || state.current == null) return
    state = state.copy(loadingMore = true)
    job = viewModelScope.launch { load(reset = false) }
  }

  fun retry() {
    if (state.onWatchlist) {
      job?.cancel()
      state = state.copy(items = emptyList(), loading = true, error = false)
      job = viewModelScope.launch { loadWatchlist() }
      return
    }
    if (state.current == null) {
      started = false
      start()
      return
    }
    job?.cancel()
    state = state.copy(items = emptyList(), skip = 0, hasMore = true, loading = true, loadingMore = false, error = false)
    job = viewModelScope.launch { load(reset = true) }
  }

  /** Re-reads the watchlist when a detail returns, so the count and the grid stay honest. */
  suspend fun refreshWatchlist() {
    refreshWatchlistCount()
  }

  private suspend fun refreshWatchlistCount() {
    val entries = watchlistOrNull() ?: return
    state = state.copy(
      watchlist = entries,
      watchlistCount = entries.size,
      items = if (state.onWatchlist) entries.map(::toMeta) else state.items,
      error = if (state.onWatchlist) false else state.error,
    )
  }

  private suspend fun loadWatchlist() {
    val entries = watchlistOrNull()
    if (entries == null) {
      state = state.copy(items = emptyList(), loading = false, error = true)
      return
    }
    state = state.copy(
      watchlist = entries,
      watchlistCount = entries.size,
      items = entries.map(::toMeta),
      skip = entries.size,
      hasMore = false,
      loading = false,
      loadingMore = false,
      error = false,
    )
  }

  private suspend fun watchlistOrNull(): List<WatchlistEntryDto>? = try {
    api.watchlist()
  } catch (cancelled: CancellationException) {
    throw cancelled
  } catch (_: ApiError) {
    null
  }

  private fun toMeta(entry: WatchlistEntryDto): MetaDto =
    MetaDto(id = entry.id, type = entry.type.ifEmpty { "movie" }, name = entry.name, poster = entry.poster)

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
