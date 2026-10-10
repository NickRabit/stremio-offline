package cz.stremiooffline.tv.data

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The exact request paths and bodies the catalogue calls put on the wire. */
class CatalogApiTest {

  private val server = MockWebServer()

  @After
  fun shutdown() {
    server.shutdown()
  }

  @Test
  fun `catalogs asks the listing route`() = runTest {
    server.enqueue(MockResponse().setBody("""[{"addonKey":"a","addonName":"A","type":"movie","id":"top"}]"""))
    val catalogs = client(start()).catalogs()

    assertEquals("/api/catalogs", server.takeRequest().path)
    assertEquals("A", catalogs.single().addonName)
  }

  @Test
  fun `a catalogue page carries the addon, the type, the id, skip and genre`() = runTest {
    server.enqueue(MockResponse().setBody("""[{"id":"tt1","type":"movie","name":"It"}]"""))
    client(start()).catalog("key", "movie", "top", 40, "Action")

    assertEquals("/api/catalog?addon=key&type=movie&id=top&skip=40&genre=Action", server.takeRequest().path)
  }

  @Test
  fun `search carries the query and the cursor`() = runTest {
    server.enqueue(MockResponse().setBody("""{"items":[],"cursor":"c2","hasMore":false,"sources":2}"""))
    client(start()).search("matrix", "c1")

    assertEquals("/api/search?query=matrix&cursor=c1", server.takeRequest().path)
  }

  @Test
  fun `meta asks for the language of the interface`() = runTest {
    server.enqueue(MockResponse().setBody("""{"id":"tt1","type":"movie","name":"It"}"""))
    client(start()).meta("movie", "tt1", "en")

    assertEquals("/api/meta/movie/tt1?language=en", server.takeRequest().path)
  }

  @Test
  fun `streams of a movie name the title`() = runTest {
    server.enqueue(MockResponse().setBody("[]"))
    client(start()).streams("movie", "tt1")

    assertEquals("/api/streams/movie/tt1", server.takeRequest().path)
  }

  @Test
  fun `streams of an episode encode the colon of its id`() = runTest {
    server.enqueue(MockResponse().setBody("[]"))
    client(start()).streams("series", "tt1:1:2")

    assertEquals("/api/streams/series/tt1%3A1%3A2", server.takeRequest().path)
  }

  @Test
  fun `to library posts the title, the source and the media fields`() = runTest {
    server.enqueue(MockResponse().setResponseCode(201).setBody("""{"id":"j1","status":"queued"}"""))
    val media = MediaDto(
      kind = "episode",
      title = "Show",
      id = "tt1",
      metaType = "series",
      poster = "/api/image/p1",
      background = "/api/image/b1",
      season = 1,
      episode = 2,
      episodeTitle = "Volcano",
    )
    val result = client(start()).download("Show · Volcano", "src1", media)

    val request = server.takeRequest()
    assertEquals("/api/downloads", request.path)
    assertEquals("POST", request.method)
    val body = request.body.readUtf8()
    assertTrue(body, body.contains("\"title\":\"Show · Volcano\""))
    assertTrue(body, body.contains("\"sourceId\":\"src1\""))
    assertTrue(body, body.contains("\"kind\":\"episode\""))
    assertTrue(body, body.contains("\"season\":1"))
    assertTrue(body, body.contains("\"episodeTitle\":\"Volcano\""))
    // The server unwraps `/api/image/...` itself; an absolute URL would not be a proxied image.
    assertTrue(body, body.contains("\"poster\":\"/api/image/p1\""))
    assertEquals("queued", result.status)
  }

  @Test
  fun `watchlist toggle posts the type, the id and the wanted state`() = runTest {
    server.enqueue(MockResponse().setBody("""{"key":"movie:tt1","favorite":true}"""))
    client(start()).setWatchlist("movie", "tt1", "It", null, true)

    val request = server.takeRequest()
    assertEquals("/api/watchlist", request.path)
    val body = request.body.readUtf8()
    assertTrue(body, body.contains("\"type\":\"movie\""))
    assertTrue(body, body.contains("\"id\":\"tt1\""))
    assertTrue(body, body.contains("\"favorite\":true"))
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
