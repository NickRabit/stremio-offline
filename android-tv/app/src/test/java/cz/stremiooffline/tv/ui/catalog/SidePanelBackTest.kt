@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.catalog

import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The catalogue's side panel closes on Back whichever way it arrives: the back dispatcher on
 * API 33+ and the key event the window still sends first. The rows' focus exit used to make the
 * focus system eat the key, so the panel stayed open.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class SidePanelBackTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private var closed = 0

  private fun mount() {
    compose.setContent {
      SidePanel(title = "Sources", onClose = { closed += 1 }, modifier = Modifier.testTag("panel")) {
        PanelOption(text = "Row", onClick = {}, modifier = Modifier.testTag("row"))
      }
    }
    compose.waitForIdle()
  }

  @Test
  fun `the back dispatcher closes the panel`() {
    mount()

    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()

    assertEquals(1, closed)
  }

  @Test
  fun `a real back key closes the panel`() {
    mount()

    compose.runOnUiThread {
      compose.activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK))
      compose.activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK))
    }
    compose.waitForIdle()

    assertEquals(1, closed)
  }
}
