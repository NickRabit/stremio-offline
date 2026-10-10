@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package cz.stremiooffline.tv.ui.player

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.key
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.media3.exoplayer.ExoPlayer
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Bug 2: `PlayerScreen` wrapped the overlay in a preview handler that turned `Key.Back` into an
 * exit. Compose runs the outer preview handler first, so on API < 33, where the remote's Back
 * arrives as a key event, the first Back left the player instead of hiding the controls. The
 * player's own overlay has to own Back.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerOverlayKeyTest {

  @get:Rule val compose = createComposeRule()

  @Test
  fun `the player's preview handler no longer turns back into an exit`() {
    val player = ExoPlayer.Builder(ApplicationProvider.getApplicationContext()).build()
    try {
      val back = android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_BACK)
      val key = KeyEvent(back).key
      assertTrue("a raw Back key maps to Key.Back", key == Key.Back)

      var exits = 0
      // Before the fix this arm returned true and called onExit, so the outer preview handler ate
      // Back. Null hands the key to the overlay, whose own rule hides the controls first.
      val answer = mediaKey(key, player, playing = false, onExit = { exits++ })
      assertFalse(answer ?: false)
      assertTrue(exits == 0)
    } finally {
      player.release()
    }
  }
}
