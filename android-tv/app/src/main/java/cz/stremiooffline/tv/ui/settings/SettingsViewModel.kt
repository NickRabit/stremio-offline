package cz.stremiooffline.tv.ui.settings

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.ClientLogBundleDto
import cz.stremiooffline.tv.data.HomeLayoutDto
import cz.stremiooffline.tv.data.LanguageDto
import cz.stremiooffline.tv.data.SearchStateDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.diagnostics.AppLog
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** The personal settings the Settings screen shows and edits. */
data class SettingsState(
  val uiLanguage: String? = null,
  val audioLanguage: String? = null,
  val subtitleLanguage: String? = null,
  val startView: String? = null,
  val serverVersion: String? = null,
  /** The last write that failed; the screen shows it and the row already holds the old value. */
  val error: ApiFailure? = null,
)

/** What the Send diagnostics row shows after OK. */
sealed interface DiagnosticsState {
  data object Idle : DiagnosticsState
  data object Sending : DiagnosticsState
  data class Sent(val id: String) : DiagnosticsState
  /** The failure the row explains: the server's own message when it sent one, the kind otherwise. */
  data class Failed(val failure: ApiFailure, val serverMessage: String? = null) : DiagnosticsState
}

/** One row of the personal Home arrangement: what it is, what it is called and whether Home draws it. */
data class HomeLayoutRow(
  val id: String,
  val kind: String,
  val label: String,
  val shown: Boolean,
)

/** The personal Home arrangement the settings panel edits. */
sealed interface HomeLayoutState {
  /** Still asking `GET /api/home/layout`. */
  data object Loading : HomeLayoutState

  /** The server has no `/api/home/layout` (an older one): the Settings row says so and does nothing. */
  data object Unavailable : HomeLayoutState

  data class Ready(
    val rows: List<HomeLayoutRow>,
    val layout: HomeLayoutDto,
    /** Bumped by every edit, so the panel restarts its debounce. */
    val changeSeq: Int = 0,
    /** Set by a rejected write: the panel shows it and the rows are back where the server had them. */
    val failure: ApiFailure? = null,
    val message: String? = null,
  ) : HomeLayoutState
}

/**
 * Reads the account's own preferences and writes one field at a time. The interface language is
 * also handed to [onLocale] so the app switches at once; the PATCH and the locale change are two
 * halves of the same choice.
 */
