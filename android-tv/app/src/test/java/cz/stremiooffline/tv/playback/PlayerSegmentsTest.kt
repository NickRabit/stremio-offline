package cz.stremiooffline.tv.playback

import cz.stremiooffline.tv.data.IntroSegmentsDto
import cz.stremiooffline.tv.data.SegmentRangeDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlayerSegmentsTest {
  @Test
  fun `reads movie and series IMDb keys`() {
    assertEquals(IntroQuery("tt12345"), introQueryOf("movie:tt12345"))
    assertEquals(IntroQuery("tt0903747", 1, 2), introQueryOf("series:tt0903747:1:2"))
  }

  @Test
  fun `rejects other keys and malformed ids`() {
    assertNull(introQueryOf("kitsu:123"))
    assertNull(introQueryOf("file:Films/a.mkv"))
    assertNull(introQueryOf(null))
    assertNull(introQueryOf("series:tt0903747:-1:2"))
  }

  @Test
  fun `uses an inclusive start and hides in the final second`() {
    val segments = IntroSegmentsDto(intro = SegmentRangeDto(5.0, 60.0))
    assertNull(activeSegment(segments, 4.99))
    assertEquals(SegmentKind.Intro, activeSegment(segments, 5.0)?.kind)
    assertEquals(SegmentKind.Intro, activeSegment(segments, 58.99)?.kind)
    assertNull(activeSegment(segments, 59.0))
  }

  @Test
  fun `prefers intro then recap then outro`() {
    val ranges = IntroSegmentsDto(
      intro = SegmentRangeDto(10.0, 30.0),
      recap = SegmentRangeDto(20.0, 40.0),
      outro = SegmentRangeDto(25.0, 50.0),
    )
    assertEquals(SegmentKind.Intro, activeSegment(ranges, 25.0)?.kind)
    assertEquals(SegmentKind.Recap, activeSegment(ranges.copy(intro = null), 25.0)?.kind)
    assertEquals(SegmentKind.Outro, activeSegment(ranges.copy(intro = null, recap = null), 25.0)?.kind)
  }

  @Test
  fun `maps every non-end choice`() {
    val expected = mapOf(
      "end" to null,
      "pct97" to 3492.0,
      "pct98" to 3528.0,
      "pct99" to 3564.0,
      "sec30" to 3570.0,
      "sec60" to 3540.0,
      "sec120" to 3480.0,
      "sec180" to 3420.0,
    )
    expected.forEach { (value, point) -> assertEquals(point, upNextPoint(value, 3600.0)) }
  }

  @Test
  fun `moves an earlier point to known credits`() {
    assertEquals(3500.0, upNextPoint("sec60", 3600.0, SegmentRangeDto(3500.0, 3600.0)))
    assertEquals(3540.0, upNextPoint("sec60", 3600.0, SegmentRangeDto(3550.0, 3600.0)))
  }

  @Test
  fun `ignores end unknown and non-positive points`() {
    assertNull(upNextPoint("end", 3600.0, SegmentRangeDto(3500.0, 3600.0)))
    assertNull(upNextPoint("sec60", 0.0))
    assertNull(upNextPoint("sec180", 100.0))
  }

  @Test
  fun `threshold shows once at the crossing`() {
    val trigger = UpNextTrigger()
    assertFalse(trigger.observe(9.0, 10.0, playing = true))
    assertTrue(trigger.observe(10.0, 10.0, playing = true))
    assertFalse(trigger.observe(11.0, 10.0, playing = true))
    assertFalse(trigger.observe(12.0, 10.0, playing = true))
  }

  @Test
  fun `dismissal lasts until the position returns below the point`() {
    val trigger = UpNextTrigger()
    trigger.observe(9.0, 10.0, playing = true)
    assertTrue(trigger.observe(10.0, 10.0, playing = true))
    trigger.dismiss()
    assertFalse(trigger.observe(11.0, 10.0, playing = true))
    assertFalse(trigger.observe(9.0, 10.0, playing = true))
    assertTrue(trigger.observe(10.0, 10.0, playing = true))
  }

  @Test
  fun `a paused crossing does not show the card`() {
    val trigger = UpNextTrigger()
    trigger.observe(9.0, 10.0, playing = true)
    assertFalse(trigger.observe(10.0, 10.0, playing = false))
    assertFalse(trigger.observe(11.0, 10.0, playing = true))
  }

  @Test
  fun `a threshold arriving after the position passed it does not show the card`() {
    val trigger = UpNextTrigger()
    assertFalse(trigger.observe(11.0, null, playing = false))
    assertFalse(trigger.observe(12.0, 10.0, playing = true))
  }
}
