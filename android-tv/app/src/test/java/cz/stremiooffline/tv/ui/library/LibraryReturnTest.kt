@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.library

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.ui.FakeTvApi
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Bug 4: swapping the section content without a state holder dropped the grid's focused card, and
 * re-entering the sheet never asked the server again. The shell wraps each section in a
 * `SaveableStateProvider` and bumps a refresh token on re-entry; the toggle drives the same swap
 * the rail's picker performs.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class LibraryReturnTest {

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

  private fun folders(names: List<String>) =
    names.map { name -> BrowseItem.Folder(path = "Films/$name", name = name, fileCount = 1) }

  @Test
  fun `returning to the library keeps focus and shows the refreshed rows`() {
    val first = listOf("A", "B", "C", "D", "E", "F")
    val grown = first + listOf("G", "H")
    var browseCount = 0
    val api = object : FakeTvApi() {
      override suspend fun browse(path: String?, limit: Int, skip: Int): BrowseResult {
        browseCalls += path to skip
        val all = if (browseCount++ == 0) first else grown
        return BrowseResult(path.orEmpty(), folders(all).drop(skip).take(limit), all.size, pending = false)
      }
    }
    var library by mutableStateOf(true)
    var refresh by mutableIntStateOf(0)
    scenario.onActivity { activity ->
      activity.setContent {
        val sections = rememberSaveableStateHolder()
        sections.SaveableStateProvider(if (library) "library" else "other") {
          if (library) {
            LibraryRoute(api = api, onOpenDetail = {}, refreshToken = refresh)
          } else {
            Box(Modifier.fillMaxSize())
          }
        }
      }
    }
    compose.waitForIdle()

    // Focus the fifth card, one row two slots in.
    compose.onNodeWithTag("Films/A").assertIsFocused()
    for ((from, to) in listOf("A" to "B", "B" to "C", "C" to "D", "D" to "E")) {
      compose.onNodeWithTag("Films/$from").performKeyInput { pressKey(Key.DirectionRight) }
      compose.waitForIdle()
      compose.onNodeWithTag("Films/$to").assertIsFocused()
    }

    // Leave the section...
    library = false
    compose.waitForIdle()
    compose.onNodeWithTag("Films/E").assertDoesNotExist()

    // ...and come back: the fifth card is focused again and the sheet asks the server again.
    library = true
    refresh++
    compose.waitForIdle()

    compose.waitUntil("the refreshed rows load") {
      compose.onAllNodes(hasTestTag("Films/H")).fetchSemanticsNodes().isNotEmpty()
    }
    compose.waitUntil("focus returns to the fifth card") {
      compose.onAllNodes(hasTestTag("Films/E") and isFocused()).fetchSemanticsNodes().isNotEmpty()
    }
  }
}
