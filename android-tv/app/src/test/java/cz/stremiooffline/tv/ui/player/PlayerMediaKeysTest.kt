package cz.stremiooffline.tv.ui.player

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.KeyEvent as ComposeKeyEvent
import androidx.media3.exoplayer.ExoPlayer
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The remote's own media keys. They are handled outside the OSD's key map on purpose: a play/pause
 * press has to work whether the controls are up or hidden, and it must reach the player rather than
 * move the ring.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w960dp-h540dp-xhdpi")
class PlayerMediaKeysTest {

  private fun keyOf(keyCode: Int): Key =
    ComposeKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, keyCode)).key

  private fun player(): ExoPlayer = ExoPlayer.Builder(ApplicationProvider.getApplicationContext()).build()

  @Test
  fun `a real media play-pause key toggles playback with the OSD hidden or shown`() {
    val player = player()
    try {
      val key = keyOf(android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)
      assertEquals(Key.MediaPlayPause, key)

      // The controls are up and the film is playing: the press pauses and is consumed.
      assertTrue(mediaKey(key, player, playing = true) {} ?: false)
      assertFalse(player.playWhenReady)

      // The controls are hidden and the film is paused: the same press starts it again.
      assertTrue(mediaKey(key, player, playing = false) {} ?: false)
      assertTrue(player.playWhenReady)
    } finally {
      player.release()
    }
  }

  @Test
  fun `the dedicated media play and pause keys mean what they say`() {
    val player = player()
    try {
      assertTrue(mediaKey(keyOf(android.view.KeyEvent.KEYCODE_MEDIA_PAUSE), player, playing = true) {} ?: false)
      assertFalse(player.playWhenReady)
      assertTrue(mediaKey(keyOf(android.view.KeyEvent.KEYCODE_MEDIA_PLAY), player, playing = false) {} ?: false)
      assertTrue(player.playWhenReady)
    } finally {
      player.release()
    }
  }

  @Test
  fun `the pad keys are none of the media key handler's business`() {
    val player = player()
    try {
      assertNull(mediaKey(Key.DirectionCenter, player, playing = false) {})
      assertNull(mediaKey(Key.Back, player, playing = false) {})
    } finally {
      player.release()
    }
  }
}
