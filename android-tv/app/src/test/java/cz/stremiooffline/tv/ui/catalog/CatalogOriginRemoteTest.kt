@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class CatalogOriginRemoteTest {

  @get:Rule val compose = createComposeRule()

  private val played = mutableListOf<PlayTarget>()
  private val gateKey = "rlibA|movie|tt1"

  private fun addonRow() = StreamDto(
    sourceId = "addon-version",
    kind = "remote",
    playable = true,
    title = "Addon title",
    addonName = "Addon version",
  )

  private fun remoteRow() = StreamDto(
    sourceId = "remote-version",
    kind = "remote",
    playable = true,
    name = "Server version",
    provider = "jellyfin",
    libraryName = "Filmy",
    remoteItem = RemoteItemContext(
      libraryId = "rlibA",
      itemId = "item-1",
      mediaSourceId = "media-1",
      progressKey = "remote:rlibA:item-1",
    ),
  )

  private fun api(remoteGate: CompletableDeferred<Unit>) = FakeTvApi().apply {
    settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", streamSort = "recommended", realDebridConfigured = true)
    streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    addonStreams["movie:tt1|alpha"] = listOf(addonRow())
    remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibA", name = "Filmy", provider = "jellyfin"))
    remoteMatchGates[gateKey] = remoteGate
    remoteMatchValues[gateKey] = listOf(remoteRow())
  }

  private fun mount(api: FakeTvApi) {
    compose.setContent {
      CatalogDetailScreen(
        api = api,
        args = CatalogDetailArgs(
          meta = MetaDto(id = "tt1", type = "movie", name = "Heat"),
          addonName = "",
          type = "movie",
          preferredRemote = RemoteItemRef("rlibA", "item-1", "media-1"),
        ),
        imageUrl = { null },
        onPlay = { played += it },
        onBack = {},
      )
    }
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focused(tag: String): Boolean =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .any { it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag }

  private fun chooseAddonSource() {
    repeat(6) {
      if (!focused(TagCatalogSources)) press(Key.DirectionRight)
    }
    compose.onNodeWithTag(TagCatalogSources).assertIsFocused()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    press(Key.DirectionCenter)
  }

  private fun play() {
    compose.onNodeWithTag(TagCatalogPrimary).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    press(Key.DirectionCenter)
  }

  @Test
  fun `the preferred remote row replaces an automatic addon pick when it arrives`() {
    val remoteGate = CompletableDeferred<Unit>()
    val api = api(remoteGate)
    mount(api)
    compose.waitUntil(5_000) { api.streamsCompleted.contains("movie:tt1|alpha") }
    compose.waitUntil(5_000) { api.remoteMatchRequests.contains(gateKey) }
    compose.waitForIdle()
    compose.onNodeWithTag(TagCatalogChosenSource).assertTextContains("Addon version", substring = true)

    remoteGate.complete(Unit)
    compose.waitUntil(5_000) { api.remoteMatchesInFlight == 0 }
    compose.waitForIdle()
    compose.onNodeWithTag(TagCatalogChosenSource).assertTextContains("jellyfin", substring = true)

    play()

    val target = played.single()
    assertEquals("remote-version", target.sourceId)
    assertEquals(RemoteItemContext("rlibA", "item-1", "media-1", "remote:rlibA:item-1"), target.remoteItem)
  }

  @Test
  fun `an in-progress stored addon row wins over the preferred remote row`() {
    val api = api(CompletableDeferred(Unit)).apply {
      addonStreams["movie:tt1|alpha"] = listOf(addonRow().copy(stableKey = "addon-key"))
      progressValues["movie:tt1"] = ProgressDto(position = 120.0, duration = 600.0, stableKey = "addon-key")
    }
    mount(api)
    compose.waitUntil(5_000) { api.streamsCompleted.contains("movie:tt1|alpha") }
    compose.waitUntil(5_000) { api.remoteMatchRequests.contains(gateKey) }
    compose.waitForIdle()

    play()

    val target = played.single()
    assertEquals("addon-version", target.sourceId)
    assertNull(target.remoteItem)
  }

  @Test
  fun `a viewer's addon pick stays when the preferred remote row arrives`() {
    val remoteGate = CompletableDeferred<Unit>()
    val api = api(remoteGate)
    mount(api)
    compose.waitUntil(5_000) { api.streamsCompleted.contains("movie:tt1|alpha") }
    compose.waitUntil(5_000) { api.remoteMatchRequests.contains(gateKey) }
    compose.waitForIdle()

    chooseAddonSource()
    remoteGate.complete(Unit)
    compose.waitUntil(5_000) { api.remoteMatchesInFlight == 0 }
    compose.waitForIdle()
    compose.onNodeWithTag(TagCatalogChosenSource).assertTextContains("Addon version", substring = true)

    play()

    val target = played.single()
    assertEquals("addon-version", target.sourceId)
    assertNull(target.remoteItem)
  }

  @Test
  fun `an episode card opens the series named by the catalogue on that episode and its server copy`() {
    val episode = VideoDto(id = "tt9:2:3", title = "Episode Three", season = 2, episode = 3)
    val api = FakeTvApi().apply {
      settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", streamSort = "recommended", realDebridConfigured = true)
      metaValues["series:tt9"] = MetaDto(
        id = "tt9",
        type = "series",
        name = "The Show",
        videos = listOf(VideoDto(id = "tt9:1:1", title = "Pilot", season = 1, episode = 1), episode),
      )
      streamSourcesValues["series:tt9:2:3"] = listOf(StreamSourceDto("alpha", "Alpha"))
      addonStreams["series:tt9:2:3|alpha"] = listOf(addonRow())
      remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibA", name = "Serialy", provider = "jellyfin"))
      remoteMatchValues["rlibA|series|tt9:2:3"] = listOf(
        remoteRow().copy(remoteItem = RemoteItemContext("rlibA", "episode-9", "ms9", "remote:rlibA:episode-9")),
      )
    }
    compose.setContent {
      CatalogDetailScreen(
        api = api,
        args = CatalogDetailArgs(
          meta = MetaDto(id = "tt9", type = "series"),
          addonName = "",
          type = "series",
          episode = cz.stremiooffline.tv.catalog.ResumeEpisode("series:tt9:2:3", 2, 3),
          preferRemote = true,
          preferredRemote = RemoteItemRef("rlibA", "episode-9", "ms9"),
        ),
        imageUrl = { null },
        onPlay = { played += it },
        onBack = {},
      )
    }
    compose.waitUntil(5_000) { api.remoteMatchRequests.contains("rlibA|series|tt9:2:3") }
    compose.waitForIdle()

    compose.onNodeWithText("The Show").assertExists()
    play()

    val target = played.single()
    assertEquals("series:tt9:2:3", target.key)
    assertEquals("episode-9", target.remoteItem?.itemId)
  }

  @Test
  fun `the item the detail was opened from plays even when the match by catalogue id missed it`() {
    val api = api(CompletableDeferred(Unit)).apply {
      remoteMatchValues[gateKey] = emptyList()
      remoteSourcesValue = listOf(remoteRow())
    }
    mount(api)
    compose.waitUntil(5_000) { api.remoteSourcesRequests.isNotEmpty() }
    compose.waitForIdle()

    assertEquals(listOf("rlibA" to "item-1"), api.remoteSourcesRequests)
    play()
    assertEquals("item-1", played.single().remoteItem?.itemId)
  }

  @Test
  fun `another episode never borrows the versions of the one the detail was opened from`() {
    val args = CatalogDetailArgs(
      meta = MetaDto(id = "tt9", type = "series"),
      addonName = "",
      type = "series",
      episode = cz.stremiooffline.tv.catalog.ResumeEpisode("series:tt9:2:3", 2, 3),
      preferredRemote = RemoteItemRef("rlibA", "episode-9"),
    )
    assertEquals(RemoteItemRef("rlibA", "episode-9"), originFor(args, "tt9:2:3"))
    assertNull(originFor(args, "tt9:2:4"))
    assertNull(originFor(args.copy(preferredRemote = RemoteItemRef("rlibA", "")), "tt9:2:3"))
  }
}
