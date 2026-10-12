package cz.stremiooffline.tv.ui.catalog

import cz.stremiooffline.tv.data.VideoDto
import org.junit.Assert.assertEquals
import org.junit.Test

/** Which episodes a scope queues, worked out the way the web's `toEpisodes` and its bulk filter do. */
class SeriesDownloadTest {

  private val today = "2026-10-12"

  private fun video(id: String, season: Int?, episode: Int?, released: String? = "2020-01-01") =
    VideoDto(id = id, season = season, episode = episode, released = released)

  private fun ids(scope: DownloadScope, selected: VideoDto?) =
    scopeEpisodes(
      listOf(
        video("s0e1", 0, 1),
        video("s1e1", 1, 1),
        video("s1e2", 1, 2),
        video("s1e3", 1, 3, released = "2999-01-01"),
        video("s2e1", 2, 1),
      ),
      scope,
      selected,
      today,
    ).map { it.id }

  @Test
  fun `a special is not an episode of the series`() {
    assertEquals(listOf("s1e1", "s1e2", "s2e1"), ids(DownloadScope.All, video("s1e1", 1, 1)))
  }

  @Test
  fun `an episode whose release day is still ahead is left out`() {
    assertEquals(false, ids(DownloadScope.All, video("s1e1", 1, 1)).contains("s1e3"))
    assertEquals(emptyList<String>(), ids(DownloadScope.Episode, video("s1e3", 1, 3, "2999-01-01")))
  }

  @Test
  fun `this episode is the selected one alone`() {
    assertEquals(listOf("s1e2"), ids(DownloadScope.Episode, video("s1e2", 1, 2)))
  }

  @Test
  fun `this season is the released episodes of the selected season`() {
    assertEquals(listOf("s1e1", "s1e2"), ids(DownloadScope.Season, video("s1e2", 1, 2)))
    assertEquals(listOf("s2e1"), ids(DownloadScope.Season, video("s2e1", 2, 1)))
  }

  @Test
  fun `from this episode on keeps it and everything after it`() {
    assertEquals(listOf("s1e2", "s2e1"), ids(DownloadScope.FromEpisode, video("s1e2", 1, 2)))
    assertEquals(listOf("s1e1", "s1e2", "s2e1"), ids(DownloadScope.FromEpisode, video("s1e1", 1, 1)))
  }

  @Test
  fun `all episodes is every released regular one`() {
    assertEquals(listOf("s1e1", "s1e2", "s2e1"), ids(DownloadScope.All, video("s1e1", 1, 1)))
  }

  @Test
  fun `a video without a season and number is not an episode`() {
    val videos = listOf(VideoDto(id = "part1", released = "2020-01-01"), video("s1e1", 1, 1))
    assertEquals(listOf("s1e1"), scopeEpisodes(videos, DownloadScope.All, null, today).map { it.id })
  }
}
