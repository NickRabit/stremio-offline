package cz.stremiooffline.tv.ui.player

import android.view.View
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The set must not fall asleep under a film: the screensaver came up after ten minutes. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class KeepScreenOnTest {

  @get:Rule val compose = createComposeRule()

  @Test
  fun `the screen is kept on while enabled and released when it is turned off or the player leaves`() {
    var enabled by mutableStateOf(true)
    var shown by mutableStateOf(true)
    var seen: View? = null
    compose.setContent {
      seen = LocalView.current
      if (shown) KeepScreenOn(enabled)
    }
    compose.waitForIdle()
    assertTrue(seen!!.keepScreenOn)

    enabled = false
    compose.waitForIdle()
    assertFalse(seen!!.keepScreenOn)

    enabled = true
    compose.waitForIdle()
    assertTrue(seen!!.keepScreenOn)

    shown = false
    compose.waitForIdle()
    assertFalse(seen!!.keepScreenOn)
  }
}
