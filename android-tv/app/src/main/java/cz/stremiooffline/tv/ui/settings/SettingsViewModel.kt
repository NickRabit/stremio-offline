package cz.stremiooffline.tv.ui.settings

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import cz.stremiooffline.tv.data.LanguageDto
import cz.stremiooffline.tv.data.TvApi
import kotlinx.coroutines.launch

/** The personal settings the Settings screen shows and edits. */
data class SettingsState(
  val loaded: Boolean = false,
  val uiLanguage: String? = null,
  val audioLanguage: String? = null,
  val subtitleLanguage: String? = null,
  val startView: String? = null,
  val serverVersion: String? = null,
)

/** The settings screen's state and the four writes it fires, so a screen test can drive it. */
interface SettingsActions {
  val state: SettingsState
  val languages: List<LanguageDto>
  fun setUiLanguage(code: String)
  fun setAudioLanguage(code: String)
  fun setSubtitleLanguage(code: String)
  fun setStartView(view: String)
}

/**
 * Reads the account's own preferences and writes one field at a time. The interface language is
 * also handed to [onLocale] so the app switches at once; the PATCH and the locale change are two
 * halves of the same choice.
 */
class SettingsViewModel(
  private val api: TvApi,
  private val onLocale: (String) -> Unit,
) : ViewModel(), SettingsActions {

  override var state by mutableStateOf(SettingsState())
    private set

  override var languages by mutableStateOf(emptyList<LanguageDto>())
    private set

  init {
    viewModelScope.launch {
      val settings = runCatching { api.settings() }.getOrNull()
      languages = runCatching { api.languages() }.getOrDefault(emptyList())
      val version = runCatching { api.serverVersion() }.getOrNull()
      state = SettingsState(
        loaded = settings != null,
        uiLanguage = settings?.uiLanguage,
        audioLanguage = settings?.audioLanguage,
        subtitleLanguage = settings?.subtitleLanguage,
        startView = settings?.startView,
        serverVersion = version,
      )
    }
  }

  override fun setUiLanguage(code: String) {
    state = state.copy(uiLanguage = code)
    onLocale(code)
    viewModelScope.launch {
      val answer = runCatching { api.updateSettings("uiLanguage", code) }.getOrNull() ?: return@launch
      answer.uiLanguage?.let { state = state.copy(uiLanguage = it) }
    }
  }

  override fun setAudioLanguage(code: String) {
    state = state.copy(audioLanguage = code)
    viewModelScope.launch {
      val answer = runCatching { api.updateSettings("audioLanguage", code) }.getOrNull() ?: return@launch
      answer.audioLanguage?.let { state = state.copy(audioLanguage = it) }
    }
  }

  override fun setSubtitleLanguage(code: String) {
    state = state.copy(subtitleLanguage = code)
    viewModelScope.launch {
      val answer = runCatching { api.updateSettings("subtitleLanguage", code) }.getOrNull() ?: return@launch
      answer.subtitleLanguage?.let { state = state.copy(subtitleLanguage = it) }
    }
  }

  override fun setStartView(view: String) {
    state = state.copy(startView = view)
    viewModelScope.launch {
      val answer = runCatching { api.updateSettings("startView", view) }.getOrNull() ?: return@launch
      answer.startView?.let { state = state.copy(startView = it) }
    }
  }

  companion object {
    fun factory(api: TvApi, onLocale: (String) -> Unit) =
      viewModelFactory { initializer { SettingsViewModel(api, onLocale) } }
  }
}
