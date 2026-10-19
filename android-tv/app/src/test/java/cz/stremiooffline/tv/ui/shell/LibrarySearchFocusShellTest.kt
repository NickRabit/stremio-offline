@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

import android.content.ComponentName
import android.content.Intent
import android.content.IntentFilter
import android.speech.RecognizerIntent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
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
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemsPageDto
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.ui.FakeTvApi
import cz.stremiooffline.tv.ui.library.TagLibrarySearchAction
import cz.stremiooffline.tv.ui.library.remoteItemTag
import cz.stremiooffline.tv.ui.library.remoteLibraryTag
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The library toolbar's search action is reachable with the remote alone, inside the real shell. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class LibrarySearchFocusShellTest {

  @get:Rule val compose = createEmptyComposeRule()

  private lateinit var scenario: ActivityScenario<ComponentActivity>

  @Before
  fun launchHost() {
    // A recognizer on the device: the library toolbar still draws no mic of its own, since voice
    // belongs to the search page the action opens.
    val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    val recognizer = ComponentName("com.example.voice", "com.example.voice.Recognize")
    shadowOf(context.packageManager).apply {
      addActivityIfNotPresent(recognizer)
      addIntentFilterForActivity(recognizer, IntentFilter(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply { addCategory(Intent.CATEGORY_DEFAULT) })
    }
    scenario = ActivityScenario.launch(
      Intent(context, ComponentActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
  }

  @After
  fun closeHost() {
    scenario.close()
  }

  private fun api() = FakeTvApi().apply {
    remoteLibrariesValue = listOf(RemoteLibraryDto(id = "rlibA", name = "Server", provider = "emby", type = "mixed"))
    remoteBrowsePages["rlibA||"] = RemoteItemsPageDto(
      items = listOf(
        RemoteItemDto(id = "m1", name = "First", type = "movie"),
        RemoteItemDto(id = "m2", name = "Second", type = "movie"),
      ),
      total = 2,
    )
  }

  private fun press(key: Key) {
    compose.onRoot().performKeyInput { pressKey(key) }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()
  }

  private fun focusedTag(): String? =
    compose.onAllNodes(isFocused()).fetchSemanticsNodes()
      .map { it.config.getOrElse(SemanticsProperties.TestTag) { "" } }
      .firstOrNull { it.isNotEmpty() }

  /** The shell on the Library section, inside one remote library, with its first tile focused. */
  private fun openLibrary(api: FakeTvApi) {
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = Section.Library, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()
    compose.onNodeWithText("Media servers").performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.remoteLibrariesCalls > 0 }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()
    compose.onNodeWithTag(remoteLibraryTag("rlibA")).performSemanticsAction(SemanticsActions.RequestFocus)
    press(Key.DirectionCenter)
    compose.waitUntil(5_000) { api.remoteBrowseRequests.isNotEmpty() }
    compose.waitForIdle()
    compose.mainClock.advanceTimeBy(200)
    compose.waitForIdle()
    compose.onNodeWithTag("library_search_voice").assertDoesNotExist()
    compose.onNodeWithTag(remoteItemTag("m1")).performSemanticsAction(SemanticsActions.RequestFocus)
    compose.waitForIdle()
    assertEquals(remoteItemTag("m1"), focusedTag())
  }

  @Test
  fun `up from the first tile lands on the search action`() {
    openLibrary(api())
    press(Key.DirectionUp)
    assertEquals(TagLibrarySearchAction, focusedTag())
  }

  @Test
  fun `left from the search action reaches the rail`() {
    openLibrary(api())
    press(Key.DirectionUp)
    assertEquals(TagLibrarySearchAction, focusedTag())
    press(Key.DirectionLeft)
    assertEquals(railTag(Section.Library), focusedTag())
  }
}
