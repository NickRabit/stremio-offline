@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.shell

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

/** The whole shell, not the scaffold alone: picking a section on the rail has to switch content. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class ShellNavigationTest {

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

  // Bug: the rail called NavController.navigate on a controller with no graph, so choosing any
  // section from the rail crashed the app.
  @Test
  fun `choosing library on the rail opens the library`() {
    val api = FakeTvApi()
    api.pages[null] = BrowseResult("", listOf(BrowseItem.Folder(path = "Films", name = "Films", fileCount = 1)), 1, false)
    scenario.onActivity { activity ->
      activity.setContent { Shell(start = Section.Catalog, api = api, username = "demo", onSignOut = {}) }
    }
    compose.waitForIdle()

    compose.onRoot().performKeyInput { pressKey(Key.DirectionLeft) }
    compose.waitForIdle()
    compose.onNodeWithTag(railTag(Section.Catalog)).assertIsFocused()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionDown) }
    compose.waitForIdle()
    compose.onNodeWithTag(railTag(Section.Library)).assertIsFocused()
    compose.onRoot().performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    compose.onNodeWithTag("Films").assertIsFocused()
  }
}
