package cz.stremiooffline.tv.ui.search

import androidx.annotation.StringRes
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.GlobalSearchAliasDto
import cz.stremiooffline.tv.data.GlobalSearchApi
import cz.stremiooffline.tv.data.GlobalSearchClusterDto
import cz.stremiooffline.tv.data.GlobalSearchLibraryDto
import cz.stremiooffline.tv.data.GlobalSearchMemberPageDto
import cz.stremiooffline.tv.data.GlobalSearchSnapshotDto
import cz.stremiooffline.tv.data.GlobalSearchStartDto
import cz.stremiooffline.tv.data.RecentSearchDto
import cz.stremiooffline.tv.data.SearchScope
import cz.stremiooffline.tv.data.SearchStateDto
import cz.stremiooffline.tv.data.SearchableCatalogDto
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

enum class SourceClass(val wire: String) {
  Catalog("catalog"),
  Local("local"),
  Remote("remote"),
}

enum class KindFilter(val wire: String) {
  All("all"),
  Movies("movie"),
  Series("series"),
}

data class GlobalSearchState(
  val committed: String = "",
  val sources: Set<SourceClass> = emptySet(),
  val scope: SearchScope = SearchScope(),
  val searchable: List<SearchableCatalogDto> = emptyList(),
  val kind: KindFilter = KindFilter.All,
  val snapshot: GlobalSearchSnapshotDto? = null,
  val order: List<String> = emptyList(),
  val unidentifiedOrder: List<String> = emptyList(),
  val previousQuery: Boolean = false,
  /** The account's recent searches, newest first; empty while none are kept or the read failed. */
  val recent: List<RecentSearchDto> = emptyList(),
  /** False once the account has switched history saving off: nothing is recorded then. */
  val saveHistory: Boolean = true,
  @StringRes val error: Int? = null,
  val loading: Boolean = false,
  val focusAnchor: String? = null,
) {
  val submitted: Boolean get() = committed.isNotEmpty()
  val hasMore: Boolean get() = snapshot?.sources?.any { it.hasMore } == true
}

internal fun mergeGlobalSearchOrder(
  previous: List<String>,
  clusters: List<GlobalSearchClusterDto>,
  aliases: List<GlobalSearchAliasDto>,
): List<String> {
  val present = clusters.mapTo(hashSetOf()) { it.key }
  val retired = aliases.associate { it.retired to it.current }
  fun resolve(key: String): String {
    val seen = hashSetOf<String>()
    var current = key
    while (current in retired && seen.add(current)) current = retired.getValue(current)
    return current
  }

  val result = mutableListOf<String>()
  val added = hashSetOf<String>()
  for (key in previous) {
    val current = resolve(key)
    if (current in present && added.add(current)) result += current
  }
  for (cluster in clusters) {
    if (added.add(cluster.key)) result += cluster.key
  }
  return result
}

internal fun retainedFocusAnchor(
  anchor: String?,
  oldOrder: List<String>,
  oldClusters: List<GlobalSearchClusterDto>,
  newClusters: List<GlobalSearchClusterDto>,
  aliases: List<GlobalSearchAliasDto> = emptyList(),
): String? {
  if (anchor == null) return null
  if (newClusters.any { anchor in it.memberKeys }) return anchor
  val oldIndex = oldClusters.indexOfFirst { anchor in it.memberKeys }
    .takeIf { it >= 0 }
    ?.let { cluster -> oldOrder.indexOf(oldClusters[cluster].key) }
    ?: return null
  val retired = aliases.associate { it.retired to it.current }
  fun resolve(key: String): String {
    val seen = hashSetOf<String>()
    var current = key
    while (current in retired && seen.add(current)) current = retired.getValue(current)
    return current
  }
  fun following(oldKey: String): GlobalSearchClusterDto? {
    val old = oldClusters.firstOrNull { it.key == oldKey } ?: return null
    return newClusters.firstOrNull { it.key == resolve(oldKey) }
      ?: newClusters.firstOrNull { candidate -> candidate.memberKeys.any { it in old.memberKeys } }
  }
  for (index in oldIndex + 1 until oldOrder.size) {
    following(oldOrder[index])?.let { return it.memberKeys.firstOrNull() ?: it.key }
  }
  for (index in oldIndex - 1 downTo 0) {
    following(oldOrder[index])?.let { return it.memberKeys.firstOrNull() ?: it.key }
  }
  return null
}

