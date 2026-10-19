package cz.stremiooffline.tv.data

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
    client(start()).search("matrix", "c1", SearchScope())

    assertEquals("/api/search?query=matrix&cursor=c1", server.takeRequest().path)
  }

  @Test
  fun `search pointed at a catalogue carries the addon, the type and the id`() = runTest {
    server.enqueue(MockResponse().setBody("""{"items":[],"cursor":"","hasMore":false,"sources":1}"""))
    client(start()).search("matrix", null, SearchScope("key", "series", "top"))

    assertEquals("/api/search?query=matrix&addon=key&catalogType=series&catalogId=top", server.takeRequest().path)
  }

  @Test
  fun `search pointed at an addon carries only its key`() = runTest {
    server.enqueue(MockResponse().setBody("""{"items":[],"cursor":"","hasMore":false,"sources":1}"""))
    client(start()).search("matrix", null, SearchScope(addonKey = "key"))

    assertEquals("/api/search?query=matrix&addon=key", server.takeRequest().path)
  }

  @Test
  fun `catalogue search starts, polls, pages and deletes its session`() = runTest {
    val client = client(start())
    server.enqueue(
      MockResponse().setBody(
        """{"id":"cs_1","snapshot":{"revision":1,"state":"partial","items":[],"sources":2,"pending":1,"failed":0,"hasMore":true}}""",
      ),
    )
    server.enqueue(
      MockResponse().setBody(
        """{"changed":true,"snapshot":{"revision":2,"state":"complete","items":[],"sources":2,"pending":0,"failed":0,"hasMore":false}}""",
      ),
    )
    server.enqueue(MockResponse().setResponseCode(202).setBody("""{"revision":3}"""))
    server.enqueue(MockResponse().setResponseCode(204))

    val started = client.startCatalogSearch(
      CatalogSearchStartDto(
        query = "matrix",
        type = "movie",
        scope = CatalogSearchScopeDto("key", "movie", "top"),
        slotId = "slot",
        generation = 2,
      ),
    )
    val polled = client.pollCatalogSearch("cs_1", 1)
    val revision = client.pageCatalogSearch("cs_1")
    client.deleteCatalogSearch("cs_1")

    val startRequest = server.takeRequest()
    val pollRequest = server.takeRequest()
    val pageRequest = server.takeRequest()
    val deleteRequest = server.takeRequest()
    assertEquals("/api/search/catalog", startRequest.path)
    assertEquals(
      """{"query":"matrix","type":"movie","scope":{"addonKey":"key","catalogType":"movie","catalogId":"top"},"slotId":"slot","generation":2}""",
      startRequest.body.readUtf8(),
    )
    assertEquals("/api/search/catalog/cs_1/poll", pollRequest.path)
    assertEquals("/api/search/catalog/cs_1/page", pageRequest.path)
    assertEquals("DELETE", deleteRequest.method)
    assertEquals("cs_1", started.id)
    assertEquals("complete", polled.snapshot?.state)
    assertEquals(3, revision)
  }

  @Test
  fun `searchable asks the listing of scopes`() = runTest {
    server.enqueue(MockResponse().setBody("""[{"addonKey":"a","addonName":"A","globalSearch":false,"type":"series","id":"top","name":"Popular"}]"""))
    val scopes = client(start()).searchable()

    assertEquals("/api/searchable", server.takeRequest().path)
    assertEquals("Popular", scopes.single().name)
    assertEquals(false, scopes.single().globalSearch)
  }

  @Test
  fun `search state reads the shared history`() = runTest {
    server.enqueue(
      MockResponse().setBody("""{"saveHistory":true,"liveSearch":false,"defaultOrder":"titleMatch","recent":[{"query":"Heat","usedAt":"2026-01-01T00:00:00.000Z"}]}""")
    )
    val state = client(start()).searchState()

    assertEquals("/api/search/state", server.takeRequest().path)
    assertEquals("Heat", state.recent.single().query)
    assertEquals("titleMatch", state.defaultOrder)
  }

  @Test
  fun `recording a search posts just the query`() = runTest {
    server.enqueue(MockResponse().setResponseCode(204))
    client(start()).recordSearch("Heat")

    val request = server.takeRequest()
    assertEquals("/api/search/history", request.path)
    assertEquals("POST", request.method)
    assertEquals("""{"query":"Heat"}""", request.body.readUtf8())
  }

  @Test
  fun `forgetting a search posts the query and answers the new state`() = runTest {
    server.enqueue(MockResponse().setBody("""{"saveHistory":true,"liveSearch":true,"defaultOrder":"source","recent":[]}"""))
    val state = client(start()).forgetSearch("Heat")

    val request = server.takeRequest()
    assertEquals("/api/search/history/forget", request.path)
    assertEquals("POST", request.method)
    assertEquals("""{"query":"Heat"}""", request.body.readUtf8())
    assertTrue(state.recent.isEmpty())
  }

  @Test
  fun `clearing the history deletes and answers the new state`() = runTest {
    server.enqueue(MockResponse().setBody("""{"saveHistory":true,"liveSearch":true,"defaultOrder":"source","recent":[]}"""))
    val state = client(start()).clearSearchHistory()

    val request = server.takeRequest()
    assertEquals("/api/search/history", request.path)
    assertEquals("DELETE", request.method)
    assertTrue(state.recent.isEmpty())
  }

  @Test
  fun `meta asks for the language of the interface`() = runTest {
    server.enqueue(MockResponse().setBody("""{"id":"tt1","type":"movie","name":"It"}"""))
    client(start()).meta("movie", "tt1", "en")

    assertEquals("/api/meta/movie/tt1?language=en", server.takeRequest().path)
  }

  @Test
  fun `streamSources lists the addons that offer a source`() = runTest {
    server.enqueue(MockResponse().setBody("""[{"key":"alpha","name":"Alpha"}]"""))
    val sources = client(start()).streamSources("movie", "tt1")

    assertEquals("/api/stream-sources/movie/tt1", server.takeRequest().path)
    assertEquals("Alpha", sources.single().name)
  }

  @Test
  fun `streams of a movie name the title`() = runTest {
    server.enqueue(MockResponse().setBody("[]"))
    client(start()).streams("movie", "tt1")

    assertEquals("/api/streams/movie/tt1", server.takeRequest().path)
  }

  @Test
  fun `streams of one addon carry the addon key`() = runTest {
    server.enqueue(MockResponse().setBody("[]"))
    client(start()).streams("movie", "tt1", "alpha")

    assertEquals("/api/streams/movie/tt1?addon=alpha", server.takeRequest().path)
  }

  @Test
  fun `streams of an episode encode the colon of its id`() = runTest {
    server.enqueue(MockResponse().setBody("[]"))
    client(start()).streams("series", "tt1:1:2")

    assertEquals("/api/streams/series/tt1%3A1%3A2", server.takeRequest().path)
  }

  @Test
  fun `the title of a library file carries its path`() = runTest {
    server.enqueue(MockResponse().setBody("""{"type":"series","id":"tt5","videoId":"tt5:1:2","name":"Show"}"""))
    val title = client(start()).libraryTitle("Shows/Show S01/E02.mkv")

    assertEquals("/api/library/title?path=Shows%2FShow%20S01%2FE02.mkv", server.takeRequest().path)
    assertEquals("tt5:1:2", title?.videoId)
  }

  @Test
  fun `an unbound library file answers null`() = runTest {
    server.enqueue(MockResponse().setBody("{}"))

    assertNull(client(start()).libraryTitle("Filmy/Loose.mkv"))
  }

  @Test
  fun `a refused library title answers null`() = runTest {
    server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":"nope"}"""))

    assertNull(client(start()).libraryTitle("Filmy/Loose.mkv"))
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
    assertTrue(body, !body.contains("addonKey"))
  }

  @Test
  fun `watchlist toggle names the addon the title was starred from`() = runTest {
    server.enqueue(MockResponse().setBody("""{"key":"movie:tt1","favorite":true}"""))
    client(start()).setWatchlist("movie", "tt1", "It", null, true, "pleasure")

    val body = server.takeRequest().body.readUtf8()
    assertTrue(body, body.contains("\"addonKey\":\"pleasure\""))
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
