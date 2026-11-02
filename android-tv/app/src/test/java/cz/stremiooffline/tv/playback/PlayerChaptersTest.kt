package cz.stremiooffline.tv.playback

import cz.stremiooffline.tv.data.PlaybackChapterDto
import org.junit.Assert.assertEquals
import org.junit.Test

class PlayerChaptersTest {
  private val chapters = listOf(
    PlaybackChapterDto(0.0, 600.0, "Opening"),
    PlaybackChapterDto(600.0, 1800.0),
    PlaybackChapterDto(1800.0, 3600.0, "Finale"),
  )

  @Test
  fun `finds the chapter around a position`() {
    assertEquals(-1, chapterAt(chapters, -1.0))
    assertEquals(0, chapterAt(chapters, 300.0))
    assertEquals(1, chapterAt(chapters, 600.0))
    assertEquals(-1, chapterAt(chapters, 3600.0))
  }

  @Test
  fun `numbers an untitled chapter`() {
    assertEquals("Chapter 2", chapterLabelOf(chapters, 1) { "Chapter $it" })
  }
}
