@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import java.util.concurrent.CountDownLatch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * OK pressed while the sources load: it waits for them and then plays the web's default,
 * with an 8 s escape hatch once something playable has arrived.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class CatalogPendingPlayTest {

  @get:Rule val compose = createComposeRule()

  private val played = mutableListOf<PlayTarget>()

  private fun settings() = SettingsResponse(uiLanguage = "en", audioLanguage = "en", streamSort = "recommended", realDebridConfigured = true)

  private fun source(key: String) = StreamSourceDto(key, key.replaceFirstChar { it.uppercase() })

  private fun stream(sourceId: String, title: String, addonName: String) =
    StreamDto(sourceId = sourceId, kind = "remote", playable = true, title = title, addonName = addonName)

  private fun movieArgs() = CatalogDetailArgs(MetaDto(id = "tt1", type = "movie", name = "It"), "Cinemeta", "movie")

  private fun mount(api: FakeTvApi, args: CatalogDetailArgs = movieArgs()) {
    compose.setContent {
      CatalogDetailScreen(api = api, args = args, imageUrl = { null }, onPlay = { played += it }, onBack = {})
    }
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun messageShown() = compose.onAllNodesWithTag(TagCatalogMessage).fetchSemanticsNodes().isNotEmpty()

  private fun hasText(text: String) = compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()

  /** Two addons whose answers the test releases: alpha has 1 GB, beta the larger 8 GB. */
  private fun twoSlowAddons(api: FakeTvApi): Pair<CountDownLatch, CountDownLatch> {
    api.settingsValue = settings()
    api.streamSourcesValues["movie:tt1"] = listOf(source("alpha"), source("beta"))
    api.addonStreams["movie:tt1|alpha"] = listOf(stream("srcA", "Czech 1 GB", "Alpha"))
    api.addonStreams["movie:tt1|beta"] = listOf(stream("srcB", "Czech 8 GB", "Beta"))
    val alpha = CountDownLatch(1)
    val beta = CountDownLatch(1)
    api.streamsLatches["movie:tt1|alpha"] = alpha
    api.streamsLatches["movie:tt1|beta"] = beta
    return alpha to beta
  }

  @Test
  fun `OK while both addons are pending plays the merged default once they answer`() {
    val api = FakeTvApi()
    val (alpha, beta) = twoSlowAddons(api)
    mount(api)
    compose.waitUntil(5_000) { api.streamsRequests.size == 2 }
    compose.waitForIdle()

    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { hasText("Starting when sources are ready…") }
    assertTrue(played.isEmpty())
    compose.onNodeWithTag(TagCatalogPrimary).assertTextContains("Starting when sources are ready…")

    alpha.countDown()
    compose.waitUntil(5_000) { api.streamsCompleted.contains("movie:tt1|alpha") }
    compose.waitForIdle()
    // The slow addon is still out, so nothing has played yet.
    assertTrue(played.isEmpty())

    beta.countDown()
    compose.waitUntil(5_000) { api.streamsCompleted.contains("movie:tt1|beta") }
    compose.waitUntil(5_000) { played.isNotEmpty() }
    compose.waitForIdle()
    assertEquals(listOf("srcB"), played.map { it.sourceId })
  }

  @Test
  fun `a playable stream plays at the deadline while the slow addon never answers`() {
    val api = FakeTvApi()
    val (alpha, beta) = twoSlowAddons(api)
    mount(api)
    compose.waitUntil(5_000) { api.streamsRequests.size == 2 }
    compose.waitForIdle()

    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { hasText("Starting when sources are ready…") }
    alpha.countDown()
    compose.waitUntil(5_000) { api.streamsCompleted.contains("movie:tt1|alpha") }
    compose.waitForIdle()
    assertTrue(played.isEmpty())

    compose.mainClock.advanceTimeBy(PLAY_WHEN_READY_TIMEOUT_MS + 100)
    compose.waitUntil(5_000) { played.isNotEmpty() }
    compose.waitForIdle()
    assertEquals(listOf("srcA"), played.map { it.sourceId })

    beta.countDown()
  }

  @Test
  fun `no playable source shows the no sources message and plays nothing`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    api.streamSourcesValues["movie:tt1"] = listOf(source("alpha"), source("beta"))
    api.addonStreams["movie:tt1|alpha"] = emptyList()
    api.addonStreams["movie:tt1|beta"] = emptyList()
    val alpha = CountDownLatch(1)
    val beta = CountDownLatch(1)
    api.streamsLatches["movie:tt1|alpha"] = alpha
    api.streamsLatches["movie:tt1|beta"] = beta
    mount(api)
    compose.waitUntil(5_000) { api.streamsRequests.size == 2 }
    compose.waitForIdle()

    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { hasText("Starting when sources are ready…") }
    compose.onNodeWithTag(TagCatalogPrimary).assertTextContains("Starting when sources are ready…")

    alpha.countDown()
    beta.countDown()
    compose.waitUntil(5_000) { api.streamsCompleted.contains("movie:tt1|beta") }
    compose.waitUntil(5_000) { messageShown() }
    compose.waitForIdle()

    assertTrue(played.isEmpty())
    compose.onNodeWithTag(TagCatalogMessage).assertTextContains("No active source addon has a stream for this title.")
  }

  @Test
  fun `switching episode while a play waits drops the wait`() {
    val api = FakeTvApi()
    api.settingsValue = settings()
    val first = VideoDto(id = "tt1:1:1", title = "One", season = 1, episode = 1)
    val second = VideoDto(id = "tt1:1:2", title = "Two", season = 1, episode = 2)
    api.metaValues["series:tt1"] = MetaDto(id = "tt1", type = "series", name = "Show", videos = listOf(first, second))
    api.streamsValues["series:tt1:1:1"] = listOf(stream("s1", "One's source", "Alpha"))
    api.streamsValues["series:tt1:1:2"] = listOf(stream("s2", "Two's source", "Beta"))
    val gate = CountDownLatch(1)
    api.streamsLatches["series:tt1:1:1"] = gate
    mount(api, CatalogDetailArgs(MetaDto(id = "tt1", type = "series", name = "Show"), "Cinemeta", "series"))
    compose.waitUntil(5_000) { api.streamsRequests.contains("series:tt1:1:1") }
    compose.waitForIdle()

    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { hasText("Starting when sources are ready…") }
    compose.onNodeWithTag(TagCatalogPrimary).assertTextContains("Starting when sources are ready…")

    // DOWN into the episode row (episode one is focused), RIGHT to episode two, OK selects it.
    press(Key.DirectionDown)
    press(Key.DirectionRight)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.streamsCompleted.contains("series:tt1:1:2") }
    compose.waitForIdle()

    gate.countDown()
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(PLAY_WHEN_READY_TIMEOUT_MS + 100)
    compose.waitUntil(5_000) { hasText("Play") }
    compose.waitForIdle()

    // Neither the stale episode nor the newly selected one plays on its own.
    assertTrue(played.isEmpty())
    compose.onNodeWithTag(TagCatalogPrimary).assertTextContains("Play")
  }
}
