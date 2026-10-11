package cz.stremiooffline.tv.data

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** What the To library choice puts on the wire, and how the library list is read back. */
class DownloadApiTest {

  private val server = MockWebServer()

  @After
  fun shutdown() {
    server.shutdown()
  }

  @Test
  fun `the to-library body carries the picked target`() = runTest {
    server.enqueue(MockResponse().setBody("""{"id":"j1","status":"queued"}"""))

    client(start()).download("It", "src1", MediaDto(kind = "movie", title = "It"), DownloadTargetDto("movies"))

    val request = server.takeRequest()
    assertEquals("/api/downloads", request.path)
    val body = request.body.readUtf8()
    assertTrue(body, body.contains(""""target":{"libraryId":"movies"}"""))
  }

  @Test
  fun `queuing without a target leaves the field out`() = runTest {
    server.enqueue(MockResponse().setBody("""{"id":"j1","status":"queued"}"""))

    client(start()).download("It", "src1", MediaDto(kind = "movie", title = "It"), null)

    val body = server.takeRequest().body.readUtf8()
    assertTrue(body, !body.contains("target"))
  }

  @Test
  fun `libraries read writable and fall back to the older-server rule`() = runTest {
    server.enqueue(
      MockResponse().setBody(
        """[{"id":"a","name":"A","type":"movie","writable":true},""" +
          """{"id":"b","name":"B","type":"movie","enabled":true,"readOnly":false},""" +
          """{"id":"c","name":"C","type":"movie","enabled":true,"readOnly":true}]""",
      ),
    )

    val libraries = client(start()).libraries()

    assertEquals("/api/libraries", server.takeRequest().path)
    assertEquals(true, libraries[0].canWrite)
    // No `writable` field: visible, enabled and writable is what the older server means.
    assertEquals(true, libraries[1].canWrite)
    assertEquals(false, libraries[2].canWrite)
  }

  @Test
  fun `a refusal carries the server's own message`() = runTest {
    server.enqueue(
      MockResponse().setResponseCode(403)
        .setBody("""{"error":"This account may not save to that library. Choose another one.","messageKey":"err.downloadLibraryNotAllowed"}"""),
    )

    try {
      client(start()).download("It", "src1", MediaDto(kind = "movie", title = "It"), DownloadTargetDto("movies"))
      fail("expected the refusal to reach the caller")
    } catch (error: ApiError) {
      assertEquals(ApiFailure.Forbidden, error.failure)
      assertEquals("This account may not save to that library. Choose another one.", error.serverMessage)
    }
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
