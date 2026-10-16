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
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/** Which half of the Library section is on screen. */
enum class LibrarySegment { All, Files, Servers }

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
  /** A page after the first failed while its rows stayed: the notice sits beside the grid. */
  val appendError: RemoteErrorKind? = null,
  /** The server rejected the cursor. The rows stay; an explicit retry starts the listing again. */
  val staleCursor: Boolean = false,
  val nextCursor: String? = null,
  val total: Int = 0,
  val search: String = "",
  val type: RemoteTypeFilter = RemoteTypeFilter.All,
) {
  val hasMore: Boolean get() = nextCursor != null
}

/** One artwork answer for a library root or folder tile: loading, ready posters or a failure that
 *  leaves the plain folder icon. */
sealed interface RemotePreviewState {
  data object Loading : RemotePreviewState
  data class Ready(val posters: List<String>) : RemotePreviewState
  data object Failed : RemotePreviewState
}

/** One level of the remote navigation. A folder keeps its opaque parent id, so two folders with the
 *  same number of children never share an identity. */
sealed interface RemoteLevel {
  val libraryId: String
  val libraryName: String
  val provider: String
  val title: String
  /** Whether this level's root and folder tiles may load a preview mosaic at all. */
  val mosaic: Boolean
  val state: RemoteItemsState

  /** A stable identity for one stack position. */
  val key: String

  /** A library root or one folder inside it. Folders and their media share the level; episodes and
   *  seasons are only ever listed through [Episodes]. */
  data class Directory(
    override val libraryId: String,
    override val libraryName: String,
    override val provider: String,
    override val title: String,
    /** The opaque upstream parent: null at the attached root, the folder's own id below it. */
    val parentId: String?,
    /** `folders` lists this directory's children, `titles` is the flat listing. */
    val mode: String,
    override val mosaic: Boolean,
    override val state: RemoteItemsState = RemoteItemsState(),
  ) : RemoteLevel {
    override val key: String get() = "dir:$libraryId:${parentId ?: "root"}:$mode"
  }

