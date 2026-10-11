package cz.stremiooffline.tv.data

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The diagnostics bundle body and the single-line route the player reports through. */
class ClientLogBundleTest {

  private val server = MockWebServer()

  @After
  fun shutdown() {
    server.shutdown()
  }

  @Test
  fun `the bundle names the client, app and device and carries the lines`() = runTest {
    server.enqueue(MockResponse().setBody("""{"id":"b1"}"""))

    val id = client(start()).sendClientLogBundle(
      ClientLogBundleDto(
        client = "tv",
        app = "0.5.39",
        device = "TCL 55C725 · Android 11",
        note = null,
        lines = listOf(ClientLogLineDto("2026-10-11T10:00:00.000Z", "WARN", "API GET /api/home", mapOf("status" to "403"))),
      ),
    )

    assertEquals("b1", id)
    val request = server.takeRequest()
    assertEquals("/api/client-log/bundle", request.path)
    val body = request.body.readUtf8()
    assertTrue(body, body.contains(""""client":"tv""""))
    assertTrue(body, body.contains(""""app":"0.5.39""""))
    assertTrue(body, body.contains(""""device":"TCL 55C725 · Android 11""""))
    assertTrue(body, body.contains(""""message":"API GET /api/home""""))
    assertTrue(body, !body.contains("note"))
  }

  @Test
  fun `a single warning goes out as the tv client`() = runTest {
    server.enqueue(MockResponse().setResponseCode(204))

    client(start()).clientLog("WARN", "Player error: Network")

    val request = server.takeRequest()
    assertEquals("/api/client-log", request.path)
    val body = request.body.readUtf8()
    assertTrue(body, body.contains(""""client":"tv""""))
    assertTrue(body, body.contains(""""level":"WARN""""))
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
