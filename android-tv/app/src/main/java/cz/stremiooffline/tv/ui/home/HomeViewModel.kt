package cz.stremiooffline.tv.ui.home

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import cz.stremiooffline.tv.data.DownloadDto
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.HomeResponseDto
import cz.stremiooffline.tv.data.HomeRowStatus
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.data.decodeHomeRow
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The web's rule for a catalogue row that came back before the addon answered. */
const val PARTIAL_RETRY_MS = 2_500L
const val PARTIAL_RETRIES = 3

sealed interface RowContent {
  /** A catalogue row that has not come within a row of focus yet. */
  data object Placeholder : RowContent

  data object Loading : RowContent

  data class Cards(val items: List<HomeCard>, val hasMore: Boolean, val partial: Boolean) : RowContent

  data object Error : RowContent
}

data class HomeRowSlot(
  val id: String,
  val title: String?,
  val catalog: Boolean,
  val content: RowContent,
  /** Automatic partial retries already spent; reset by a non-partial answer or a reload. */
  val attempts: Int = 0,
  /** Bumped on every answer, so a retry timer restarts on a fresh partial answer. */
  val answerSeq: Int = 0,
)

data class HomeState(
  val rows: List<HomeRowSlot> = emptyList(),
  val loading: Boolean = true,
  /** Either of the two built-in requests failed, so the page shows its own error panel. */
  val failed: Boolean = false,
  val downloads: List<DownloadDto> = emptyList(),
  /** Bumped whenever rows land, so the screen can restore the remembered card. */
  val dataVersion: Int = 0,
)

/** True when a row has something to draw: an empty, complete row is the only one left out. */
fun drawnContent(content: RowContent): Boolean = when (content) {
  is RowContent.Cards -> content.items.isNotEmpty() || content.partial
  else -> true
}

/** The rows a page draws, in the server's order. */
fun drawnRowIds(rows: List<HomeRowSlot>): List<String> = rows.filter { drawnContent(it.content) }.map { it.id }

/**
 * The Home rows: the `order` probe, the built-in request, the lazy catalogue carousels and the
 * downloads summary. Rows are keyed by id, so a retry touches only the row it names.
 */
class HomeViewModel(private val api: TvApi) : ViewModel() {

  var state by mutableStateOf(HomeState())
    private set

  private var started = false
  private val pendingReveal = mutableSetOf<String>()
  private var revealJob: Job? = null

  fun start() {
    if (started) return
    started = true
    load()
  }

  /** Re-entering Home, or returning from detail or the player: built-in rows and every
   *  catalogue row already revealed, and every partial counter starts again. */
  fun refresh() {
    if (!started) {
      start()
      return
    }
    load()
  }

  private fun load() {
    viewModelScope.launch {
      val existing = state.rows.associateBy { it.id }
      state = state.copy(loading = existing.isEmpty(), failed = false)
      val probe = runCatching { api.home(emptyList()) }.getOrNull()
      if (probe == null) {
        state = state.copy(loading = false, failed = true)
        return@launch
      }
      // `confirm` is administrator curation and never drawn; every other ordered id gets a slot.
      val slots = probe.order.filter { it.id != "confirm" }.map { entry ->
        existing[entry.id]?.copy(title = entry.title, attempts = 0)
          ?: HomeRowSlot(entry.id, entry.title, entry.catalog, if (entry.catalog) RowContent.Placeholder else RowContent.Loading)
      }
      state = state.copy(rows = slots)

      val builtin = slots.filter { !it.catalog }.map { it.id }
      if (builtin.isNotEmpty()) {
        val answer = runCatching { api.home(builtin) }.getOrNull()
        if (answer == null) {
          state = state.copy(loading = false, failed = true)
          return@launch
        }
        apply(builtin, answer, catalog = false)
      }
      state = state.copy(loading = false)

      val revealed = revealedCatalogRows(slots)
      if (revealed.isNotEmpty()) {
        runCatching { api.home(revealed) }.getOrNull()?.let { apply(revealed, it, catalog = true) }
      }
      refreshDownloads()
    }
  }

  /** The catalogue rows already on screen, which a refresh asks again along with the built-ins. */
  private fun revealedCatalogRows(slots: List<HomeRowSlot>): List<String> =
    slots.filter { it.catalog && it.content != RowContent.Placeholder }.map { it.id }

  private fun refreshDownloads() {
    viewModelScope.launch {
      val jobs = runCatching { api.downloads() }.getOrNull()?.jobs ?: return@launch
      state = state.copy(downloads = jobs)
    }
  }

  /** A catalogue row came within a row of focus: reveal it, batching rows revealed together. */
  fun reveal(rowId: String) {
    val slot = state.rows.firstOrNull { it.id == rowId } ?: return
    if (!slot.catalog || slot.content != RowContent.Placeholder) return
    update(rowId) { it.copy(content = RowContent.Loading, answerSeq = it.answerSeq + 1) }
    pendingReveal += rowId
    if (revealJob?.isActive == true) return
    revealJob = viewModelScope.launch {
      // Rows revealed in the same moment go out as one request.
      delay(0)
      val ids = pendingReveal.toList()
      pendingReveal.clear()
      if (ids.isEmpty()) return@launch
      val answer = runCatching { api.home(ids) }.getOrNull()
      if (answer == null) ids.forEach { id -> update(id) { it.copy(content = RowContent.Error, answerSeq = it.answerSeq + 1) } }
      else apply(ids, answer, catalog = true)
    }
  }

  /** The Try again button of one row: asks that row alone and leaves the others alone. */
  fun retry(rowId: String) {
    viewModelScope.launch {
      val catalog = state.rows.firstOrNull { it.id == rowId }?.catalog == true
      val answer = runCatching { api.home(listOf(rowId)) }.getOrNull()
      if (answer == null) update(rowId) { it.copy(content = RowContent.Error, answerSeq = it.answerSeq + 1) }
      else apply(listOf(rowId), answer, catalog = catalog)
    }
  }

  /** The automatic partial retry, fired by the screen after [PARTIAL_RETRY_MS]. */
  fun autoRetry(rowId: String) {
    val slot = state.rows.firstOrNull { it.id == rowId } ?: return
    if (!slot.catalog || slot.attempts >= PARTIAL_RETRIES) return
    update(rowId) { it.copy(attempts = it.attempts + 1) }
    retry(rowId)
  }

  private fun apply(ids: List<String>, response: HomeResponseDto, catalog: Boolean) {
    val wanted = ids.toSet()
    state = state.copy(
      rows = state.rows.map { slot ->
        if (slot.id !in wanted) slot
        else {
          val row = response.rows[slot.id]
          val content = if (row == null) {
            RowContent.Cards(emptyList(), false, false)
          } else {
            val decoded = decodeHomeRow(row)
            if (decoded.status == HomeRowStatus.Error) RowContent.Error
            else RowContent.Cards(decoded.items, decoded.hasMore, decoded.partial)
          }
          val attempts = if (catalog && content is RowContent.Cards && !content.partial) 0 else slot.attempts
          slot.copy(content = content, attempts = attempts, answerSeq = slot.answerSeq + 1)
        }
      },
      dataVersion = state.dataVersion + 1,
    )
  }

  private fun update(rowId: String, transform: (HomeRowSlot) -> HomeRowSlot) {
    state = state.copy(rows = state.rows.map { if (it.id == rowId) transform(it) else it })
  }

  companion object {
    fun factory(api: TvApi) = viewModelFactory { initializer { HomeViewModel(api) } }
  }
}
