package cz.stremiooffline.tv.data

import kotlinx.serialization.Serializable

@Serializable
data class ProfileDto(
  val id: String,
  val username: String,
  val unlock: String,
  val current: Boolean = false,
  val pinLocked: Boolean = false,
)

@Serializable
data class ProfilesResponse(val profiles: List<ProfileDto> = emptyList())

@Serializable
data class SwitchProfileRequest(
  val id: String,
  val pin: String? = null,
  val password: String? = null,
)

@Serializable
data class SwitchProfileResponse(
  val username: String = "",
  val language: String? = null,
)
