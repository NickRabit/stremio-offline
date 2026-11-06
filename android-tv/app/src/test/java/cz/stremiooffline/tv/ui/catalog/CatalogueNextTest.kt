package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.requestFocus
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.BehaviorHintsDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
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
  private val three = VideoDto(id = "tt1:1:3", title = "Three", season = 1, episode = 3)
  private val special = VideoDto(id = "tt1:0:1", title = "Special", season = 0, episode = 1)

  private fun api() = FakeTvApi().apply {
    settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", streamSort = "recommended", realDebridConfigured = true)
    metaValues["series:tt1"] = MetaDto(id = "tt1", type = "series", name = "Show", videos = listOf(one, two, special))
    streamsValues["series:tt1:1:1"] = listOf(StreamDto(sourceId = "s1", kind = "remote", playable = true, name = "One HD"))
  }

  private fun addonRow(sourceId: String, addonKey: String, addonName: String, episode: Int) = StreamDto(
    sourceId = sourceId,
    kind = "remote",
    playable = true,
    name = "$addonName $episode",
    addonKey = addonKey,
    addonName = addonName,
  )

  private fun twoAddonApi(videos: List<VideoDto>, rows: Map<String, Map<String, List<StreamDto>>>): FakeTvApi {
    val api = api()
    api.metaValues["series:tt1"] = MetaDto(id = "tt1", type = "series", name = "Show", videos = videos)
    rows.forEach { (episodeId, byAddon) ->
      api.streamSourcesValues["series:$episodeId"] =
        listOf(StreamSourceDto("alpha", "Alpha"), StreamSourceDto("beta", "Beta"))
      byAddon.forEach { (addon, streams) ->
        api.addonStreams["series:$episodeId|$addon"] = streams
      }
    }
    return api
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

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun openSources() {
    compose.onNodeWithTag(TagCatalogSources).requestFocus()
    press(Key.DirectionCenter)
  }

  private fun chooseSource(label: String) {
    compose.onNodeWithText(label).requestFocus()
    press(Key.DirectionCenter)
  }

  private fun play() {
    compose.onNodeWithTag(TagCatalogPrimary).requestFocus()
    press(Key.DirectionCenter)
  }

  private fun advance() {
    compose.runOnUiThread { bridge.advance() }
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
  fun `a hand-picked source keeps its provider on the next episode`() {
    val a1 = addonRow("a1", "alpha", "Alpha", 1)
    val b1 = addonRow("b1", "beta", "Beta", 1)
    val a2 = addonRow("a2", "alpha", "Alpha", 2)
    val b2 = addonRow("b2", "beta", "Beta", 2)
    val api = twoAddonApi(
      listOf(one, two, special),
      mapOf(
        one.id.orEmpty() to mapOf("alpha" to listOf(a1), "beta" to listOf(b1)),
        two.id.orEmpty() to mapOf("alpha" to listOf(a2), "beta" to listOf(b2)),
      ),
    )
    mount(api)
    compose.waitUntil(5_000) { bridge.offer != null }
    compose.waitUntil(5_000) {
      api.streamsCompleted.containsAll(listOf("series:tt1:1:1|alpha", "series:tt1:1:1|beta"))
    }
    compose.waitForIdle()

    openSources()
    chooseSource("Beta 1")
    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { played.size == 1 }
    assertEquals("b1", played.first().sourceId)

    advance()
    compose.waitUntil(5_000) { played.size == 2 }
    assertEquals("b2", played.last().sourceId)
    compose.onNodeWithTag(TagCatalogChosenSource).assertTextContains("Beta")
  }

  @Test
  fun `a hand pick keeps its own install when two installs share the addon name`() {
    fun row(sourceId: String, key: String, name: String) =
      StreamDto(sourceId = sourceId, kind = "remote", playable = true, name = name, addonKey = key, addonName = "Torrentio")
    val api = twoAddonApi(
      listOf(one, two, special),
      mapOf(
        one.id.orEmpty() to mapOf("alpha" to listOf(row("a1", "alpha", "First 1")), "beta" to listOf(row("b1", "beta", "Second 1"))),
        two.id.orEmpty() to mapOf("alpha" to listOf(row("a2", "alpha", "First 2")), "beta" to listOf(row("b2", "beta", "Second 2"))),
      ),
    )
    mount(api)
    compose.waitUntil(5_000) { bridge.offer != null }
    compose.waitUntil(5_000) {
      api.streamsCompleted.containsAll(listOf("series:tt1:1:1|alpha", "series:tt1:1:1|beta"))
    }
    compose.waitForIdle()

    openSources()
    chooseSource("Second 1")
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { played.size == 1 }
    assertEquals("b1", played.first().sourceId)

    advance()
    compose.waitUntil(5_000) { played.size == 2 }
    assertEquals("b2", played.last().sourceId)
  }

  @Test
  fun `a rule pick lets the rule choose again`() {
    val a1 = addonRow("a1", "alpha", "Alpha", 1)
    val b1 = addonRow("b1", "beta", "Beta", 1)
    val a2 = addonRow("a2", "alpha", "Alpha", 2)
    val b2 = addonRow("b2", "beta", "Beta", 2)
    val api = twoAddonApi(
      listOf(one, two, special),
      mapOf(
        one.id.orEmpty() to mapOf("alpha" to listOf(a1), "beta" to listOf(b1)),
        two.id.orEmpty() to mapOf("alpha" to listOf(a2), "beta" to listOf(b2)),
      ),
    )
    mount(api)
    compose.waitUntil(5_000) { bridge.offer != null }
    compose.waitUntil(5_000) {
      api.streamsCompleted.containsAll(listOf("series:tt1:1:1|alpha", "series:tt1:1:1|beta"))
    }
    compose.waitForIdle()

    play()
    compose.waitUntil(5_000) { played.size == 1 }
    assertEquals("a1", played.first().sourceId)

    advance()
    compose.waitUntil(5_000) { played.size == 2 }
    assertEquals("a2", played.last().sourceId)
  }

  @Test
  fun `a hand pick survives an episode without that provider`() {
    val a1 = addonRow("a1", "alpha", "Alpha", 1)
    val b1 = addonRow("b1", "beta", "Beta", 1)
    val a2 = addonRow("a2", "alpha", "Alpha", 2)
    val a3 = addonRow("a3", "alpha", "Alpha", 3)
    val b3 = addonRow("b3", "beta", "Beta", 3)
    val api = twoAddonApi(
      listOf(one, two, three, special),
      mapOf(
        one.id.orEmpty() to mapOf("alpha" to listOf(a1), "beta" to listOf(b1)),
        two.id.orEmpty() to mapOf("alpha" to listOf(a2)),
        three.id.orEmpty() to mapOf("alpha" to listOf(a3), "beta" to listOf(b3)),
      ),
    )
    mount(api)
    compose.waitUntil(5_000) { bridge.offer != null }
    compose.waitUntil(5_000) {
      api.streamsCompleted.containsAll(listOf("series:tt1:1:1|alpha", "series:tt1:1:1|beta"))
    }
    compose.waitForIdle()

    openSources()
    chooseSource("Beta 1")
    compose.onNodeWithTag(TagCatalogPrimary).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { played.size == 1 }
    assertEquals("b1", played.first().sourceId)

    advance()
    compose.waitUntil(5_000) { played.size == 2 }
    assertEquals("a2", played.last().sourceId)
    compose.waitUntil(5_000) { bridge.offer?.title == "Show · Three" }

    advance()
    compose.waitUntil(5_000) { played.size == 3 }
    assertEquals("b3", played.last().sourceId)
  }

  @Test
  fun `a source chosen in the player counts as a hand pick`() {
    val a1 = addonRow("a1", "alpha", "Alpha", 1)
    val b1 = addonRow("b1", "beta", "Beta", 1)
    val a2 = addonRow("a2", "alpha", "Alpha", 2)
    val b2 = addonRow("b2", "beta", "Beta", 2)
    val api = twoAddonApi(
      listOf(one, two, special),
      mapOf(
        one.id.orEmpty() to mapOf("alpha" to listOf(a1), "beta" to listOf(b1)),
        two.id.orEmpty() to mapOf("alpha" to listOf(a2), "beta" to listOf(b2)),
      ),
    )
    mount(api)
    compose.waitUntil(5_000) { bridge.offer != null }
    compose.waitUntil(5_000) {
      api.streamsCompleted.containsAll(listOf("series:tt1:1:1|alpha", "series:tt1:1:1|beta"))
    }
    compose.waitForIdle()

    play()
    compose.waitUntil(5_000) { played.size == 1 }
    assertEquals("a1", played.first().sourceId)
    compose.runOnUiThread { bridge.choseInPlayer(b1) }

    advance()
    compose.waitUntil(5_000) { played.size == 2 }
    assertEquals("b2", played.last().sourceId)
  }

  @Test
  fun `replaying the rules' row after leaving the player is not a hand pick`() {
    val a = addonRow("a", "alpha", "Alpha", 1)
    val b = addonRow("b", "beta", "Beta", 1)

    bridge.played(a, byHand = false)
    bridge.played(a, byHand = true)
    assertNull(bridge.handPick)

    bridge.played(b, byHand = true)
    assertEquals(b, bridge.handPick)
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

class StreamsNextEpisodeRowTest {

  private fun stream(
    sourceId: String,
    addonKey: String?,
    addonName: String?,
    title: String,
    size: Long? = null,
    playable: Boolean = true,
    kind: String = "remote",
    remoteItem: RemoteItemContext? = null,
  ) = StreamDto(
    sourceId = sourceId,
    kind = kind,
    playable = playable,
    title = title,
    addonKey = addonKey,
    addonName = addonName,
    behaviorHints = size?.let { BehaviorHintsDto(videoSize = it.toDouble()) },
    remoteItem = remoteItem,
  )

  @Test
  fun `prefers the current audio language over list order`() {
    val current = stream("current", "alpha", "Alpha", "Czech 2 GB", 2_000)
    val english = stream("english", "alpha", "Alpha", "English 2 GB", 2_000)
    val czech = stream("czech", "alpha", "Alpha", "Czech 2 GB", 8_000)

    assertEquals(czech, Streams.nextEpisodeRow(current, listOf(english, czech), "cs", null))
  }

  @Test
  fun `chooses the closest size among rows in the preferred language`() {
    val current = stream("current", "alpha", "Alpha", "English 2 GB", 2_000)
    val far = stream("far", "alpha", "Alpha", "English 8 GB", 8_000)
    val close = stream("close", "alpha", "Alpha", "English 1 GB", 1_000)

    assertEquals(close, Streams.nextEpisodeRow(current, listOf(far, close), "en", null))
  }

  @Test
  fun `matches by addon name when the addon key is blank`() {
    val current = stream("current", null, "Second", "English 2 GB", 2_000)
    val other = stream("other", null, "First", "English 2 GB", 2_000)
    val same = stream("same", null, "Second", "English 2 GB", 2_000)

    assertEquals(same, Streams.nextEpisodeRow(current, listOf(other, same), "en", null))
  }

  @Test
  fun `two installs of one addon under the same name are told apart by their key`() {
    val current = stream("current", "second-install", "Torrentio", "English 900 MB", 900)
    val first = stream("first", "first-install", "Torrentio", "English 900 MB", 900)
    val second = stream("second", "second-install", "Torrentio", "English 900 MB", 900)

    assertEquals(second, Streams.nextEpisodeRow(current, listOf(first, second), "en", null))
  }

  @Test
  fun `ignores unplayable local and remote rows`() {
    val current = stream("current", "alpha", "Alpha", "English 2 GB", 2_000)
    val unplayable = stream("unplayable", "alpha", "Alpha", "English 2 GB", 2_000, playable = false)
    val local = stream("local", "alpha", "Alpha", "English 2 GB", 2_000, kind = "library")
    val remote = stream(
      "remote",
      "alpha",
      "Alpha",
      "English 2 GB",
      2_000,
      remoteItem = RemoteItemContext("library", "item", "source", "progress"),
    )
    val playable = stream("playable", "alpha", "Alpha", "English 2 GB", 2_000)

    assertEquals(playable, Streams.nextEpisodeRow(current, listOf(unplayable, local, remote, playable), "en", null))
  }

  @Test
  fun `returns null without a playable row from the same addon`() {
    val current = stream("current", "alpha", "Alpha", "English 2 GB", 2_000)
    val other = stream("other", "beta", "Beta", "English 2 GB", 2_000)

    assertNull(Streams.nextEpisodeRow(current, listOf(other), "en", null))
  }
}
