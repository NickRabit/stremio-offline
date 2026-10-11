package cz.stremiooffline.tv.playback

import java.util.Locale

/** The two subtitle addresses the web builds, ported so the app asks for the same thing. */
object SubtitleUrls {

  /** `subtitleUrl` in `web/src/api.ts`: `offset` and `delay` ride in the query, each only when
   *  it is not zero, and a comma-free two/three-decimal form keeps the URL stable. */
  fun addon(id: String, offset: Double, delay: Double): String {
    val query = buildList {
      if (offset != 0.0) add("offset=" + fixed(offset, 3))
      if (delay != 0.0) add("delay=" + fixed(delay, 2))
    }.joinToString("&")
    return "/api/subtitle/" + encode(id) + if (query.isEmpty()) "" else "?$query"
  }

  /** `watchSidecar`'s poll: the descriptor URL already carries `revision` and `offset`; the
   *  picture's position is always asked for and the delay only when it is not zero. */
  fun sidecar(url: String, position: Double, delay: Double): String {
    val builder = StringBuilder(url)
      .append(if (url.contains("?")) "&" else "?")
      .append("position=").append(fixed(maxOf(0.0, position), 3))
    if (delay != 0.0) builder.append("&delay=").append(fixed(delay, 2))
    return builder.toString()
  }

  internal fun fixed(value: Double, digits: Int): String = String.format(Locale.US, "%.${digits}f", value)

  private fun encode(value: String): String = java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")
}
