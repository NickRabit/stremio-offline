package cz.stremiooffline.tv.data

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GlobalSearchApiTest {

  private val server = MockWebServer()

  @After
  fun shutdown() {
    server.shutdown()
  }

  @Test
  fun `status carries the search flag`() = runTest {
    server.enqueue(MockResponse().setBody("""{"status":"ok","version":"1.0.0","searchEverywhere":true}"""))

    assertTrue(client(start()).searchEverywhereEnabled())
  }

  @Test
  fun `start sends the explicit request and decodes a locator with unknown keys`() = runTest {
    server.enqueue(
      MockResponse().setBody(
        """{"id":"ss_1","snapshot":{"revision":1,"state":"partial","unknown":"ignored","sources":[],""" +
          """"clusters":[],"unidentified":[],"aliases":[],"limitReached":false}}""",
      ),
    )
    val result = client(start()).startGlobalSearch(
      GlobalSearchStartDto("matrix", "all", listOf("catalog", "local", "remote"), "slot", 2),
    )

    val request = server.takeRequest()
    assertEquals("/api/search/everywhere", request.path)
    assertEquals(
      """{"query":"matrix","kind":"all","sources":["catalog","local","remote"],"slotId":"slot","generation":2}""",
      request.body.readUtf8(),
    )
    assertEquals("ss_1", result.id)
    assertEquals("partial", result.snapshot.state)
  }

  @Test
  fun `poll posts the revision and maps an expired session to 410`() = runTest {
    server.enqueue(MockResponse().setResponseCode(410).setBody("""{"error":"expired","messageKey":"err.searchRestartRequired"}"""))

    try {
      client(start()).pollGlobalSearch("ss_1", 4)
    } catch (error: ApiError) {
      assertEquals(410, error.status)
      assertEquals(ApiFailure.NotFound, error.failure)
    }
    val request = server.takeRequest()
    assertEquals("/api/search/everywhere/ss_1/poll", request.path)
    assertEquals("""{"revision":4}""", request.body.readUtf8())
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
