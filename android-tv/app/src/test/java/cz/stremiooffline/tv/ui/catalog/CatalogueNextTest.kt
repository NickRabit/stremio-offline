package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.test.junit4.createComposeRule
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A catalogue episode never offered the next one on the television: only a library file asked for
 * its neighbour. The detail that started the play now names the next episode and plays it with its
 * own source rules, or says it cannot.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class CatalogueNextTest {

  @get:Rule val compose = createComposeRule()

  private val played = mutableListOf<PlayTarget>()
  private val bridge = CatalogueNextBridge()
  private var failed = 0

  private val one = VideoDto(id = "tt1:1:1", title = "One", season = 1, episode = 1)
  private val two = VideoDto(id = "tt1:1:2", title = "Two", season = 1, episode = 2)
  private val special = VideoDto(id = "tt1:0:1", title = "Special", season = 0, episode = 1)

  private fun api() = FakeTvApi().apply {
    settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", streamSort = "recommended", realDebridConfigured = true)
    metaValues["series:tt1"] = MetaDto(id = "tt1", type = "series", name = "Show", videos = listOf(one, two, special))
    streamsValues["series:tt1:1:1"] = listOf(StreamDto(sourceId = "s1", kind = "remote", playable = true, name = "One HD"))
  }

  private fun mount(api: FakeTvApi) {
    bridge.onFailed = { failed++ }
    compose.setContent {
      CatalogDetailScreen(
        api = api,
        args = CatalogDetailArgs(MetaDto(id = "tt1", type = "series", name = "Show"), "Cinemeta", "series"),
        imageUrl = { null },
        onPlay = { if (bridge.take() || played.isEmpty()) played += it },
        onBack = {},
        nextBridge = bridge,
      )
    }
    compose.waitForIdle()
  }

  @Test
  fun `the detail offers the next episode and plays it with its own source`() {
    val api = api()
    api.streamsValues["series:tt1:1:2"] = listOf(StreamDto(sourceId = "s2", kind = "remote", playable = true, name = "Two HD"))
    mount(api)
    compose.waitUntil(5_000) { bridge.offer != null }
    assertEquals("Show · Two", bridge.offer?.title)

    compose.runOnUiThread { bridge.advance() }
    compose.waitForIdle()
    compose.waitUntil(5_000) { played.isNotEmpty() }

    val target = played.single()
    assertEquals("series:tt1:1:2", target.key)
    assertEquals("s2", target.sourceId)
    assertEquals("tt1:1:2", target.subtitleTarget)
    assertEquals(true, target.catalogue)
    assertFalse(bridge.advancing)
    assertEquals(0, failed)
    // The episode it moved to has no regular one after it, and a special is never next.
    compose.waitUntil(5_000) { bridge.offer == null }
  }

  @Test
  fun `a next episode with nothing playable fails back to the detail`() {
    val api = api()
    api.streamsValues["series:tt1:1:2"] = emptyList()
    mount(api)
    compose.waitUntil(5_000) { bridge.offer != null }

    compose.runOnUiThread { bridge.advance() }
    compose.waitForIdle()
    compose.waitUntil(5_000) { failed == 1 }

    assertEquals(emptyList<PlayTarget>(), played)
    assertFalse(bridge.advancing)
  }

  @Test
  fun `the episode after follows the watching order and stops before the specials`() {
    val three = VideoDto(id = "tt1:2:1", season = 2, episode = 1)
    val later = VideoDto(id = "tt1:2:2", season = 2, episode = 2, released = "2999-01-01T00:00:00.000Z")
    val videos = listOf(three, special, two, one, later)
    assertEquals(two, catalogueEpisodeAfter(videos, one, today = "2026-11-06"))
    assertEquals(three, catalogueEpisodeAfter(videos, two, today = "2026-11-06"))
    assertNull(catalogueEpisodeAfter(videos, three, today = "2026-11-06"))
    assertNull(catalogueEpisodeAfter(listOf(one, special), one, today = "2026-11-06"))
    assertNull(catalogueEpisodeAfter(videos, null, today = "2026-11-06"))
  }

  @Test
  fun `leaving the player drops the wait for the next episode`() {
    var cancelled = 0
    val bridge = CatalogueNextBridge()
    bridge.offer = CatalogueNextOffer("Show · Two", {}, { cancelled++ })
    bridge.advance()
    bridge.cancel()
    assertEquals(1, cancelled)
    assertFalse(bridge.take())
    bridge.cancel()
    assertEquals(1, cancelled)
  }
}
