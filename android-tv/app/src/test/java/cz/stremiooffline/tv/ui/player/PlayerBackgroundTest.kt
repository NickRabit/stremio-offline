package cz.stremiooffline.tv.ui.player

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A screensaver must not be treated as leaving, or the remote is dead until a new session opens. */
class PlayerBackgroundTest {

  @Test
  fun `a stop while the screen stays on and nobody left keeps the session`() {
    assertFalse(releasePlaybackOnStop(userLeaving = false, screenInteractive = true, dreaming = false))
  }

  @Test
  fun `home and the screen turning off release the session`() {
    assertTrue(releasePlaybackOnStop(userLeaving = true, screenInteractive = true, dreaming = false))
    assertTrue(releasePlaybackOnStop(userLeaving = false, screenInteractive = false, dreaming = false))
  }

  @Test
  fun `a dream keeps the session even when the platform also reports a leave`() {
    assertFalse(releasePlaybackOnStop(userLeaving = true, screenInteractive = true, dreaming = true))
  }

  @Test
  fun `the screen turning off releases the session even during a dream`() {
    assertTrue(releasePlaybackOnStop(userLeaving = false, screenInteractive = false, dreaming = true))
  }
}
