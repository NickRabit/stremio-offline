@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.BehaviorHintsDto
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.TagSourcesPanel
import cz.stremiooffline.tv.ui.catalog.sourceRowTag
import cz.stremiooffline.tv.ui.player.TAG_OSD_SOURCES
import kotlinx.coroutines.CompletableDeferred
import org.junit.After
import org.junit.Assert.assertEquals
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
    override suspend fun browse(path: String?, limit: Int, skip: Int): BrowseResult {
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
}
