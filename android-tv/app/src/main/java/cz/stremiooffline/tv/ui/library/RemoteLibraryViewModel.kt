package cz.stremiooffline.tv.ui.library

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteLibraryApi
import cz.stremiooffline.tv.data.RemoteLibraryDto
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** Which half of the Library section is on screen. */
enum class LibrarySegment { Files, Servers }

/** The type filter over one remote item list: the wire value is `null`, `movie` or `series`. */
enum class RemoteTypeFilter(val wire: String?) {
  All(null),
  Movies("movie"),
  Series("series"),
}

/** An unreachable server reads differently from a refusal. */
enum class RemoteErrorKind { Offline, Failed }

data class RemoteItemsState(
  val items: List<RemoteItemDto> = emptyList(),
  val loading: Boolean = false,
  val loadingMore: Boolean = false,
  val error: RemoteErrorKind? = null,
  val nextCursor: String? = null,
  val total: Int = 0,
  val search: String = "",
  val type: RemoteTypeFilter = RemoteTypeFilter.All,
) {
  val hasMore: Boolean get() = nextCursor != null
}

/** One level of the remote navigation. */
sealed interface RemoteLevel {
  val libraryId: String
  val libraryName: String
  val provider: String
  val state: RemoteItemsState

  /** A stable identity for one stack position. */
  val key: String

  /** The library root: movies and series only. Episodes and seasons are never presented here. */
  data class Items(
    override val libraryId: String,
    override val libraryName: String,
    override val provider: String,
    val title: String,
    override val state: RemoteItemsState = RemoteItemsState(),
  ) : RemoteLevel {
    override val key: String get() = "items:$libraryId:$title"
  }

  /** A series or season whose episodes come from the episodes route. */
  data class Episodes(
    override val libraryId: String,
    override val libraryName: String,
    override val provider: String,
    val title: String,
    val itemId: String,
    override val state: RemoteItemsState = RemoteItemsState(),
  ) : RemoteLevel {
    override val key: String get() = "episodes:$libraryId:$itemId"
  }
}

data class RemoteLibraryState(
  val levels: List<RemoteLevel> = emptyList(),
  val libraries: List<RemoteLibraryDto> = emptyList(),
  val librariesLoading: Boolean = false,
  val librariesError: RemoteErrorKind? = null,
) {
  val current: RemoteLevel? get() = levels.lastOrNull()
}

const val REMOTE_PICKER_KEY = "libraries"

/**
 * The read-only media-server browser. A level's first page clears the level before it loads; a
 * "load more" only appends. Every load carries the epoch it was asked under, and Back, a segment
 * change or unmount cancels the jobs and advances the epoch, so a late answer can never land.
 */
class RemoteLibraryViewModel(private val api: RemoteLibraryApi) : ViewModel() {

  var state by mutableStateOf(RemoteLibraryState())
    private set

  /** The item last focused on each level, so Back restores the card that opened the level. */
  var selection by mutableStateOf<Map<String, String>>(emptyMap())
    private set

  private var librariesJob: Job? = null
  private var listJob: Job? = null
  /** Separate guards, so starting an item load never invalidates a libraries load and vice versa. */
  private var librariesEpoch = 0
  private var itemsEpoch = 0

  fun selectedFor(key: String): String? = selection[key]

  fun select(key: String, value: String) {
    selection = selection + (key to value)
  }

  fun loadLibraries() {
    val mine = ++librariesEpoch
    librariesJob?.cancel()
    state = state.copy(librariesLoading = true, librariesError = null)
    librariesJob = viewModelScope.launch {
      try {
        val libraries = api.remoteLibraries()
        if (mine != librariesEpoch) return@launch
        state = state.copy(libraries = libraries, librariesLoading = false, librariesError = null)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: Throwable) {
        if (mine != librariesEpoch) return@launch
        state = state.copy(librariesLoading = false, librariesError = kindOf(error))
      }
    }
  }

  fun openLibrary(library: RemoteLibraryDto) {
    val level = RemoteLevel.Items(library.id, library.name, library.provider, library.name)
    state = state.copy(levels = listOf(level))
    startLevel(level)
  }

  fun openItem(item: RemoteItemDto) {
    val current = state.current ?: return
    val level = when (item.type) {
      "series", "season" ->
        RemoteLevel.Episodes(current.libraryId, current.libraryName, current.provider, item.name, item.id)
      else -> return
    }
    state = state.copy(levels = state.levels + level)
    startLevel(level)
  }

  /** Pops one level, cancelling its load; false when the stack is already at the picker. */
  fun back(): Boolean {
    if (state.levels.isEmpty()) return false
    cancelLoads()
    state = state.copy(levels = state.levels.dropLast(1))
    return true
  }

  /** The view left the screen: no in-flight answer may be applied after this. */
  fun onHidden() {
    cancelLoads()
  }

  /** The servers half came back into view: the picker reads again, and an open level reloads its
   *  first page rather than showing a page that was left half-loaded. */
  fun onShown() {
    loadLibraries()
    val level = state.current ?: return
    reload(level)
  }

  fun retry() {
    val level = state.current
    if (level == null) {
      if (state.librariesError != null) loadLibraries()
      return
    }
    reload(level)
  }

