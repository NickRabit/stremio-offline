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
  fun `start sends a catalog scope only when the panel picked one`() = runTest {
    server.enqueue(MockResponse().setBody("""{"id":"ss_1","snapshot":{"revision":1,"state":"complete"}}"""))

    client(start()).startGlobalSearch(
      GlobalSearchStartDto(
        "matrix",
        "movie",
        listOf("catalog"),
        "slot",
        3,
        SearchScope("a", "movie", "top"),
      ),
    )

    assertEquals(
      """{"query":"matrix","kind":"movie","sources":["catalog"],"slotId":"slot","generation":3,""" +
        """"scope":{"addonKey":"a","catalogType":"movie","catalogId":"top"}}""",
      server.takeRequest().body.readUtf8(),
    )
  }

  @Test
  fun `an addon-only scope omits the catalog fields`() = runTest {
    server.enqueue(MockResponse().setBody("""{"id":"ss_1","snapshot":{"revision":1,"state":"complete"}}"""))

    client(start()).startGlobalSearch(
      GlobalSearchStartDto("matrix", "all", listOf("catalog"), "slot", 4, SearchScope(addonKey = "a")),
    )

    assertEquals(
      """{"query":"matrix","kind":"all","sources":["catalog"],"slotId":"slot","generation":4,""" +
        """"scope":{"addonKey":"a"}}""",
      server.takeRequest().body.readUtf8(),
    )
  }

  @Test
  fun `a library scope is serialized only when it is set`() = runTest {
    server.enqueue(MockResponse().setBody("""{"id":"ss_1","snapshot":{"revision":1,"state":"complete"}}"""))

    client(start()).startGlobalSearch(
      GlobalSearchStartDto(
        "matrix",
        "all",
        listOf("local"),
        "slot",
        5,
        library = GlobalSearchLibraryDto("lib_ab12cd34", path = "Shows/S1"),
      ),
    )

    assertEquals(
      """{"query":"matrix","kind":"all","sources":["local"],"slotId":"slot","generation":5,""" +
        """"library":{"libraryId":"lib_ab12cd34","path":"Shows/S1"}}""",
      server.takeRequest().body.readUtf8(),
    )
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
