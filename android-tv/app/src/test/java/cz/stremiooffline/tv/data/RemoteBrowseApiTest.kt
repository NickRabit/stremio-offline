package cz.stremiooffline.tv.data

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The lazy browse and preview routes: the client names the request exactly, encodes every opaque
 *  value, and never falls back to the snapshot items route. */
class RemoteBrowseApiTest {

  private val server = MockWebServer()

  @After
  fun shutdown() {
    server.shutdown()
  }

  private fun start(): ServerAddress {
    server.start()
    return ServerAddress.parse(server.url("/").toString())!!
  }

  private fun api(address: ServerAddress) = ApiClient(address, CookieStore(address.origin, Memory()))

  @Test
  fun `browse asks the browse route with the encoded query`() = runTest {
    server.enqueue(MockResponse().setBody("""{"items":[{"id":"f1","name":"Shows","type":"folder"}],"total":1}"""))

    val page = api(start()).remoteBrowse(
      libraryId = "lib/a b",
      cursor = "cur s+1",
      search = "rock & roll",
      type = "movie",
      parentId = "par/ent",
      mode = "folders",
      sort = "name",
      order = "asc",
    )

    assertEquals("f1", page.items.single().id)
    assertEquals("folder", page.items.single().type)
    assertEquals(
      "/api/remote-libraries/lib%2Fa%20b/browse" +
        "?limit=60&parentId=par%2Fent&mode=folders&cursor=cur%20s%2B1&search=rock%20%26%20roll&type=movie&sort=name&order=asc",
      server.takeRequest().path,
    )
  }

  @Test
  fun `browse sends only the limit when nothing else is asked`() = runTest {
    server.enqueue(MockResponse().setBody("""{"items":[],"total":0}"""))

    api(start()).remoteBrowse("rlibA")

    assertEquals("/api/remote-libraries/rlibA/browse?limit=60", server.takeRequest().path)
  }

  @Test
  fun `preview asks the library root without a parent`() = runTest {
    server.enqueue(MockResponse().setBody("""{"posters":["/api/media/a.jpg","/api/media/b.jpg"]}"""))

    val preview = api(start()).remotePreview("rlibA")

    assertEquals(listOf("/api/media/a.jpg", "/api/media/b.jpg"), preview.posters)
    assertEquals("/api/remote-libraries/rlibA/preview", server.takeRequest().path)
  }

  @Test
  fun `preview encodes the folder parent id`() = runTest {
    server.enqueue(MockResponse().setBody("""{"posters":[]}"""))

    api(start()).remotePreview("lib/1", "a b/c&d")

    assertEquals("/api/remote-libraries/lib%2F1/preview?parentId=a%20b%2Fc%26d", server.takeRequest().path)
  }

  @Test
  fun `a preview with no posters answers an empty list`() = runTest {
    server.enqueue(MockResponse().setResponseCode(204))

    assertEquals(emptyList<String>(), api(start()).remotePreview("rlibA").posters)
  }

  @Test
  fun `matched streams carry the resolved catalogue name as an encoded filter`() = runTest {
    server.enqueue(MockResponse().setBody("""{"streams":[]}"""))

    api(start()).remoteMatchedStreams("lib/1", "series", "tt5:1:2", nameHint = "Show & Order")

    assertEquals(
      "/api/remote-libraries/lib%2F1/streams/series/tt5%3A1%3A2?name=Show%20%26%20Order",
      server.takeRequest().path,
    )
  }

  @Test
  fun `matched streams send no name filter without a hint`() = runTest {
    server.enqueue(MockResponse().setBody("""{"streams":[]}"""))

    api(start()).remoteMatchedStreams("lib/1", "series", "tt5:1:2")

    assertEquals("/api/remote-libraries/lib%2F1/streams/series/tt5%3A1%3A2", server.takeRequest().path)
  }

  @Test
  fun `playback reports post the encoded route and every field`() = runTest {
    server.enqueue(MockResponse().setResponseCode(204))

    api(start()).reportRemotePlayback("lib A", "item/1", RemotePlaybackReport("ms1", 12, false, "progress"))

    val request = server.takeRequest()
    assertEquals("POST", request.method)
    assertEquals("/api/remote-libraries/lib%20A/items/item%2F1/playing", request.path)
    assertEquals(
      """{"mediaSourceId":"ms1","position":12,"paused":false,"event":"progress"}""",
      request.body.readUtf8(),
    )
  }

  @Test
  fun `a refused playback report surfaces as an api error`() = runTest {
    server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"no"}"""))

    val error = runCatching {
      api(start()).reportRemotePlayback("lib1", "item1", RemotePlaybackReport("ms1", 12, true, "stop"))
    }.exceptionOrNull()

    assertTrue(error is ApiError)
  }

  private class Memory : SessionPersistence {
    override fun loadSession(origin: String): String? = null
    override fun saveSession(origin: String, value: String?) = Unit
  }
}
