package cz.stremiooffline.tv.ui.signin

import android.os.Build
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
import cz.stremiooffline.tv.data.MemorySessionPersistence
import cz.stremiooffline.tv.data.PairingErrorInfo
import cz.stremiooffline.tv.data.PairingFailure
import cz.stremiooffline.tv.data.PairingPollOutcome
import cz.stremiooffline.tv.data.PairingStartOutcome
import cz.stremiooffline.tv.data.ServerAddress
import cz.stremiooffline.tv.data.SessionStore
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.ui.shell.Section
import cz.stremiooffline.tv.ui.shell.startSection
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.min

sealed interface ServerCheck {
  data object Idle : ServerCheck
  data object Checking : ServerCheck
  data class Found(val version: String) : ServerCheck
  data class Failed(val failure: ApiFailure) : ServerCheck
}

sealed interface PairingState {
  data object Idle : PairingState
  data object Starting : PairingState
  data class Waiting(
    val code: String,
    val expiresIn: Int,
    val interval: Int,
  ) : PairingState
  data class Failed(val error: PairingErrorInfo) : PairingState
}

data class SignInState(
  val server: String = "http://",
  val username: String = "",
  val password: String = "",
  val check: ServerCheck = ServerCheck.Idle,
  val busy: Boolean = false,
  val error: ApiFailure? = null,
  val errorSeconds: Int? = null,
  val pairing: PairingState = PairingState.Idle,
)

fun ApiFailure.messageRes(): Int = when (this) {
  ApiFailure.Unreachable -> R.string.tv_err_unreachable
  ApiFailure.Incompatible -> R.string.tv_err_incompatible
  ApiFailure.BadCredentials -> R.string.tv_err_bad_credentials
  ApiFailure.TooMany -> R.string.tv_err_too_many
  ApiFailure.NeedsSetup -> R.string.tv_err_needs_setup
  ApiFailure.MustChangePassword -> R.string.tv_err_must_change_password
  ApiFailure.SessionExpired -> R.string.tv_err_session_expired
  ApiFailure.NotFound -> R.string.tv_err_generic
  ApiFailure.Forbidden -> R.string.tv_err_generic
  ApiFailure.Generic -> R.string.tv_err_generic
}

fun PairingFailure.messageRes(): Int = when (this) {
  PairingFailure.Unsupported -> R.string.pair_unsupported
  PairingFailure.Expired -> R.string.pair_expired
  PairingFailure.Restricted -> R.string.err_restricted
  PairingFailure.NeedsSetup -> R.string.tv_err_needs_setup
  PairingFailure.MustChangePassword -> R.string.tv_err_must_change_password
  PairingFailure.Busy -> R.string.err_pair_busy
  PairingFailure.Unreachable -> R.string.tv_err_unreachable
  PairingFailure.Incompatible -> R.string.tv_err_incompatible
  PairingFailure.Generic -> R.string.tv_err_generic
}

/** The TV-facing slice of a staging pairing API, kept small so polling races are testable. */
interface PairingTransport {
  val api: ApiClient
  suspend fun start(deviceLabel: String): PairingStartOutcome
  suspend fun poll(pollToken: String): PairingPollOutcome
  suspend fun settings(): SettingsResponse
  fun stagedSession(): String?
}

private class StagedPairingTransport(override val api: ApiClient, private val cookies: CookieStore) : PairingTransport {
  override suspend fun start(deviceLabel: String) = api.startPairing(deviceLabel)
  override suspend fun poll(pollToken: String) = api.pollPairing(pollToken)
  override suspend fun settings() = api.settings()
  override fun stagedSession(): String? = cookies.currentSession()
}

fun interface PairingTransportFactory {
  fun open(address: ServerAddress): PairingTransport
}

private val defaultPairingTransport = PairingTransportFactory { address ->
  val cookies = CookieStore(address.origin, MemorySessionPersistence())
  StagedPairingTransport(ApiClient(address, cookies), cookies)
}

/** The sign-in screen's state and actions, so the screen and polling races can be tested. */
interface SignInActions {
  val state: SignInState
  fun onServerChange(value: String)
  fun onUsernameChange(value: String)
  fun onPasswordChange(value: String)
  fun checkServer()
  fun signIn()
  fun startPairing()
  fun cancelPairing()
  fun onScreenLeave()
}