class SettingsViewModel(
  private val api: TvApi,
  private val onLocale: (String) -> Unit,
) : ViewModel() {

  var state by mutableStateOf(SettingsState())
    private set

  var languages by mutableStateOf(emptyList<LanguageDto>())
    private set

  var diagnostics by mutableStateOf<DiagnosticsState>(DiagnosticsState.Idle)
    private set

  var homeLayout by mutableStateOf<HomeLayoutState>(HomeLayoutState.Loading)
    private set

  /** The account's search history, read for the Clear search history row; null until it is known. */
  var searchState by mutableStateOf<SearchStateDto?>(null)
    private set

  /** Counts the clears that landed; the screen shows the shell's notice once per clear. */
  var historyCleared by mutableStateOf(0)
    private set

  /** The last arrangement the server accepted, so a rejected write can go back to it. */
  private var savedHomeRows: List<HomeLayoutRow> = emptyList()
  private var savedHomeLayout: HomeLayoutDto = HomeLayoutDto()
  private var pendingHomeLayout: HomeLayoutDto? = null
  private var hasPendingHomeLayout = false
  /** The arrangement that arrived while a PATCH was in flight; only the newest one is kept. */
  private var queuedHomeLayout: HomeLayoutDto? = null
  private var hasQueuedHomeLayout = false
  private var homeSaveJob: Job? = null

  init {
    viewModelScope.launch {
      val settings = runCatching { api.settings() }.getOrNull()
      languages = runCatching { api.languages() }.getOrDefault(emptyList())
      val version = runCatching { api.serverVersion() }.getOrNull()
      state = SettingsState(
        uiLanguage = settings?.uiLanguage,
        audioLanguage = settings?.audioLanguage,
        subtitleLanguage = settings?.subtitleLanguage,
        startView = settings?.startView,
        serverVersion = version,
      )
    }
    viewModelScope.launch { loadHomeLayout() }
    viewModelScope.launch {
      searchState = try {
        api.searchState()
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        null
      }
    }
  }

  /** Empties the account's search history, shared with the web. */
  fun clearSearchHistory() {
    viewModelScope.launch {
      val next = try {
        api.clearSearchHistory()
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        return@launch
      }
      searchState = next
      historyCleared += 1
    }
  }

  /** Reads the arrangement again; the panel asks for this as it opens, so a layout changed on the
   *  web or on another device is never shown stale for the rest of the session. */
  fun refreshHomeLayout() {
    // A write in flight or waiting lands in a moment; reading past it could show it half-applied.
    if (hasPendingHomeLayout || hasQueuedHomeLayout || homeSaveJob?.isActive == true) return
    viewModelScope.launch { loadHomeLayout() }
  }

  /** Reads everything the account may arrange. Only a server without the route offers nothing;
   *  any other failure keeps what the server last accepted and says why, to be retried. */
  private suspend fun loadHomeLayout(failure: ApiFailure? = null, message: String? = null) {
    homeLayout = try {
      val answer = api.homeLayout()
      val rows = answer.rows.filter { it.added }.map { HomeLayoutRow(it.id, it.kind, it.label, it.shown) }
      savedHomeRows = rows
      savedHomeLayout = answer.layout
      HomeLayoutState.Ready(rows = rows, layout = answer.layout, failure = failure, message = message)
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (error: ApiError) {
      if (error.failure == ApiFailure.NotFound) {
        HomeLayoutState.Unavailable
      } else {
        HomeLayoutState.Ready(
          rows = savedHomeRows,
          layout = savedHomeLayout,
          failure = failure ?: error.failure,
          message = message ?: error.serverMessage,
        )
      }
    }
  }

  /** The show/hide action flips the row's mark; `confirm` is the same switch and nothing more. */
  fun toggleHomeRow(id: String) {
    val ready = homeLayout as? HomeLayoutState.Ready ?: return
    val hidden = ready.layout.hidden.toMutableList()
    if (!hidden.remove(id)) hidden.add(id)
    val rows = ready.rows.map { if (it.id == id) it.copy(shown = !it.shown) else it }
    draftHomeLayout(ready.copy(rows = rows, layout = ready.layout.copy(hidden = hidden), failure = null, message = null), clear = false)
  }

  /** One step up or down: the row changes places and the order travels with it. */
  fun moveHomeRow(id: String, delta: Int) {
    val ready = homeLayout as? HomeLayoutState.Ready ?: return
    val order = ready.layout.order.toMutableList()
    val from = order.indexOf(id)
    if (from < 0) return
    val to = (from + delta).coerceIn(0, order.size - 1)
    if (to == from) return
    order.removeAt(from)
    order.add(to, id)
    applyHomeOrder(ready, order)
  }

  /** "Move to the top": the row goes to the front of the arrangement. */
  fun moveHomeRowToTop(id: String) {
    val ready = homeLayout as? HomeLayoutState.Ready ?: return
    val order = ready.layout.order.toMutableList()
    val from = order.indexOf(id)
    if (from <= 0) return
    order.removeAt(from)
    order.add(0, id)
    applyHomeOrder(ready, order)
  }

  private fun applyHomeOrder(ready: HomeLayoutState.Ready, order: List<String>) {
    val rows = order.mapNotNull { id -> ready.rows.firstOrNull { it.id == id } }
    draftHomeLayout(ready.copy(rows = rows, layout = ready.layout.copy(order = order), failure = null, message = null), clear = false)
  }

  /** Reset to default clears the whole arrangement with a `null`. */
  fun resetHomeLayout() {
    val ready = homeLayout as? HomeLayoutState.Ready ?: return
    val rows = ready.rows.map { it.copy(shown = true) }
    draftHomeLayout(ready.copy(rows = rows, layout = HomeLayoutDto(), failure = null, message = null), clear = true)
  }

  private fun draftHomeLayout(next: HomeLayoutState.Ready, clear: Boolean) {
    homeLayout = next.copy(changeSeq = next.changeSeq + 1)
    pendingHomeLayout = if (clear) null else next.layout
    hasPendingHomeLayout = true
  }

  /** Sends whatever an edit left waiting: the panel calls this once the edits stop and as it
   *  closes. One PATCH is in flight at a time; a newer arrangement replaces whatever is still
   *  waiting, so the last edit always lands last. */
  fun flushHomeLayout() {
    if (!hasPendingHomeLayout) return
    val layout = pendingHomeLayout
    val rows = (homeLayout as? HomeLayoutState.Ready)?.rows ?: savedHomeRows
    hasPendingHomeLayout = false
    pendingHomeLayout = null
    if (homeSaveJob?.isActive == true) {
      queuedHomeLayout = layout
      hasQueuedHomeLayout = true
      return
    }
    homeSaveJob = viewModelScope.launch { saveHomeLayout(layout, rows) }
  }

  private suspend fun saveHomeLayout(first: HomeLayoutDto?, firstRows: List<HomeLayoutRow>) {
    var layout = first
    var rows = firstRows
    while (true) {
      try {
        api.updateHomeLayout(layout)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        // The edit that failed -- and any draft resting on it -- is gone; the read puts the
        // arrangement back where the server has it.
        hasQueuedHomeLayout = false
        queuedHomeLayout = null
        hasPendingHomeLayout = false
        pendingHomeLayout = null
        loadHomeLayout(failure = error.failure, message = error.serverMessage)
        return
      }
      // Nothing newer arrived while this PATCH was in flight: it was the last edit.
      if (!hasQueuedHomeLayout) {
        savedHomeRows = rows
        savedHomeLayout = layout ?: HomeLayoutDto()
        val ready = homeLayout as? HomeLayoutState.Ready ?: return
        homeLayout = ready.copy(failure = null, message = null)
        return
      }
      layout = queuedHomeLayout
      rows = (homeLayout as? HomeLayoutState.Ready)?.rows ?: rows
      hasQueuedHomeLayout = false
      queuedHomeLayout = null
    }
  }

  fun setUiLanguage(code: String) {
    val before = state.uiLanguage
    state = state.copy(uiLanguage = code, error = null)
    onLocale(code)
    viewModelScope.launch {
      try {
        val answer = api.updateSettings("uiLanguage", code)
        answer.uiLanguage?.let { state = state.copy(uiLanguage = it) }
      } catch (error: ApiError) {
        state = state.copy(uiLanguage = before, error = error.failure)
      }
    }
  }

  fun setAudioLanguage(code: String) {
    val before = state.audioLanguage
    state = state.copy(audioLanguage = code, error = null)
    viewModelScope.launch {
      try {
        val answer = api.updateSettings("audioLanguage", code)
        answer.audioLanguage?.let { state = state.copy(audioLanguage = it) }
      } catch (error: ApiError) {
        state = state.copy(audioLanguage = before, error = error.failure)
      }
    }
  }

  fun setSubtitleLanguage(code: String) {
    val before = state.subtitleLanguage
    state = state.copy(subtitleLanguage = code, error = null)
    viewModelScope.launch {
      try {
        val answer = api.updateSettings("subtitleLanguage", code)
        answer.subtitleLanguage?.let { state = state.copy(subtitleLanguage = it) }
      } catch (error: ApiError) {
        state = state.copy(subtitleLanguage = before, error = error.failure)
      }
    }
  }

  fun setStartView(view: String) {
    val before = state.startView
    state = state.copy(startView = view, error = null)
    viewModelScope.launch {
      try {
        val answer = api.updateSettings("startView", view)
        answer.startView?.let { state = state.copy(startView = it) }
      } catch (error: ApiError) {
        state = state.copy(startView = before, error = error.failure)
      }
    }
  }

  /** Posts the buffer, with the crash the previous run left, as one bundle. */
  fun sendDiagnostics(app: String, device: String, crash: String?) {
    if (diagnostics == DiagnosticsState.Sending) return
    diagnostics = DiagnosticsState.Sending
    val bundle = ClientLogBundleDto(client = "tv", app = app, device = device, note = null, lines = AppLog.bundleLines(crash))
    viewModelScope.launch {
      diagnostics = try {
        DiagnosticsState.Sent(api.sendClientLogBundle(bundle))
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        DiagnosticsState.Failed(error.failure, error.serverMessage)
      }
    }
  }

  companion object {
    fun factory(api: TvApi, onLocale: (String) -> Unit) =
      viewModelFactory { initializer { SettingsViewModel(api, onLocale) } }
  }
}
