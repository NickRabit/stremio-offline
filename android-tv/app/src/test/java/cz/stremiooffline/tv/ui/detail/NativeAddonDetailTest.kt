@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.detail

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.DownloadTargetDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.MediaDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemsPageDto
import cz.stremiooffline.tv.data.RemoteProviderIdsDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.TagAddonDiscover
import cz.stremiooffline.tv.ui.catalog.TagNativeQueueDefault
import cz.stremiooffline.tv.ui.catalog.TagSourcesPanel
import cz.stremiooffline.tv.ui.catalog.addonProviderTag
import cz.stremiooffline.tv.ui.catalog.nativeQueueLibraryTag
import cz.stremiooffline.tv.ui.catalog.sourceRowTag
import cz.stremiooffline.tv.ui.catalog.sourceSaveTag
import cz.stremiooffline.tv.ui.library.remoteItemTag
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The explicit addon sources on a native detail: nothing is asked until the panel's own button is
 * pressed, one provider is loaded for its own key alone, the native version stays the default and
 * a chosen addon row plays a generic target carrying exactly the rows that were in hand.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class NativeAddonDetailTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>

  /** Every call the addon path may not make throws instead of answering empty. */
  private class StrictApi : FakeTvApi() {
    val calls = mutableListOf<String>()

    override suspend fun settings(): SettingsResponse {
      calls += "settings"
      return settingsValue
    }

    override suspend fun streamSources(type: String, id: String): List<StreamSourceDto> {
      calls += "streamSources:$type:$id"
      return streamSourcesValues["$type:$id"] ?: throw ApiError(ApiFailure.NotFound)
    }

    override suspend fun streams(type: String, id: String, addon: String?): List<StreamDto> {
      calls += "streams:$type:$id:${addon ?: "*"}"
      if (addon.isNullOrEmpty()) throw ApiError(ApiFailure.Generic)
      return addonStreams["$type:$id|$addon"] ?: throw ApiError(ApiFailure.NotFound)
    }
  }

  @Before
  fun launchHost() {
    scenario = ActivityScenario.launch(
      Intent(ApplicationProvider.getApplicationContext(), ComponentActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
  }

  @After
  fun closeHost() {
    scenario.close()
  }

  private fun movie(ids: RemoteProviderIdsDto = RemoteProviderIdsDto(imdb = "tt1")) = RemoteItemDto(
    id = "iA",
    name = "Heat",
    type = "movie",
    providerIds = ids,
    poster = "poster.jpg",
  )

  private fun episode() = RemoteItemDto(
    id = "eA",
    name = "Pilot",
    type = "episode",
    season = 1,
    episode = 2,
    providerIds = RemoteProviderIdsDto(imdb = "tt9999"),
  )

  private fun data(item: RemoteItemDto = movie(), seriesIds: RemoteProviderIdsDto? = null) = RemoteDetailData(
    libraryId = "rlibA",
    libraryName = "Filmy",
    provider = "jellyfin",
    item = item,
    seriesName = if (item.type == "episode") "Show" else null,
    seriesIds = seriesIds,
  )

  private fun version(sourceId: String) = StreamDto(
    sourceId = sourceId,
    kind = "remote",
    playable = true,
    name = "Version $sourceId",
    remoteItem = RemoteItemContext(libraryId = "rlibA", itemId = "iA", mediaSourceId = sourceId, progressKey = "remote:rlibA:iA"),
  )

  private fun addonRow(sourceId: String, title: String) = StreamDto(
    sourceId = sourceId,
    kind = "remote",
    playable = true,
    title = title,
  )

  private fun library(id: String, name: String) = LibraryDto(id = id, name = name, type = "movie", writable = true)

  private data class Queued(val title: String, val sourceId: String, val media: MediaDto, val target: DownloadTargetDto?)

  private val played = mutableListOf<PlayTarget>()
  private val queued = mutableListOf<Queued>()
  private var destinations: List<LibraryDto> = listOf(library("libA", "Films"))
  private var destinationsFailure: ApiError? = null

  private fun mount(api: StrictApi, data: RemoteDetailData = data()) {
    scenario.onActivity { activity ->
      activity.setContent {
        RemoteDetailScreen(
          api = api,
          data = data,
          catalogueApi = api,
          onPlay = { played += it },
          onBack = {},
          loadDestinations = { destinationsFailure?.let { throw it } ?: destinations },
          onQueue = { title, sourceId, media, target -> queued += Queued(title, sourceId, media, target) },
        )
      }
    }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focusedTag(): String = compose.onAllNodes(isFocused()).fetchSemanticsNodes()
    .firstOrNull()?.config?.getOrElse(SemanticsProperties.TestTag) { "" } ?: ""

  /** Puts the remote on one node directly, so an action test does not depend on the path there. */
  private fun focusOn(tag: String) {
    compose.onNodeWithTag(tag).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
  }

  /** Walks the D-pad in one direction until [tag] holds the remote, the way a viewer would. */
  private fun walkTo(tag: String, key: Key = Key.DirectionRight, steps: Int = 8) {
    repeat(steps) {
      if (focusedTag() == tag) return
      press(key)
    }
    compose.onNodeWithTag(tag).assertIsFocused()
  }

  /** Loads one native version and opens its sources panel with one provider seeded. */
  private fun openPanel(): StrictApi {
    val api = StrictApi()
    api.remoteSourcesValue = listOf(version("ms1"))
    api.streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    api.addonStreams["movie:tt1|alpha"] = listOf(addonRow("srcA", "Czech 40 GB"))
    mount(api)
    focusOn(TagRemoteDetailVersions)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
    return api
  }

  private fun discover(api: StrictApi, request: String = "movie:tt1") {
    focusOn(TagAddonDiscover)
    press(Key.DirectionCenter)
    assertTrue(api.calls.contains("streamSources:$request"))
  }

  private fun loadAlpha(api: StrictApi, request: String = "movie:tt1") {
    focusOn(addonProviderTag("alpha"))
    press(Key.DirectionCenter)
    assertTrue(api.calls.contains("streams:$request:alpha"))
  }

  @Test
  fun `nothing is asked of the addons until the panel's own button is pressed`() {
    val api = StrictApi()
    api.remoteSourcesValue = listOf(version("ms1"))
    api.streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    mount(api)

    assertTrue(api.calls.isEmpty())
    focusOn(TagRemoteDetailPlay)
    press(Key.DirectionCenter)
    assertEquals("remote:rlibA:iA", played.single().key)
    assertNull(played.single().initialSources)
  }

  @Test
  fun `an item no request can be derived for never offers the addon block`() {
    val api = StrictApi()
    api.remoteSourcesValue = listOf(version("ms1"))
    mount(api, data(movie(RemoteProviderIdsDto(imdb = "heat-1995"))))

    compose.onNodeWithTag(TagRemoteDetailVersions).assertDoesNotExist()
    assertTrue(api.calls.isEmpty())
  }

  @Test
  fun `zero native versions still offer the panel when the identity and port are there`() {
    val api = StrictApi()
    api.remoteSourcesValue = emptyList()
    api.streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    mount(api)

    focusOn(TagRemoteDetailVersions)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
    discover(api)
  }

  @Test
  fun `one provider is loaded for its own key alone and its rows join the native ones`() {
    val api = openPanel()
    discover(api)
    loadAlpha(api)

    assertEquals(listOf("settings", "streamSources:movie:tt1", "streams:movie:tt1:alpha"), api.calls)
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("Version ms1"))
    compose.onNodeWithTag(sourceRowTag(1)).assert(hasText("Alpha"))
  }

  @Test
  fun `a larger addon row never becomes the default and Play still plays the native version`() {
    val api = openPanel()
    discover(api)
    loadAlpha(api)

    // Only the native version carries the default mark, whatever arrived from the addon.
    val defaultLabel = ApplicationProvider.getApplicationContext<android.content.Context>()
      .getString(cz.stremiooffline.tv.R.string.tv_default)
    compose.onAllNodesWithText(defaultLabel, substring = true).assertCountEquals(1)
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText(defaultLabel, substring = true))

    press(Key.Back)
    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()
    // Back hands the remote to the button that opened the panel.
    compose.onNodeWithTag(TagRemoteDetailVersions).assertIsFocused()
    walkTo(TagRemoteDetailPlay, Key.DirectionLeft, steps = 4)
    press(Key.DirectionCenter)
    assertEquals("remote:rlibA:iA", played.last().key)
    assertNull(played.last().initialSources)
  }

  @Test
  fun `a failed provider leaves the native row where it was`() {
    val api = openPanel()
    api.addonStreams.remove("movie:tt1|alpha")
    discover(api)
    loadAlpha(api)

    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("Version ms1"))
    compose.onNodeWithTag(sourceRowTag(1)).assertDoesNotExist()
  }

  @Test
  fun `an addon row plays a generic target carrying exactly the loaded rows`() {
    val api = openPanel()
    discover(api)
    loadAlpha(api)

    focusOn(sourceRowTag(1))
    press(Key.DirectionCenter)

    val target = played.last()
    assertEquals("movie:tt1", target.key)
    assertEquals("Heat", target.title)
    assertTrue(target.resume)
    assertEquals("srcA", target.sourceId)
    assertEquals("poster.jpg", target.poster)
    assertNull(target.addonKey)
    assertEquals("movie", target.subtitleType)
    assertEquals("tt1", target.subtitleTarget)
    assertNull(target.remoteItem)
    assertFalse(target.catalogue)
    assertEquals(listOf("srcA"), target.initialSources?.map { it.sourceId })
    // A play never writes the native state.
    assertTrue(api.remoteStatePatches.isEmpty())
  }

  @Test
  fun `the addon copy defaults to the server's rule and a picked library is an explicit override`() {
    val api = openPanel()
    discover(api)
    loadAlpha(api)

    focusOn(sourceSaveTag(1))
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagNativeQueueDefault).assertExists()
    // The automatic row leads: OK hands the choice back to the server.
    press(Key.DirectionCenter)
    assertEquals(1, queued.size)
    assertNull(queued.single().target)
    assertEquals("srcA", queued.single().sourceId)
    assertEquals("Heat", queued.single().media.title)

    // Reopening the panel reuses the rows that were already loaded, and the exact library stays a
    // deliberate override.
    focusOn(TagRemoteDetailVersions)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(sourceRowTag(1)).assert(hasText("Alpha"))
    focusOn(sourceSaveTag(1))
    press(Key.DirectionCenter)
    focusOn(nativeQueueLibraryTag("libA"))
    press(Key.DirectionCenter)
    assertEquals(2, queued.size)
    assertEquals(DownloadTargetDto("libA"), queued.last().target)
    assertTrue(api.remoteStatePatches.isEmpty())
  }

  @Test
  fun `an episode's addon copy carries the series title and ids`() {
    val api = StrictApi()
    api.remoteSourcesValue = listOf(version("ms1"))
    api.streamSourcesValues["series:tt5:1:2"] = listOf(StreamSourceDto("alpha", "Alpha"))
    api.addonStreams["series:tt5:1:2|alpha"] = listOf(addonRow("srcA", "Czech 40 GB"))
    mount(api, data(episode(), seriesIds = RemoteProviderIdsDto(imdb = "tt5")))

    focusOn(TagRemoteDetailVersions)
    press(Key.DirectionCenter)
    discover(api, "series:tt5:1:2")
    loadAlpha(api, "series:tt5:1:2")

    focusOn(sourceSaveTag(1))
    press(Key.DirectionCenter)
    press(Key.DirectionCenter)

    assertEquals("Show · S1 · E2", queued.single().title)
    val media = queued.single().media
    assertEquals("episode", media.kind)
    assertEquals("Show", media.title)
    assertEquals("tt5", media.id)
    assertEquals("series", media.metaType)
    assertEquals(1, media.season)
    assertEquals(2, media.episode)
    assertEquals("Pilot", media.episodeTitle)
  }

  @Test
  fun `a destination read that fails keeps the queue panel closed and says why`() {
    val api = openPanel()
    discover(api)
    loadAlpha(api)
    destinationsFailure = ApiError(ApiFailure.Unreachable)

    focusOn(sourceSaveTag(1))
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagRemoteAddonNotice).assertExists()
    compose.onNodeWithTag(TagNativeQueueDefault).assertDoesNotExist()
    assertTrue(queued.isEmpty())
  }

  @Test
  fun `the D-pad reaches the discover control, the provider load and the row's own Save`() {
    val api = openPanel()
    // From the native row, DOWN reaches the addon block at the bottom of the list.
    walkTo(TagAddonDiscover, Key.DirectionDown, steps = 6)
    press(Key.DirectionCenter)
    assertTrue(api.calls.contains("streamSources:movie:tt1"))
    // And DOWN again reaches the one provider's own load button.
    walkTo(addonProviderTag("alpha"), Key.DirectionDown, steps = 6)
    press(Key.DirectionCenter)
    assertTrue(api.calls.contains("streams:movie:tt1:alpha"))

    // UP from the controls returns to the row they belong to, and RIGHT reaches its Save.
    walkTo(sourceRowTag(1), Key.DirectionUp, steps = 6)
    press(Key.DirectionRight)
    compose.onNodeWithTag(sourceSaveTag(1)).assertIsFocused()
  }

  @Test
  fun `the port the series detail was handed reaches an episode it opens`() {
    val api = StrictApi()
    api.remoteEpisodesPages["s1|"] = RemoteItemsPageDto(items = listOf(episode()), total = 1)
    api.remoteSourcesValue = listOf(version("ms1"))
    api.streamSourcesValues["series:tt5:1:2"] = listOf(StreamSourceDto("alpha", "Alpha"))
    mount(
      api,
      RemoteDetailData(
        libraryId = "rlibA",
        libraryName = "Filmy",
        provider = "jellyfin",
        item = RemoteItemDto(id = "s1", name = "Show", type = "series", providerIds = RemoteProviderIdsDto(imdb = "tt5")),
      ),
    )
    compose.waitUntil(5_000) { api.remoteEpisodesRequests.isNotEmpty() }
    compose.onNodeWithTag(remoteItemTag("eA")).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.remoteSourcesRequests.contains("rlibA" to "eA") }

    // The episode's detail was handed the port with its series data, so its own panel exists even
    // with a single native version -- and still asks nothing until the viewer presses.
    compose.onNodeWithTag(TagRemoteDetailVersions).assertExists()
    assertTrue(api.calls.isEmpty())
    focusOn(TagRemoteDetailVersions)
    press(Key.DirectionCenter)
    focusOn(TagAddonDiscover)
    press(Key.DirectionCenter)
    assertTrue(api.calls.contains("streamSources:series:tt5:1:2"))
  }

  @Test
  fun `two native items with the same catalogue id never share loaded addon rows`() {
    val api = StrictApi()
    api.remoteSourcesValue = listOf(version("ms1"))
    api.streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    api.addonStreams["movie:tt1|alpha"] = listOf(addonRow("srcA", "Czech 40 GB"))
    val current = mutableStateOf(data())
    scenario.onActivity { activity ->
      activity.setContent {
        RemoteDetailScreen(api = api, data = current.value, catalogueApi = api, onPlay = {}, onBack = {})
      }
    }
    compose.waitForIdle()
    focusOn(TagRemoteDetailVersions)
    press(Key.DirectionCenter)
    discover(api)
    loadAlpha(api)
    compose.onNodeWithTag(sourceRowTag(1)).assertExists()
    press(Key.Back)
    compose.runOnIdle { current.value = current.value.copy(item = movie().copy(id = "another-native-copy")) }
    compose.waitForIdle()
    focusOn(TagRemoteDetailVersions)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(sourceRowTag(1)).assertDoesNotExist()
    assertEquals(3, api.calls.size)
    discover(api)
    loadAlpha(api)
    press(Key.Back)
    compose.runOnIdle { current.value = current.value.copy(libraryId = "another-library") }
    compose.waitForIdle()
    focusOn(TagRemoteDetailVersions)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(sourceRowTag(1)).assertDoesNotExist()
    assertEquals(6, api.calls.size)
  }

}
