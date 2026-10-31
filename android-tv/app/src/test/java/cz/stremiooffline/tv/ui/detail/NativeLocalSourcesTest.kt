@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.detail

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.AddonDto
import cz.stremiooffline.tv.data.AddonManifestDto
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.BehaviorHintsDto
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.DownloadTargetDto
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.MediaDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.RemoteCapabilitiesDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.TagNativeQueuePanel
import cz.stremiooffline.tv.ui.catalog.TagRemoteSourcesPanelRetry
import cz.stremiooffline.tv.ui.catalog.TagSourceFilterOptions
import cz.stremiooffline.tv.ui.catalog.TagSourcesFilters
import cz.stremiooffline.tv.ui.catalog.TagSourcesPanel
import cz.stremiooffline.tv.ui.catalog.actionRowOrder
import cz.stremiooffline.tv.ui.catalog.nativeQueueLibraryTag
import cz.stremiooffline.tv.ui.catalog.sourceFilterTag
import cz.stremiooffline.tv.ui.catalog.sourceFilterOptionTag
import cz.stremiooffline.tv.ui.catalog.sourceRowTag
import cz.stremiooffline.tv.ui.catalog.sourceSaveTag
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The local detail's Sources action: the file's own rows are there the moment it is pressed, the
 * file's exact catalogue binding decides what else is asked -- never before -- and every row keeps
 * its own owner when it is played.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class NativeLocalSourcesTest {

  @get:Rule val compose = createComposeRule()

  private val played = mutableListOf<PlayTarget>()
  private val queued = mutableListOf<Queued>()
  private val markedWatched = mutableListOf<BrowseItem.File>()
  /** Every queue call the screen issued, in flight or not. */
  private var queueCalls = 0
  private var queuedGate: CompletableDeferred<Unit>? = null
  private var destinationsGate: CompletableDeferred<Unit>? = null
  private val film = "Films/It/It.mkv"
  private val secondEpisode = "Shows/Show/S01/Show.S01E02.mkv"
  private val episodeOnePath = "Shows/Show/S01/Show.S01E01.mkv"
  private val episodeTwoPath = "Shows/Show/S01/Show.S01E02.mkv"

  private data class Queued(val title: String, val sourceId: String, val media: MediaDto)

  private fun file(path: String, label: String, size: Double = 0.0, season: Int? = null, episode: Int? = null) =
    BrowseItem.File(path = path, label = label, size = size, season = season, episode = episode)

  private fun detail(files: List<BrowseItem.File>, title: String = "It") = DetailData(
    gridPath = "Films/It",
    title = title,
    year = null,
    description = null,
    poster = "poster.jpg",
    wide = null,
    size = files.sumOf { it.size },
    fileCount = files.size,
    files = files,
  )

  private fun localCopy(path: String) = StreamDto(
    sourceId = "lib1",
    kind = "library",
    playable = true,
    localPath = path,
    libraryName = "Filmy",
    behaviorHints = BehaviorHintsDto(filename = path.substringAfterLast('/')),
  )

  private fun addonRow(sourceId: String = "srcA", title: String = "Czech 40 GB") =
    StreamDto(sourceId = sourceId, kind = "remote", playable = true, title = title)

  private fun remoteVersion(
    sourceId: String,
    libraryId: String = "rlibB",
    itemId: String = "iB",
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

  private fun seeded() = FakeTvApi().apply {
    libraryTitleValues[film] = LibraryTitleDto("movie", "tt1", name = "It")
    streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    addonStreams["movie:tt1|alpha"] = listOf(addonRow())
    localStreamsValues["movie:tt1"] = listOf(localCopy(film))
    remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibB", name = "Serialy", provider = "jellyfin"))
    remoteMatchValues["rlibB|movie|tt1"] = listOf(remoteVersion("ms9"))
  }

  private fun mount(
    api: FakeTvApi,
    data: DetailData = detail(listOf(file(film, "It.mkv"))),
    destinations: (suspend () -> List<LibraryDto>)? = null,
    onQueue: (suspend (String, String, MediaDto, DownloadTargetDto?) -> Unit)? = null,
    markWatched: (suspend (BrowseItem.File) -> Unit)? = null,
    progress: suspend (String) -> ProgressDto? = { null },
  ) {
    compose.setContent {
      DetailScreen(
        detail = data,
        imageUrl = { null },
        onPlay = { played += it },
        onBack = {},
        progress = progress,
        forgetProgress = {},
        sourcesApi = api,
        loadDestinations = destinations,
        onQueue = onQueue,
        markWatched = markWatched,
      )
    }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focusOn(tag: String) {
    compose.onNodeWithTag(tag).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
  }

  private fun focusedTag(): String = compose.onAllNodes(isFocused()).fetchSemanticsNodes()
    .firstOrNull()?.config?.getOrElse(SemanticsProperties.TestTag) { "" } ?: ""

  /** Opens the panel the way the remote does and waits for [rows] rows to be drawn. */
  private fun openPanel(rows: Int) {
    focusOn(TagDetailSources)
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
    compose.waitUntil(5_000) {
      compose.onAllNodesWithTag(sourceRowTag(rows - 1)).fetchSemanticsNodes().isNotEmpty()
    }
  }

  @Test
  fun `nothing is asked of any group until the action is pressed`() {
    val api = seeded()
    mount(api)

    compose.onNodeWithTag(TagDetailSources).assertExists()
    assertEquals(listOf(film), api.libraryTitleRequests)
    assertTrue(api.streamSourcesRequests.isEmpty())
    assertTrue(api.streamsRequests.isEmpty())
    assertTrue(api.localStreamsRequests.isEmpty())
    assertEquals(0, api.remoteLibrariesCalls)
    assertEquals(0, api.settingsCalls)
  }

  @Test
  fun `the panel opens on the file's own row and then draws the mixed groups`() {
    val api = seeded()
    mount(api)
    openPanel(rows = 3)

    // The file's binding is read on the open, once, and the groups follow under it.
    assertEquals(listOf(film), api.libraryTitleRequests)
    assertEquals(listOf("movie:tt1"), api.streamSourcesRequests)
    assertEquals(listOf("movie:tt1|alpha"), api.streamsRequests)
    assertEquals(listOf("movie:tt1"), api.localStreamsRequests)
    assertEquals(listOf("rlibB|movie|tt1"), api.remoteMatchRequests)

    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("It.mkv"))
    compose.onNodeWithTag(sourceRowTag(1)).assert(hasText("Version ms9"))
    compose.onNodeWithTag(sourceRowTag(2)).assert(hasText("Czech 40 GB"))
    // The library's own copy of this exact file is the row above, never a second row of itself.
    compose.onAllNodes(hasText("It.mkv") and hasAnyAncestor(hasTestTag(TagSourcesPanel))).assertCountEquals(1)
    compose.onNodeWithTag(TagSourcesFilters).assertExists()
  }

  @Test
  fun `a film's own versions lead largest first and the largest is the default`() {
    val api = seeded()
    api.localStreamsValues["movie:tt1"] = emptyList()
    api.remoteLibrariesValue = emptyList()
    val versions = listOf(
      file("Films/It/It.720.mkv", "It.720.mkv", size = 3_000_000_000.0),
      file("Films/It/It.1080.mkv", "It.1080.mkv", size = 8_000_000_000.0),
    )
    mount(api, data = detail(versions))
    openPanel(rows = 2)

    // The detail was opened on the 720p file, but the film's versions lead by reported size.
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("It.1080.mkv"))
    val defaultLabel = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
      .getString(R.string.tv_default)
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText(defaultLabel, substring = true))
    compose.onNodeWithTag(sourceRowTag(1)).assert(hasText("It.720.mkv"))
  }

  @Test
  fun `a series card opens Sources for exactly that episode`() {
    val api = seeded()
    api.libraryTitleValues[secondEpisode] = LibraryTitleDto("series", "tt5", videoId = "tt5:1:2", name = "Show")
    api.streamSourcesValues["series:tt5:1:2"] = listOf(StreamSourceDto("alpha", "Alpha"))
    api.addonStreams["series:tt5:1:2|alpha"] = listOf(addonRow())
    api.localStreamsValues["series:tt5:1:2"] = emptyList()
    api.remoteLibrariesValue = emptyList()
    val episodes = listOf(
      file("Shows/Show/S01/Show.S01E01.mkv", "Show.S01E01.mkv", season = 1, episode = 1),
      file(secondEpisode, "Show.S01E02.mkv", season = 1, episode = 2),
    )
    mount(api, data = detail(episodes, title = "Show"))

    // Enter still plays the card; Menu opens the panel for exactly that file.
    compose.onNodeWithTag(secondEpisode).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    compose.onNodeWithTag(secondEpisode).performKeyInput { pressKey(Key.Menu) }
    compose.waitForIdle()
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
    compose.waitUntil(5_000) {
      compose.onAllNodesWithTag(sourceRowTag(1)).fetchSemanticsNodes().isNotEmpty()
    }

    // Only the episode the panel was opened on, under its own video id, never the series or a
    // sibling episode.
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("Show.S01E02.mkv"))
    compose.onAllNodes(
      hasText("Show.S01E01.mkv") and hasAnyAncestor(hasTestTag(TagSourcesPanel)),
    ).assertCountEquals(0)
    assertEquals(listOf(episodes.first().path, secondEpisode), api.libraryTitleRequests)
    assertEquals(listOf("series:tt5:1:2"), api.streamSourcesRequests)
    assertTrue(played.isEmpty())
  }

  @Test
  fun `a series binding without its episode numbers asks no addon or media server`() {
    val api = seeded()
    api.libraryTitleValues[film] = LibraryTitleDto("series", "tt5", name = "Show")
    mount(api)
    openPanel(rows = 1)

    assertEquals(listOf(film), api.libraryTitleRequests)
    assertTrue(api.streamSourcesRequests.isEmpty())
    assertTrue(api.remoteLibrariesCalls == 0)
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("It.mkv"))
  }

  @Test
  fun `an unbound file keeps its own row and asks nothing`() {
    val api = FakeTvApi()
    mount(api)
    openPanel(rows = 1)

    assertEquals(listOf(film), api.libraryTitleRequests)
    assertTrue(api.streamSourcesRequests.isEmpty())
    assertTrue(api.streamsRequests.isEmpty())
    assertTrue(api.localStreamsRequests.isEmpty())
    assertEquals(0, api.remoteLibrariesCalls)
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("It.mkv"))
  }

  @Test
  fun `reopening the same file asks nothing again`() {
    val api = seeded()
    mount(api)
    openPanel(rows = 3)
    press(Key.Back)
    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()
    // Back hands the remote back to the action that opened the panel.
    compose.onNodeWithTag(TagDetailSources).assertIsFocused()

    openPanel(rows = 3)

    assertEquals(listOf(film), api.libraryTitleRequests)
    assertEquals(1, api.streamSourcesRequests.size)
    assertEquals(1, api.streamsRequests.size)
    assertEquals(1, api.localStreamsRequests.size)
    assertEquals(1, api.remoteLibrariesCalls)
    assertEquals(1, api.remoteMatchRequests.size)
  }

  @Test
  fun `the own file row and the picked addon row each play what they name`() {
    val api = seeded()
    mount(api)
    openPanel(rows = 3)

    focusOn(sourceRowTag(0))
    press(Key.DirectionCenter)
    assertTrue(played.isEmpty())
    focusOn(TagDetailPrimary)
    press(Key.DirectionCenter)

    val own = played.single()
    assertEquals("file:$film", own.key)
    assertEquals(film, own.path)
    assertNull(own.sourceId)
    assertNull(own.remoteItem)
    assertEquals(listOf("file:$film", "ms9", "srcA"), own.initialSources?.map { it.sourceId })

    openPanel(rows = 3)
    focusOn(sourceRowTag(2))
    press(Key.DirectionCenter)
    assertTrue(played.size == 1)
    focusOn(TagDetailPrimary)
    press(Key.DirectionCenter)

    val addon = played.last()
    assertEquals("movie:tt1", addon.key)
    assertEquals("srcA", addon.sourceId)
    assertEquals("It", addon.title)
    assertEquals("poster.jpg", addon.poster)
    assertEquals("movie", addon.subtitleType)
    assertEquals("tt1", addon.subtitleTarget)
    assertNull(addon.remoteItem)
    assertEquals(listOf("file:$film", "ms9", "srcA"), addon.initialSources?.map { it.sourceId })
  }

  @Test
  fun `another provider hides the detail's own row and a local copy never repeats it`() {
    val api = seeded()
    mount(api)
    openPanel(rows = 3)

    // Choosing Alpha narrows the panel to Alpha's own rows: the file on disk is not one of them.
    focusOn(sourceFilterTag("addon"))
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSourceFilterOptions).assertExists()
    focusOn(sourceFilterOptionTag(3))
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) {
      compose.onAllNodesWithTag(sourceRowTag(0)).fetchSemanticsNodes().isNotEmpty() &&
        compose.onAllNodesWithTag(sourceRowTag(1)).fetchSemanticsNodes().isEmpty()
    }
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("Czech 40 GB"))

    // The Local choice is the file the detail holds, once, whatever the library answered.
    focusOn(sourceFilterTag("addon"))
    press(Key.DirectionCenter)
    focusOn(sourceFilterOptionTag(1))
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) {
      compose.onAllNodesWithTag(sourceRowTag(1)).fetchSemanticsNodes().isEmpty()
    }
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("It.mkv"))
    compose.onAllNodes(hasText("It.mkv") and hasAnyAncestor(hasTestTag(TagSourcesPanel))).assertCountEquals(1)
  }

  @Test
  fun `only the rows that are not the file on disk offer a Save`() {
    val api = seeded()
    // Only a version the server projected the account's native download right on may be copied.
    api.remoteMatchValues["rlibB|movie|tt1"] = listOf(remoteVersion("ms9", copyable = true))
    val destinations = listOf(LibraryDto(id = "libA", name = "Films", type = "movie", writable = true))
    mount(api, destinations = { destinations }, onQueue = { _, _, _, _ -> })
    openPanel(rows = 3)

    // A library detail's panel only picks: no row carries a save control of its own, whatever the
    // account may copy.
    compose.onNodeWithTag(sourceSaveTag(0)).assertDoesNotExist()
    compose.onNodeWithTag(sourceSaveTag(1)).assertDoesNotExist()
    compose.onNodeWithTag(sourceSaveTag(2)).assertDoesNotExist()
  }

  // --- Two libraries, the same version id ---------------------------------------------------------

  @Test
  fun `two libraries offering one version id stay two selectable and filterable rows`() {
    val api = seeded()
    api.remoteLibrariesValue = listOf(
      RemoteLibraryDto(id = "rlibB", name = "Serialy", provider = "jellyfin"),
      RemoteLibraryDto(id = "rlibC", name = "Dokumenty", provider = "emby"),
    )
    // One version id in two libraries: the same text must not collapse them into one row.
    api.remoteMatchValues["rlibB|movie|tt1"] = listOf(
      remoteVersion("v1", libraryId = "rlibB", itemId = "iB").copy(name = "B 1080p", provider = "jellyfin", libraryName = "Serialy"),
    )
    api.remoteMatchValues["rlibC|movie|tt1"] = listOf(
      remoteVersion("v1", libraryId = "rlibC", itemId = "iC").copy(name = "C 1080p", provider = "emby", libraryName = "Dokumenty"),
    )
    mount(api)
    openPanel(rows = 4)

    compose.onNodeWithTag(sourceRowTag(1)).assert(hasText("B 1080p"))
    compose.onNodeWithTag(sourceRowTag(2)).assert(hasText("C 1080p"))

    // Each library's own choice shows exactly its own version.
    focusOn(sourceFilterTag("addon"))
    press(Key.DirectionCenter)
    focusOn(sourceFilterOptionTag(2))
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) {
      compose.onAllNodesWithTag(sourceRowTag(1)).fetchSemanticsNodes().isEmpty()
    }
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("B 1080p"))

    focusOn(sourceFilterTag("addon"))
    press(Key.DirectionCenter)
    focusOn(sourceFilterOptionTag(3))
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) {
      compose.onAllNodesWithTag(sourceRowTag(0)).fetchSemanticsNodes().isNotEmpty()
    }
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("C 1080p"))

    // Both versions travel with the play: a switch inside the player still has both of them.
    focusOn(sourceRowTag(0))
    press(Key.DirectionCenter)
    assertTrue(played.isEmpty())
    focusOn(TagDetailPrimary)
    press(Key.DirectionCenter)
    val target = played.single()
    assertEquals("rlibC", target.remoteItem?.libraryId)
    assertEquals(2, target.initialSources.orEmpty().count { it.sourceId == "v1" })
    assertEquals(
      listOf("rlibB", "rlibC"),
      target.initialSources.orEmpty().filter { it.sourceId == "v1" }.map { it.remoteItem?.libraryId },
    )
  }

  // --- A failed metadata read, and the addons' own messages ---------------------------------------

  @Test
  fun `a failed settings read is retryable and its answer reveals the debrid row`() {
    val api = FakeTvApi().apply {
      libraryTitleValues[film] = LibraryTitleDto("movie", "tt1", name = "It")
      settingsValue = SettingsResponse(audioLanguage = "en", realDebridConfigured = true)
      settingsReadFailure = ApiFailure.Unreachable
      streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
      addonStreams["movie:tt1|alpha"] = listOf(
        StreamDto(sourceId = "torrent1", kind = "torrent", playable = false, title = "Torrent 20 GB", addonName = "Alpha"),
      )
      localStreamsValues["movie:tt1"] = emptyList()
      remoteLibrariesValue = emptyList()
    }
    mount(api)
    openPanel(rows = 1)

    // Without the account's own settings no debrid rule is known, so the torrent is not offered --
    // and the failed read is still a failure the panel can retry.
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("It.mkv"))
    compose.onNodeWithTag(sourceRowTag(1)).assertDoesNotExist()
    compose.onNodeWithTag(TagRemoteSourcesPanelRetry).assertExists()

    api.settingsReadFailure = null
    focusOn(TagRemoteSourcesPanelRetry)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) {
      compose.onAllNodesWithTag(sourceRowTag(1)).fetchSemanticsNodes().isNotEmpty()
    }

    assertEquals(2, api.settingsCalls)
    assertEquals(1, api.streamsRequests.count { it == "movie:tt1|alpha" })
    compose.onNodeWithTag(sourceRowTag(1)).assert(hasText("Torrent 20 GB"))
    compose.onNodeWithTag(TagRemoteSourcesPanelRetry).assertDoesNotExist()
  }

  @Test
  fun `a failed addon list is retried and its order decides the recommended rows`() {
    val api = FakeTvApi().apply {
      libraryTitleValues[film] = LibraryTitleDto("movie", "tt1", name = "It")
      settingsValue = SettingsResponse(audioLanguage = "cs")
      addonsValue = listOf(
        AddonDto(key = "beta", manifest = AddonManifestDto(id = "beta.id", name = "Beta")),
        AddonDto(key = "alpha", manifest = AddonManifestDto(id = "alpha.id", name = "Alpha")),
      )
      streamSourcesValues["movie:tt1"] =
        listOf(StreamSourceDto("alpha", "Alpha"), StreamSourceDto("beta", "Beta"))
      addonStreams["movie:tt1|alpha"] = listOf(
        StreamDto(sourceId = "srcA", kind = "remote", playable = true, title = "Czech 5 GB", addonName = "Alpha"),
      )
      addonStreams["movie:tt1|beta"] = listOf(
        StreamDto(sourceId = "srcB", kind = "remote", playable = true, title = "Czech 1 GB", addonName = "Beta"),
      )
      localStreamsValues["movie:tt1"] = emptyList()
      remoteLibrariesValue = emptyList()
      addonsFailure = ApiFailure.Unreachable
    }
    mount(api)
    openPanel(rows = 3)

    // With no addon list the rows fall back to their reported size: the larger one leads.
    compose.onNodeWithTag(sourceRowTag(1)).assert(hasText("Czech 5 GB"))
    compose.onNodeWithTag(TagRemoteSourcesPanelRetry).assertExists()

    api.addonsFailure = null
    focusOn(TagRemoteSourcesPanelRetry)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { compose.onAllNodesWithText("Czech 1 GB").fetchSemanticsNodes().isNotEmpty() }

    // The recovered list ranks Beta above Alpha, so its smaller row leads the recommended order.
    compose.onNodeWithTag(sourceRowTag(1)).assert(hasText("Czech 1 GB"))
    compose.onNodeWithTag(sourceRowTag(2)).assert(hasText("Czech 5 GB"))
    assertEquals(2, api.addonsCalls)
    assertEquals(1, api.streamsRequests.count { it == "movie:tt1|alpha" })
    assertEquals(1, api.streamsRequests.count { it == "movie:tt1|beta" })
  }

  @Test
  fun `an addon's own message is drawn as a notice and is not a row`() {
    val api = seeded()
    api.addonStreams["movie:tt1|alpha"] = listOf(
      StreamDto(sourceId = "srcA", kind = "remote", playable = true, title = "Czech 40 GB", addonName = "Alpha"),
      StreamDto(sourceId = "n1", kind = "unsupported", title = "No stream for this one", addonName = "Alpha"),
    )
    mount(api)
    openPanel(rows = 3)

    // The message is a line of its own, after the rows; the numbering stops before it, so it can
    // never be picked and it never carries the default mark.
    compose.onNodeWithText("No stream for this one").assertExists()
    compose.onNodeWithTag(sourceRowTag(3)).assertDoesNotExist()
    compose.onNodeWithTag(sourceRowTag(2)).assert(hasText("Czech 40 GB"))
  }

  // --- A colon-bearing (TMDB) series binding ------------------------------------------------------

  @Test
  fun `a tmdb episode asks under its whole video id and saves with the split numbers`() {
    val api = FakeTvApi().apply {
      libraryTitleValues[episodeTwoPath] =
        LibraryTitleDto("series", "tmdb:123", videoId = "tmdb:123:4:5", name = "Show")
      streamSourcesValues["series:tmdb:123:4:5"] = listOf(StreamSourceDto("alpha", "Alpha"))
      addonStreams["series:tmdb:123:4:5|alpha"] = listOf(addonRow())
      localStreamsValues["series:tmdb:123:4:5"] = emptyList()
      remoteLibrariesValue = emptyList()
    }
    val episodes = listOf(file(episodeTwoPath, "Show.S04E05.mkv", season = 4, episode = 5))
    mount(api, data = detail(episodes, title = "Show"), destinations = heldDestinations(), onQueue = recordingQueue())

    // The detail lists one file, so the action itself opens the panel for exactly that episode.
    openPanel(rows = 2)

    // The addon is asked under the binding's own video id, colons and all.
    assertEquals(listOf("series:tmdb:123:4:5"), api.streamSourcesRequests)
    assertEquals(listOf("series:tmdb:123:4:5|alpha"), api.streamsRequests)

    focusOn(sourceRowTag(1))
    press(Key.DirectionCenter)
    focusOn(TagDetailToLibrary)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { compose.onAllNodesWithTag(TagNativeQueuePanel).fetchSemanticsNodes().isNotEmpty() }
    focusOn(nativeQueueLibraryTag("libA"))
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { queued.isNotEmpty() }

    val media = queued.single().media
    assertEquals("episode", media.kind)
    assertEquals("tmdb:123", media.id)
    assertEquals("series", media.metaType)
    assertEquals(4, media.season)
    assertEquals(5, media.episode)
    assertEquals("Show", media.title)
    assertEquals("srcA", queued.single().sourceId)
  }

  // --- The save work belongs to the panel it was pressed in ---------------------------------------

  private fun recordingQueue(): suspend (String, String, MediaDto, DownloadTargetDto?) -> Unit =
    { title, sourceId, media, _ ->
      queueCalls += 1
      queuedGate?.await()
      queued += Queued(title, sourceId, media)
    }

  private fun heldDestinations(): suspend () -> List<LibraryDto> = {
    destinationsGate?.await()
    listOf(LibraryDto(id = "libA", name = "Films", type = "mixed", writable = true))
  }

  private fun openEpisodePanel(path: String, rows: Int) {
    compose.onNodeWithTag(path).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    compose.onNodeWithTag(path).performKeyInput { pressKey(Key.Menu) }
    compose.waitForIdle()
    compose.waitUntil(5_000) {
      compose.onAllNodesWithTag(sourceRowTag(rows - 1)).fetchSemanticsNodes().isNotEmpty()
    }
  }

  private fun episodeOne() = file(episodeOnePath, "Show.S01E01.mkv", season = 1, episode = 1)

  private fun episodeTwo() = file(episodeTwoPath, "Show.S01E02.mkv", season = 1, episode = 2)

  private fun episodeDetail() = detail(listOf(episodeOne(), episodeTwo()), title = "Show")

  /** Two episodes of one series, each bound to its own video id and each with its own addon row. */
  private fun episodeFakes() = FakeTvApi().apply {
    libraryTitleValues[episodeOnePath] = LibraryTitleDto("series", "tt7", videoId = "tt7:1:1", name = "Show")
    libraryTitleValues[episodeTwoPath] = LibraryTitleDto("series", "tt7", videoId = "tt7:1:2", name = "Show")
    streamSourcesValues["series:tt7:1:1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    streamSourcesValues["series:tt7:1:2"] = listOf(StreamSourceDto("alpha", "Alpha"))
    addonStreams["series:tt7:1:1|alpha"] = listOf(addonRow("srcA"))
    addonStreams["series:tt7:1:2|alpha"] = listOf(addonRow("srcB"))
    localStreamsValues["series:tt7:1:1"] = emptyList()
    localStreamsValues["series:tt7:1:2"] = emptyList()
    remoteLibrariesValue = emptyList()
  }

  @Test
  fun `a late destination read never opens over the panel that replaced it`() {
    val api = episodeFakes()
    destinationsGate = CompletableDeferred()
    mount(api, data = episodeDetail(), destinations = heldDestinations(), onQueue = recordingQueue())

    // The action row's own panel picks the first episode's addon row; To library starts the read.
    openPanel(rows = 2)
    focusOn(sourceRowTag(1))
    press(Key.DirectionCenter)
    focusOn(TagDetailToLibrary)
    press(Key.DirectionCenter)
    compose.waitForIdle()
    // The viewer leaves while the destinations are still out and opens the next episode's panel.
    openEpisodePanel(episodeTwoPath, rows = 2)

    destinationsGate?.complete(Unit)
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    // Nothing of the first panel opened over it: the second panel is still the one on screen, and
    // the subject a queue carries is the second episode's.
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
    compose.onNodeWithTag(TagNativeQueuePanel).assertDoesNotExist()

    // The second episode's panel is what saves now: it plays the row the viewer chooses, and To
    // library then carries that episode's own subject.
    focusOn(sourceRowTag(1))
    press(Key.DirectionCenter)
    focusOn(TagDetailToLibrary)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { compose.onAllNodesWithTag(TagNativeQueuePanel).fetchSemanticsNodes().isNotEmpty() }
    focusOn(nativeQueueLibraryTag("libA"))
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { queued.isNotEmpty() }

    assertEquals("srcB", queued.single().sourceId)
    assertEquals(1, queued.single().media.season)
    assertEquals(2, queued.single().media.episode)
  }

  @Test
  fun `a queue in flight is issued once, holds its panel and lands once`() {
    val api = episodeFakes()
    queuedGate = CompletableDeferred()
    mount(api, data = episodeDetail(), destinations = heldDestinations(), onQueue = recordingQueue())

    // The first episode's queue is issued and stays in flight.
    openPanel(rows = 2)
    focusOn(sourceRowTag(1))
    press(Key.DirectionCenter)
    focusOn(TagDetailToLibrary)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { compose.onAllNodesWithTag(TagNativeQueuePanel).fetchSemanticsNodes().isNotEmpty() }
    focusOn(nativeQueueLibraryTag("libA"))
    press(Key.DirectionCenter)
    compose.waitForIdle()
    assertEquals(1, queueCalls)

    // A copy the server already took is not sent a second time: the panel holds while it is out.
    press(Key.Back)
    compose.onNodeWithTag(TagNativeQueuePanel).assertExists()
    assertEquals(1, queueCalls)

    // Its own completion lands: it closes its own panel and says the copy was queued, once.
    queuedGate?.complete(Unit)
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()

    assertEquals(1, queueCalls)
    compose.onNodeWithTag(TagNativeQueuePanel).assertDoesNotExist()
    compose.onNodeWithTag(TagDetailSourceNotice).assertExists()
    assertEquals(listOf("srcA"), queued.map { it.sourceId })
    assertEquals(listOf(1), queued.map { it.media.episode })
  }

  // --- The card that opened the panel takes the remote back ---------------------------------------

  @Test
  fun `a panel opened from a card comes back to that exact card`() {
    val api = FakeTvApi().apply {
      libraryTitleValues[episodeTwoPath] = LibraryTitleDto("series", "tt5", videoId = "tt5:1:2", name = "Show")
      streamSourcesValues["series:tt5:1:2"] = listOf(StreamSourceDto("alpha", "Alpha"))
      addonStreams["series:tt5:1:2|alpha"] = listOf(addonRow())
      localStreamsValues["series:tt5:1:2"] = emptyList()
      remoteLibrariesValue = emptyList()
    }
    val episodes = listOf(
      file(episodeOnePath, "Show.S01E01.mkv", season = 1, episode = 1),
      file(episodeTwoPath, "Show.S01E02.mkv", season = 1, episode = 2),
      file("Shows/Show/S01/Show.S01E03.mkv", "Show.S01E03.mkv", season = 1, episode = 3),
    )
    mount(api, data = detail(episodes, title = "Show"))

    openEpisodePanel(episodeTwoPath, rows = 2)
    press(Key.Back)

    // The exact card the panel was opened from, never the detail's own action.
    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()
    compose.onNodeWithTag(episodeTwoPath).assertIsFocused()
    compose.onNodeWithTag(TagDetailSources).assertIsNotFocused()

    // Enter on a card still plays that file directly.
    compose.onNodeWithTag(episodeTwoPath).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    assertEquals("file:$episodeTwoPath", played.single().key)
    assertEquals(episodeTwoPath, played.single().path)
  }

  @Test
  fun `a destinations read in flight opens nothing once another panel owns the save work`() {
    val api = episodeFakes()
    destinationsGate = CompletableDeferred()
    mount(api, data = episodeDetail(), destinations = heldDestinations(), onQueue = recordingQueue())

    // The action row opens the panel for the first episode; picking its addon row and pressing To
    // library starts the destination read.
    openPanel(rows = 2)
    focusOn(sourceRowTag(1))
    press(Key.DirectionCenter)
    focusOn(TagDetailToLibrary)
    press(Key.DirectionCenter)
    compose.waitForIdle()

    // A new panel owns the save work from here on.
    openEpisodePanel(episodeOnePath, rows = 2)
    destinationsGate?.complete(Unit)
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
    compose.onNodeWithTag(TagNativeQueuePanel).assertDoesNotExist()
    assertEquals(0, queueCalls)
  }


  @Test
  fun `reopening sources focuses the selected version`() {
    mount(seeded())
    openPanel(rows = 3)
    focusOn(sourceRowTag(2))
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()
    openPanel(rows = 3)
    compose.onNodeWithTag(sourceRowTag(2)).assertIsFocused()
  }

  // --- The one action row, the pick and Mark watched --------------------------------------------

  @Test
  fun `the action row draws the shared order`() {
    val api = FakeTvApi().apply {
      libraryTitleValues[film] = LibraryTitleDto("movie", "tt1", name = "It")
      streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
      addonStreams["movie:tt1|alpha"] = listOf(addonRow())
      localStreamsValues["movie:tt1"] = emptyList()
      remoteLibrariesValue = emptyList()
    }
    val destinations = listOf(LibraryDto(id = "libA", name = "Films", type = "movie", writable = true))
    mount(
      api,
      data = detail(listOf(file(film, "It.mkv").copy(progress = ProgressDto(40.0, 120.0)))),
      destinations = { destinations },
      onQueue = { _, _, _, _ -> },
      markWatched = { markedWatched += it },
      progress = { ProgressDto(40.0, 120.0) },
    )

    // The addon row is picked first, so To library is offered beside everything else.
    openPanel(rows = 2)
    focusOn(sourceRowTag(1))
    press(Key.DirectionCenter)

    assertEquals(
      listOf(
        TagDetailPrimary,
        TagDetailStartOver,
        TagDetailSources,
        TagDetailToLibrary,
        TagDetailFavourite,
        TagDetailForget,
        TagDetailMarkWatched,
      ),
      compose.actionRowOrder(
        TagDetailPrimary,
        TagDetailStartOver,
        TagDetailSources,
        TagDetailToLibrary,
        TagDetailFavourite,
        TagDetailForget,
        TagDetailMarkWatched,
      ),
    )
  }

  @Test
  fun `choosing an addon row only picks it, names it and leaves Play to start it`() {
    val api = seeded()
    mount(api)
    openPanel(rows = 3)

    focusOn(sourceRowTag(2))
    press(Key.DirectionCenter)

    assertTrue(played.isEmpty())
    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()
    compose.onNodeWithTag(TagDetailPickCaption).assertTextContains("Alpha · 40.0 GB")

    focusOn(TagDetailPrimary)
    press(Key.DirectionCenter)

    assertEquals(listOf("srcA"), played.map { it.sourceId })
  }

  @Test
  fun `To library appears once a row is picked and queues exactly that row`() {
    val api = seeded()
    val destinations = listOf(LibraryDto(id = "libA", name = "Films", type = "movie", writable = true))
    mount(api, destinations = { destinations }, onQueue = recordingQueue())

    // With nothing picked there is nothing for the action to act on.
    compose.onNodeWithTag(TagDetailToLibrary).assertDoesNotExist()

    openPanel(rows = 3)
    focusOn(sourceRowTag(2))
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagDetailToLibrary).assertExists()

    focusOn(TagDetailToLibrary)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { compose.onAllNodesWithTag(TagNativeQueuePanel).fetchSemanticsNodes().isNotEmpty() }
    // The panel offers the destinations for exactly the picked row.
    compose.onNodeWithTag(nativeQueueLibraryTag("libA")).assertExists()
    focusOn(nativeQueueLibraryTag("libA"))
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { queued.isNotEmpty() }

    assertEquals(listOf("srcA"), queued.map { it.sourceId })
    // A file already on disk is never queued again.
    openPanel(rows = 3)
    focusOn(sourceRowTag(0))
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagDetailToLibrary).assertDoesNotExist()
  }

  @Test
  fun `a row chosen from an episode card's panel still plays at once`() {
    val api = episodeFakes()
    mount(api, data = episodeDetail())

    openEpisodePanel(episodeOnePath, rows = 2)
    focusOn(sourceRowTag(1))
    press(Key.DirectionCenter)

    // The card is the episode's only button, so its panel plays the row there and then.
    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()
    assertEquals("srcA", played.single().sourceId)
    assertEquals("Shows/Show/S01/Show.S01E01.mkv", episodeOnePath)
  }

  @Test
  fun `Mark watched stores the file Play would start as finished`() {
    val api = FakeTvApi()
    mount(api, markWatched = { markedWatched += it })

    focusOn(TagDetailMarkWatched)
    press(Key.DirectionCenter)
    compose.waitForIdle()

    assertEquals(listOf(film), markedWatched.map { it.path })
  }

  @Test
  fun `Mark watched is not drawn without a playback surface to store it`() {
    mount(FakeTvApi())

    compose.onNodeWithTag(TagDetailMarkWatched).assertDoesNotExist()
  }

}
