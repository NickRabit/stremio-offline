@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerNextCardTest {

  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

  private var plays = 0
  private var dismissals = 0

  private fun mount(title: String = "It · S1 · E2") {
    compose.setContent {
      Box(Modifier.fillMaxSize().background(Color.Black)) {
        NextEpisodeOffer(
          title = title,
          onPlay = { plays += 1 },
          onDismiss = { dismissals += 1 },
          focus = remember { FocusRequester() },
        )
      }
    }
  }

  @Test
  fun `the card names the next episode and counts down`() {
    mount()

    compose.onNodeWithTag(TagNextCard).assertExists()
    compose.onNodeWithText("It · S1 · E2").assertExists()
    compose.onNodeWithText("Starts in 5s").assertExists()

    compose.mainClock.advanceTimeBy(2_100)
    compose.waitForIdle()
    compose.onNodeWithText("Starts in 3s").assertExists()
  }

  @Test
  fun `OK starts the next episode at once`() {
    mount()

    compose.onNodeWithTag(TagNextCard).performKeyInput { pressKey(Key.DirectionCenter) }
    compose.waitForIdle()

    assertEquals(1, plays)
  }

  @Test
  fun `the countdown hands the next episode over at zero`() {
    mount()

    compose.mainClock.advanceTimeBy(NEXT_EPISODE_COUNTDOWN_S * 1_000L + 200)
    compose.waitForIdle()

    assertEquals(1, plays)
  }

  @Test
  fun `Back dismisses the offer`() {
    mount()

    compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
    compose.waitForIdle()

    assertEquals(1, dismissals)
    assertEquals(0, plays)
  }

  @Test
  fun `a real back key dismisses the offer`() {
    mount()

    compose.runOnUiThread {
      compose.activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK))
      compose.activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK))
    }
    compose.waitForIdle()

    assertEquals(1, dismissals)
    assertEquals(0, plays)
  }
}