  /** A series whose episodes load lazily through the browse route, one page at a time. */
  data class Episodes(
    override val libraryId: String,
    override val libraryName: String,
    override val provider: String,
    override val title: String,
    val itemId: String,
    override val mosaic: Boolean = false,
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
 *
 * A root or folder tile asks for its preview mosaic only while it is composed, at most
 * [MAX_PREVIEWS] requests at once, cancelled when the level or the half changes.
 */
class RemoteLibraryViewModel(private val api: RemoteLibraryApi) : ViewModel() {

  var state by mutableStateOf(RemoteLibraryState())
    private set

  /** The item last focused on each level, so Back restores the card that opened the level. */
  var selection by mutableStateOf<Map<String, String>>(emptyMap())
    private set

  /** Poster mosaics for roots and folders, keyed by [previewKey]. */
  var previews by mutableStateOf<Map<String, RemotePreviewState>>(emptyMap())
    private set

  private var librariesJob: Job? = null
  private var listJob: Job? = null
  /** Separate guards, so starting an item load never invalidates a libraries load and vice versa. */
  private var librariesEpoch = 0
  private var itemsEpoch = 0

  private val previewJobs = mutableMapOf<String, Job>()
  private val previewSlots = Semaphore(MAX_PREVIEWS)
  private var previewEpoch = 0

  fun selectedFor(key: String): String? = selection[key]

  fun select(key: String, value: String) {
    selection = selection + (key to value)
  }

  fun preview(key: String): RemotePreviewState? = previews[key]

  /**
   * Asks for one root or folder mosaic. The composed tile calls this; the cache and the running
   * jobs dedupe. A library with the mosaic off never fetches at all, and a tile that already
   * carries its own poster never does either -- the own picture wins over any child collage.
   */
  fun loadPreview(key: String, libraryId: String, parentId: String?, mosaic: Boolean, poster: String? = null) {
    if (!mosaic || !poster.isNullOrEmpty()) return
    val known = previews[key]
    if (known is RemotePreviewState.Ready || known is RemotePreviewState.Failed) return
    if (previewJobs.containsKey(key)) return
    previews = previews + (key to RemotePreviewState.Loading)
    val generation = previewEpoch
    previewJobs[key] = viewModelScope.launch {
      try {
        val posters = previewSlots.withPermit { api.remotePreview(libraryId, parentId).posters }
        if (generation != previewEpoch) return@launch
        previews = previews + (key to RemotePreviewState.Ready(posters))
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: Throwable) {
        if (generation == previewEpoch) previews = previews + (key to RemotePreviewState.Failed)
      } finally {
        // A cancelled job is replaced by cancelPreviews, which clears the map itself.
        if (generation == previewEpoch) previewJobs.remove(key)
      }
    }
  }

  fun loadLibraries() {
    cancelPreviews()
    previews = emptyMap()
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
    cancelPreviews()
    val level = RemoteLevel.Directory(
      libraryId = library.id,
      libraryName = library.name,
      provider = library.provider,
      title = library.name,
      parentId = null,
      mode = effectiveMode(library),
      mosaic = library.mosaic,
    )
    state = state.copy(levels = listOf(level))
    startLevel(level)
  }

  /** Opens one folder as a nested directory, keeping its opaque parent id. */
  fun openFolder(item: RemoteItemDto) {
    if (item.type != "folder" && item.type != "season") return
    val current = state.current as? RemoteLevel.Directory ?: return
    cancelPreviews()
    val level = RemoteLevel.Directory(
      libraryId = current.libraryId,
      libraryName = current.libraryName,
      provider = current.provider,
      title = item.name,
      parentId = item.id,
      mode = FOLDERS_MODE,
      mosaic = current.mosaic,
    )
    state = state.copy(levels = state.levels + level)
    startLevel(level)
  }

  fun openItem(item: RemoteItemDto) {
    val current = state.current ?: return
    val level = when (item.type) {
      "series", "season" ->
        RemoteLevel.Episodes(current.libraryId, current.libraryName, current.provider, item.name, item.id)
      else -> return
    }
    cancelPreviews()
    state = state.copy(levels = state.levels + level)
    startLevel(level)
  }

  /** Opens one series straight at its episodes, without browsing the rest of its library. */
  fun openSeries(libraryId: String, libraryName: String, provider: String, item: RemoteItemDto) {
    cancelPreviews()
    val level = RemoteLevel.Episodes(libraryId, libraryName, provider, item.name, item.id)
    state = state.copy(levels = listOf(level))
    startLevel(level)
  }

  /** Pops one level, cancelling its load; false when the stack is already at the picker. */
  fun back(): Boolean {
    if (state.levels.isEmpty()) return false
    cancelPreviews()
    cancelLoads()
    state = state.copy(levels = state.levels.dropLast(1))
    return true
  }

  /** The view left the screen: no in-flight answer may be applied after this. */
  fun onHidden() {
    cancelPreviews()
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
    updateItems(level) { it.copy(loadingMore = true, error = null, appendError = null, staleCursor = false) }
    request(currentLevel(level) ?: return, cursor = current.nextCursor, append = true)
  }

  /** Retries the page that failed, keeping the rows already loaded. */
  fun retryAppend() {
    val level = state.current ?: return
    val current = level.state
    if (current.loading || current.loadingMore) return
    val cursor = current.nextCursor ?: return reload(level)
    updateItems(level) { it.copy(loadingMore = true, appendError = null, staleCursor = false) }
    request(currentLevel(level) ?: return, cursor = cursor, append = true)
  }

  /** A committed query; never fired per keystroke. It resets the level to its first page. */
  fun search(query: String) {
    val level = state.current as? RemoteLevel.Directory ?: return
    if (level.state.search == query) return
    clearForLoad(level) { it.copy(search = query) }
    request(currentLevel(level) ?: return, cursor = null, append = false)
  }

  fun filter(type: RemoteTypeFilter) {
    val level = state.current as? RemoteLevel.Directory ?: return
    if (level.state.type == type) return
    clearForLoad(level) { it.copy(type = type) }
    request(currentLevel(level) ?: return, cursor = null, append = false)
  }

  /** A new level with no rows yet; it loads its first page straight away. */
  private fun startLevel(level: RemoteLevel) {
    updateItems(level) { it.copy(loading = true, error = null, appendError = null, staleCursor = false) }
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
      change(it).copy(
        items = emptyList(),
        loading = true,
        loadingMore = false,
        error = null,
        appendError = null,
        staleCursor = false,
        nextCursor = null,
        total = 0,
      )
    }
  }

  /** Reads one page for [level]; the answer is applied only if its epoch is still current. */
  private fun request(level: RemoteLevel, cursor: String?, append: Boolean) {
    val mine = ++itemsEpoch
    listJob?.cancel()
    listJob = viewModelScope.launch {
      try {
        val page = when (level) {
          is RemoteLevel.Episodes -> api.remoteBrowse(
            libraryId = level.libraryId,
            limit = BROWSE_LIMIT,
            cursor = cursor,
            type = EPISODE_TYPE,
            parentId = level.itemId,
            mode = TITLES_MODE,
          )
          is RemoteLevel.Directory -> api.remoteBrowse(
            libraryId = level.libraryId,
            limit = BROWSE_LIMIT,
            cursor = cursor,
            search = level.state.search.ifEmpty { null },
            type = level.state.type.wire,
            parentId = level.parentId,
            mode = level.mode,
          )
        }
        if (mine != itemsEpoch) return@launch
        val items = presentable(level, page.items)
        updateItems(level) {
          it.copy(
            items = if (append) mergeAppended(it.items, items) else items,
            loading = false,
            loadingMore = false,
            error = null,
            appendError = null,
            staleCursor = false,
            nextCursor = page.cursor,
            total = page.total,
          )
        }
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: Throwable) {
        if (mine != itemsEpoch) return@launch
        val kind = kindOf(error)
        // A cursor the server no longer accepts cannot be retried: drop it and let an explicit
        // retry start the listing again. The rows already loaded stay until that retry.
        val stale = append && (error as? ApiError)?.status == 409
        updateItems(level) {
          when {
            stale -> it.copy(loading = false, loadingMore = false, error = null, appendError = null, nextCursor = null, staleCursor = true)
            append -> it.copy(loading = false, loadingMore = false, error = null, appendError = kind)
            else -> it.copy(loading = false, loadingMore = false, error = kind, appendError = null, staleCursor = false)
          }
        }
      }
    }
  }

  /** One page appended after another: an id already shown is never drawn twice. */
  private fun mergeAppended(existing: List<RemoteItemDto>, added: List<RemoteItemDto>): List<RemoteItemDto> {
    if (added.isEmpty()) return existing
    val seen = existing.mapTo(HashSet()) { it.id }
    return existing + added.filter { seen.add(it.id) }
  }

  /**
   * What a page presents. A folders level keeps every folder whatever the filter is, so the
   * hierarchy is never flattened; its media is narrowed to the filter in place. The flat titles
   * listing lets the server do the filtering and only drops the episodes and seasons that would
   * clutter it. Episodes are ordered season, then episode, then name, missing season reads as 0.
   */
  private fun presentable(level: RemoteLevel, items: List<RemoteItemDto>): List<RemoteItemDto> =
    when (level) {
      is RemoteLevel.Episodes -> items.sortedWith(compareBy({ it.season ?: 0 }, { it.episode ?: 0 }, { it.name }))
      is RemoteLevel.Directory ->
        if (level.mode == FOLDERS_MODE) filterFolders(items, level.state.type)
        else items.filter { it.type != "episode" && it.type != "season" }
    }

  /** A folders level filtered by type: every folder survives, only the media narrows. */
  private fun filterFolders(items: List<RemoteItemDto>, type: RemoteTypeFilter): List<RemoteItemDto> =
    when (type) {
      RemoteTypeFilter.All -> items
      RemoteTypeFilter.Movies -> items.filter { it.type == "folder" || it.type == "movie" }
      RemoteTypeFilter.Series -> items.filter { it.type in setOf("folder", "series", "season", "episode") }
    }

  /** Cancels every running mosaic load; finished answers stay cached for a return. */
  private fun cancelPreviews() {
    previewEpoch++
    previewJobs.values.forEach { it.cancel() }
    previewJobs.clear()
    previews = previews.filterValues { it !is RemotePreviewState.Loading }
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
          is RemoteLevel.Directory -> level.copy(state = level.state.copy(loading = false, loadingMore = false))
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
      is RemoteLevel.Directory -> current.copy(state = transform(current.state))
      is RemoteLevel.Episodes -> current.copy(state = transform(current.state))
    }
    val levels = state.levels.toMutableList()
    levels[index] = next
    state = state.copy(levels = levels)
  }

  private fun kindOf(error: Throwable): RemoteErrorKind =
    if ((error as? ApiError)?.failure == ApiFailure.Unreachable) RemoteErrorKind.Offline else RemoteErrorKind.Failed

  companion object {
    /** The page size the browse route defaults to; the client never asks for a scan. */
    const val BROWSE_LIMIT = 60
    const val FOLDERS_MODE = "folders"
    const val TITLES_MODE = "titles"
    const val EPISODE_TYPE = "episode"
    /** At most two preview mosaics are fetched at once, as the web client does. */
    const val MAX_PREVIEWS = 2

    /** The cache key of one root or folder tile's mosaic. */
    fun previewKey(libraryId: String, parentId: String?): String = "$libraryId|${parentId ?: ""}"

    /** A mixed library browses folders by default; movies and series browse flat titles. */
    fun effectiveMode(library: RemoteLibraryDto): String {
      val chosen = library.browseMode
      if (chosen == FOLDERS_MODE || chosen == TITLES_MODE) return chosen
      return if (library.type == "mixed") FOLDERS_MODE else TITLES_MODE
    }

    fun factory(api: RemoteLibraryApi) = viewModelFactory { initializer { RemoteLibraryViewModel(api) } }
  }
}
