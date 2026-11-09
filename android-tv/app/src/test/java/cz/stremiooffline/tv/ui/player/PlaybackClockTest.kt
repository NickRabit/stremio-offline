package cz.stremiooffline.tv.ui.player

import org.junit.Assert.assertEquals
import org.junit.Test

class PlaybackClockTest {

  @Test
  fun `under an hour is minutes and seconds`() {
    assertEquals("00:00", playbackClock(0.0))
    assertEquals("02:03", playbackClock(123.9))
    assertEquals("59:59", playbackClock(3599.0))
  }

  @Test
  fun `an hour or more is hours, minutes and seconds instead of a minute count`() {
    assertEquals("1:00:00", playbackClock(3600.0))
    assertEquals("1:37:12", playbackClock(5832.0))
    assertEquals("12:00:05", playbackClock(43205.0))
  }

  @Test
  fun `a position beside a long film keeps the hour column`() {
    assertEquals("0:05:12", playbackClock(312.0, withHours = true))
  }

  @Test
  fun `negative and non-finite times read as zero`() {
    assertEquals("00:00", playbackClock(-5.0))
    assertEquals("00:00", playbackClock(Double.NaN))
  }

  @Test
  fun `the seek bubble reads hours past an hour`() {
    assertEquals("+1:30", seekBubble(90))
    assertEquals("−0:10", seekBubble(-10))
    assertEquals("+1:05:00", seekBubble(3900))
  }
}
