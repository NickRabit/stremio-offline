package cz.stremiooffline.tv.data

import kotlinx.serialization.Serializable

/** The fields of one `GET /api/downloads` job the TVs Home summary reads. */
@Serializable
data class DownloadDto(
  val id: String = "",
  val title: String = "",
  val status: String = "queued",
  val order: Int = 0,
  val mine: Boolean? = null,
  val pauseReason: String? = null,
  val libraryGone: Boolean? = null,
)

@Serializable
data class DownloadsResponseDto(val jobs: List<DownloadDto> = emptyList())

/** The `target` the To library choice sends: the one field the route reads off the body. */
@Serializable
data class DownloadTargetDto(val libraryId: String)

/** One episode of a bulk download: the id the queue adds, and the numbers its job title needs. */
@Serializable
data class BulkEpisodeDto(
  val id: String,
  val season: Int? = null,
  val episode: Int? = null,
  val title: String? = null,
)

/** The lazy rules `POST /api/downloads/bulk` reads off the selection the web sends. */
@Serializable
data class DownloadSelectionDto(
  val addonKeys: List<String>,
  val sourceStrategy: String,
  val audioLanguage: String,
  val fallbackAudioLanguage: String? = null,
  val audioMode: String,
  val subtitleMode: String,
  val subtitleLanguage: String? = null,
  val fallbackSubtitleLanguage: String? = null,
)

/** The parent title a bulk body carries; the route reads the id, the type and the poster. */
@Serializable
data class BulkMediaDto(
  val id: String? = null,
  val metaType: String? = null,
  val poster: String? = null,
  val background: String? = null,
)

/** What `POST /api/downloads/bulk` answers: how many jobs it added, and how many it skipped. */
@Serializable
data class BulkDownloadResult(val added: Int = 0, val skipped: Int = 0)

/** The whole bulk body, in the order the web builds it. */
@Serializable
data class BulkDownloadRequest(
  val title: String,
  val type: String,
  val episodes: List<BulkEpisodeDto>,
  val selection: DownloadSelectionDto,
  val media: BulkMediaDto,
  val target: DownloadTargetDto? = null,
)

/** The body the web posts for a bulk download; a null target leaves the key out. */
fun bulkDownloadBody(
  title: String,
  type: String,
  episodes: List<BulkEpisodeDto>,
  selection: DownloadSelectionDto,
  media: BulkMediaDto,
  target: DownloadTargetDto?,
): BulkDownloadRequest = BulkDownloadRequest(title, type, episodes, selection, media, target)

/** The episodes a scope sends, as the route reads them: the id and the numbers it has. */
fun bulkEpisodes(videos: List<VideoDto>): List<BulkEpisodeDto> = videos.mapNotNull { video ->
  video.id?.let { BulkEpisodeDto(it, video.season, video.episode, video.title ?: video.name) }
}
