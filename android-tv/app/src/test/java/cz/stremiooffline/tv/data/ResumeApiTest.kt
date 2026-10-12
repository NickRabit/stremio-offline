package cz.stremiooffline.tv.data

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

/** The exact request the merged Continue watching calls put on the wire. */
class ResumeApiTest {

  private val server = MockWebServer()

  @After
  fun shutdown() {
    server.shutdown()
  }

  @Test
  fun `the resume page names its filter, limit and skip`() = runTest {
    server.enqueue(MockResponse().setBody("""{"items":[],"total":0,"pending":false}"""))

    client(start()).resume(ResumeFilter.Library, limit = 60, skip = 20)

    assertEquals("/api/resume?filter=library&limit=60&skip=20", server.takeRequest().path)
  }

  @Test
  fun `the merged filter is sent as all`() = runTest {
    server.enqueue(MockResponse().setBody("""{"items":[],"total":0,"pending":false}"""))

    client(start()).resume()

    assertEquals("/api/resume?filter=all&limit=60&skip=0", server.takeRequest().path)
  }

  @Test
  fun `forgetting posts every key in one body`() = runTest {
    server.enqueue(MockResponse().setResponseCode(204))

    client(start()).forgetProgress(listOf("file:a", "series:tt1:1:2"))

    val request = server.takeRequest()
    assertEquals("POST", request.method)
    assertEquals("/api/progress/forget", request.path)
    assertEquals("""{"keys":["file:a","series:tt1:1:2"]}""", request.body.readUtf8())
  }

  @Test
  fun `forgetting nothing asks the server nothing`() = runTest {
    client(start()).forgetProgress(emptyList())

    assertEquals(0, server.requestCount)
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
