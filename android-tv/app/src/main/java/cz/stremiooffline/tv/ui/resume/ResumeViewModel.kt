package cz.stremiooffline.tv.ui.resume

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.ResumeApi
import cz.stremiooffline.tv.data.ResumeFilter
import cz.stremiooffline.tv.data.ResumePage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

data class ResumeState(
  val filter: ResumeFilter = ResumeFilter.All,
  val items: List<HomeCard> = emptyList(),
  val total: Int = 0,
  val loading: Boolean = true,
  val loadingMore: Boolean = false,
  val error: Boolean = false,
)

/** The one Continue watching grid: the merged list, its filter and its pages. Held in a view
 *  model so the filter and the rows survive a rail section switch without being persisted. */
class ResumeViewModel(private val api: ResumeApi) : ViewModel() {

  var state by mutableStateOf(ResumeState())
    private set

  /** The card the grid last focused, kept across a section swap and a detail return. */
  var selectedKey by mutableStateOf("")

  private var job: Job? = null
  private var started = false

  fun start() {
    if (started) return
    started = true
    load(ResumeFilter.All)
  }

  fun select(filter: ResumeFilter) {
    if (filter == state.filter) return
    selectedKey = ""
    load(filter)
  }

  /** Re-reads the current filter on return: a title forgotten in a detail disappears. */
  fun refresh() {
    val filter = state.filter
    if (state.loading) return
    job?.cancel()
    job = viewModelScope.launch {
      val page = pageOrNull(filter, 0) ?: return@launch
      state = state.copy(items = page.items, total = page.total, loading = false, loadingMore = false, error = false)
    }
  }

  fun retry() {
    load(state.filter)
  }

  fun loadMore() {
    if (state.loading || state.loadingMore || state.items.size >= state.total) return
    state = state.copy(loadingMore = true)
    job = viewModelScope.launch {
      try {
        val page = api.resume(state.filter, limit = PAGE, skip = state.items.size)
        state = state.copy(items = state.items + page.items, total = page.total.coerceAtLeast(state.total), loadingMore = false)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        state = state.copy(loadingMore = false)
      }
    }
  }

  private fun load(filter: ResumeFilter) {
    job?.cancel()
    state = state.copy(filter = filter, items = emptyList(), total = 0, loading = true, loadingMore = false, error = false)
    job = viewModelScope.launch {
      val page = pageOrNull(filter, 0)
      state = if (page == null) {
        state.copy(loading = false, error = true)
      } else {
        state.copy(items = page.items, total = page.total, loading = false, error = false)
      }
    }
  }

  private suspend fun pageOrNull(filter: ResumeFilter, skip: Int): ResumePage? = try {
    api.resume(filter, limit = PAGE, skip = skip)
  } catch (cancelled: CancellationException) {
    throw cancelled
  } catch (_: ApiError) {
    null
  }

  companion object {
    const val PAGE = 60

    fun factory(api: ResumeApi) = viewModelFactory { initializer { ResumeViewModel(api) } }
  }
}
