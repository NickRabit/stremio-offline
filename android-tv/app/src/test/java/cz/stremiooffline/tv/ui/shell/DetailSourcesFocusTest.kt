@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.hasTestTag
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
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.TagSourcesPanel
import cz.stremiooffline.tv.ui.catalog.sourceRowTag
import cz.stremiooffline.tv.ui.detail.TagDetailPrimary
import cz.stremiooffline.tv.ui.detail.TagDetailSources
import cz.stremiooffline.tv.ui.player.TAG_OSD_PLAY
import cz.stremiooffline.tv.ui.player.TAG_OVERLAY_ROOT
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Choosing a source starts the player over the detail that offered it. The detail is covered from
 * that moment, so its own panel-closing focus work must not pull the remote out of the session; when
 * the session ends, the detail takes the remote back.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class DetailSourcesFocusTest {

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

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  private fun back() {
    scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()
  }

  private fun focused(tag: String): Boolean =
    runCatching { compose.onNodeWithTag(tag).assertIsFocused() }.isSuccess

  /** A play the library view started, opened from the detail's own Sources panel. */
  private fun playFromPanel(api: FakeTvApi) {
    compose.waitForIdle()
    // The section opens on the All grid; the filesystem's rows are one switch press away.
    compose.onNodeWithText("Files").performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    // The only folder holds one file, so opening it is the detail of that film.
    compose.onNodeWithTag("It").performSemanticsAction(SemanticsActions.RequestFocus)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { focused(TagDetailPrimary) }

    // Its Sources action opens the panel; the addon row starts the session.
    compose.onNodeWithTag(TagDetailSources).performSemanticsAction(SemanticsActions.RequestFocus)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag(TagSourcesPanel)).fetchSemanticsNodes().isNotEmpty() }
    compose.waitUntil(5_000) {
      compose.onAllNodes(hasTestTag(sourceRowTag(1))).fetchSemanticsNodes().isNotEmpty()
    }
    compose.onNodeWithTag(sourceRowTag(1)).performSemanticsAction(SemanticsActions.RequestFocus)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.startedSources.size == 1 }
  }

  private fun api(): LibraryFake = LibraryFake().apply {
    settingsValue = SettingsResponse(uiLanguage = "en", audioLanguage = "en", realDebridConfigured = true)
    libraryTitleValues[path] = LibraryTitleDto("movie", "tt1", name = "It")
    streamSourcesValues["movie:tt1"] = listOf(StreamSourceDto("alpha", "Alpha"))
    addonStreams["movie:tt1|alpha"] = listOf(
      StreamDto(sourceId = "srcA", kind = "remote", playable = true, title = "Czech 8 GB", addonName = "Alpha"),
    )
    localStreamsValues["movie:tt1"] = listOf(
      StreamDto(
        sourceId = "lib1",
        kind = "library",
        playable = true,
        localPath = path,
        libraryName = "Filmy",
        behaviorHints = BehaviorHintsDto(filename = "It.mkv"),
      ),
    )
  }

  @Test
  fun `choosing a source gives the player the remote and Back gives it back to the detail`() {
    val fake = api()
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = Section.Library, api = fake, username = "demo", onSignOut = {}) }
    }
    playFromPanel(fake)

    // The session owns the remote: the covered detail's panel-closing work never took it.
    compose.waitUntil(5_000) {
      listOf(TAG_OVERLAY_ROOT, TAG_OSD_PLAY).any { tag -> focused(tag) }
    }
    compose.onNodeWithTag(TagDetailSources).assertIsNotFocused()
    assertTrue(fake.startedSources.last() == "srcA")

    // Leaving the session hands the remote back to the detail that opened it.
    repeat(3) {
      if (compose.onAllNodes(hasTestTag(TAG_OVERLAY_ROOT)).fetchSemanticsNodes().isEmpty()) return@repeat
      back()
    }
    compose.waitUntil(5_000) { focused(TagDetailPrimary) }
  }
}
