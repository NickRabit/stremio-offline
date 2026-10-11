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
