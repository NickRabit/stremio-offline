package cz.stremiooffline.tv.ui.detail

import cz.stremiooffline.tv.data.RemoteItemDto
import org.junit.Assert.assertEquals
import org.junit.Test

/** The progress title a media-server play writes: Continue watching names the show from it. */
class RemoteTitleOfTest {

  private fun episode(seriesName: String?, itemSeries: String? = null) = RemoteDetailData(
    libraryId = "rlib",
    libraryName = "Shows",
    provider = "emby",
    item = RemoteItemDto(id = "e2", name = "The Break-Up Scene", type = "episode", season = 1, episode = 2, seriesName = itemSeries),
    seriesName = seriesName,
  )

  @Test
  fun `an episode leads with its series name`() {
    assertEquals("2 Broke Girls · S1 · E2", titleOf(episode("2 Broke Girls")))
    assertEquals("2 Broke Girls · S1 · E2", titleOf(episode(null, itemSeries = "2 Broke Girls")))
  }

  @Test
  fun `an episode with no known series keeps its own name`() {
    assertEquals("The Break-Up Scene · S1 · E2", titleOf(episode(null)))
  }
}
