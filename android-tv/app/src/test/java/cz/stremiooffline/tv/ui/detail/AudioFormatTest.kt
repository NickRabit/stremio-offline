package cz.stremiooffline.tv.ui.detail

import org.junit.Assert.assertEquals
import org.junit.Test

class AudioFormatTest {

  @Test
  fun `audio format recognises the supported release tags`() {
    assertEquals("Atmos 7.1", audioFormat("Movie.2026.Atmos.7.1.mkv"))
    assertEquals("TrueHD 7.1", audioFormat("Movie.2026.TrueHD.7.1.mkv"))
    assertEquals("DTS-HD MA 5.1", audioFormat("Movie.2026.DTS-HD.MA.5.1.mkv"))
    assertEquals("DTS-HD 7.1", audioFormat("Movie.2026.DTS-HD.7.1.mkv"))
    assertEquals("DTS 5.1", audioFormat("Movie.2026.DTS.5.1.mkv"))
    assertEquals("DD+ 5.1", audioFormat("Movie.2026.DDP5.1.mkv"))
    assertEquals("DD+ 5.1", audioFormat("Movie.2026.DD+.5.1.mkv"))
    assertEquals("DD+ 5.1", audioFormat("Movie.2026.EAC3.5.1.mkv"))
    assertEquals("DD 5.1", audioFormat("Movie.2026.DD.5.1.mkv"))
    assertEquals("DD 5.1", audioFormat("Movie.2026.AC3.5.1.mkv"))
    assertEquals("AAC 2.0", audioFormat("Movie.2026.AAC.2.0.mkv"))
    assertEquals("FLAC 7.1", audioFormat("Movie.2026.FLAC.7.1.flac"))
    assertEquals("Opus 5.1", audioFormat("Movie.2026.Opus.5.1.mkv"))
    assertEquals("DTS-HD MA", audioFormat("Movie.2026.DTS-HD.MA.mkv"))
    assertEquals("", audioFormat("Movie.2026.1080p.WEB-DL.mkv"))
  }
}
