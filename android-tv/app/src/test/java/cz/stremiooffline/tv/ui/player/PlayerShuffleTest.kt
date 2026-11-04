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
import cz.stremiooffline.tv.data.DownloadTargetSettingsDto
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.data.NextFileDto
import cz.stremiooffline.tv.data.PlaybackDescriptorDto
import cz.stremiooffline.tv.data.RemoteCapabilitiesDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemDetailDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteProviderIdsDto
import cz.stremiooffline.tv.data.ShuffleItemDto
import cz.stremiooffline.tv.data.ShuffleNextDto
import cz.stremiooffline.tv.data.ShuffleRemoteDto
import cz.stremiooffline.tv.data.StreamSourceDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.catalog.TagSourcesPanel
import cz.stremiooffline.tv.ui.catalog.sourceRowTag
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

  private fun mount(api: FakeTvApi, target: PlayTarget, sources: List<StreamDto> = emptyList()) {
    compose.setContent {
      PlayerScreen(api = api, target = target, sources = sources, onExit = {})
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
  fun `remote shuffle plays the next item from its own sources without a shuffle progress flag`() {
    val api = api().apply {
      shuffleNextValue = ShuffleNextDto(
        item = ShuffleItemDto(
          title = "Next",
          remote = ShuffleRemoteDto(libraryId = "rlibA", itemId = "m2"),
        ),
      )
      remoteItemValues["rlibA:m2"] = RemoteItemDetailDto(
        item = RemoteItemDto(
          id = "m2",
          name = "Next",
          type = "movie",
          providerIds = RemoteProviderIdsDto(imdb = "tt22"),
          poster = "/poster/next.jpg",
        ),
      )
      remoteSourcesValue = listOf(
        StreamDto(
          sourceId = "src:m2",
          kind = "remote",
          playable = true,
          remoteItem = RemoteItemContext(
            libraryId = "rlibA",
            itemId = "m2",
            mediaSourceId = "version-2",
            progressKey = "remote:m2",
          ),
          stableKey = "stable-m2",
          capabilities = RemoteCapabilitiesDto(downloadToLibrary = true),
          downloadTarget = DownloadTargetSettingsDto(libraryId = "lib-target", layout = "structured"),
        ),
      )
    }
    mount(
      api,
      PlayTarget(
        key = "remote:m1",
        title = "First",
        resume = false,
        sourceId = "src:m1",
        remoteItem = RemoteItemContext(
          libraryId = "rlibA",
          itemId = "m1",
          mediaSourceId = "version-1",
          progressKey = "remote:m1",
        ),
        subtitleType = "movie",
        subtitleTarget = "tt11",
        shuffle = ShuffleRun("run3", "Next"),
      ),
    )
    compose.waitUntil(5_000) { compose.onAllNodesWithTag(TAG_OSD_NEXT).fetchSemanticsNodes().isNotEmpty() }
    assertTrue(api.libraryNextRequests.isEmpty())

    pressNext()
    compose.waitUntil(5_000) { api.startedSources.size == 2 }
    assertEquals(listOf("run3"), api.shuffleNextRequests)
    assertEquals(listOf("rlibA" to "m2"), api.remoteSourcesRequests)
    assertEquals("src:m2", api.startedSources[1])
    assertEquals(0.0, api.startedTimes[1], 0.0)
    compose.waitUntil(5_000) { api.remoteItemRequests.contains("rlibA" to "m2") }
    compose.waitUntil(5_000) { api.subtitlesRequests.contains("movie" to "tt22") }
    compose.onNodeWithTag(TAG_OSD_SOURCES).requestFocus()
    compose.onNodeWithTag(TAG_OSD_SOURCES).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
    compose.onNodeWithTag(sourceRowTag(0)).assertExists()
    compose.onNodeWithTag(sourceRowTag(0)).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.onNodeWithTag(TagSourcesPanel).assertDoesNotExist()

    compose.onNodeWithTag(TAG_OSD_SEEK_FORWARD).performSemanticsAction(SemanticsActions.OnClick) { it() }
    compose.waitUntil(5_000) { api.progressSaves.any { it.key == "movie:tt22" } }
    close()
    compose.waitUntil(5_000) { api.deletedShuffleIds.isNotEmpty() }
    assertFalse(api.progressSaves.any { it.shuffle })
  }

  @Test
  fun `local shuffle next carries the next file's binding into its player sources`() {
    val api = api().apply {
      shuffleNextValue = ShuffleNextDto(
        item = ShuffleItemDto(path = "Films/Next.mkv", title = "Next"),
        hasPrevious = true,
      )
      libraryTitleValues["Films/Next.mkv"] = LibraryTitleDto("movie", "tt9", name = "Next")
      streamSourcesValues["movie:tt9"] = listOf(StreamSourceDto("alpha", "Alpha"))
    }
    mount(
      api,
      PlayTarget(
        key = Progress.libraryKey("Films/First.mkv"),
        title = "First",
        resume = false,
        path = "Films/First.mkv",
        subtitleType = "movie",
        subtitleTarget = "tt1",
        shuffle = ShuffleRun("run-local", "Next"),
      ),
    )
    compose.waitUntil(5_000) { compose.onAllNodesWithTag(TAG_OSD_NEXT).fetchSemanticsNodes().isNotEmpty() }

    pressNext()
    compose.waitUntil(5_000) { api.startedSources.size == 2 }
    assertEquals("src:Films/Next.mkv", api.startedSources[1])
    assertEquals(0.0, api.startedTimes[1], 0.0)
    compose.waitUntil(5_000) { api.libraryTitleRequests.contains("Films/Next.mkv") }
    compose.onNodeWithTag(TAG_OSD_SOURCES).requestFocus()
    compose.onNodeWithTag(TAG_OSD_SOURCES).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.onNodeWithTag(TagSourcesPanel).assertExists()
    compose.onNodeWithTag(sourceRowTag(0)).assertExists()
  }

  @Test
  fun `a source switch keeps shuffle progress and next on the same run`() {
    val api = api().apply {
      shuffleNextValue = ShuffleNextDto(
        item = ShuffleItemDto(path = "Films/Next.mkv", title = "Next"),
        hasPrevious = true,
      )
    }
    val libraryRow = StreamDto(
      sourceId = "src:Films/First.mkv",
      kind = "library",
      playable = true,
      localPath = "Films/First.mkv",
    )
    val addonRow = StreamDto(
      sourceId = "addon-switch",
      kind = "remote",
      playable = true,
      name = "Switch source",
      addonKey = "alpha",
    )
    mount(
      api,
      PlayTarget(
        key = Progress.libraryKey("Films/First.mkv"),
        title = "First",
        resume = false,
        path = "Films/First.mkv",
        shuffle = ShuffleRun("run-switch", "Next"),
      ),
      listOf(libraryRow, addonRow),
    )
    compose.waitUntil(5_000) { compose.onAllNodesWithTag(TAG_OSD_NEXT).fetchSemanticsNodes().isNotEmpty() }

    compose.onNodeWithTag(TAG_OSD_SOURCES).requestFocus()
    compose.onNodeWithTag(TAG_OSD_SOURCES).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.onNodeWithTag(sourceRowTag(1)).requestFocus()
    compose.onNodeWithTag(sourceRowTag(1)).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { api.startedSources.size == 2 }
    assertEquals("addon-switch", api.startedSources[1])
    compose.onNodeWithTag(TAG_OSD_NEXT).assertExists()

    val savesBeforeSwitch = api.progressSaves.size
    compose.onNodeWithTag(TAG_OSD_SEEK_FORWARD).performSemanticsAction(SemanticsActions.OnClick) { it() }
    compose.waitUntil(5_000) { api.progressSaves.drop(savesBeforeSwitch).any { it.shuffle } }
    pressNext()
    compose.waitUntil(5_000) { api.shuffleNextRequests.isNotEmpty() }
    assertEquals(listOf("run-switch"), api.shuffleNextRequests)
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