class SignInViewModel(
  private val store: SessionStore,
  private val onSignedIn: (String, String?, Section, ApiClient) -> Unit,
  private val pairingFactory: PairingTransportFactory = defaultPairingTransport,
  private val now: () -> Long = System::currentTimeMillis,
  private val wait: suspend (Long) -> Unit = { delay(it) },
  private val deviceLabel: String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
    .ifBlank { "Android TV" }
    .take(80),
) : ViewModel(), SignInActions {

  override var state by mutableStateOf(SignInState())
    private set

  private var client: ApiClient? = null
  private var clientAddress: String? = null
  private var pairingJob: Job? = null
  private var generation = 0L

  /** Called each time the sign-in screen is entered, with the address and error to show. */
  fun reset(address: String, error: ApiFailure?) {
    stopPairing()
    state = SignInState(server = address, error = error)
    client = null
    clientAddress = null
  }

  override fun onServerChange(value: String) {
    stopPairing()
    state = state.copy(
      server = value,
      check = ServerCheck.Idle,
      error = null,
      errorSeconds = null,
      pairing = PairingState.Idle,
    )
  }

  override fun onUsernameChange(value: String) {
    state = state.copy(username = value, error = null, errorSeconds = null)
  }

  override fun onPasswordChange(value: String) {
    state = state.copy(password = value, error = null, errorSeconds = null)
  }

  /** The reachability line under the address field, checked when the field is left. */
  override fun checkServer() {
    val address = ServerAddress.parse(state.server)
    if (address == null) {
      state = state.copy(check = ServerCheck.Failed(ApiFailure.Unreachable))
      return
    }
    if (state.check is ServerCheck.Found && clientAddress == address.display) return
    viewModelScope.launch {
      state = state.copy(check = ServerCheck.Checking)
      try {
        state = state.copy(check = ServerCheck.Found(clientFor(address).status().version))
      } catch (error: ApiError) {
        state = state.copy(check = ServerCheck.Failed(error.failure))
      }
    }
  }

  override fun signIn() {
    if (state.busy) return
    stopPairing()
    state = state.copy(pairing = PairingState.Idle)
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
        when (val me = runCatching { api.me() }.getOrNull()) {
          MeResult.Setup -> return@launch fail(ApiFailure.NeedsSetup)
          is MeResult.SignedIn -> {
            succeed(address, me.username, me.language, api)
            return@launch
          }
          null -> Unit
        }
        val login = api.login(username, password)
        if (login.mustChangePassword) {
          api.logout()
          store.clearSession()
          return@launch fail(ApiFailure.MustChangePassword)
        }
        succeed(address, login.username, null, api)
      } catch (error: ApiError) {
        fail(error.failure, error.seconds)
      }
    }
  }

  override fun startPairing() {
    if (state.busy) return
    val address = ServerAddress.parse(state.server)
    if (address == null) {
      state = state.copy(
        check = ServerCheck.Failed(ApiFailure.Unreachable),
        pairing = PairingState.Failed(PairingErrorInfo(PairingFailure.Unreachable)),
      )
      return
    }
    stopPairing()
    val currentGeneration = generation
    state = state.copy(busy = true, pairing = PairingState.Starting, error = null, errorSeconds = null)
    pairingJob = viewModelScope.launch {
      val transport = pairingFactory.open(address)
      val started = transport.start(deviceLabel)
      if (!isCurrent(currentGeneration)) return@launch
      when (started) {
        is PairingStartOutcome.Failed -> pairingFailed(started.error, currentGeneration)
        is PairingStartOutcome.Started -> {
          val interval = started.interval.coerceAtLeast(1) * 1_000L
          val expiresAt = now() + started.expiresIn.coerceAtLeast(1) * 1_000L
          state = state.copy(
            busy = false,
            pairing = PairingState.Waiting(started.code, started.expiresIn.coerceAtLeast(1), started.interval.coerceAtLeast(1)),
          )
          pollPairing(address, transport, started.pollToken, interval, expiresAt, currentGeneration)
        }
      }
    }
  }

  override fun cancelPairing() {
    stopPairing()
    state = state.copy(pairing = PairingState.Idle, busy = false)
  }

  override fun onScreenLeave() {
    stopPairing()
  }

  private suspend fun pollPairing(
    address: ServerAddress,
    transport: PairingTransport,
    pollToken: String,
    baseInterval: Long,
    expiresAt: Long,
    currentGeneration: Long,
  ) {
    var waitMs = baseInterval
    var transportFailures = 0
    while (isCurrent(currentGeneration)) {
      val remaining = expiresAt - now()
      if (remaining <= 0) return pairingFailed(PairingErrorInfo(PairingFailure.Expired), currentGeneration)
      wait(min(waitMs, remaining))
      if (!isCurrent(currentGeneration)) return
      if (now() >= expiresAt) return pairingFailed(PairingErrorInfo(PairingFailure.Expired), currentGeneration)

      when (val answer = transport.poll(pollToken)) {
        PairingPollOutcome.Pending -> {
          waitMs = baseInterval
          transportFailures = 0
          refreshPairingExpiry(expiresAt, currentGeneration)
        }
        is PairingPollOutcome.Approved -> {
          succeed(
            address,
            answer.username,
            answer.language,
            transport.api,
            currentGeneration,
            loadSettings = { transport.settings() },
          ) {
            val token = transport.stagedSession()
            if (token != null) {
              store.serverUrl = address.display
              store.saveSession(address.origin, token)
              true
            } else {
              false
            }
          }
          return
        }
        is PairingPollOutcome.Failed -> when (answer.error.failure) {
          PairingFailure.Busy -> {
            waitMs = maxOf(baseInterval, (answer.error.seconds ?: 5).coerceAtLeast(1) * 1_000L)
            refreshPairingExpiry(expiresAt, currentGeneration)
          }
          PairingFailure.Unreachable -> {
            transportFailures += 1
            waitMs = min(30_000L, baseInterval * (1L shl min(transportFailures, 3)))
            refreshPairingExpiry(expiresAt, currentGeneration)
          }
          else -> return pairingFailed(answer.error, currentGeneration)
        }
      }
    }
  }

  private fun pairingFailed(error: PairingErrorInfo, currentGeneration: Long) {
    if (!isCurrent(currentGeneration)) return
    state = state.copy(busy = false, pairing = PairingState.Failed(error))
  }

  private fun refreshPairingExpiry(expiresAt: Long, currentGeneration: Long) {
    if (!isCurrent(currentGeneration)) return
    val current = state.pairing as? PairingState.Waiting ?: return
    val seconds = ((expiresAt - now()).coerceAtLeast(0) + 999) / 1_000
    state = state.copy(pairing = current.copy(expiresIn = seconds.toInt()))
  }

  private fun fail(failure: ApiFailure, seconds: Int? = null) {
    val check = if (state.check is ServerCheck.Checking) ServerCheck.Failed(failure) else state.check
    state = state.copy(busy = false, error = failure, errorSeconds = seconds, check = check)
  }

  private suspend fun succeed(
    address: ServerAddress,
    username: String,
    language: String?,
    api: ApiClient,
    expectedGeneration: Long? = null,
    loadSettings: (suspend () -> SettingsResponse)? = null,
    beforeCommit: () -> Boolean = {
      store.serverUrl = address.display
      true
    },
  ): Boolean {
    if (expectedGeneration != null && !isCurrent(expectedGeneration)) return false
    // The settings call proves the staged cookie works with the same client before adoption.
    val settings = runCatching { loadSettings?.invoke() ?: api.settings() }.getOrNull()
    if (expectedGeneration != null && !isCurrent(expectedGeneration)) return false
    if (!beforeCommit()) {
      if (expectedGeneration != null) pairingFailed(PairingErrorInfo(PairingFailure.Generic), expectedGeneration)
      return false
    }
    if (expectedGeneration != null && !isCurrent(expectedGeneration)) return false
    val start = startSection(settings?.startView)
    val uiLanguage = language ?: settings?.uiLanguage
    state = state.copy(busy = false, pairing = PairingState.Idle)
    onSignedIn(username, uiLanguage, start, api)
    return true
  }

  private fun stopPairing() {
    generation += 1
    pairingJob?.cancel()
    pairingJob = null
  }

  private fun isCurrent(expected: Long): Boolean = generation == expected

  private fun clientFor(address: ServerAddress): ApiClient {
    val existing = client
    if (existing != null && clientAddress == address.display) return existing
    return ApiClient(address, CookieStore(address.origin, store)).also {
      client = it
      clientAddress = address.display
    }
  }

  override fun onCleared() {
    stopPairing()
    super.onCleared()
  }

  companion object {
    fun factory(store: SessionStore, onSignedIn: (String, String?, Section, ApiClient) -> Unit) =
      viewModelFactory { initializer { SignInViewModel(store, onSignedIn) } }
  }
}
