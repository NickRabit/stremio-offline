package cz.stremiooffline.tv.data

import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CookieStoreTest {

  private class Memory : SessionPersistence {
    private var origin: String? = null
    private var value: String? = null

    override fun loadSession(origin: String): String? = value.takeIf { this.origin == origin }

    override fun saveSession(origin: String, value: String?) {
      this.origin = origin
      this.value = value
    }
  }

  private val session = Cookie.Builder()
    .name(CookieStore.SESSION_COOKIE)
    .value("token")
    .hostOnlyDomain("nas")
    .path("/")
    .build()

  @Test
  fun `the cookie is returned to its own origin`() {
    val store = CookieStore("http://nas:8090", Memory())
    store.saveFromResponse("http://nas:8090".toHttpUrl(), listOf(session))
    assertEquals(listOf(session), store.loadForRequest("http://nas:8090/api/x".toHttpUrl()))
  }

  @Test
  fun `another host and another scheme get nothing`() {
    val store = CookieStore("http://nas:8090", Memory())
    store.saveFromResponse("http://nas:8090".toHttpUrl(), listOf(session))
    assertTrue(store.loadForRequest("http://other:8090/".toHttpUrl()).isEmpty())
    assertTrue(store.loadForRequest("https://nas:8090/".toHttpUrl()).isEmpty())
  }
}
