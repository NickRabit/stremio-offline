package cz.stremiooffline.tv.data

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** The configured server: its origin, plus an optional reverse-proxy path prefix. */
class ServerAddress private constructor(val base: HttpUrl, private val prefix: String) {

  val origin: String get() = originOf(base)

  /** The address as the user typed it, without the trailing slash: what the field is prefilled with. */
  val display: String get() = base.toString().removeSuffix("/")

  /** Joins a server-relative path such as `/api/status` under the configured prefix. */
  fun resolve(path: String): HttpUrl {
    val parts = path.split("?", limit = 2)
    val builder = base.newBuilder().encodedPath(prefix + "/" + parts[0].trimStart('/'))
    if (parts.size == 2) builder.encodedQuery(parts[1]) else builder.query(null)
    return builder.build()
  }

  /** An https server is never reached over cleartext: a redirect to http is refused. */
  fun isDowngrade(target: HttpUrl): Boolean = base.scheme == "https" && target.scheme == "http"

  override fun toString(): String = base.toString()

  companion object {
    private val SCHEME = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://")

    fun originOf(url: HttpUrl): String = "${url.scheme}://${url.host}:${url.port}"

    fun parse(input: String): ServerAddress? {
      val trimmed = input.trim()
      if (trimmed.isEmpty()) return null
      val candidate = if (SCHEME.containsMatchIn(trimmed)) trimmed else "http://$trimmed"
      val url = candidate.toHttpUrlOrNull() ?: return null
      if (url.scheme != "http" && url.scheme != "https") return null
      val prefix = url.pathSegments.filter { it.isNotEmpty() }.joinToString("/", prefix = "/")
        .takeIf { it != "/" }
        .orEmpty()
      val base = url.newBuilder().encodedPath(prefix.ifEmpty { "/" }).query(null).fragment(null).build()
      return ServerAddress(base, prefix)
    }
  }
}
