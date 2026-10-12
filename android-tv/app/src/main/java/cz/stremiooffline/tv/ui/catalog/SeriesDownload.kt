package cz.stremiooffline.tv.ui.catalog

import cz.stremiooffline.tv.data.VideoDto

/** Which episodes a bulk download queues, in the order the panel offers them. */
enum class DownloadScope { Episode, Season, FromEpisode, All }

/** The videos the web counts as episodes of a show at all: `toEpisodes` drops anything without
 *  a season and a number, and specials (season 0) are not episodes of a series. */
internal fun isRegularEpisode(video: VideoDto): Boolean =
  video.id != null && video.season != null && video.episode != null && video.season >= 1

internal fun regularEpisodes(videos: List<VideoDto>): List<VideoDto> = videos.filter(::isRegularEpisode)

/** An episode may be queued once its release day has come; one that names no day counts. */
internal fun releasedEpisode(video: VideoDto, today: String): Boolean =
  (releasedDate(video) ?: "0000-01-01") <= today

/** The released, regular episodes a scope would queue, oldest season first. */
fun scopeEpisodes(
  videos: List<VideoDto>,
  scope: DownloadScope,
  selected: VideoDto?,
  today: String = utcToday(),
): List<VideoDto> {
  val released = orderedEpisodes(videos).filter { isRegularEpisode(it) && releasedEpisode(it, today) }
  val season = selected?.season
  val episode = selected?.episode
  return when (scope) {
    DownloadScope.Episode -> released.filter { it.id == selected?.id }
    DownloadScope.Season -> if (season == null) emptyList() else released.filter { it.season == season }
    DownloadScope.FromEpisode ->
      if (season == null || episode == null) {
        emptyList()
      } else {
        released.filter { (it.season ?: 0) > season || (it.season == season && (it.episode ?: 0) >= episode) }
      }
    DownloadScope.All -> released
  }
}
