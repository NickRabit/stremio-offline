package cz.stremiooffline.tv.data

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The exact requests `GET /api/home/layout` and the personal `homeLayout` PATCH put on the wire. */
class HomeLayoutApiTest {

  private val server = MockWebServer()

  @After
  fun shutdown() {
    server.shutdown()
  }

  @Test
  fun `the arrangement is read from its own route`() = runTest {
    server.enqueue(
      MockResponse().setBody(
        """{"rows":[{"id":"resume","kind":"builtin","label":"home.continue","shown":true,"position":0,"added":true}],""" +
          """"layout":{"order":["resume"],"hidden":[],"feeds":[]}}""",
      ),
    )

    val answer = client(start()).homeLayout()

    assertEquals("/api/home/layout", server.takeRequest().path)
    assertEquals(listOf("resume"), answer.rows.map { it.id })
    assertEquals("home.continue", answer.rows.single().label)
    assertEquals(listOf("resume"), answer.layout.order)
  }

  @Test
  fun `an arrangement is one homeLayout object and carries all three arrays`() = runTest {
    server.enqueue(MockResponse().setBody("""{"uiLanguage":"en"}"""))

    client(start()).updateHomeLayout(
      HomeLayoutDto(order = listOf("favorites", "resume"), hidden = listOf("tonight"), feeds = emptyList()),
    )

    val request = server.takeRequest()
    assertEquals("PATCH", request.method)
    assertEquals("/api/settings", request.path)
    assertEquals(
      """{"homeLayout":{"order":["favorites","resume"],"hidden":["tonight"],"feeds":[]}}""",
      request.body.readUtf8(),
    )
  }

  @Test
  fun `resetting the arrangement sends a null`() = runTest {
    server.enqueue(MockResponse().setBody("""{"uiLanguage":"en"}"""))

    client(start()).updateHomeLayout(null)

    assertEquals("""{"homeLayout":null}""", server.takeRequest().body.readUtf8())
  }

  @Test
  fun `an older server without the route answers not-found`() = runTest {
    server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"Not found."}"""))

    val error = runCatching { client(start()).homeLayout() }.exceptionOrNull()

    assertTrue("expected an ApiError, got $error", error is ApiError)
    assertEquals(ApiFailure.NotFound, (error as ApiError).failure)
  }

  private fun start(): ServerAddress {
    server.start()
    return ServerAddress.parse(server.url("/").toString())!!
  }

  private fun client(address: ServerAddress) = ApiClient(address, CookieStore(address.origin, Memory()))

  private class Memory : SessionPersistence {
    override fun loadSession(origin: String): String? = null
    override fun saveSession(origin: String, value: String?) = Unit
  }
}