class GlobalSearchViewModel(
  private val api: GlobalSearchApi,
  private val slotId: String = UUID.randomUUID().toString().replace("-", ""),
  private val library: GlobalSearchLibraryDto? = null,
  sources: Set<SourceClass>? = null,
) : ViewModel() {

  private val fixedSources = sources
  private val keepsHistory = library == null && sources == null

  var state by mutableStateOf(GlobalSearchState(sources = fixedSources.orEmpty()))
    private set

  private var generation = 0
  private var sessionId: String? = null
  private var revision = 0
  private var restartDepth = 0
  private var active = false
  private var interacted = false
  private var searchableLoaded = false
  private var startJob: Job? = null
  private var pollJob: Job? = null
  private var actionJob: Job? = null

  fun submit(query: String) {
    val trimmed = query.trim()
    if (trimmed.isEmpty()) return
    restartDepth = 0
    startSearch(trimmed, freshLayout = true, record = keepsHistory)
  }

  fun refreshRecent() {
    if (!keepsHistory) return
    viewModelScope.launch { loadRecent() }
  }

  fun forget(query: String) {
    if (!keepsHistory) return
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

  fun setSources(sources: Set<SourceClass>) {
    if (fixedSources != null) return
    if (sources == state.sources) return
    state = state.copy(
      sources = sources,
      scope = state.scope.takeIf { sources == setOf(SourceClass.Catalog) } ?: SearchScope(),
    )
    if (state.committed.isNotEmpty()) startSearch(state.committed, freshLayout = true)
  }

  fun loadSearchable() {
    if (searchableLoaded) return
    searchableLoaded = true
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

  fun setScope(scope: SearchScope) {
    if (fixedSources != null) return
    val scopedSources = setOf(SourceClass.Catalog)
    if (state.scope == scope && state.sources == scopedSources) return
    state = state.copy(sources = scopedSources, scope = scope)
    if (state.committed.isNotEmpty()) startSearch(state.committed, freshLayout = true)
  }

  fun setKind(kind: KindFilter) {
    if (fixedSources != null) return
    if (kind == state.kind) return
    state = state.copy(kind = kind)
    if (state.committed.isNotEmpty()) startSearch(state.committed, freshLayout = true)
  }

  fun setActive(value: Boolean) {
    active = value
    if (value) launchPoll(generation, 0) else pollJob?.cancel()
  }

  fun setFocusAnchor(anchor: String?) {
    if (anchor != null) interacted = true
    if (anchor != state.focusAnchor) state = state.copy(focusAnchor = anchor)
  }

  fun loadMore() {
    val id = sessionId ?: return
    if (actionJob?.isActive == true) return
    interacted = true
    val currentGeneration = generation
    actionJob = viewModelScope.launch {
      try {
        api.pageGlobalSearch(id)
        if (currentGeneration == generation) launchPoll(currentGeneration, 0)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        handleError(error, currentGeneration, state.committed)
      }
    }
  }

  fun retry(sourceId: String) {
    val id = sessionId ?: return
    val currentGeneration = generation
    actionJob = viewModelScope.launch {
      try {
        api.retryGlobalSearchSource(id, sourceId)
        if (currentGeneration == generation) launchPoll(currentGeneration, 0)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        handleError(error, currentGeneration, state.committed)
      }
    }
  }

  suspend fun members(memberKey: String, from: Int): GlobalSearchMemberPageDto {
    val id = sessionId ?: throw ApiError(ApiFailure.Generic)
    val currentGeneration = generation
    try {
      val page = api.globalSearchMembers(id, memberKey, from)
      if (currentGeneration != generation) throw ApiError(ApiFailure.Generic)
      return page
    } catch (error: ApiError) {
      if (error.status == 410) restartExpired(currentGeneration)
      throw error
    }
  }

  fun leave() {
    val id = sessionId
    generation += 1
    active = false
    startJob?.cancel()
    pollJob?.cancel()
    actionJob?.cancel()
    sessionId = null
    revision = 0
    restartDepth = 0
    state = GlobalSearchState()
    searchableLoaded = false
    if (id != null) viewModelScope.launch { api.deleteGlobalSearch(id) }
  }

  override fun onCleared() {
    val id = sessionId
    generation += 1
    startJob?.cancel()
    pollJob?.cancel()
    actionJob?.cancel()
    sessionId = null
    if (id != null) {
      CoroutineScope(SupervisorJob() + Dispatchers.IO).launch { api.deleteGlobalSearch(id) }
    }
    super.onCleared()
  }

  private fun startSearch(query: String, freshLayout: Boolean, record: Boolean = false) {
    if (freshLayout) interacted = false
    val currentGeneration = ++generation
    startJob?.cancel()
    pollJob?.cancel()
    actionJob?.cancel()
    val requestSources = fixedSources ?: state.sources.ifEmpty { SourceClass.entries.toSet() }
    state = state.copy(
      committed = query,
      previousQuery = state.snapshot != null,
      error = null,
      loading = true,
    )
    startJob = viewModelScope.launch {
      try {
        val answer = api.startGlobalSearch(
          GlobalSearchStartDto(
            query = query,
            kind = state.kind.wire,
            sources = requestSources.sortedBy { it.ordinal }.map { it.wire },
            slotId = slotId,
            generation = currentGeneration,
            scope = state.scope.takeIf {
              fixedSources == null &&
              requestSources == setOf(SourceClass.Catalog) && !it.addonKey.isNullOrEmpty()
            },
            library = library,
          ),
        )
        if (currentGeneration != generation) return@launch
        sessionId = answer.id
        applySnapshot(answer.snapshot, freshLayout)
        if (record) noteQuery(query)
        launchPoll(currentGeneration, 0)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        handleError(error, currentGeneration, query)
      }
    }
  }

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

  private fun launchPoll(currentGeneration: Int, wait: Long) {
    pollJob?.cancel()
    if (!active || sessionId == null || currentGeneration != generation) return
    pollJob = viewModelScope.launch {
      if (wait > 0) delay(wait)
      while (active && currentGeneration == generation) {
        val id = sessionId ?: break
        val answer = try {
          api.pollGlobalSearch(id, revision)
        } catch (cancelled: CancellationException) {
          throw cancelled
        } catch (error: ApiError) {
          handleError(error, currentGeneration, state.committed)
          break
        }
        if (currentGeneration != generation) break
        if (answer.changed && answer.snapshot != null) {
          applySnapshot(answer.snapshot, freshLayout = false)
          continue
        }
        delay(if (state.snapshot?.state == "partial") 250 else 1_000)
      }
    }
  }

  private fun applySnapshot(next: GlobalSearchSnapshotDto, freshLayout: Boolean) {
    val oldOrder = state.order
    val oldClusters = state.snapshot?.clusters.orEmpty()
    val adoptServerOrder = freshLayout || !interacted
    val order = if (adoptServerOrder) next.clusters.map { it.key }
    else mergeGlobalSearchOrder(oldOrder, next.clusters, next.aliases)
    val unidentified = if (adoptServerOrder) next.unidentified.map { it.key }
    else mergeGlobalSearchOrder(state.unidentifiedOrder, next.unidentified, next.aliases)
    val anchor = retainedFocusAnchor(state.focusAnchor, oldOrder, oldClusters, next.clusters, next.aliases)
    revision = next.revision
    state = state.copy(
      snapshot = next,
      order = order,
      unidentifiedOrder = unidentified,
      previousQuery = false,
      error = null,
      loading = false,
      focusAnchor = anchor,
    )
  }

  private fun handleError(error: ApiError, currentGeneration: Int, query: String) {
    if (currentGeneration != generation) return
    if (error.status == 410) {
      restartExpired(currentGeneration)
      return
    }
    pollJob?.cancel()
    state = state.copy(loading = false, error = R.string.tv_load_error)
  }

  private fun restartExpired(currentGeneration: Int) {
    if (currentGeneration != generation) return
    if (restartDepth == 0) {
      restartDepth = 1
      sessionId = null
      startSearch(state.committed, freshLayout = false)
    } else {
      pollJob?.cancel()
      sessionId = null
      state = state.copy(loading = false, error = R.string.tv_global_search_restart_failed)
    }
  }

  companion object {
    fun factory(
      api: GlobalSearchApi,
      library: GlobalSearchLibraryDto? = null,
      sources: Set<SourceClass>? = null,
    ) = viewModelFactory {
      initializer { GlobalSearchViewModel(api, library = library, sources = sources) }
    }
  }
}
