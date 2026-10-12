package cz.stremiooffline.tv.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The body `POST /api/downloads/bulk` reads, built the way the web builds it. */
class BulkDownloadBodyTest {

  // The client's own shape: a null field is left out of the body, not sent as null.
  private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = false }

  private fun encode(request: BulkDownloadRequest): String =
    json.encodeToString(BulkDownloadRequest.serializer(), request)

  @Test
  fun `the whole body carries the web's fields in the web's order`() {
    val body = bulkDownloadBody(
      title = "Show",
      type = "series",
      episodes = listOf(BulkEpisodeDto("e1", 1, 1, "Pilot"), BulkEpisodeDto("e2", 1, 2)),
      selection = DownloadSelectionDto(
        addonKeys = listOf("alpha", "beta"),
        sourceStrategy = "largest",
        audioLanguage = "en",
        audioMode = "listed",
        subtitleMode = "optional",
        subtitleLanguage = "cs",
        fallbackSubtitleLanguage = "en",
      ),
      media = BulkMediaDto(id = "tt1", metaType = "series", poster = "p.jpg"),
      target = DownloadTargetDto("shows"),
    )

    assertEquals(
      """{"title":"Show","type":"series",""" +
        """"episodes":[{"id":"e1","season":1,"episode":1,"title":"Pilot"},{"id":"e2","season":1,"episode":2}],""" +
        """"selection":{"addonKeys":["alpha","beta"],"sourceStrategy":"largest","audioLanguage":"en",""" +
        """"audioMode":"listed","subtitleMode":"optional","subtitleLanguage":"cs","fallbackSubtitleLanguage":"en"},""" +
        """"media":{"id":"tt1","metaType":"series","poster":"p.jpg"},"target":{"libraryId":"shows"}}""",
      encode(body),
    )
  }

  @Test
  fun `no target and no fallbacks leave those keys out of the body`() {
    val body = bulkDownloadBody(
      title = "Show",
      type = "series",
      episodes = listOf(BulkEpisodeDto("e1")),
      selection = DownloadSelectionDto(
        addonKeys = listOf("alpha"),
        sourceStrategy = "priority",
        audioLanguage = "en",
        audioMode = "listed",
        subtitleMode = "off",
      ),
      media = BulkMediaDto(id = "tt1", metaType = "series"),
      target = null,
    )
    val text = encode(body)

    assertFalse(text, text.contains("target"))
    assertFalse(text, text.contains("fallback"))
    assertFalse(text, text.contains("season"))
    assertTrue(text, text.contains(""""subtitleMode":"off""""))
  }

  @Test
  fun `episodes carry the id and the numbers a video has`() {
    val videos = listOf(
      VideoDto(id = "e1", season = 1, episode = 1, title = "Pilot"),
      VideoDto(id = null, season = 1, episode = 2),
      VideoDto(id = "e3", season = 1, episode = 3, name = "Named"),
    )

    assertEquals(
      listOf(BulkEpisodeDto("e1", 1, 1, "Pilot"), BulkEpisodeDto("e3", 1, 3, "Named")),
      bulkEpisodes(videos),
    )
  }
}
