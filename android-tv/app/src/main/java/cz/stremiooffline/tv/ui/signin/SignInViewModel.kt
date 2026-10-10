package cz.stremiooffline.tv.ui.signin

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.ApiClient
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.CookieStore
import cz.stremiooffline.tv.data.MeResult
import cz.stremiooffline.tv.data.ServerAddress
import cz.stremiooffline.tv.data.SessionStore
import cz.stremiooffline.tv.ui.shell.Section
import cz.stremiooffline.tv.ui.shell.startSection
import kotlinx.coroutines.launch

sealed interface ServerCheck {
  data object Idle : ServerCheck
  data object Checking : ServerCheck
  data class Found(val version: String) : ServerCheck
  data class Failed(val failure: ApiFailure) : ServerCheck
}

data class SignInState(
  val server: String = "http://",
  val username: String = "",
  val password: String = "",
  val check: ServerCheck = ServerCheck.Idle,
  val busy: Boolean = false,
  val error: ApiFailure? = null,
  val errorSeconds: Int? = null,
)

fun ApiFailure.messageRes(): Int = when (this) {
  ApiFailure.Unreachable -> R.string.tv_err_unreachable
  ApiFailure.Incompatible -> R.string.tv_err_incompatible
  ApiFailure.BadCredentials -> R.string.tv_err_bad_credentials
  ApiFailure.TooMany -> R.string.tv_err_too_many
  ApiFailure.NeedsSetup -> R.string.tv_err_needs_setup
  ApiFailure.MustChangePassword -> R.string.tv_err_must_change_password
  ApiFailure.SessionExpired -> R.string.tv_err_session_expired
  ApiFailure.Generic -> R.string.tv_err_generic
}

class SignInViewModel(
  private val store: SessionStore,
  private val onSignedIn: (String, Section) -> Unit,
) : ViewModel() {

  var state by mutableStateOf(SignInState())
    private set

  private var client: ApiClient? = null
  private var clientOrigin: String? = null

  /** Called each time the sign-in screen is entered, with the address and error to show. */
  fun reset(address: String, error: ApiFailure?) {
    state = SignInState(server = address, error = error)
    client = null
    clientOrigin = null
  }

  fun onServerChange(value: String) {
    state = state.copy(server = value, check = ServerCheck.Idle, error = null, errorSeconds = null)
  }

  fun onUsernameChange(value: String) {
    state = state.copy(username = value, error = null, errorSeconds = null)
  }

  fun onPasswordChange(value: String) {
    state = state.copy(password = value, error = null, errorSeconds = null)
  }

  /** The reachability line under the address field, checked when the field is left. */
  fun checkServer() {
    val address = ServerAddress.parse(state.server)
    if (address == null) {
      state = state.copy(check = ServerCheck.Failed(ApiFailure.Unreachable))
      return
    }
    if (state.check is ServerCheck.Found && clientOrigin == address.origin) return
    viewModelScope.launch {
      state = state.copy(check = ServerCheck.Checking)
      try {
        state = state.copy(check = ServerCheck.Found(clientFor(address).status().version))
      } catch (error: ApiError) {
        state = state.copy(check = ServerCheck.Failed(error.failure))
      }
    }
  }

  fun signIn() {
    if (state.busy) return
    val address = ServerAddress.parse(state.server)
    if (address == null) {
      state = state.copy(check = ServerCheck.Failed(ApiFailure.Unreachable), error = ApiFailure.Unreachable)
      return
    }
    val username = state.username
    val password = state.password
    viewModelScope.launch {
      state = state.copy(busy = true, error = null, errorSeconds = null, check = ServerCheck.Checking)
      val api = clientFor(address)
      try {
        state = state.copy(check = ServerCheck.Found(api.status().version))
        // An account that has not been created yet is told apart from wrong credentials here.
        when (val me = runCatching { api.me() }.getOrNull()) {
          MeResult.Setup -> return@launch fail(ApiFailure.NeedsSetup)
          is MeResult.SignedIn -> return@launch succeed(address, me.username, api)
          null -> Unit
        }
        val login = api.login(username, password)
        if (login.mustChangePassword) {
          api.logout()
          store.clearSession()
          return@launch fail(ApiFailure.MustChangePassword)
        }
        succeed(address, login.username, api)
      } catch (error: ApiError) {
        fail(error.failure, error.seconds)
      }
    }
  }

  private fun fail(failure: ApiFailure, seconds: Int? = null) {
    val check = if (state.check is ServerCheck.Checking) ServerCheck.Failed(failure) else state.check
    state = state.copy(busy = false, error = failure, errorSeconds = seconds, check = check)
  }

  private suspend fun succeed(address: ServerAddress, username: String, api: ApiClient) {
    store.serverUrl = address.display
    val start = startSection(runCatching { api.settings().startView }.getOrNull())
    state = state.copy(busy = false)
    onSignedIn(username, start)
  }

  private fun clientFor(address: ServerAddress): ApiClient {
    val existing = client
    if (existing != null && clientOrigin == address.origin) return existing
    return ApiClient(address, CookieStore(address.origin, store)).also {
      client = it
      clientOrigin = address.origin
    }
  }

  companion object {
    fun factory(store: SessionStore, onSignedIn: (String, Section) -> Unit) =
      viewModelFactory { initializer { SignInViewModel(store, onSignedIn) } }
  }
}
