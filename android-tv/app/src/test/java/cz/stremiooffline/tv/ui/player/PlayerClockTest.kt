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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
  fun `the OSD shows the finish time under the clock`() {
    mount(initiallyShown = true)
    compose.onNodeWithTag(TAG_OSD_ENDS_AT).assertTextEquals("Ends at 21:22")

    val clock = compose.onNodeWithTag(TAG_OSD_CLOCK).fetchSemanticsNode().boundsInRoot
    val endsAt = compose.onNodeWithTag(TAG_OSD_ENDS_AT).fetchSemanticsNode().boundsInRoot
    val root = compose.onRoot().fetchSemanticsNode().size
    assert(endsAt.top >= clock.bottom) { "ends at y=${endsAt.top}, clock ends at y=${clock.bottom}" }
    assert(endsAt.left > root.width / 2f) { "ends at x=${endsAt.left} of ${root.width}" }
  }

  @Test
  fun `the finish time holds still while playback moves within a minute`() {
    var wall = evening
    val position = androidx.compose.runtime.mutableDoubleStateOf(100.0)
    compose.setContent {
      CompositionLocalProvider(LocalWallClock provides { wall }) {
        PlayerEndsAt(position = position.doubleValue, duration = 1_000.0)
      }
    }
    compose.onNodeWithTag(TAG_OSD_ENDS_AT).assertTextEquals("Ends at 21:22")
    // 50 s later the film is 50 s further on: the end has not moved.
    wall = evening + 50_000
    position.doubleValue = 150.0
    compose.onNodeWithTag(TAG_OSD_ENDS_AT).assertTextEquals("Ends at 21:22")
  }

  @Test
  fun `no clock while the controls are hidden`() {
    mount(initiallyShown = false)
    compose.onNodeWithTag(TAG_OSD_CLOCK).assertDoesNotExist()
    compose.onNodeWithTag(TAG_OSD_ENDS_AT).assertDoesNotExist()
  }

  @Test
  fun `the finish time adds the remaining duration`() {
    assertEquals(11_000L, endsAt(1_000L, 10.0, 20.0))
  }

  @Test
  fun `the finish time is absent at or past the end`() {
    assertNull(endsAt(1_000L, 20.0, 20.0))
    assertNull(endsAt(1_000L, 21.0, 20.0))
    assertNull(endsAt(1_000L, Double.NaN, 20.0))
  }

  @Test
  fun `the finish time is absent for an unknown duration`() {
    assertNull(endsAt(1_000L, 10.0, 0.0))
    assertNull(endsAt(1_000L, 10.0, Double.NaN))
    assertNull(endsAt(1_000L, 10.0, Double.POSITIVE_INFINITY))
  }

  @Test
  fun `the finish time clamps a negative position to the start`() {
    assertEquals(21_000L, endsAt(1_000L, -5.0, 20.0))
  }
}
