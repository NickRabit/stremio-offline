package cz.stremiooffline.tv.playback

import cz.stremiooffline.tv.data.NextFileDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NextEpisodeTest {

  @Test
  fun `a library neighbour is kept as a path and a title`() {
    assertEquals(NextEpisode("Films/It 2.mkv", "It 2.mkv"), nextEpisodeOf(NextFileDto("Films/It 2.mkv", "It 2.mkv")))
  }

  @Test
  fun `a title the server left out falls back to the file name`() {
    assertEquals(NextEpisode("Films/It 2.mkv", "It 2.mkv"), nextEpisodeOf(NextFileDto("Films/It 2.mkv", "")))
  }

  @Test
  fun `no neighbour and an empty path are both nothing`() {
    assertNull(nextEpisodeOf(null))
    assertNull(nextEpisodeOf(NextFileDto("", "")))
  }

  @Test
  fun `the end offers a next episode, waits for its lookup, and otherwise leaves`() {
    assertEquals(EndAction.OfferNext, endAction(hasNext = true, nextPending = false))
    assertEquals(EndAction.OfferNext, endAction(hasNext = true, nextPending = true))
    assertEquals(EndAction.Wait, endAction(hasNext = false, nextPending = true))
    assertEquals(EndAction.Leave, endAction(hasNext = false, nextPending = false))
  }
}
