@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.library

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemsPageDto
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Servers half stands down while a detail or the player covers it, so a hidden Back never pops
 *  the stack the viewer cannot see. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class RemoteLibraryBackTest {

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

  @Test
  fun `a disabled Back leaves the remote library stack alone`() {
    val api = FakeTvApi()
    api.remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibA", name = "Filmy", provider = "jellyfin"))
    val enabled = mutableStateOf(false)
    var fallbacks = 0
    var backsToFiles = 0
    scenario.onActivity { activity ->
      host = activity
      activity.setContent {
        // Registered first, so it is the lower-priority stand-in for the shell's own Back: with the
        // library Back disabled it is what answers, which makes the disabled handler visible.
        BackHandler { fallbacks++ }
        RemoteLibraryRoute(
          api = api,
          segment = LibrarySegment.Servers,
          onOpenItem = { _, _, _, _ -> },
          onBackToFiles = { backsToFiles++ },
          backEnabled = enabled.value,
        )
      }
    }
    compose.waitForIdle()

    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    assertEquals(0, backsToFiles)
    assertEquals(1, fallbacks)

    enabled.value = true
    compose.waitForIdle()
    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    assertEquals(1, backsToFiles)
    assertEquals(1, fallbacks)
  }

  @Test
  fun `opening a library focuses its own cards and Back restores the picker`() {
    val api = FakeTvApi()
    api.remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibA", name = "Movies", provider = "jellyfin"))
    api.remoteItemsPages["rlibA|"] = RemoteItemsPageDto(
      items = listOf(RemoteItemDto(id = "movie1", name = "Movie", type = "movie")),
      total = 1,
    )
    scenario.onActivity { activity ->
      host = activity
      activity.setContent {
        RemoteLibraryRoute(api = api, segment = LibrarySegment.Servers, onOpenItem = { _, _, _, _ -> })
      }
    }
    compose.waitUntil(5_000) { api.remoteLibrariesCalls > 0 }
    compose.waitForIdle()
    compose.onNodeWithTag(remoteLibraryTag("rlibA")).assertIsFocused()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitUntil(5_000) { api.remoteItemsRequests.isNotEmpty() }
    compose.waitForIdle()
    compose.onNodeWithTag(remoteItemTag("movie1")).assertIsFocused()
    api.remoteItemsPages["rlibA|"] = RemoteItemsPageDto(
      items = listOf(RemoteItemDto(id = "movie2", name = "Another movie", type = "movie")),
      total = 1,
    )
    compose.onNodeWithTag(TagLibraryTypeFilter).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()
    compose.waitUntil(5_000) { api.remoteItemsRequests.size >= 2 }
    compose.waitForIdle()
    compose.onNodeWithTag(remoteItemTag("movie1")).assertDoesNotExist()
    compose.onNodeWithTag(remoteItemTag("movie2")).assertIsFocused()
    host!!.onBackPressedDispatcher.onBackPressed()
    compose.waitForIdle()
    compose.onNodeWithTag(remoteLibraryTag("rlibA")).assertIsFocused()
  }

}
