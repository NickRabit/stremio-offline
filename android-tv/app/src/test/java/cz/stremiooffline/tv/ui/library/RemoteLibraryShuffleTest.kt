@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.library

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.DownloadTargetSettingsDto
import cz.stremiooffline.tv.data.RemoteCapabilitiesDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemDetailDto
import cz.stremiooffline.tv.data.RemoteItemsPageDto
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.data.RemoteProviderIdsDto
import cz.stremiooffline.tv.data.ShuffleItemDto
import cz.stremiooffline.tv.data.ShuffleRemoteDto
import cz.stremiooffline.tv.data.ShuffleStartDto
import cz.stremiooffline.tv.data.ShuffleUpcomingDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.detail.PlayTarget
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class RemoteLibraryShuffleTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>

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

  private fun mount(api: FakeTvApi, onPlay: (PlayTarget) -> Unit) {
    scenario.onActivity { activity ->
      activity.setContent {
        RemoteLibraryRoute(
          api = api,
          segment = LibrarySegment.Servers,
          onOpenItem = { _, _, _, _ -> },
          onPlay = onPlay,
        )
      }
    }
  }

  private fun shuffleApi(itemId: String = "movie-1"): FakeTvApi = FakeTvApi().apply {
    remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibA", name = "Server", provider = "emby", type = "mixed"))
    remoteItemValues["rlibA:$itemId"] = RemoteItemDetailDto(
      item = RemoteItemDto(
        id = itemId,
        name = "Random",
        type = "movie",
        providerIds = RemoteProviderIdsDto(imdb = "tt42"),
        poster = "/poster/random.jpg",
      ),
    )
    shuffleStartValue = ShuffleStartDto(
      id = "run1",
      item = ShuffleItemDto(
        title = "Random",
        remote = ShuffleRemoteDto(libraryId = "rlibA", itemId = itemId),
      ),
      total = 2,
      hasNext = true,
      upcoming = ShuffleUpcomingDto("Next"),
    )
    remoteSourcesValue = listOf(
      StreamDto(
        sourceId = "remote-source",
        kind = "remote",
        playable = true,
        remoteItem = RemoteItemContext(
          libraryId = "rlibA",
          itemId = itemId,
          mediaSourceId = "version-1",
          progressKey = "remote:$itemId",
        ),
        stableKey = "stable-$itemId",
        capabilities = RemoteCapabilitiesDto(downloadToLibrary = true),
        downloadTarget = DownloadTargetSettingsDto(libraryId = "lib-target", layout = "structured"),
      ),
    )
  }

  private fun startFromPanel() {
    compose.onNodeWithTag(TagLibraryShufflePanel).assertExists()
    compose.onNodeWithTag(TagLibraryShuffleAction).requestFocus()
    compose.onNodeWithTag(TagLibraryShuffleAction).performKeyInput { pressKey(Key.DirectionCenter) }
  }

  @Test
  fun `Menu on a remote library starts that library from the beginning`() {
    val api = shuffleApi()
    val played = mutableListOf<PlayTarget>()
    mount(api) { played += it }
    compose.waitUntil(5_000) { api.remoteLibrariesCalls > 0 }
    compose.waitForIdle()

    compose.onNodeWithTag(remoteLibraryTag("rlibA")).performKeyInput { pressKey(Key.Menu) }
    startFromPanel()

    compose.waitUntil(5_000) { played.isNotEmpty() }
    assertEquals(listOf("rlibA" to null), api.remoteShuffleStarts)
    assertEquals(listOf("rlibA" to "movie-1"), api.remoteSourcesRequests)
    assertEquals("remote-source", played.single().sourceId)
    assertEquals(false, played.single().resume)
    assertEquals("movie:tt42", played.single().key)
    assertEquals("Random", played.single().title)
    assertEquals("/poster/random.jpg", played.single().poster)
    assertEquals("movie", played.single().subtitleType)
    assertEquals("tt42", played.single().subtitleTarget)
    assertEquals("stable-movie-1", played.single().stableKey)
    assertEquals("remote-source", played.single().remoteSources.single().sourceId)
    assertEquals("lib-target", played.single().remoteSources.single().downloadTarget?.libraryId)
    assertEquals("Next", played.single().shuffle?.upcomingTitle)
  }

  @Test
  fun `Menu on a remote folder starts that folder`() {
    val api = shuffleApi()
    api.remoteBrowsePages["rlibA||"] = RemoteItemsPageDto(
      items = listOf(RemoteItemDto(id = "folder-1", name = "Folder", type = "folder")),
      total = 1,
    )
    val played = mutableListOf<PlayTarget>()
    mount(api) { played += it }
    compose.waitUntil(5_000) { api.remoteLibrariesCalls > 0 }
    compose.waitForIdle()
    compose.onNodeWithTag(remoteLibraryTag("rlibA")).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { api.remoteBrowseRequests.isNotEmpty() }
    compose.waitForIdle()

    compose.onNodeWithTag(remoteItemTag("folder-1")).performKeyInput { pressKey(Key.Menu) }
    startFromPanel()

    compose.waitUntil(5_000) { played.isNotEmpty() }
    assertEquals(listOf("rlibA" to "folder-1"), api.remoteShuffleStarts)
  }

  @Test
  fun `long OK on a remote folder opens Play random`() {
    val api = shuffleApi()
    api.remoteBrowsePages["rlibA||"] = RemoteItemsPageDto(
      items = listOf(RemoteItemDto(id = "folder-1", name = "Folder", type = "folder")),
      total = 1,
    )
    val played = mutableListOf<PlayTarget>()
    mount(api) { played += it }
    compose.waitUntil(5_000) { api.remoteLibrariesCalls > 0 }
    compose.waitForIdle()
    compose.onNodeWithTag(remoteLibraryTag("rlibA")).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { api.remoteBrowseRequests.isNotEmpty() }
    compose.waitForIdle()

    compose.onNodeWithTag(remoteItemTag("folder-1"))
      .performSemanticsAction(SemanticsActions.OnLongClick) { it() }
    startFromPanel()

    compose.waitUntil(5_000) { played.isNotEmpty() }
    assertEquals(listOf("rlibA" to "folder-1"), api.remoteShuffleStarts)
    assertEquals(false, played.single().resume)
  }
}
