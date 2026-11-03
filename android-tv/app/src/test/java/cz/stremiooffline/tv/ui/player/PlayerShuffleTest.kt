@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.activity.ComponentActivity
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import cz.stremiooffline.tv.data.NextFileDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.ShuffleItemDto
import cz.stremiooffline.tv.data.ShuffleNextDto
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import cz.stremiooffline.tv.ui.detail.ShuffleRun
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerShuffleTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private fun api() = FakeTvApi().apply {
    startAnswer = PlaybackDescriptorDto(id = "p1", url = "/stream.mp4", duration = 600.0)
    libraryNextValue = NextFileDto(path = "Films/Wrong.mkv", title = "Wrong")
  }

  private fun mount(api: FakeTvApi, target: PlayTarget) {
    compose.setContent {
      PlayerScreen(api = api, target = target, onExit = {})
    }
    compose.waitForIdle()
  }

  private fun pressNext() {
    compose.onNodeWithTag(TAG_OSD_NEXT).requestFocus()
    compose.onNodeWithTag(TAG_OSD_NEXT).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
  }

  private fun close() {
    repeat(3) {
      compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
      compose.waitForIdle()
    }
  }

  @Test
  fun `shuffle uses its own next path and closes the run`() {
    val api = api().apply {
      shuffleNextValue = ShuffleNextDto(
        item = ShuffleItemDto(path = "Films/Next.mkv", title = "Next"),
        hasPrevious = true,
      )
    }
    mount(
      api,
      PlayTarget(
        key = Progress.libraryKey("Films/First.mkv"),
        title = "First",
        resume = false,
        path = "Films/First.mkv",
        shuffle = ShuffleRun("run1", "Next"),
      ),
    )
    compose.waitUntil(5_000) { compose.onAllNodesWithTag(TAG_OSD_NEXT).fetchSemanticsNodes().isNotEmpty() }
    assertTrue(api.libraryNextRequests.isEmpty())

    pressNext()
    compose.waitUntil(5_000) { api.startedSources.size == 2 }
    assertEquals(listOf("run1"), api.shuffleNextRequests)
    assertEquals("src:Films/Next.mkv", api.startedSources[1])
    assertEquals(0.0, api.startedTimes[1], 0.0)
    compose.onNodeWithTag(TAG_OSD_NEXT).assertDoesNotExist()

    compose.onNodeWithTag(TAG_OSD_SEEK_FORWARD).performSemanticsAction(SemanticsActions.OnClick) { it() }
    compose.waitUntil(5_000) { api.progressSaves.isNotEmpty() }
    close()
    compose.waitUntil(5_000) { api.deletedShuffleIds.isNotEmpty() }
    assertTrue(api.progressSaves.any { it.shuffle })
    assertEquals(listOf("run1"), api.deletedShuffleIds)
  }

  @Test
  fun `an exhausted shuffle removes the next offer`() {
    val api = api().apply {
      shuffleNextValue = ShuffleNextDto(item = null, exhausted = true)
    }
    mount(
      api,
      PlayTarget(
        key = Progress.libraryKey("Films/Last.mkv"),
        title = "Last",
        resume = false,
        path = "Films/Last.mkv",
        shuffle = ShuffleRun("run2", "Only once"),
      ),
    )
    compose.waitUntil(5_000) { compose.onAllNodesWithTag(TAG_OSD_NEXT).fetchSemanticsNodes().isNotEmpty() }
    pressNext()
    compose.waitUntil(5_000) { api.shuffleNextRequests.isNotEmpty() }
    compose.onNodeWithTag(TAG_OSD_NEXT).assertDoesNotExist()
  }

  @Test
  fun `a normal local play still uses library next`() {
    val api = api().apply {
      libraryNextValue = NextFileDto(path = "Films/Second.mkv", title = "Second")
    }
    mount(
      api,
      PlayTarget(
        key = Progress.libraryKey("Films/First.mkv"),
        title = "First",
        resume = false,
        path = "Films/First.mkv",
      ),
    )
    compose.waitUntil(5_000) { api.libraryNextRequests.isNotEmpty() }
    assertTrue(api.shuffleNextRequests.isEmpty())

    pressNext()
    compose.waitUntil(5_000) { api.startedSources.size == 2 }
    assertEquals("src:Films/Second.mkv", api.startedSources[1])
    compose.onNodeWithTag(TAG_OSD_SEEK_FORWARD).performSemanticsAction(SemanticsActions.OnClick) { it() }
    compose.waitUntil(5_000) { api.progressSaves.isNotEmpty() }
    assertFalse(api.progressSaves.any { it.shuffle })
  }
}
