package cz.stremiooffline.tv.data

import kotlinx.serialization.Serializable

@Serializable
data class StatusResponse(val status: String? = null, val version: String? = null)

@Serializable
data class LoginRequest(val username: String, val password: String, val remember: Boolean)

@Serializable
data class LoginResponse(
  val username: String? = null,
  val role: String? = null,
  val mustChangePassword: Boolean = false,
)

@Serializable
data class MeResponse(
  val setup: Boolean = false,
  val username: String? = null,
  val role: String? = null,
  val language: String? = null,
  val mustChangePassword: Boolean = false,
)

@Serializable
data class SettingsResponse(
  val startView: String? = null,
  val uiLanguage: String? = null,
  val audioLanguage: String? = null,
  val streamSort: String? = null,
  val realDebridConfigured: Boolean = false,
)

@Serializable
data class ErrorVars(val seconds: Int? = null)

@Serializable
data class ErrorBody(val error: String? = null, val messageKey: String? = null, val vars: ErrorVars? = null)
