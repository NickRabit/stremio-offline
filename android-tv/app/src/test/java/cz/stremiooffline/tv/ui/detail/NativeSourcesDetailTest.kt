@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.detail

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import cz.stremiooffline.tv.ui.components.FocusButton
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.BehaviorHintsDto
import cz.stremiooffline.tv.data.DownloadTargetDto
import cz.stremiooffline.tv.data.DownloadTargetSettingsDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.MediaDto
import cz.stremiooffline.tv.data.RemoteCapabilitiesDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemsPageDto
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.data.RemoteProviderIdsDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.TagNativeQueuePanel
import cz.stremiooffline.tv.ui.catalog.TagNativeQueueDefault
import cz.stremiooffline.tv.ui.catalog.TagNativeQueueNoTargets
import cz.stremiooffline.tv.ui.catalog.TagRemoteSourcesPanelRetry
import cz.stremiooffline.tv.ui.catalog.TagSourceFilterOptions
import cz.stremiooffline.tv.ui.catalog.TagSourcesFilters
import cz.stremiooffline.tv.ui.catalog.TagSourcesLoading
import cz.stremiooffline.tv.ui.catalog.TagSourcesPanel
import cz.stremiooffline.tv.ui.catalog.nativeQueueLibraryTag
import cz.stremiooffline.tv.ui.catalog.sourceFilterTag
import cz.stremiooffline.tv.ui.catalog.sourceRowTag
import cz.stremiooffline.tv.ui.catalog.sourceSaveTag
import cz.stremiooffline.tv.ui.library.remoteItemTag
import kotlinx.coroutines.CompletableDeferred
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
 * The unified Sources panel of a native detail: opening it asks the viewer's copies, every addon
 * provider and every other media library at once, with no discovery control anywhere; the item's
 * own version leads whatever arrives; and one row's own action follows what that row actually is.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class NativeSourcesDetailTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>

  private val app: android.content.Context
    get() = ApplicationProvider.getApplicationContext()

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

  private fun version(
    sourceId: String,
    libraryId: String = "rlibA",
    itemId: String = "iA",
    copyable: Boolean = false,
  ) = StreamDto(
    sourceId = sourceId,
    kind = "remote",
    playable = true,
    name = "Version $sourceId",
    capabilities = if (copyable) RemoteCapabilitiesDto(downloadToLibrary = true) else null,
    remoteItem = RemoteItemContext(
      libraryId = libraryId,
      itemId = itemId,
      mediaSourceId = sourceId,
      progressKey = "remote:$libraryId:$itemId",
    ),
  )

  private fun localCopy(path: String = "Filmy/Heat/Heat.mkv") = StreamDto(
    sourceId = "lib1",
    kind = "library",
    playable = true,
    localPath = path,
    libraryName = "Filmy",
    behaviorHints = BehaviorHintsDto(filename = path.substringAfterLast('/')),
  )

  private fun addonRow(sourceId: String = "srcA", title: String = "Czech 40 GB") = StreamDto(
    sourceId = sourceId,
    kind = "remote",
    playable = true,
    title = title,
  )

  private fun library(id: String, name: String) = RemoteLibraryDto(id = id, name = name, provider = "jellyfin")

  private fun writable(id: String, name: String) = LibraryDto(id = id, name = name, type = "movie", writable = true)

  private data class Queued(val title: String, val sourceId: String, val media: MediaDto, val target: DownloadTargetDto?)

  private val played = mutableListOf<PlayTarget>()
  private val queued = mutableListOf<Queued>()
  private var destinations: List<LibraryDto> = listOf(writable("libA", "Films"))
  private var destinationsFailure: ApiError? = null
  private var destinationsGate: CompletableDeferred<Unit>? = null

  /** The seeds every mixed-group test starts from: one addon provider, the viewer's own copy and a
   *  matched version in a second media library. */
  private fun seeded(): FakeTvApi = FakeTvApi().apply {
    remoteSourcesValue = listOf(version("ms1"))
    streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    addonStreams["movie:tt1|alpha"] = listOf(addonRow())
    localStreamsValues["movie:tt1"] = listOf(localCopy())
    remoteLibrariesValue = listOf(library("rlibA", "Filmy"), library("rlibB", "Serialy"))
    remoteMatchValues["rlibB|movie|tt1"] = listOf(version("ms9", libraryId = "rlibB", itemId = "iB"))
  }

  private fun mount(api: FakeTvApi, data: RemoteDetailData = data(), withCopy: Boolean = true, active: () -> Boolean = { true }, afterPlay: () -> Unit = {}) {
    scenario.onActivity { activity ->
      activity.setContent {
        RemoteDetailScreen(
          api = api,
          data = data,
          catalogueApi = api,
          onPlay = { played += it; afterPlay() },
          backEnabled = active(),
          onBack = {},
          loadDestinations = if (withCopy) ({ destinationsGate?.await(); destinationsFailure?.let { throw it } ?: destinations }) else null,
          onQueue = if (withCopy) {
            ({ title, sourceId, media, target -> queued += Queued(title, sourceId, media, target) })
          } else {
            null
          },
        )
        if (!active()) FocusButton("Player", {}, Modifier.testTag("covered-player"))
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

  private fun focusOn(tag: String) {
    compose.onNodeWithTag(tag).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
  }

  /** Opens the Versions panel the way the remote does, then waits for [rows] rows to be drawn. */
  private fun openPanel(rows: Int = 4) {
    focusOn(TagRemoteDetailVersions)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
    compose.waitUntil(5_000) {
      compose.onAllNodesWithTag(sourceRowTag(rows - 1)).fetchSemanticsNodes().isNotEmpty()
    }
  }

  /** No part of the panel may ask the viewer to press before the addons are asked. */
  private fun assertNoAddonControls() {
    compose.onAllNodesWithText(app.getString(R.string.sources_load_addons)).assertCountEquals(0)
    compose.onAllNodesWithText(app.getString(R.string.sources_load_provider)).assertCountEquals(0)
  }

  private fun awaitQueued(count: Int) {
    compose.waitUntil(5_000) { queued.size == count }
  }

  @Test
  fun `nothing is asked of any group until the panel is opened`() {
    val api = seeded()
    mount(api)

    assertEquals(0, api.settingsCalls)
    assertEquals(0, api.addonsCalls)
    assertTrue(api.streamSourcesRequests.isEmpty())
    assertTrue(api.streamsRequests.isEmpty())
    assertTrue(api.localStreamsRequests.isEmpty())
    assertEquals(0, api.remoteLibrariesCalls)
    assertTrue(api.remoteMatchRequests.isEmpty())

    // The item's own version is playable without any of that.
    focusOn(TagRemoteDetailPlay)
    press(Key.DirectionCenter)
    // The catalogue names the item, so the title's own key owns the play.
    assertEquals("movie:tt1", played.single().key)
    assertEquals(listOf("ms1"), played.single().initialSources?.map { it.sourceId })
  }

  @Test
  fun `opening the panel asks every group at once and draws the mixed rows`() {
    val api = seeded()
    mount(api)
    openPanel()

    // The panel asks on its own opening: the addon providers, the viewer's copies and the other
    // libraries -- with the origin library's own versions never matched again.
    assertEquals(listOf("movie:tt1"), api.streamSourcesRequests)
    assertEquals(listOf("movie:tt1|alpha"), api.streamsRequests)
    assertTrue(api.streamsRequests.all { it.contains("|") })
    assertEquals(listOf("movie:tt1"), api.localStreamsRequests)
    assertEquals(1, api.remoteLibrariesCalls)
    assertEquals(listOf("rlibB|movie|tt1"), api.remoteMatchRequests)
    assertNoAddonControls()

    // The item's own version leads; the copy, the other library and the addon row follow.
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("Version ms1"))
    compose.onNodeWithTag(sourceRowTag(1)).assert(hasText(app.getString(R.string.sources_local_badge)))
    compose.onNodeWithTag(sourceRowTag(1)).assert(hasText("Heat.mkv"))
    compose.onNodeWithTag(sourceRowTag(2)).assert(hasText("Version ms9"))
    compose.onNodeWithTag(sourceRowTag(3)).assert(hasText("Czech 40 GB"))
    compose.onNodeWithTag(TagSourcesFilters).assertExists()
    // The open panel owns the remote: the focus is on its own first row, not on the detail behind.
    assertTrue(focusedTag().startsWith("source_row_"))
  }

  @Test
  fun `the item's own version stays the default and Play still plays it`() {
    val api = seeded()
    mount(api)
    openPanel()

    val defaultLabel = app.getString(R.string.tv_default)
    compose.onAllNodesWithText(defaultLabel, substring = true).assertCountEquals(1)
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText(defaultLabel, substring = true))

    press(Key.Back)
    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()
    compose.onNodeWithTag(TagRemoteDetailVersions).assertIsFocused()
    repeat(4) {
      if (focusedTag() == TagRemoteDetailPlay) return@repeat
      press(Key.DirectionLeft)
    }
    press(Key.DirectionCenter)

    assertEquals("movie:tt1", played.last().key)
    assertEquals(listOf("ms1", "lib1", "ms9", "srcA"), played.last().initialSources?.map { it.sourceId })
  }

  @Test
  fun `an addon row picked in the panel plays the title's generic identity once Play is pressed`() {
    val api = seeded()
    mount(api)
    openPanel()

    // Choosing only picks the row; the action row is what starts the session.
    focusOn(sourceRowTag(3))
    press(Key.DirectionCenter)
    assertTrue(played.isEmpty())
    focusOn(TagRemoteDetailPlay)
    press(Key.DirectionCenter)

    val target = played.single()
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
    assertEquals(listOf("ms1", "lib1", "ms9", "srcA"), target.initialSources?.map { it.sourceId })
    // A play never writes the native state.
    assertTrue(api.remoteStatePatches.isEmpty())
  }

  @Test
  fun `a row of another media library picked in the panel plays its own item and its own versions`() {
    val api = seeded()
    api.remoteMatchValues["rlibB|movie|tt1"] = listOf(
      version("ms10", libraryId = "rlibB", itemId = "iB"),
      version("ms9", libraryId = "rlibB", itemId = "iB"),
    )
    mount(api)
    openPanel(rows = 5)

    focusOn(sourceRowTag(2))
    press(Key.DirectionCenter)
    assertTrue(played.isEmpty())
    focusOn(TagRemoteDetailPlay)
    press(Key.DirectionCenter)

    val target = played.single()
    // The title the detail was opened on keeps the key, while the row's own item travels with the
    // play so its own exact versions and state are what is offered.
    assertEquals("movie:tt1", target.key)
    assertEquals("rlibB", target.remoteItem?.libraryId)
    assertEquals("iB", target.remoteItem?.itemId)
    assertEquals("ms10", target.sourceId)
    // Only the versions of that same library item travel with it.
    assertEquals(listOf("ms10", "ms9"), target.remoteSources.map { it.sourceId })
    assertEquals(listOf("ms1", "lib1", "ms10", "ms9", "srcA"), target.initialSources?.map { it.sourceId })
  }

  @Test
  fun `a library copy plays the file's own path and no row offers a Save anywhere`() {
    val api = seeded()
    api.remoteMatchValues["rlibB|movie|tt1"] =
      listOf(version("ms9", libraryId = "rlibB", itemId = "iB", copyable = true))
    mount(api)
    openPanel()

    // A library detail's panel only picks: no row carries a control of its own any more.
    compose.onNodeWithTag(sourceSaveTag(0)).assertDoesNotExist()
    compose.onNodeWithTag(sourceSaveTag(1)).assertDoesNotExist()
    compose.onNodeWithTag(sourceSaveTag(2)).assertDoesNotExist()
    compose.onNodeWithTag(sourceSaveTag(3)).assertDoesNotExist()

    focusOn(sourceRowTag(1))
    press(Key.DirectionCenter)
    assertTrue(played.isEmpty())
    focusOn(TagRemoteDetailPlay)
    press(Key.DirectionCenter)

    val target = played.single()
    assertEquals("file:Filmy/Heat/Heat.mkv", target.key)
    assertEquals("Filmy/Heat/Heat.mkv", target.path)
    assertNull(target.sourceId)
    assertTrue(target.resume)
    assertNull(target.remoteItem)
    assertEquals(listOf("ms1", "lib1", "ms9", "srcA"), target.initialSources?.map { it.sourceId })
  }

  @Test
  fun `To library copies the picked version into its projected destination`() {
    val api = seeded()
    api.remoteMatchValues["rlibB|movie|tt1"] = listOf(
      version("ms9", libraryId = "rlibB", itemId = "iB", copyable = true)
        .copy(downloadTarget = DownloadTargetSettingsDto(libraryId = "libB")),
    )
    destinations = listOf(writable("libA", "Films"), writable("libB", "Serialy"))
    mount(api)
    openPanel()

    focusOn(sourceRowTag(2))
    press(Key.DirectionCenter)
    focusOn(TagRemoteDetailToLibrary)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(nativeQueueLibraryTag("libB")).assertIsSelected()
    press(Key.DirectionCenter)
    awaitQueued(1)

    assertEquals("ms9", queued.single().sourceId)
    // The picked library is exactly the projected one, so no target travels.
    assertNull(queued.single().target)
    assertEquals("Heat", queued.single().media.title)
    assertEquals("movie", queued.single().media.kind)
  }

  @Test
  fun `To library on an addon pick offers the automatic destination and queues with no target`() {
    val api = seeded()
    mount(api)
    openPanel()

    focusOn(sourceRowTag(3))
    press(Key.DirectionCenter)
    focusOn(TagRemoteDetailToLibrary)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagNativeQueueDefault).assertExists()
    press(Key.DirectionCenter)
    awaitQueued(1)

    assertNull(queued.single().target)
    assertEquals("srcA", queued.single().sourceId)
    assertEquals("Heat", queued.single().media.title)
  }

  @Test
  fun `an episode's panel asks its parent series identity and its copy carries the series title`() {
    val api = FakeTvApi().apply {
      remoteSourcesValue = listOf(version("ms1", itemId = "eA"))
      streamSourcesValues["series:tt5:1:2"] = listOf(StreamSourceDto("alpha", "Alpha"))
      addonStreams["series:tt5:1:2|alpha"] = listOf(addonRow())
      localStreamsValues["series:tt5:1:2"] = emptyList()
      remoteLibrariesValue = listOf(library("rlibA", "Filmy"), library("rlibB", "Serialy"))
    }
    mount(api, data(episode(), seriesIds = RemoteProviderIdsDto(imdb = "tt5")))
    assertTrue(api.streamSourcesRequests.isEmpty())
    openPanel(rows = 2)

    assertEquals(listOf("series:tt5:1:2"), api.streamSourcesRequests)
    assertEquals(listOf("series:tt5:1:2|alpha"), api.streamsRequests)
    assertEquals(listOf("series:tt5:1:2"), api.localStreamsRequests)
    assertEquals(listOf("rlibB|series|tt5:1:2"), api.remoteMatchRequests)
    // The provider's name filter takes the series name, never the episode's own.
    assertEquals(listOf("Show"), api.remoteMatchHints)

    focusOn(sourceRowTag(1))
    press(Key.DirectionCenter)
    focusOn(TagRemoteDetailToLibrary)
    press(Key.DirectionCenter)
    // The picker takes the panel's place; its own first row is the automatic destination.
    compose.onNodeWithTag(TagNativeQueueDefault).assertExists()
    compose.onNodeWithTag(TagNativeQueueDefault).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    press(Key.DirectionCenter)
    awaitQueued(1)

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
  fun `a failed group leaves the rows and offers a retry that asks only it again`() {
    val api = seeded()
    api.streamFailures["movie:tt1|alpha"] = ApiFailure.Unreachable
    mount(api)
    openPanel(rows = 3)

    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("Version ms1"))
    compose.onNodeWithTag(sourceRowTag(1)).assert(hasText("Heat.mkv"))
    compose.onNodeWithTag(TagRemoteSourcesPanelRetry).assertExists()

    api.streamFailures.remove("movie:tt1|alpha")
    focusOn(TagRemoteSourcesPanelRetry)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) {
      compose.onAllNodesWithTag(sourceRowTag(3)).fetchSemanticsNodes().isNotEmpty()
    }

    assertEquals(2, api.streamsRequests.count { it == "movie:tt1|alpha" })
    assertEquals(1, api.localStreamsRequests.size)
    assertEquals(1, api.remoteLibrariesCalls)
    compose.onNodeWithTag(sourceRowTag(3)).assert(hasText("Czech 40 GB"))
    compose.onNodeWithTag(TagRemoteSourcesPanelRetry).assertDoesNotExist()
  }

  @Test
  fun `a row that arrives while the panel is open never takes the remote`() {
    val api = seeded()
    api.streamsGates["movie:tt1|alpha"] = CompletableDeferred()
    mount(api)
    openPanel(rows = 3)

    // The rows that already answered hold the list; the addon row is still owed.
    compose.onNodeWithTag(TagSourcesLoading).assertExists()
    focusOn(sourceRowTag(0))
    press(Key.DirectionDown)
    assertEquals(sourceRowTag(1), focusedTag())

    api.streamsGates.remove("movie:tt1|alpha")?.complete(Unit)
    compose.waitUntil(5_000) {
      compose.onAllNodesWithTag(sourceRowTag(3)).fetchSemanticsNodes().isNotEmpty()
    }

    assertEquals(sourceRowTag(1), focusedTag())
    compose.onNodeWithTag(TagSourcesLoading).assertDoesNotExist()
  }

  @Test
  fun `the D-pad walks the chips and the rows, and Back restores the opener`() {
    val api = seeded()
    api.remoteMatchValues["rlibB|movie|tt1"] =
      listOf(version("ms9", libraryId = "rlibB", itemId = "iB", copyable = true))
    mount(api)
    openPanel()

    // UP from the first row returns to the filter chips; OK opens a chip's own choices.
    focusOn(sourceRowTag(0))
    press(Key.DirectionUp)
    assertEquals(sourceFilterTag("sort"), focusedTag())
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSourceFilterOptions).assertExists()
    press(Key.Back)
    compose.onNodeWithTag(TagSourceFilterOptions).assertDoesNotExist()
    assertEquals(sourceFilterTag("sort"), focusedTag())

    // DOWN returns to the list and walks the rows.
    press(Key.DirectionDown)
    assertEquals(sourceRowTag(0), focusedTag())
    press(Key.DirectionDown)
    press(Key.DirectionDown)
    assertEquals(sourceRowTag(2), focusedTag())

    // Back closes the panel and hands the remote back to the button that opened it.
    press(Key.Back)
    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()
    compose.onNodeWithTag(TagRemoteDetailVersions).assertIsFocused()
  }

  @Test
  fun `an item no request can be derived for offers only its own versions and asks nothing`() {
    val api = seeded()
    mount(api, data(movie(RemoteProviderIdsDto(imdb = "heat-1995"))))

    openPanel(rows = 1)

    // The item's own version is a choice on its own; nothing was asked of any addon or media server.
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("Version ms1"))
    assertEquals(0, api.settingsCalls)
    assertTrue(api.streamSourcesRequests.isEmpty())
    assertTrue(api.localStreamsRequests.isEmpty())
    assertEquals(0, api.remoteLibrariesCalls)
  }

  @Test
  fun `zero native versions still offer the panel when the identity is there`() {
    val api = seeded()
    api.remoteSourcesValue = emptyList()
    mount(api)

    openPanel(rows = 3)

    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText(app.getString(R.string.sources_local_badge)))
    assertNoAddonControls()
  }

  @Test
  fun `the port the series detail was handed reaches an episode it opens`() {
    val api = FakeTvApi().apply {
      remoteEpisodesPages["s1|"] = RemoteItemsPageDto(items = listOf(episode()), total = 1)
      remoteSourcesValue = listOf(version("ms1", itemId = "eA"))
      streamSourcesValues["series:tt5:1:2"] = listOf(StreamSourceDto("alpha", "Alpha"))
      addonStreams["series:tt5:1:2|alpha"] = listOf(addonRow())
      localStreamsValues["series:tt5:1:2"] = emptyList()
      remoteLibrariesValue = emptyList()
    }
    mount(
      api,
      RemoteDetailData(
        libraryId = "rlibA",
        libraryName = "Filmy",
        provider = "jellyfin",
        item = RemoteItemDto(id = "s1", name = "Show", type = "series", providerIds = RemoteProviderIdsDto(imdb = "tt5")),
      ),
      withCopy = false,
    )
    compose.waitUntil(5_000) { api.remoteEpisodesRequests.isNotEmpty() }
    compose.onNodeWithTag(remoteItemTag("eA")).assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.remoteSourcesRequests.contains("rlibA" to "eA") }

    // The episode's detail keeps the port and its series data, and asks everything on opening.
    compose.onNodeWithTag(TagRemoteDetailVersions).assertExists()
    assertTrue(api.streamSourcesRequests.isEmpty())
    openPanel(rows = 2)
    assertEquals(listOf("series:tt5:1:2"), api.streamSourcesRequests)
    assertEquals(listOf("series:tt5:1:2|alpha"), api.streamsRequests)
  }

  @Test
  fun `two native items with the same catalogue id never share loaded rows`() {
    val api = seeded()
    val current = mutableStateOf(data())
    scenario.onActivity { activity ->
      activity.setContent {
        RemoteDetailScreen(api = api, data = current.value, catalogueApi = api, onPlay = {}, onBack = {})
      }
    }
    compose.waitForIdle()
    openPanel()
    press(Key.Back)

    val first = api.streamSourcesRequests.size
    compose.runOnIdle { current.value = current.value.copy(item = movie().copy(id = "another-native-copy")) }
    compose.waitForIdle()
    openPanel()
    assertTrue(api.streamSourcesRequests.size > first)
    press(Key.Back)

    // The same item id in another library is another item too.
    val beforeLibrary = api.streamSourcesRequests.size
    compose.runOnIdle { current.value = current.value.copy(libraryId = "another-library") }
    compose.waitForIdle()
    openPanel()
    assertTrue(api.streamSourcesRequests.size > beforeLibrary)
  }

  @Test
  fun `a destination read that fails says why and queues nothing`() {
    val api = seeded()
    destinationsFailure = ApiError(ApiFailure.Unreachable)
    mount(api)
    openPanel()

    focusOn(sourceRowTag(3))
    press(Key.DirectionCenter)
    focusOn(TagRemoteDetailToLibrary)
    press(Key.DirectionCenter)

    compose.onNodeWithTag(TagRemoteSourceNotice).assertExists()
    compose.onNodeWithTag(TagNativeQueueDefault).assertDoesNotExist()
    assertTrue(queued.isEmpty())
  }

  @Test
  fun `a matched version with no writable library is refused instead of queued`() {
    val api = seeded()
    api.remoteMatchValues["rlibB|movie|tt1"] =
      listOf(version("ms9", libraryId = "rlibB", itemId = "iB", copyable = true))
    destinations = listOf(LibraryDto(id = "libA", name = "Films", type = "movie", writable = false))
    mount(api)
    openPanel()

    focusOn(sourceRowTag(2))
    press(Key.DirectionCenter)
    focusOn(TagRemoteDetailToLibrary)
    press(Key.DirectionCenter)

    // A media-server version has no automatic destination, so nothing is queued blind.
    compose.onNodeWithTag(TagNativeQueueNoTargets).assertExists()
    compose.onNodeWithTag(TagNativeQueueDefault).assertDoesNotExist()
    assertTrue(queued.isEmpty())
  }

  @Test
  fun `a destinations read in flight opens nothing over a panel the viewer replaced`() {
    destinationsGate = CompletableDeferred()
    mount(seeded())
    openPanel()
    focusOn(sourceRowTag(3))
    press(Key.DirectionCenter)
    focusOn(TagRemoteDetailToLibrary)
    press(Key.DirectionCenter)

    // The viewer leaves while the destinations are still out and opens the panel again, which is
    // another panel: the answer that lands belongs to nobody.
    openPanel()
    destinationsGate?.complete(Unit)
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
    compose.onNodeWithTag(TagNativeQueuePanel).assertDoesNotExist()
    assertTrue(queued.isEmpty())
  }

  @Test
  fun `late remote state leaves sources focus in the panel`() {
    val gate = CompletableDeferred<Unit>()
    mount(seeded().apply { remoteStateReadGate = gate })
    openPanel()
    focusOn(sourceRowTag(3))
    gate.complete(Unit)
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()
    compose.onNodeWithTag(sourceRowTag(3)).assertIsFocused()
  }


  @Test
  fun `picking another row cancels a pending destinations read`() {
    destinationsGate = CompletableDeferred()
    mount(seeded())
    openPanel()
    focusOn(sourceRowTag(3))
    press(Key.DirectionCenter)
    focusOn(TagRemoteDetailToLibrary)
    press(Key.DirectionCenter)

    // A pick made while the read is out replaces what the read belongs to.
    openPanel()
    focusOn(sourceRowTag(0))
    press(Key.DirectionCenter)
    destinationsGate?.complete(Unit)
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()
    compose.onNodeWithTag(TagNativeQueuePanel).assertDoesNotExist()
    assertTrue(queued.isEmpty())
  }

  @Test
  fun `late remote state does not focus a covered detail`() {
    val gate = CompletableDeferred<Unit>()
    val active = mutableStateOf(true)
    mount(seeded().apply { remoteStateReadGate = gate }, active = { active.value }, afterPlay = { active.value = false })
    openPanel()
    focusOn(sourceRowTag(0))
    press(Key.DirectionCenter)
    focusOn(TagRemoteDetailPlay)
    press(Key.DirectionCenter)
    focusOn("covered-player")
    gate.complete(Unit)
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()
    compose.onNodeWithTag("covered-player").assertIsFocused()
    compose.onNodeWithTag(TagRemoteDetailPlay).assertIsNotFocused()
  }

}
