@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.detail

import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The shared bar draws one stored position the same way for the local and the remote detail. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class SavedPlaybackProgressComponentTest {

  @get:Rule val compose = createComposeRule()

  private fun mount(position: Double, duration: Double) {
    compose.setContent {
      SavedPlaybackProgress(position = position, duration = duration, tag = "saved_progress")
    }
  }

  @Test
  fun `a known duration draws the localized percentage`() {
    mount(50.0, 100.0)
    compose.onNodeWithTag("saved_progress").assertTextContains("50 % watched")
  }

  @Test
  fun `an early position still draws the bar`() {
    mount(10.0, 600.0)
    compose.onNodeWithTag("saved_progress").assertTextContains("1 % watched")
  }

  @Test
  fun `a completed position draws the full bar`() {
    mount(600.0, 600.0)
    compose.onNodeWithTag("saved_progress").assertTextContains("100 % watched")
  }

  @Test
  fun `an unknown duration draws the elapsed position`() {
    mount(125.0, 0.0)
    compose.onNodeWithTag("saved_progress").assertTextContains("02:05")
  }

  @Test
  fun `a negative position draws nothing`() {
    mount(-1.0, 100.0)
    compose.onNodeWithTag("saved_progress").assertDoesNotExist()
  }

  @Test
  fun `a non-finite position draws nothing`() {
    mount(Double.NaN, 100.0)
    compose.onNodeWithTag("saved_progress").assertDoesNotExist()
  }
}
