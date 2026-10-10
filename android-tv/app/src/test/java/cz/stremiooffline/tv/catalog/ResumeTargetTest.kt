package cz.stremiooffline.tv.catalog

import cz.stremiooffline.tv.data.ProgressEntryDto
import cz.stremiooffline.tv.data.VideoDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The nine cases of `web/src/resume-target.test.ts`. */
class ResumeTargetTest {

  private fun entry(
    key: String,
    position: Double = 120.0,
    duration: Double = 2400.0,
    title: String = "Title",
    poster: String? = null,
    series: ProgressEntryDto.Series? = null,
  ) = ProgressEntryDto(key = key, position = position, duration = duration, title = title, poster = poster, series = series)

  @Test
  fun `opens a grouped series row as the series and remembers its episode`() {
    val row = entry(
      key = "series:tt0944947:1:5",
      title = "Městečko South Park · Volcano",
      poster = "tt0944947.jpg",
      series = ProgressEntryDto.Series("tt0944947", "Městečko South Park", 1, 5),
    )
    assertEquals(
      ResumeTarget(ResumeMeta("tt0944947", "series", "Městečko South Park", "tt0944947.jpg"), ResumeEpisode("series:tt0944947:1:5", 1, 5)),
      Resume.resumeTarget(row),
    )
  }

  @Test
  fun `derives the series of a row stored before the field existed`() {
    val row = entry(key = "series:tt0944947:1:5", title = "Show · S01E05")
    assertEquals(
      ResumeTarget(ResumeMeta("tt0944947", "series", "Show", null), ResumeEpisode("series:tt0944947:1:5", 1, 5)),
      Resume.resumeTarget(row),
    )
  }

  @Test
  fun `opens a movie row as itself`() {
    val row = entry(key = "movie:tt1", title = "Zkušební film", poster = "tt1.jpg")
    assertEquals(ResumeTarget(ResumeMeta("tt1", "movie", "Zkušební film", "tt1.jpg")), Resume.resumeTarget(row))
  }

  @Test
  fun `opens a local file as itself instead of inventing a series`() {
    val row = entry(key = "file:lib_ab12cd34/Show/01.mkv", title = "Show · S01E05")
    assertNull(Resume.resumeTarget(row).episode)
    assertEquals(ResumeMeta("lib_ab12cd34/Show/01.mkv", "file", "Show · S01E05", null), Resume.resumeTarget(row).meta)
  }

  @Test
  fun `finds the episode the season and number point at`() {
    val videos = listOf(VideoDto("tt0944947:1:4", season = 1, episode = 4), VideoDto("tt0944947:1:5", season = 1, episode = 5))
    assertEquals(videos[1], Resume.resumeVideo(videos, ResumeEpisode("series:tt0944947:1:5", 1, 5)))
  }

  @Test
  fun `falls back to the id in the key when the metadata carries no numbers`() {
    val videos = listOf(VideoDto("tt0944947:1:5", title = "Volcano"))
    assertEquals(videos[0], Resume.resumeVideo(videos, ResumeEpisode("series:tt0944947:1:5", 1, 5)))
  }

  @Test
  fun `does not take a special numbered 0 for an episode whose numbers are unknown`() {
    val specials = listOf(VideoDto("tt0944947:0:0", season = 0, episode = 0), VideoDto("tt0944947:1:5", season = 1, episode = 5))
    assertEquals(specials[1], Resume.resumeVideo(specials, ResumeEpisode("series:tt0944947:1:5", 0, 0)))
  }

  @Test
  fun `answers nothing when the metadata no longer lists the episode`() {
    val videos = listOf(VideoDto("tt0944947:1:4", season = 1, episode = 4))
    assertNull(Resume.resumeVideo(videos, ResumeEpisode("series:tt0944947:1:5", 1, 5)))
  }

  @Test
  fun `resumeVideo never answers a video that carries no id`() {
    val videos = listOf(VideoDto(null, name = "Spoonful", season = 1, episode = 3))
    assertNull(Resume.resumeVideo(videos, ResumeEpisode("series:tt9288030:1:3", 1, 3)))
  }
}
