package cz.stremiooffline.tv.data

import kotlinx.serialization.Serializable

@Serializable
data class PairingStartRequest(val deviceLabel: String)

@Serializable
data class PairingStartResponse(
  val code: String = "",
  val pollToken: String = "",
  val expiresIn: Int = 300,
  val interval: Int = 5,
)

@Serializable
data class PairingPollRequest(val pollToken: String)

@Serializable
data class PairingPollResponse(
  val status: String = "",
  val username: String? = null,
  val role: String? = null,
  val language: String? = null,
)

enum class PairingFailure {
  Unsupported,
  Expired,
  Restricted,
  NeedsSetup,
  MustChangePassword,
  Busy,
  Unreachable,
  Incompatible,
  Generic,
}

data class PairingErrorInfo(
  val failure: PairingFailure,
  val seconds: Int? = null,
  val serverMessage: String? = null,
  val messageKey: String? = null,
)

sealed interface PairingStartOutcome {
  data class Started(val code: String, val pollToken: String, val expiresIn: Int, val interval: Int) : PairingStartOutcome
  data class Failed(val error: PairingErrorInfo) : PairingStartOutcome
}

sealed interface PairingPollOutcome {
  data object Pending : PairingPollOutcome
  data class Approved(val username: String, val language: String?) : PairingPollOutcome
  data class Failed(val error: PairingErrorInfo) : PairingPollOutcome
}
