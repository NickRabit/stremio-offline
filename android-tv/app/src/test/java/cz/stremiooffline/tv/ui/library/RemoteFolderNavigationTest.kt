@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.library

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemsPageDto
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.ui.FakeTvApi
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
 * A folders-mode library walks one directory level per card: Folder -> Folder -> movie, and Back
 * twice lands on the card that opened each level. Folders are navigable only, never playable, so
 * they never reach the item detail or ask for sources.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class RemoteFolderNavigationTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>
  private var host: ComponentActivity? = null

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

  private fun folder(id: String, name: String) = RemoteItemDto(id = id, name = name, type = "folder")

  private fun movie(id: String, name: String) = RemoteItemDto(id = id, name = name, type = "movie")

  @Test
  fun `Folder to Folder to movie, then Back twice, restores each folder card`() {
    val api = FakeTvApi()
    api.remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibA", name = "Server", provider = "emby", type = "mixed"))
    api.remoteBrowsePages["rlibA||"] = RemoteItemsPageDto(items = listOf(folder("f1", "Shows")), total = 1)
    api.remoteBrowsePages["rlibA|f1|"] = RemoteItemsPageDto(items = listOf(folder("f2", "Season 1")), total = 1)
    api.remoteBrowsePages["rlibA|f2|"] = RemoteItemsPageDto(items = listOf(movie("m1", "Pilot")), total = 1)
    val opened = mutableListOf<RemoteItemDto>()
    scenario.onActivity { activity ->
      host = activity
      activity.setContent {
        RemoteLibraryRoute(
          api = api,
          segment = LibrarySegment.Servers,
          onOpenItem = { _, _, _, item -> opened += item },
        )
      }
    }
    compose.waitUntil(5_000) { api.remoteLibrariesCalls > 0 }
    compose.waitForIdle()
    compose.onNodeWithTag(remoteLibraryTag("rlibA")).assertIsFocused()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { api.remoteBrowseRequests.isNotEmpty() }
    compose.waitForIdle()

    // The root is folders mode: the folder card takes focus and the first request is lazy.
    val first = api.remoteBrowseRequests.single()
    assertEquals(RemoteLibraryViewModel.FOLDERS_MODE, first.mode)
    assertEquals(null, first.parentId)
    assertEquals(RemoteLibraryViewModel.BROWSE_LIMIT, first.limit)

    compose.onNodeWithTag(remoteItemTag("f1")).assertIsFocused()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { api.remoteBrowseRequests.any { it.parentId == "f1" } }
    compose.waitForIdle()
    compose.onNodeWithTag(remoteItemTag("f2")).assertIsFocused()

    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { api.remoteBrowseRequests.any { it.parentId == "f2" } }
    compose.waitForIdle()
    compose.onNodeWithTag(remoteItemTag("m1")).assertIsFocused()

    // Nothing was eager: three directory requests for three levels, no cursor followed on its own.
    assertEquals(3, api.remoteBrowseRequests.size)
    assertTrue(api.remoteBrowseRequests.all { it.cursor == null })
    // A folder is not playable, so it never opened a detail nor asked for sources.
    assertTrue(opened.isEmpty())
    assertTrue(api.remoteSourcesRequests.isEmpty())

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    compose.onNodeWithTag(remoteItemTag("f2")).assertIsFocused()

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    compose.onNodeWithTag(remoteItemTag("f1")).assertIsFocused()
  }

  @Test
  fun `loading a nested folder retains content focus until its page arrives`() {
    val api = FakeTvApi()
    api.remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibA", name = "Server", provider = "emby", type = "mixed"))
    api.remoteBrowsePages["rlibA||"] = RemoteItemsPageDto(items = listOf(folder("f1", "Folder")), total = 1)
    api.remoteBrowsePages["rlibA|f1|"] = RemoteItemsPageDto(items = listOf(movie("m1", "Movie")), total = 1)
    val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
    api.remoteBrowseGates["f1"] = gate
    scenario.onActivity { activity ->
      activity.setContent {
        RemoteLibraryRoute(api = api, segment = LibrarySegment.Servers, onOpenItem = { _, _, _, _ -> })
      }
    }
    compose.waitUntil(5_000) { api.remoteLibrariesCalls > 0 }
    compose.waitForIdle()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { api.remoteBrowseRequests.isNotEmpty() }
    compose.waitForIdle()
    compose.onNodeWithTag(remoteItemTag("f1")).assertIsFocused()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { api.remoteBrowseRequests.any { it.parentId == "f1" } }
    compose.waitForIdle()
    compose.onNodeWithTag("remote-loading").assertIsFocused()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    gate.complete(Unit)
    compose.waitForIdle()
    compose.onNodeWithTag(remoteItemTag("m1")).assertIsFocused()
    assertEquals(2, api.remoteBrowseRequests.size)
  }

  @Test
  fun `a library root that carries its own poster asks for no preview mosaic`() {
    val api = FakeTvApi()
    api.remoteLibrariesValue = listOf(
      RemoteLibraryDto(id = "rlibA", name = "Server", provider = "emby", type = "mixed", poster = "/own-root.jpg"),
    )
    scenario.onActivity { activity ->
      activity.setContent {
        RemoteLibraryRoute(api = api, segment = LibrarySegment.Servers, onOpenItem = { _, _, _, _ -> })
      }
    }
    compose.waitUntil(5_000) { api.remoteLibrariesCalls > 0 }
    compose.waitForIdle()
    compose.onNodeWithTag(remoteLibraryTag("rlibA")).assertIsFocused()

    // The own picture wins over any child collage, so nothing was asked of the preview route.
    assertTrue(api.remotePreviewRequests.isEmpty())
  }

  @Test
  fun `a season tile never asks for a preview mosaic`() {
    val api = FakeTvApi()
    api.remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibA", name = "Server", provider = "emby", type = "mixed"))
    api.remoteBrowsePages["rlibA||"] = RemoteItemsPageDto(
      items = listOf(RemoteItemDto(id = "sea1", name = "Season 1", type = "season")),
      total = 1,
    )
    scenario.onActivity { activity ->
      activity.setContent {
        RemoteLibraryRoute(api = api, segment = LibrarySegment.Servers, onOpenItem = { _, _, _, _ -> })
      }
    }
    compose.waitUntil(5_000) { api.remoteLibrariesCalls > 0 }
    compose.waitForIdle()
    compose.onNodeWithTag(remoteLibraryTag("rlibA")).assertIsFocused()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { api.remoteBrowseRequests.isNotEmpty() }
    compose.waitForIdle()
    compose.onNodeWithTag(remoteItemTag("sea1")).assertIsFocused()

    // The season's collage would be its episodes, which says nothing about it, so it never asked.
    assertTrue(api.remotePreviewRequests.none { it.second == "sea1" })
  }
}
