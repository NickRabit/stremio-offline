@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.activity.ComponentActivity
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.TagSourcesPanel
import cz.stremiooffline.tv.ui.catalog.sourceRowTag
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The player a native detail's addon play opens: the switch between the rows it was handed keeps
 * the generic catalogue key and the incoming row's own addon, discovers nothing, and never turns
 * a native version into a generic play.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerInitialSourcesTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private val alpha = StreamDto(
    sourceId = "srcA",
    kind = "remote",
    playable = true,
    name = "small",
    title = "Czech 1 GB",
    addonKey = "alpha",
    addonName = "Alpha",
  )

  private val beta = StreamDto(
    sourceId = "srcB",
    kind = "remote",
    playable = true,
    name = "big",
    title = "Czech 8 GB",
    addonKey = "beta",
    addonName = "Beta",
  )

  private fun native(sourceId: String) = StreamDto(
    sourceId = sourceId,
    kind = "remote",
    playable = true,
    name = "Version $sourceId",
    remoteItem = RemoteItemContext(libraryId = "rlibA", itemId = "iA", mediaSourceId = sourceId, progressKey = "remote:rlibA:iA"),
  )

  private fun mount(api: FakeTvApi, target: PlayTarget, sources: List<StreamDto>) {
    compose.setContent {
      PlayerScreen(api = api, target = target, onExit = {}, sources = sources)
    }
    compose.waitForIdle()
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
  }

  /** Right from Play lands on the Sources button once the title offers a choice. */
  private fun openSources(fromPlay: Boolean = true) {
    if (fromPlay) {
      press(Key.DirectionRight)
      press(Key.DirectionRight)
      press(Key.DirectionRight)
    }
    compose.onNodeWithTag(TAG_OSD_SOURCES).assertIsFocused()
    press(Key.DirectionCenter)
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
  }

  @Test
  fun `an addon snapshot switches among its own rows and discovers nothing`() {
    val api = object : FakeTvApi() {
      val progressOwners = mutableListOf<String?>()
      override suspend fun saveProgress(key: String, position: Double, duration: Double, title: String, path: String?, poster: String?, addonKey: String?) {
        progressOwners += addonKey
      }
    }
    api.progressValues["movie:tt1"] = ProgressDto(position = 600.0, duration = 3_600.0)
    mount(
      api,
      PlayTarget(
        key = "movie:tt1",
        title = "It",
        resume = true,
        sourceId = "srcA",
        subtitleType = "movie",
        subtitleTarget = "tt1",
        initialSources = listOf(alpha, beta),
      ),
      listOf(alpha, beta),
    )
    compose.waitUntil(5_000) { api.startedSources.isNotEmpty() }

    compose.onNodeWithTag(TAG_OSD_SEEK_FORWARD).performSemanticsAction(SemanticsActions.OnClick) { it() }
    compose.waitForIdle()
    openSources()
    // The panel opens on the row that is playing (srcA); Down reaches the other one.
    compose.onNodeWithTag(sourceRowTag(0)).assertIsFocused()
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.startedSources.size == 2 }
    assertEquals(listOf("srcA", "srcB"), api.startedSources)
    compose.onNodeWithTag(TAG_OSD_SEEK_FORWARD).performSemanticsAction(SemanticsActions.OnClick) { it() }
    compose.waitForIdle()
    assertTrue(api.progressOwners.isNotEmpty())
    assertTrue(api.progressOwners.all { it == null })
    // The switch keeps the viewer's sought position and asks the catalogue subtitles again under
    // the same type and id, so the incoming row stayed a row of this generic title.
    assertEquals(10.0, api.startedTimes.last(), 0.001)
    assertEquals(listOf("movie" to "tt1", "movie" to "tt1"), api.subtitlesRequests)

    // The rows the detail handed over are still the player's own list.
    openSources(fromPlay = false)
    compose.onNodeWithTag(sourceRowTag(0)).assertExists()
    compose.onNodeWithTag(sourceRowTag(1)).assertExists()
    press(Key.Back)

    // Nothing but the rows the detail handed over was ever asked for.
    assertTrue(api.libraryTitleRequests.isEmpty())
    assertTrue(api.streamSourcesRequests.isEmpty())
    assertTrue(api.localStreamsRequests.isEmpty())
    assertTrue(api.remoteSourcesRequests.isEmpty())
    assertTrue(api.remoteMatchRequests.isEmpty())
    assertEquals(0, api.addonsCalls)
  }

  @Test
  fun `a native version switch stays a native play and never becomes a generic one`() {
    val api = FakeTvApi()
    api.progressValues["movie:tt1"] = ProgressDto(position = 600.0, duration = 3_600.0)
    mount(
      api,
      PlayTarget(
        key = "remote:rlibA:iA",
        title = "Heat",
        resume = true,
        remoteItem = RemoteItemContext(libraryId = "rlibA", itemId = "iA", mediaSourceId = "ms1", progressKey = "remote:rlibA:iA"),
        sourceId = "ms1",
        remoteSources = listOf(native("ms1"), native("ms2")),
      ),
      listOf(native("ms1"), native("ms2")),
    )
    compose.waitUntil(5_000) { api.startedSources.isNotEmpty() }

    openSources()
    press(Key.DirectionDown)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.startedSources.size == 2 }
    assertEquals(listOf("ms1", "ms2"), api.startedSources)
    // Another version is another file and starts at 0, and the catalogue's addon subtitles are
    // never asked for a native play.
    assertEquals(0.0, api.startedTimes.last(), 0.001)
    assertTrue(api.subtitlesRequests.isEmpty())
    assertTrue(api.libraryTitleRequests.isEmpty())
    assertTrue(api.streamSourcesRequests.isEmpty())
    assertEquals(0, api.addonsCalls)
  }
}