  fun loadMore() {
    val level = state.current ?: return
    val current = level.state
    if (current.loading || current.loadingMore || !current.hasMore) return
    updateItems(level) { it.copy(loadingMore = true, error = null) }
    request(currentLevel(level) ?: return, cursor = current.nextCursor, append = true)
  }

  /** A committed query; never fired per keystroke. It resets the level to its first page. */
  fun search(query: String) {
    val level = state.current as? RemoteLevel.Items ?: return
    if (level.state.search == query) return
    clearForLoad(level) { it.copy(search = query) }
    request(currentLevel(level) ?: return, cursor = null, append = false)
  }

  fun filter(type: RemoteTypeFilter) {
    val level = state.current as? RemoteLevel.Items ?: return
    if (level.state.type == type) return
    clearForLoad(level) { it.copy(type = type) }
    request(currentLevel(level) ?: return, cursor = null, append = false)
  }

  /** A new level with no rows yet; it loads its first page straight away. */
  private fun startLevel(level: RemoteLevel) {
    updateItems(level) { it.copy(loading = true, error = null) }
    request(level, cursor = null, append = false)
  }

  /** Re-reads the level's current first page after a retry. */
  private fun reload(level: RemoteLevel) {
    clearForLoad(level) { it }
    request(currentLevel(level) ?: return, cursor = null, append = false)
  }

  /** Empties a level and sets it loading, so a search, a filter change or a retry starts clean. */
  private fun clearForLoad(level: RemoteLevel, change: (RemoteItemsState) -> RemoteItemsState) {
    updateItems(level) {
      change(it).copy(items = emptyList(), loading = true, loadingMore = false, error = null, nextCursor = null, total = 0)
    }
  }

  /** Reads one page for [level]; the answer is applied only if its epoch is still current. */
  private fun request(level: RemoteLevel, cursor: String?, append: Boolean) {
    val mine = ++itemsEpoch
    listJob?.cancel()
    listJob = viewModelScope.launch {
      try {
        val page = when (level) {
          is RemoteLevel.Episodes -> api.remoteEpisodes(level.libraryId, level.itemId, PAGE, cursor)
          is RemoteLevel.Items ->
            api.remoteItems(level.libraryId, PAGE, cursor, level.state.search.ifEmpty { null }, level.state.type.wire)
        }
        if (mine != itemsEpoch) return@launch
        val items = presentable(level, page.items)
        updateItems(level) {
          it.copy(
            items = if (append) it.items + items else items,
            loading = false,
            loadingMore = false,
            error = null,
            nextCursor = page.cursor,
            total = page.total,
          )
        }
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: Throwable) {
        if (mine != itemsEpoch) return@launch
        updateItems(level) { it.copy(loading = false, loadingMore = false, error = kindOf(error)) }
      }
    }
  }

  /** The library root presents movies and series only; episodes and seasons never appear there
   *  even though paging continues. Episodes are ordered season, then episode, then name, with a
   *  missing season reading as the specials season 0. */
  private fun presentable(level: RemoteLevel, items: List<RemoteItemDto>): List<RemoteItemDto> =
    when (level) {
      is RemoteLevel.Episodes -> items.sortedWith(compareBy({ it.season ?: 0 }, { it.episode ?: 0 }, { it.name }))
      is RemoteLevel.Items -> items.filter { it.type != "episode" && it.type != "season" }
    }

  private fun cancelLoads() {
    librariesEpoch++
    itemsEpoch++
    listJob?.cancel(); listJob = null
    librariesJob?.cancel(); librariesJob = null
    // A level that was mid-load must not come back as a stuck spinner: it keeps its rows and stops
    // showing progress until it is asked to load again.
    state = state.copy(
      librariesLoading = false,
      levels = state.levels.map { level ->
        when (level) {
          is RemoteLevel.Items -> level.copy(state = level.state.copy(loading = false, loadingMore = false))
          is RemoteLevel.Episodes -> level.copy(state = level.state.copy(loading = false, loadingMore = false))
        }
      },
    )
  }

  private fun currentLevel(level: RemoteLevel): RemoteLevel? = state.levels.firstOrNull { it.key == level.key }

  /** Rebuilds the level in place from its state, so a late answer for a left level is dropped. */
  private fun updateItems(level: RemoteLevel, transform: (RemoteItemsState) -> RemoteItemsState) {
    val index = state.levels.indexOfFirst { it.key == level.key }
    if (index < 0) return
    val current = state.levels[index]
    val next = when (current) {
      is RemoteLevel.Items -> current.copy(state = transform(current.state))
      is RemoteLevel.Episodes -> current.copy(state = transform(current.state))
    }
    val levels = state.levels.toMutableList()
    levels[index] = next
    state = state.copy(levels = levels)
  }

  private fun kindOf(error: Throwable): RemoteErrorKind =
    if ((error as? ApiError)?.failure == ApiFailure.Unreachable) RemoteErrorKind.Offline else RemoteErrorKind.Failed

  companion object {
    const val PAGE = 100

    fun factory(api: RemoteLibraryApi) = viewModelFactory { initializer { RemoteLibraryViewModel(api) } }
  }
}
