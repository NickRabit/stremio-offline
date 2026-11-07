package cz.stremiooffline.tv.ui.player

import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.test.core.app.ApplicationProvider
import java.util.TimeZone
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The time of day sits in the OSD's top-right corner while the controls are up. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerClockTest {

  @get:Rule val compose = createComposeRule()

  private val zone = TimeZone.getDefault()
  /** 2026-11-07 21:07:30 UTC. */
  private val evening = 1_794_085_650_000L

  @Before
  fun setUp() {
    TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
    Settings.System.putString(ApplicationProvider.getApplicationContext<android.content.Context>().contentResolver, Settings.System.TIME_12_24, "24")
  }

  @After
  fun tearDown() {
    TimeZone.setDefault(zone)
  }

  private fun mount(initiallyShown: Boolean) {
    compose.setContent {
      CompositionLocalProvider(LocalWallClock provides { evening }) {
        val playFocus = remember { FocusRequester() }
        PlayerOverlayShell(
          position = 100.0,
          duration = 1_000.0,
          playing = false,
          title = "It",
          eyebrow = "Direct play",
          playFocus = playFocus,
          initiallyShown = initiallyShown,
          onSeek = {},
          onTogglePause = {},
          onExit = {},
        ) {
          Box(Modifier.fillMaxSize().background(Color.Black))
        }
      }
    }
  }

  @Test
  fun `the paused OSD shows the time of day in the TV's 24-hour format`() {
    mount(initiallyShown = true)
    compose.onNodeWithTag(TAG_OSD_CLOCK).assertIsDisplayed().assertTextEquals("21:07")
    // Top right: past the middle of the screen, above the title row's lower edge.
    val clock = compose.onNodeWithTag(TAG_OSD_CLOCK).fetchSemanticsNode().boundsInRoot
    val root = compose.onRoot().fetchSemanticsNode().size
    assert(clock.left > root.width / 2f) { "clock at x=${clock.left} of ${root.width}" }
    assert(clock.top < root.height / 4f) { "clock at y=${clock.top} of ${root.height}" }
  }

  @Test
  fun `no clock while the controls are hidden`() {
    mount(initiallyShown = false)
    compose.onNodeWithTag(TAG_OSD_CLOCK).assertDoesNotExist()
  }
}
