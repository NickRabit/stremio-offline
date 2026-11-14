package cz.stremiooffline.tv.ui.profiles

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.ProfileApi
import cz.stremiooffline.tv.data.ProfileDto
import cz.stremiooffline.tv.data.SwitchOutcome
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

sealed interface SwitcherStep {
  data object Choose : SwitcherStep
  data class Pin(val profile: ProfileDto) : SwitcherStep
  data class Password(val profile: ProfileDto, val lockedHint: Boolean) : SwitcherStep
  data object Busy : SwitcherStep
}

data class SwitcherError(val messageRes: Int, val arg: String? = null)

class ProfileSwitcherViewModel(
  private val api: ProfileApi,
  private val onSwitched: () -> Unit = {},
  /** The list came back with nobody to switch to: the entry that opened this is out of date. */
  private val onNobody: () -> Unit = {},
) : ViewModel() {

  var profiles by mutableStateOf<List<ProfileDto>>(emptyList())
    private set
  var step by mutableStateOf<SwitcherStep>(SwitcherStep.Choose)
    private set
  var error by mutableStateOf<SwitcherError?>(null)
    private set
  var waitSeconds by mutableIntStateOf(0)
    private set
  var pin by mutableStateOf("")
    private set
  var password by mutableStateOf("")
    private set

  private var resumeStep: SwitcherStep = SwitcherStep.Choose
  private var waitJob: Job? = null

  /** Why the list could not be read; an empty row with nothing said is no answer. */
  var loadFailure by mutableStateOf<ApiFailure?>(null)
    private set

  /** The list was read and holds no profile but this one; an administrator changed the group
   *  after this session learned it could switch. */
  var nobody by mutableStateOf(false)
    private set

  // Below every property it writes: load() can run to its end inside this call.
  init {
    load()
  }

  fun load() {
    viewModelScope.launch {
      loadFailure = null
      nobody = false
      profiles = try {
        api.profiles()
      } catch (error: ApiError) {
        loadFailure = error.failure
        emptyList()
      } catch (_: Exception) {
        loadFailure = ApiFailure.Generic
        emptyList()
      }
      if (loadFailure == null && profiles.none { !it.current }) {
        nobody = true
        onNobody()
      }
    }
  }

  fun choose(profile: ProfileDto) {
    if (profile.current) return
    error = null
    waitJob?.cancel()
    waitSeconds = 0
    when {
      profile.unlock == "none" -> switch(profile.id)
      profile.unlock == "pin" && profile.pinLocked -> {
        password = ""
        step = SwitcherStep.Password(profile, lockedHint = true)
      }
      profile.unlock == "pin" -> {
        pin = ""
        step = SwitcherStep.Pin(profile)
      }
      else -> {
        password = ""
        step = SwitcherStep.Password(profile, lockedHint = false)
      }
    }
  }

  fun appendDigit(digit: Char) {
    if (step !is SwitcherStep.Pin) return
    if (pin.length >= 8) return
    pin += digit
    if (error?.messageRes == R.string.err_bad_pin) error = null
  }

  fun deleteDigit() {
    if (step !is SwitcherStep.Pin) return
    if (pin.isNotEmpty()) pin = pin.dropLast(1)
  }

  fun submitPin() {
    val pinStep = step as? SwitcherStep.Pin ?: return
    if (waitSeconds > 0) return
    switch(pinStep.profile.id, pin = pin.takeIf { it.isNotEmpty() })
  }

  fun usePassword() {
    val pinStep = step as? SwitcherStep.Pin ?: return
    password = ""
    error = null
    waitJob?.cancel()
    waitSeconds = 0
    step = SwitcherStep.Password(pinStep.profile, lockedHint = false)
  }

  fun onPasswordChange(value: String) {
    password = value
    if (error?.messageRes == R.string.err_bad_credentials) error = null
  }

  fun submitPassword() {
    val passwordStep = step as? SwitcherStep.Password ?: return
    if (waitSeconds > 0) return
    switch(passwordStep.profile.id, password = password.takeIf { it.isNotEmpty() })
  }

  fun back() {
    error = null
    pin = ""
    password = ""
    waitJob?.cancel()
    waitSeconds = 0
    step = SwitcherStep.Choose
  }

  private fun switch(id: String, pin: String? = null, password: String? = null) {
    if (step is SwitcherStep.Busy) return
    resumeStep = step
    step = SwitcherStep.Busy
    viewModelScope.launch {
      val outcome = try {
        api.switchProfile(id, pin, password)
      } catch (_: Exception) {
        SwitchOutcome.Failed(ApiFailure.Generic)
      }
      when (outcome) {
        is SwitchOutcome.Switched -> onSwitched()
        SwitchOutcome.WrongPin -> {
          this@ProfileSwitcherViewModel.pin = ""
          error = SwitcherError(R.string.err_bad_pin)
          step = resumeStep
        }
        SwitchOutcome.WrongPassword -> {
          this@ProfileSwitcherViewModel.password = ""
          error = SwitcherError(R.string.err_bad_credentials)
          step = resumeStep
        }
        SwitchOutcome.PinLocked -> {
          val profile = unlockingProfile() ?: return@launch
          this@ProfileSwitcherViewModel.password = ""
          error = null
          step = SwitcherStep.Password(profile, lockedHint = true)
        }
        is SwitchOutcome.Wait -> {
          error = SwitcherError(R.string.err_too_many_attempts, outcome.seconds.toString())
          startWait(outcome.seconds)
          step = resumeStep
        }
        SwitchOutcome.Unavailable -> {
          error = SwitcherError(R.string.err_profile_unavailable)
          step = SwitcherStep.Choose
        }
        is SwitchOutcome.Failed -> {
          error = SwitcherError(
            when (outcome.failure) {
              ApiFailure.Unreachable -> R.string.tv_err_unreachable
              else -> R.string.tv_err_generic
            },
          )
          step = resumeStep
        }
      }
    }
  }

  private fun unlockingProfile(): ProfileDto? = when (val current = resumeStep) {
    is SwitcherStep.Pin -> current.profile
    is SwitcherStep.Password -> current.profile
    else -> null
  }

  private fun startWait(seconds: Int) {
    waitJob?.cancel()
    waitSeconds = seconds
    waitJob = viewModelScope.launch {
      while (waitSeconds > 0) {
        delay(1_000)
        waitSeconds--
      }
    }
  }

  companion object {
    fun factory(api: ProfileApi, onNobody: () -> Unit = {}, onSwitched: () -> Unit = {}) = viewModelFactory {
      initializer { ProfileSwitcherViewModel(api, onSwitched, onNobody) }
    }
  }
}
