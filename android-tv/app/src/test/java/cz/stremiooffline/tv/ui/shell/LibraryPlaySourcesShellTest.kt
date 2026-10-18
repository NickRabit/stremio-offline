@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.BehaviorHintsDto
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.OfferedSources
import cz.stremiooffline.tv.ui.catalog.TagSourcesPanel
import cz.stremiooffline.tv.ui.catalog.sourceRowTag
import cz.stremiooffline.tv.ui.detail.PlayTarget
import cz.stremiooffline.tv.ui.player.TAG_OSD_SOURCES
import kotlinx.coroutines.CompletableDeferred
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A play started from the library, driven by the remote: a file bound to a catalogue title gets
 * the Sources button under the session and offers the file that is playing plus the addon rows.
 * A file with no binding keeps the player it always had, and a slow answer never delays Play.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class LibraryPlaySourcesShellTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>

  private val path = "It/It.mkv"

  private class LibraryFake : FakeTvApi() {
    override suspend fun browse(path: String?, limit: Int, skip: Int, query: String): BrowseResult {
      browseCalls += path to skip
      val items: List<BrowseItem> = if (path == null) listOf(BrowseItem.Folder(path = "It", name = "It", fileCount = 1))
      else listOf(BrowseItem.File(path = "It/It.mkv", label = "It.mkv"))
      return BrowseResult(path.orEmpty(), items, items.size, false)
    }
  }

  private fun api(): LibraryFake = LibraryFake().apply {
    settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", realDebridConfigured = true)
    streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    addonStreams["movie:tt1|alpha"] = listOf(
      StreamDto(sourceId = "srcA", kind = "remote", playable = true, title = "Czech 8 GB", addonName = "Alpha")
    )
    localStreamsValues["movie:tt1"] = listOf(
      StreamDto(
        sourceId = "lib1",
        kind = "library",
        playable = true,
        localPath = path,
        libraryName = "Filmy",
        behaviorHints = BehaviorHintsDto(filename = "It.mkv"),
      )
    )
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

  private fun mount(api: FakeTvApi) {
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = Section.Library, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()
    switchToFiles()
  }

  /** The section opens on the All grid; the filesystem's rows are one switch press away. */
  private fun switchToFiles() {
    compose.onNodeWithText("Files").performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun focused(tag: String): Boolean =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .any { it.config.getOrElse(SemanticsProperties.TestTag) { "" } == tag }

  /** The library's only folder, then its only file, then Play: a play the library view started. */
  private fun playFromLibrary() {
    compose.onNodeWithTag("It").assertIsFocused()
    press(Key.DirectionCenter)
    compose.waitForIdle()
    press(Key.DirectionCenter)
    compose.waitForIdle()
  }

  /** RIGHT from Play lands on the Sources button once the title offers a choice. */
  private fun openSources() {
    repeat(4) {
      if (focused(TAG_OSD_SOURCES)) return@repeat
      press(Key.DirectionRight)
    }
    compose.onNodeWithTag(TAG_OSD_SOURCES).assertIsFocused()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
  }

  @Test
  fun `a library play of a bound file offers the playing file and the addon rows`() {
    val fake = api()
    fake.libraryTitleValues[path] = LibraryTitleDto("movie", "tt1", name = "It")
    mount(fake)

    playFromLibrary()
    openSources()

    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("Playing"))
    compose.onNodeWithTag(sourceRowTag(1)).assert(hasText("Alpha"))
  }

  @Test
  fun `a library play of an unbound file has no Sources button`() {
    mount(api())

    playFromLibrary()

    compose.onNodeWithTag(TAG_OSD_SOURCES).assertDoesNotExist()
  }

  /** The library flow keeps its own list: switching to an addon row inside the player must not
   *  shrink the panel to that row, and must not make anything discover a second time. */
  @Test
  fun `a library play keeps its rows across a switch to another source`() {
    val fake = api()
    fake.remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibB", name = "Serialy", provider = "jellyfin"))
    fake.remoteMatchValues["rlibB|movie|tt1"] = listOf(
      StreamDto(
        sourceId = "ms9",
        kind = "remote",
        playable = true,
        name = "Version ms9",
        remoteItem = RemoteItemContext(
          libraryId = "rlibB",
          itemId = "iB",
          mediaSourceId = "ms9",
          progressKey = "remote:rlibB:iB",
        ),
      )
    )
    fake.libraryTitleValues[path] = LibraryTitleDto("movie", "tt1", name = "It")
    mount(fake)

    playFromLibrary()
    openSources()
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("Playing"))
    compose.onNodeWithTag(sourceRowTag(1)).assert(hasText("Version ms9"))
    compose.onNodeWithTag(sourceRowTag(2)).assert(hasText("Alpha"))

    // DOWN from the file that is playing reaches the other library's version, and OK plays it.
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { fake.startedSources.size == 2 }
    assertEquals(listOf("src:$path", "ms9"), fake.startedSources)

    // The panel is still the caller's whole list, and nothing was asked a second time.
    openSources()
    // The row the switch landed on leads the panel now.
    compose.onNodeWithTag(sourceRowTag(0)).assert(hasText("Version ms9"))
    compose.onNodeWithTag(sourceRowTag(1)).assert(hasText("It.mkv"))
    compose.onNodeWithTag(sourceRowTag(2)).assert(hasText("Alpha"))
    press(Key.Back)
    // One read for the sources and one for the subtitles of the file, neither repeated by the switch.
    assertEquals(2, fake.libraryTitleRequests.size)
    assertEquals(1, fake.streamSourcesRequests.size)
    assertEquals(1, fake.localStreamsRequests.size)
    assertEquals(1, fake.remoteMatchRequests.size)
  }

  @Test
  fun `a slow source answer does not delay Play`() {
    val fake = api()
    val gate = CompletableDeferred<Unit>()
    fake.libraryTitleGate = gate
    mount(fake)

    playFromLibrary()

    assertEquals(listOf("src:$path"), fake.startedSources)
    assertTrue(fake.libraryTitleRequests.contains(path))
    compose.onNodeWithTag(TAG_OSD_SOURCES).assertDoesNotExist()

    fake.libraryTitleValues[path] = LibraryTitleDto("movie", "tt1", name = "It")
    gate.complete(Unit)
    compose.waitForIdle()

    compose.onNodeWithTag(TAG_OSD_SOURCES).assertExists()
  }

  /** An addon play a native detail started with several rows carries its own list: the player
   *  offers exactly those, never the catalogue list the shell happens to still hold. */
  @Test
  fun `a native detail's addon snapshot of several rows is the player's list`() {
    val row = StreamDto(sourceId = "srcA", kind = "remote", playable = true, title = "Czech 8 GB", addonName = "Alpha")
    val other = StreamDto(sourceId = "srcB", kind = "remote", playable = true, title = "Czech 4 GB", addonName = "Alpha")
    val stale = StreamDto(sourceId = "stale", kind = "remote", playable = true, title = "Stale", addonName = "Old")
    val libraryRow = StreamDto(sourceId = "lib1", kind = "library", playable = true, localPath = "It/It.mkv")
    val target = PlayTarget(
      key = "movie:tt1",
      title = "It",
      resume = true,
      sourceId = "srcA",
      subtitleType = "movie",
      subtitleTarget = "tt1",
      initialSources = listOf(row, other),
    )

    val sources = playerSourcesFor(target, OfferedSources(listOf(stale), loading = true), OfferedSources(listOf(libraryRow)))

    assertEquals(listOf(row, other), sources.streams)
    assertFalse(sources.loading)
  }

  @Test
  fun `one snapshot row hands the play to the loader, several rows are the list`() {
    val row = StreamDto(sourceId = "srcA", kind = "remote", playable = true, title = "Czech 8 GB", addonName = "Alpha")
    val other = StreamDto(sourceId = "srcB", kind = "remote", playable = true, title = "Czech 4 GB", addonName = "Alpha")
    val loaded = OfferedSources(listOf(row, other), loading = true)
    val snapshot = PlayTarget(
      key = "movie:tt1",
      title = "It",
      resume = true,
      sourceId = "srcA",
      subtitleType = "movie",
      subtitleTarget = "tt1",
      initialSources = listOf(row),
    )
    // A single row names one source, not a list: the loader discovers the title's own sources.
    assertEquals(loaded, playerSourcesFor(snapshot, OfferedSources(), loaded))

    val several = snapshot.copy(initialSources = listOf(row, other))
    assertEquals(listOf(row, other), playerSourcesFor(several, OfferedSources(), loaded).streams)

    val oneRemote = PlayTarget(
      key = "remote:rlibA:iA",
      title = "Heat",
      resume = true,
      remoteItem = RemoteItemContext(libraryId = "rlibA", itemId = "iA", mediaSourceId = "ms1", progressKey = "remote:rlibA:iA"),
      remoteSources = listOf(row),
    )
    assertEquals(loaded, playerSourcesFor(oneRemote, OfferedSources(), loaded))
  }

  @Test
  fun `a native version still offers its own versions and a catalogue play its own list`() {
    val remote = StreamDto(sourceId = "ms1", kind = "remote", playable = true, title = "Remote 8 GB")
    val remote2 = StreamDto(sourceId = "ms2", kind = "remote", playable = true, title = "Remote 4 GB")
    val remoteTarget = PlayTarget(
      key = "remote:rlibA:iA",
      title = "Heat",
      resume = true,
      remoteItem = RemoteItemContext(libraryId = "rlibA", itemId = "iA", mediaSourceId = "ms1", progressKey = "remote:rlibA:iA"),
      remoteSources = listOf(remote, remote2),
    )
    assertEquals(listOf(remote, remote2), playerSourcesFor(remoteTarget, OfferedSources(listOf(remote)), OfferedSources()).streams)

    val catalogueTarget = PlayTarget(key = "movie:tt1", title = "It", resume = false, catalogue = true)
    val catalogue = OfferedSources(listOf(remote), loading = true)
    assertEquals(catalogue, playerSourcesFor(catalogueTarget, catalogue, OfferedSources()))

    val libraryTarget = PlayTarget(key = "file:It/It.mkv", title = "It", resume = false, path = "It/It.mkv")
    val library = OfferedSources(listOf(remote), loading = true)
    assertEquals(library, playerSourcesFor(libraryTarget, OfferedSources(), library))
  }
}
