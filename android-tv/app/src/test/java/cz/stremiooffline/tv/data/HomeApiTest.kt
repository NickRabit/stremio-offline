package cz.stremiooffline.tv.data

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The exact request paths `GET /api/home` and `GET /api/downloads` put on the wire. */
class HomeApiTest {

  private val server = MockWebServer()

  @After
  fun shutdown() {
    server.shutdown()
  }

  @Test
  fun `the empty probe asks for no rows`() = runTest {
    server.enqueue(MockResponse().setBody("""{"generatedAt":"t","order":[{"id":"resume"}],"rows":{}}"""))

    val response = client(start()).home(emptyList())

    assertEquals("/api/home?rows=", server.takeRequest().path)
    assertEquals(listOf("resume"), response.order.map { it.id })
    assertTrue(response.rows.isEmpty())
  }

  @Test
  fun `the built-in request names every id, encoded`() = runTest {
    server.enqueue(MockResponse().setBody("""{"generatedAt":"t","order":[],"rows":{}}"""))

    client(start()).home(listOf("resume", "favorites", "tonight", "episodes", "completed", "recent"))

    assertEquals(
      "/api/home?rows=resume%2Cfavorites%2Ctonight%2Cepisodes%2Ccompleted%2Crecent",
      server.takeRequest().path,
    )
  }

  @Test
  fun `a catalogue request names the revealed ids only`() = runTest {
    server.enqueue(MockResponse().setBody("""{"generatedAt":"t","order":[],"rows":{}}"""))

    client(start()).home(listOf("catalog:addon:movie:top", "resume"))

    assertEquals("/api/home?rows=catalog%3Aaddon%3Amovie%3Atop%2Cresume", server.takeRequest().path)
  }

  @Test
  fun `downloads is read from its route`() = runTest {
    server.enqueue(
      MockResponse().setBody(
        """{"jobs":[{"id":"j1","title":"It","status":"failed","order":0,"mine":true,"pauseReason":"storage","libraryGone":true}],"halt":null}""",
      ),
    )

    val jobs = client(start()).downloads().jobs

    assertEquals("/api/downloads", server.takeRequest().path)
    assertEquals(1, jobs.size)
    assertEquals("j1", jobs[0].id)
    assertEquals("failed", jobs[0].status)
    assertEquals(true, jobs[0].mine)
    assertEquals("storage", jobs[0].pauseReason)
    assertEquals(true, jobs[0].libraryGone)
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
