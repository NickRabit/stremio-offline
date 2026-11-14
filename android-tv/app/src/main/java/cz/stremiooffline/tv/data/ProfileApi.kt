package cz.stremiooffline.tv.data

interface ProfileApi {
  suspend fun profiles(): List<ProfileDto>
  suspend fun switchProfile(id: String, pin: String? = null, password: String? = null): SwitchOutcome
}

sealed interface SwitchOutcome {
  data class Switched(val username: String, val language: String?) : SwitchOutcome
  data object WrongPin : SwitchOutcome
  data object WrongPassword : SwitchOutcome
  data object PinLocked : SwitchOutcome
  data class Wait(val seconds: Int) : SwitchOutcome
  data object Unavailable : SwitchOutcome
  data class Failed(val failure: ApiFailure) : SwitchOutcome
}
