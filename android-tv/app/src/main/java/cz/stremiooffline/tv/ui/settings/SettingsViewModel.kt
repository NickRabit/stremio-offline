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
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.diagnostics.AppLog
import kotlinx.coroutines.CancellationException
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

  /** The last arrangement the server accepted, so a rejected write can go back to it. */
  private var savedHomeRows: List<HomeLayoutRow> = emptyList()
  private var savedHomeLayout: HomeLayoutDto = HomeLayoutDto()
  private var pendingHomeLayout: HomeLayoutDto? = null
  private var hasPendingHomeLayout = false

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
  }

  /** Reads everything the account may arrange; a server without the route offers nothing. */
  private suspend fun loadHomeLayout() {
    homeLayout = try {
      val answer = api.homeLayout()
      val rows = answer.rows.filter { it.added }.map { HomeLayoutRow(it.id, it.kind, it.label, it.shown) }
      savedHomeRows = rows
      savedHomeLayout = answer.layout
      HomeLayoutState.Ready(rows = rows, layout = answer.layout)
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      HomeLayoutState.Unavailable
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

  /** Sends whatever an edit left waiting, at once: the panel calls this as it closes. */
  fun flushHomeLayout() {
    if (!hasPendingHomeLayout) return
    val layout = pendingHomeLayout
    // The draft the write carries, kept for the accepted snapshot: a newer edit that arrives
    // while the PATCH is in flight must not be recorded as saved.
    val sent = homeLayout as? HomeLayoutState.Ready
    hasPendingHomeLayout = false
    pendingHomeLayout = null
    viewModelScope.launch {
      try {
        api.updateHomeLayout(layout)
        if (sent != null) {
          savedHomeRows = sent.rows
          savedHomeLayout = sent.layout
        }
        val ready = homeLayout as? HomeLayoutState.Ready ?: return@launch
        homeLayout = ready.copy(failure = null, message = null)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        val ready = homeLayout as? HomeLayoutState.Ready ?: return@launch
        homeLayout = ready.copy(rows = savedHomeRows, layout = savedHomeLayout, failure = error.failure, message = error.serverMessage)
      }
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
