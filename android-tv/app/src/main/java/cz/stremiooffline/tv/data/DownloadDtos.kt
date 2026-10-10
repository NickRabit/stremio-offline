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
