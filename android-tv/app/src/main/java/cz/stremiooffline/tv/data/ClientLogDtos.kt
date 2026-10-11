package cz.stremiooffline.tv.data

import kotlinx.serialization.Serializable

/** One line of the bundle `POST /api/client-log/bundle` carries. */
@Serializable
data class ClientLogLineDto(
  val t: String,
  val level: String,
  val message: String,
  val context: Map<String, String>? = null,
)

/** The bundle body: who sent it, from what, and the lines themselves. */
@Serializable
data class ClientLogBundleDto(
  val client: String,
  val app: String,
  val device: String,
  val note: String? = null,
  val lines: List<ClientLogLineDto>,
)

/** What the bundle route answers: the id the server filed it under. */
@Serializable
data class ClientLogBundleResultDto(val id: String = "")

/** One rate-limited line for `POST /api/client-log`. */
@Serializable
data class ClientLogRequestDto(
  val client: String,
  val level: String,
  val message: String,
  val context: Map<String, String>? = null,
)
