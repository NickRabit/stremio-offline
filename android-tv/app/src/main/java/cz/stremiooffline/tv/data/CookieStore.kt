package cz.stremiooffline.tv.data

import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Where the session cookie survives an app restart; implemented by [SessionStore]. */
interface SessionPersistence {
  fun loadSession(origin: String): String?
  fun saveSession(origin: String, value: String?)
}

/**
 * Keeps cookies for the configured origin only. A request to another origin -- the other end of a
 * cross-origin redirect, say -- carries none of them, so the session cannot leak off the server.
 */
class CookieStore(private val origin: String, private val persistence: SessionPersistence) : CookieJar {

  private val cookies = LinkedHashMap<String, Cookie>()

  init {
    val url = origin.toHttpUrlOrNull()
    val token = persistence.loadSession(origin)
    if (url != null && token != null) cookies[SESSION_COOKIE] = cookieFor(url.host, token)
  }

  override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
    if (ServerAddress.originOf(url) != origin) return
    for (cookie in cookies) {
      this.cookies[cookie.name] = cookie
      if (cookie.name == SESSION_COOKIE) {
        persistence.saveSession(origin, cookie.value.takeIf { cookie.expiresAt > System.currentTimeMillis() })
      }
    }
  }

  override fun loadForRequest(url: HttpUrl): List<Cookie> {
    if (ServerAddress.originOf(url) != origin) return emptyList()
    val now = System.currentTimeMillis()
    return cookies.values.filter { it.expiresAt > now && it.matches(url) }
  }

  companion object {
    const val SESSION_COOKIE = "stremio_offline_session"

    private fun cookieFor(host: String, token: String): Cookie =
      Cookie.Builder().name(SESSION_COOKIE).value(token).hostOnlyDomain(host).path("/").build()
  }
}
