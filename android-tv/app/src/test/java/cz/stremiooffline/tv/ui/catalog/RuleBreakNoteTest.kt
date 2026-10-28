package cz.stremiooffline.tv.ui.catalog

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The break note names the three new reasons and joins several of them. */
class RuleBreakNoteTest {

  private fun note(reasons: List<String>) = ruleBreakNote(
    reasons,
    language = "other language",
    resolutionLow = "lower resolution",
    resolutionHigh = "higher resolution",
    cinema = "cinema copy (CAM/TS)",
    subtitles = "no subtitles",
    sample = "sample",
    size = "size out of range",
    provider = "source not in the rules",
    torrent = "torrents not allowed",
    codec = "unwanted codec",
    hdr = "HDR / Dolby Vision",
  )

  @Test
  fun `the video reasons are named`() {
    assertEquals("unwanted codec, HDR / Dolby Vision", note(listOf("codec", "hdr")))
  }

  @Test
  fun `the three new reasons are named`() {
    assertEquals("size out of range", note(listOf("size")))
    assertEquals("source not in the rules", note(listOf("provider")))
    assertEquals("torrents not allowed", note(listOf("torrent")))
  }

  @Test
  fun `several reasons are joined and an unknown code is left out`() {
    assertEquals(
      "size out of range, source not in the rules",
      note(listOf("size", "nope", "provider")),
    )
    assertEquals(
      "size out of range, torrents not allowed",
      note(listOf("size", "torrent")),
    )
    assertNull(note(listOf("nope")))
    assertNull(note(emptyList()))
  }
}
