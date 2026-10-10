package cz.stremiooffline.tv.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProgressTest {

  @Test
  fun `the key is the web's file key`() {
    assertEquals("file:Films/It.mkv", Progress.libraryKey("Films/It.mkv"))
  }

  @Test
  fun `a position under thirty seconds is not resumed`() {
    assertNull(Progress.resumePosition(29.9, 1_000.0))
    assertEquals(30.0, Progress.resumePosition(30.0, 1_000.0)!!, 0.0)
  }

  @Test
  fun `above ninety-four per cent counts as completed`() {
    assertTrue(Progress.isCompleted(950.0, 1_000.0))
    assertFalse(Progress.isCompleted(940.0, 1_000.0))
    assertNull(Progress.resumePosition(950.0, 1_000.0))
  }

  @Test
  fun `an unknown duration is never completed`() {
    assertFalse(Progress.isCompleted(500.0, 0.0))
    assertEquals(500.0, Progress.resumePosition(500.0, 0.0)!!, 0.0)
  }
}
