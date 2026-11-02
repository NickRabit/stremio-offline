package cz.stremiooffline.tv.ui.detail

import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteProviderIdsDto

/** What one native remote item's detail needs: the library and the item's opaque id. */
data class RemoteDetailData(
  val libraryId: String,
  val libraryName: String,
  val provider: String,
  val item: RemoteItemDto,
  val seriesName: String? = null,
  /** The parent series' external ids, when the caller already holds them, so an episode's copy
   *  carries the series' catalogue id without reading the parent again. */
  val seriesIds: RemoteProviderIdsDto? = null,
  /** Opened from Continue watching: Play is pressed once the item and a version have loaded. */
  val autoPlay: Boolean = false,
) {
  val isEpisode: Boolean get() = item.type == "episode"
}
