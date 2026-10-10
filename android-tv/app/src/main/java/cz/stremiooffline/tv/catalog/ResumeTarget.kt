package cz.stremiooffline.tv.catalog

import cz.stremiooffline.tv.data.ProgressEntryDto
import cz.stremiooffline.tv.data.VideoDto

/** What a Continue-watching row opens; a series row remembers the episode. */
data class ResumeMeta(val id: String, val type: String, val name: String, val poster: String?)

data class ResumeEpisode(val key: String, val season: Int, val number: Int)

data class ResumeTarget(val meta: ResumeMeta, val episode: ResumeEpisode? = null)

/** The web's `web/src/resume-target.ts`: where a stored row points, and which video it names. */
object Resume {

  /** `series:<stremio series id>:<season>:<episode>`, the id is greedy so `kitsu:123` survives. */
  private val EPISODE_KEY = Regex("^series:(.+):(\\d+):(\\d+)$")
  private const val TITLE_SEPARATOR = " · "

  private fun seriesOf(entry: ProgressEntryDto): ProgressEntryDto.Series? {
    if (!entry.series?.id.isNullOrEmpty()) return entry.series
    val match = EPISODE_KEY.find(entry.key) ?: return null
    val at = entry.title.indexOf(TITLE_SEPARATOR)
    return ProgressEntryDto.Series(
      id = match.groupValues[1],
      name = if (at < 0) entry.title else entry.title.substring(0, at),
      season = match.groupValues[2].toInt(),
      episode = match.groupValues[3].toInt(),
    )
  }

  fun resumeTarget(entry: ProgressEntryDto): ResumeTarget {
    val series = seriesOf(entry)
    if (series != null) {
      return ResumeTarget(
        meta = ResumeMeta(series.id, "series", series.name, entry.poster),
        episode = ResumeEpisode(entry.key, series.season, series.episode),
      )
    }
    val parts = entry.key.split(":")
    val type = parts.firstOrNull() ?: "movie"
    val rest = parts.drop(1).joinToString(":")
    return ResumeTarget(ResumeMeta(rest.ifEmpty { entry.key }, type, entry.title, entry.poster))
  }

  private fun keyVideoId(key: String): String? =
    if (key.startsWith("series:")) key.removePrefix("series:") else null

  /** The video the remembered episode points at, by numbers first and by id second. */
  fun resumeVideo(videos: List<VideoDto>?, episode: ResumeEpisode?): VideoDto? {
    if (videos.isNullOrEmpty() || episode == null) return null
    if (episode.season != 0 || episode.number != 0) {
      val byNumbers = videos.firstOrNull {
        !it.id.isNullOrEmpty() && it.season == episode.season && it.episode == episode.number
      }
      if (byNumbers != null) return byNumbers
    }
    val id = keyVideoId(episode.key) ?: return null
    return videos.firstOrNull { it.id == id }
  }
}
