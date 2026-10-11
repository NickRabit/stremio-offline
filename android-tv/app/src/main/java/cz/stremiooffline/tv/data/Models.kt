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
  val subtitleLanguage: String? = null,
  val streamSort: String? = null,
  val realDebridConfigured: Boolean = false,
)

/** One content language `GET /api/languages` offers. The name is the server's Czech label
 *  and is never shown: the TV picks for the code the way the web does. */
@Serializable
data class LanguageDto(val code: String = "", val name: String? = null)

@Serializable
data class ErrorVars(val seconds: Int? = null)

@Serializable
data class ErrorBody(val error: String? = null, val messageKey: String? = null, val vars: ErrorVars? = null)

/** One `GET /api/libraries` entry. `writable` arrives only from a server that can say whether
 *  this account may queue a download there; an older one leaves it null. */
@Serializable
data class LibraryDto(
  val id: String = "",
  val name: String = "",
  val type: String = "",
  val enabled: Boolean = true,
  val readOnly: Boolean = false,
  val unreachable: Boolean = false,
  val writable: Boolean? = null,
  val defaultMovie: Boolean = false,
  val defaultSeries: Boolean = false,
) {
  /** True when this account may queue a download here. Without the field, the older-server rule
   *  is "visible, enabled and not read-only", which is what the spec allows the TV to assume. */
  val canWrite: Boolean get() = writable ?: (enabled && !readOnly && !unreachable)
}
